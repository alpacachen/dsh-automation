import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentConfiguration } from '../src/agent-configuration.js'
import type { AutomationRun, AutomationTask } from '../src/types.js'
import { DshAutomationRunner } from '../src/runner.js'
import { AutomationError } from '../src/errors.js'
import { unattendedAgents } from '../src/runtime-marker.js'

// Opt-in: use one installed Host dependency tree for the actual loop and all its
// registries. No model request leaves this process and all cwd state is temporary.
// Only LLM replies are mocked within the loop. Runner-only workspace, permission,
// validation and stat adapters keep this regression independent of the full Host.
const loopModule = process.env.DSH_TEST_AGENT_LOOP_MODULE
const options = {
  skip: loopModule === undefined ? 'Set DSH_TEST_AGENT_LOOP_MODULE to an installed Agent loop lib/index.js.' : false,
  timeout: 10_000,
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function reply(text: string, error?: Error) {
  return { text, error, entered: deferred<AbortSignal>(), release: deferred() }
}

async function fixture(t: TestContext, replies: ReturnType<typeof reply>[]) {
  const require = createRequire(loopModule!)
  const load = (name: string) => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
  const [{ Context: RuntimeContext }, { SessionStore, SessionId }, { AgentRegistry },
    { SessionProjectionRegistry }, { SystemPrompt }, { ToolRuntime }, { AgentLoop }, { createUserMessage }] = await Promise.all([
    load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-session-projection'),
    load('dsh-system-prompt'), load('dsh-tools'), import(pathToFileURL(loopModule!).href), load('dsh-llm'),
  ])
  const cwd = await mkdtemp(join(tmpdir(), 'automation-loop-'))
  const ctx = new RuntimeContext()
  t.after(async () => { try { await ctx.fiber.dispose() } finally { await rm(cwd, { recursive: true, force: true }) } })
  new SessionStore(ctx)
  new AgentRegistry(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  let requests = 0
  ctx.provide('llm', {
    async prepareCall(config: unknown) {
      return {
        config,
        adapterDefaults: {},
        async *stream(request: { signal: AbortSignal }) {
          const next = replies[requests++]
          assert.ok(next, 'Unexpected additional LLM request')
          next.entered.resolve(request.signal)
          let onAbort!: () => void
          try {
            await Promise.race([
              next.release.promise,
              new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(request.signal.reason)
                if (request.signal.aborted) onAbort()
                else request.signal.addEventListener('abort', onAbort, { once: true })
              }),
            ])
            request.signal.throwIfAborted()
            if (next.error !== undefined) throw next.error
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: next.text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: next.text } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          } finally { request.signal.removeEventListener('abort', onAbort) }
        },
      }
    },
  })
  new AgentLoop(ctx, { agents: [] })
  const id = SessionId('session-loop-regression')
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  const agent = handle.agent
  const permissions: string[] = []
  ctx.provide('sessionPersistence', { async stat(sessionId: string) { return sessionId === id ? { header: agent.session.header } : undefined } })
  ctx.provide('workspaceRegistry', { get: () => ({ id: 'workspace-loop', path: cwd }) })
  ctx.provide('permissionPresets', { set(_session: unknown, preset: string) { permissions.push(preset) } })
  const task: AutomationTask = {
    id: 'automation-loop', name: 'Water reminder', prompt: 'Drink water.',
    createdAt: '2026-03-20T00:00:00.000Z', createdBySessionId: 'creator', status: 'active',
    schedule: { kind: 'recurring', rrule: 'FREQ=MINUTELY', timeZone: 'UTC', startAt: '2026-03-20T09:00:00' },
    nextRunAt: '2026-03-20T09:01:00.000Z', notificationPolicy: 'failures',
    pauseAfterConsecutiveFailures: false, consecutiveFailures: 0, unreadNotifications: 0,
    execution: { workspaceId: 'workspace-loop', cwd, skills: [], target: { mode: 'pinned-session', sessionId: id, workspaceId: 'workspace-loop', cwd, fallback: 'fail' } },
    security: { permissionPreset: 'read-only', source: 'user-confirmed', grantedAt: '2026-03-20T00:00:00.000Z' }, runs: [],
  }
  const run: AutomationRun = {
    id: 'run-loop', trigger: 'scheduled', status: 'running', enqueuedAt: '2026-03-20T09:01:00.000Z',
    sessionId: id, executionTarget: { mode: 'pinned-session', sessionId: id },
  }
  const runner = new DshAutomationRunner(ctx as Context, { async validate() {} } as unknown as AgentConfiguration)
  const userMessage = (text: string) => createUserMessage({ content: [{ type: 'text', text }] })
  return { ctx, agent, runner, task, run, userMessage, permissions, requests: () => requests }
}

