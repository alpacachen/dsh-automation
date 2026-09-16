import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { AgentConfiguration } from '../src/agent-configuration.js'
import { DshAutomationRunner } from '../src/runner.js'
import type { AutomationTask } from '../src/types.js'

// The concrete JSONL backend is optional, not an Automation dependency.
// Point DSH_TEST_JSONL_MODULE at an installed backend's lib/index.js to run this
// real-storage regression. All state stays in a disposable temporary directory.
const backendModule = process.env.DSH_TEST_JSONL_MODULE

test('live idle Agent reuse preserves the real JSONL exclusive write owner', {
  skip: backendModule === undefined ? 'Set DSH_TEST_JSONL_MODULE to an installed JSONL backend to run real persistence coverage.' : false,
}, async (t) => {
  const require = createRequire(backendModule!)
  const [{ Context: RuntimeContext }, { AgentRegistry, agentEvents }, { Session, SessionStore, SessionId, SESSION_FORMAT_VERSION }, { default: JsonlPersistence }] = await Promise.all([
    import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')).href),
    import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href),
    import(pathToFileURL(backendModule!).href),
  ])
  const root = await mkdtemp(join(tmpdir(), 'automation-runner-persistence-'))
  const runtime = new RuntimeContext()
  t.after(async () => { try { await runtime.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  const persistence: SessionPersistence = new JsonlPersistence(runtime, { root, compression: 'none' })
  const registry = new AgentRegistry(runtime)
  const sessions = new SessionStore(runtime)
  const id = SessionId('automation-owned-session')
  const session = Session.create(id, [], { id, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd: root, isSeeded: false })
  const writer = await persistence.create(session.header)
  let detach: (() => void) | undefined
  const detachSession = sessions.enter(session)
  try {
    // Store the constructor seed before live SessionStore events reach JSONL.
    await writer.append(session.snapshotEvents())
    await writer.flush()
    const ownershipError = /already owned by an active write handle/
    await assert.rejects(persistence.open(id, 'write'), ownershipError)
    let followups = 0
    let resumeAttempts = 0
    const agent = {
      id, ctx: runtime, session, status: 'idle',
      inbox: { nextTurn: [], nextStep: [], remove() { return false } },
      async runMaintenance(job: () => Promise<void>) { await job() },
      followup(message: unknown) {
        followups += 1
        // Deliberately fake only the Agent turn; event dispatch and disk IO are real.
        // Actual maintenance/inbox/turn lifecycle is covered by runner-loop.test.ts.
        session.append('turn/start', { turn: followups })
        agentEvents(runtime, agent).emit('agent/inbox/claimed', { message, turn: followups })
        session.append('turn/end', { turn: followups, reason: { kind: 'completed' } })
      },
      async whenIdle() {},
      cancel() { assert.fail('The borrowed idle Agent must not be canceled') },
    } as unknown as Agent
    detach = registry.enter(agent, undefined)
    registry.setFactory({
      async resume() {
        resumeAttempts += 1
        // The old runner reaches this and fails on the real ownership invariant.
        const duplicate = await persistence.open(id, 'write')
        await duplicate.close()
        assert.fail('An already registered Agent must never be resumed')
      },
      async createAgent() { assert.fail('Pinned execution must not create a new Agent') },
    })
    // Reproduce the old unconditional-resume path against the real lock first.
    await assert.rejects(registry.resume({ resumeSessionId: id }), ownershipError)
    assert.equal(resumeAttempts, 1)
    resumeAttempts = 0
    const ctx = {
      on: runtime.on.bind(runtime),
      effect: runtime.effect.bind(runtime),
      agents: registry,
      get(name: string) { return name === 'sessionPersistence' ? persistence : undefined },
      workspaceRegistry: { get: () => ({ id: 'workspace-test', path: root }) },
      permissionPresets: { set() {} },
      sessions,
    } as unknown as Context
    const configuration = { async validate() {} } as unknown as AgentConfiguration
    const task: AutomationTask = {
      id: 'automation-test', name: 'Water reminder', prompt: 'Drink water.',
      createdAt: '2026-03-20T00:00:00.000Z', createdBySessionId: 'creator', status: 'active',
      schedule: { kind: 'recurring', rrule: 'FREQ=MINUTELY', timeZone: 'UTC', startAt: '2026-03-20T09:00:00' },
      nextRunAt: '2026-03-20T09:01:00.000Z', notificationPolicy: 'failures',
      pauseAfterConsecutiveFailures: false, consecutiveFailures: 0, unreadNotifications: 0,
      execution: { workspaceId: 'workspace-test', cwd: root, skills: [], target: { mode: 'pinned-session', sessionId: id, workspaceId: 'workspace-test', cwd: root, fallback: 'fail' } },
      security: { permissionPreset: 'read-only', source: 'user-confirmed', grantedAt: '2026-03-20T00:00:00.000Z' }, runs: [],
    }
    const runner = new DshAutomationRunner(ctx, configuration)
    for (let occurrence = 1; occurrence <= 2; occurrence += 1) {
      const result = await runner.run(task, {
        id: `run-${occurrence}`, trigger: 'scheduled', status: 'running',
        enqueuedAt: '2026-03-20T09:01:00.000Z', sessionId: id,
        executionTarget: { mode: 'pinned-session', sessionId: id },
      })
      assert.equal(result.status, 'succeeded')
      assert.equal(result.sessionId, id)
      assert.equal(registry.get(id), agent, 'Borrowed Agent remains registered after each run')
      await assert.rejects(persistence.open(id, 'write'), ownershipError)
    }
    assert.equal(followups, 2)
    assert.equal(resumeAttempts, 0)
    const reader = await persistence.open(id, 'read')
    try {
      assert.deepEqual((await reader.read()).events.map((event) => event.type), ['session/end-seed', 'turn/start', 'turn/end', 'turn/start', 'turn/end'])
    } finally { await reader.close() }
    await writer.close()
    const nextOwner = await persistence.open(id, 'write')
    await nextOwner.close()
  } finally {
    detach?.()
    detachSession()
    await writer.close()
  }
})