test('real loop releases the automation turn while a later human turn is still running', options, async (t) => {
  const automatic = reply('Drink water now.')
  const human = reply('', new Error('Later human model request failed'))
  const f = await fixture(t, [automatic, human])
  const pending = f.runner.run(f.task, f.run)
  await automatic.entered.promise
  assert.equal(unattendedAgents.has(f.agent), true)
  const humanMessage = f.userMessage('Now review my unrelated code.')
  const ownershipAtHumanClaim: Array<{ unattended: boolean; cancelable: boolean }> = []
  f.ctx.on('agent/inbox/claimed', (event: { agent: unknown; message: { id: string } }) => {
    if (event.agent === f.agent && event.message.id === humanMessage.id) {
      ownershipAtHumanClaim.push({ unattended: unattendedAgents.has(f.agent), cancelable: f.runner.cancel(f.run.id, 'timeout') })
    }
  })
  f.agent.followup(humanMessage)
  automatic.release.resolve()
  const humanSignal = await human.entered.promise
  // This must settle before the human reply gate opens, not at Agent.whenIdle().
  const result = await pending
  assert.equal(f.agent.status, 'running')
  assert.equal(result.status, 'succeeded')
  assert.equal(result.summary, 'Drink water now.')
  assert.deepEqual(ownershipAtHumanClaim, [{ unattended: false, cancelable: false }], 'Turn ownership must end synchronously before the human input is claimed')
  assert.equal(unattendedAgents.has(f.agent), false)
  assert.equal(f.runner.cancel(f.run.id, 'timeout'), false)
  assert.equal(humanSignal.aborted, false)
  human.release.resolve()
  await f.agent.whenIdle()
  const ends = f.agent.session.snapshotEvents().filter((event: { type: string }) => event.type === 'turn/end')
  assert.deepEqual(ends.map((event: { data: { reason: { kind: string } } }) => event.data.reason.kind), ['completed', 'error'])
  assert.equal(result.status, 'succeeded', 'A later human error must not rewrite the automation outcome')
  assert.equal(f.ctx.agents.get(f.agent.id), f.agent)
})

test('real loop cancellation aborts only the claimed automation and retains queued human messages', options, async (t) => {
  const automatic = reply('Not reached')
  const f = await fixture(t, [automatic])
  const pending = f.runner.run(f.task, f.run)
  const signal = await automatic.entered.promise
  const first = f.userMessage('First human follow-up')
  const second = f.userMessage('Second human follow-up')
  f.agent.followup(first)
  f.agent.followup(second)
  assert.equal(f.runner.cancel(f.run.id, 'manual'), true)
  const result = await pending
  await f.agent.whenIdle()
  assert.equal(signal.aborted, true)
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /aborted/)
  assert.deepEqual(f.agent.inbox.nextTurn.map((message: { id: string }) => message.id), [first.id, second.id])
  assert.equal(unattendedAgents.has(f.agent), false)
  assert.equal(f.ctx.agents.get(f.agent.id), f.agent)
  assert.equal(f.requests(), 1)
})

test('real loop maintenance is rejected without canceling user compaction or changing permissions', options, async (t) => {
  const f = await fixture(t, [])
  const release = deferred()
  let maintenanceSignal!: AbortSignal
  const maintenance = f.agent.runMaintenance(async (signal: AbortSignal) => {
    maintenanceSignal = signal
    await release.promise
  })
  try {
    assert.equal(f.agent.status, 'idle', 'The public status hides maintenance; it is not sufficient admission protection')
    await assert.rejects(f.runner.run(f.task, f.run), (error: unknown) => error instanceof AutomationError && error.code === 'target_session_busy')
    assert.equal(f.runner.cancel(f.run.id, 'manual'), false)
    assert.equal(maintenanceSignal.aborted, false)
    assert.deepEqual(f.permissions, [])
    assert.equal(f.agent.inbox.nextTurn.length, 0)
    assert.equal(f.requests(), 0)
  } finally { release.resolve(); await maintenance }
})

test('disposing the runner owner settles its turn without disposing the borrowed real Agent', options, async (t) => {
  const automatic = reply('Not reached')
  const f = await fixture(t, [automatic])
  let runner!: DshAutomationRunner
  const owner = await f.ctx.plugin({
    name: 'automation-loop-test-owner',
    apply(ownerCtx: Context) {
      runner = new DshAutomationRunner(ownerCtx, { async validate() {} } as unknown as AgentConfiguration)
    },
  })
  const pending = runner.run(f.task, f.run)
  const signal = await automatic.entered.promise
  const human = f.userMessage('Keep this queued message after plugin disposal')
  f.agent.followup(human)
  await owner.dispose()
  const result = await pending
  await f.agent.whenIdle()
  assert.equal(result.status, 'failed')
  assert.equal(signal.aborted, true)
  assert.equal(unattendedAgents.has(f.agent), false)
  assert.equal(f.ctx.agents.get(f.agent.id), f.agent)
  assert.deepEqual(f.agent.inbox.nextTurn.map((message: { id: string }) => message.id), [human.id])
  assert.equal(runner.cancel(f.run.id, 'manual'), false)
})

test('real loop pending cancellation removes only automation input before it is claimed', options, async (t) => {
  const human = reply('Human reply survives')
  const f = await fixture(t, [human])
  const message = f.userMessage('Queued human input must survive')
  let canceled = false
  const stop = f.ctx.on('agent/inbox/inserted', (event: { agent: unknown; message: { source?: { kind?: string; plugin?: string } } }) => {
    if (event.agent !== f.agent || event.message.source?.kind !== 'plugin:automation') return
    f.agent.followup(message)
    canceled = f.runner.cancel(f.run.id, 'manual')
  })
  try {
    const result = await f.runner.run(f.task, f.run)
    const signal = await human.entered.promise
    assert.equal(canceled, true)
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /before execution/)
    assert.equal(unattendedAgents.has(f.agent), false)
    assert.equal(signal.aborted, false)
    human.release.resolve()
    await f.agent.whenIdle()
    const inputIds = f.agent.session.snapshotEvents().filter((event: { type: string }) => event.type === 'user/message')
      .map((event: { data: { id: string } }) => event.data.id)
    assert.deepEqual(inputIds, [message.id])
    assert.equal(f.requests(), 1)
  } finally { stop() }
})
