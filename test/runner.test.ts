import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { DshAutomationRunner } from '../src/runner.js'
import type { AutomationRun, AutomationTask } from '../src/types.js'

const task: AutomationTask = {
  id: 'automation-test',
  name: 'Daily review',
  prompt: 'Review the project and report findings.',
  createdAt: '2026-03-20T00:00:00.000Z',
  createdBySessionId: 'creator',
  status: 'active',
  schedule: { kind: 'recurring', rrule: 'FREQ=DAILY', timeZone: 'UTC', startAt: '2026-03-20T09:00:00' },
  nextRunAt: '2026-03-20T09:00:00.000Z',
  notificationPolicy: 'failures',
  pauseAfterConsecutiveFailures: false,
  consecutiveFailures: 0,
  unreadNotifications: 0,
  execution: {
    workspaceId: 'workspace-test',
    cwd: '/tmp/workspace',
    agentPreset: 'standard',
    provider: 'provider',
    model: 'model',
    skills: [],
  },
  security: {
    permissionPreset: 'danger-full-access',
    source: 'plugin-default',
    grantedAt: '2026-03-20T00:00:00.000Z',
  },
  runs: [],
}

const run: AutomationRun = {
  id: 'run-test',
  trigger: 'scheduled',
  scheduledAt: '2026-03-20T09:00:00.000Z',
  enqueuedAt: '2026-03-20T09:00:01.000Z',
  startedAt: '2026-03-20T09:00:02.000Z',
  status: 'running',
}

function fakeContext(
  reason: { kind: string; error?: { message: string } } = { kind: 'completed' },
  assistantText?: string,
) {
  const order: string[] = []
  const messages: unknown[] = []
  const createdIds: string[] = []
  let disposed = 0
  const workspace = {
    id: 'workspace-test',
    path: '/tmp/workspace',
    async attachSession() { order.push('attach') },
  }
  const ctx = {
    workspaceRegistry: {
      get: () => workspace,
      create: async () => workspace,
    },
    agentPresets: {
      async mount() { order.push('mount') },
      async resolve(id?: string) { return { id: id ?? 'standard', trust: 'system', path: '/preset' } },
      async standingKeyFor() { return {} },
      serviceFor() { return undefined },
    },
    permissionPresets: {
      set(_session: unknown, preset: string) { order.push(`permission:${preset}`) },
      resolve() { return { sandbox: 'danger-full-access', approval: 'never' } },
    },
    llm: { async resolveCallConfig(config: unknown) { return config } },
    skills: { async get() { return undefined }, async list() { return [] } },
    sessionTitle: {
      rename(_session: unknown, title: string) { order.push(`title:${title}`) },
    },
    sessions: {
      async flush() { order.push('flush') },
    },
    agents: {
      async create(options: { sessionId: string; setup?: (ctx: Context) => Promise<void> }) {
        createdIds.push(options.sessionId)
        await options.setup?.({} as Context)
        const events: Array<Record<string, unknown>> = []
        const session = { events }
        return {
          agent: {
            ctx: {},
            session,
            inject(message: unknown) { order.push('inject'); messages.push(message) },
            followup(message: unknown) {
              order.push('followup')
              messages.push(message)
              if (assistantText !== undefined) {
                events.push({
                  type: 'assistant/message',
                  seq: 1,
                  time: Date.now(),
                  data: {
                    turn: 1,
                    step: 1,
                    message: createAssistantMessage({
                      content: [{ type: 'text', text: assistantText }],
                      source: { provider: 'test', model: 'test' },
                    }),
                  },
                })
              }
              events.push({ type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason } })
            },
            async whenIdle() { order.push('idle') },
          },
          async dispose() { disposed += 1; order.push('dispose') },
        }
      },
    },
  } as unknown as Context
  return { ctx, order, messages, createdIds, disposed: () => disposed, workspace }
}

test('runner keeps a completed session live for immediate sidebar visibility', async () => {
  const fake = fakeContext()
  const runner = new DshAutomationRunner(fake.ctx)
  const result = await runner.run(task, run)
  assert.equal(result.status, 'succeeded')
  assert.match(result.sessionId, /^automation-/)
  assert.deepEqual(fake.createdIds, [result.sessionId])
  assert.equal(fake.disposed(), 0)
  assert.ok(fake.order.indexOf('permission:danger-full-access') < fake.order.indexOf('followup'))
  assert.ok(fake.order.indexOf('attach') < fake.order.indexOf('followup'))
  assert.match(JSON.stringify(fake.messages[0]), /Review the project and report findings/)
  assert.match(fake.order.find((entry) => entry.startsWith('title:')) ?? '', /^title:\[Automation\]/)
})

test('runner applies each task permission preset before execution', async () => {
  const fake = fakeContext()
  await new DshAutomationRunner(fake.ctx).run({
    ...task,
    security: { ...task.security, permissionPreset: 'read-only' },
  }, run)
  assert.ok(fake.order.includes('permission:read-only'))
  assert.match(JSON.stringify(fake.messages[0]), /Permission preset: read-only/)
})

test('runner revalidates then injects selected skills in order before the task prompt', async () => {
  const fake = fakeContext()
  const configured = { ...task, execution: { ...task.execution, skills: ['first', 'second'] }, security: { ...task.security, permissionPreset: 'workspace-safe' } }
  const configuration = {
    async validate() { fake.order.push('validate') },
    async loadSelectedSkills() {
      return ['first', 'second'].map((name) => ({ text: `<skill_content name="${name}">${name}</skill_content>`, source: { kind: 'skill-invocation' as const, name, form: 'instructions' as const } }))
    },
  }
  await new DshAutomationRunner(fake.ctx, configuration as any).run(configured, run)
  assert.deepEqual(fake.order.filter((entry) => ['validate', 'mount', 'permission:workspace-safe', 'inject', 'followup'].includes(entry)), [
    'validate', 'mount', 'permission:workspace-safe', 'inject', 'inject', 'followup',
  ])
  assert.equal((fake.messages[0] as any).source.name, 'first')
  assert.equal((fake.messages[1] as any).source.name, 'second')
})

test('runner cancellation releases a run blocked in configuration validation', async () => {
  const fake = fakeContext()
  const configuration = {
    validate: async () => new Promise<void>(() => undefined),
    async loadSelectedSkills() { return [] },
  }
  const runner = new DshAutomationRunner(fake.ctx, configuration as any)

  const pending = runner.run(task, run)
  await Promise.resolve()
  assert.equal(runner.cancel(run.id, 'timeout'), true)

  await assert.rejects(pending, /canceled before Agent creation/)
})

test('runner cancellation releases a run blocked while loading selected skills', async () => {
  const fake = fakeContext()
  let markLoadingStarted!: () => void
  const loadingStarted = new Promise<void>((resolve) => { markLoadingStarted = resolve })
  const configuration = {
    async validate() {},
    async loadSelectedSkills() {
      markLoadingStarted()
      return new Promise<never>(() => undefined)
    },
  }
  const runner = new DshAutomationRunner(fake.ctx, configuration as any)

  const pending = runner.run(task, run)
  await loadingStarted
  assert.equal(runner.cancel(run.id, 'timeout'), true)

  await assert.rejects(pending, /canceled before Agent creation/)
  assert.equal(fake.messages.length, 0)
})

test('each invocation uses a different session id', async () => {
  const fake = fakeContext()
  const runner = new DshAutomationRunner(fake.ctx)
  const first = await runner.run(task, run)
  const second = await runner.run(task, { ...run, id: 'run-second' })
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(fake.disposed(), 0)
})

test('runner reuses the session id persisted when the run was claimed', async () => {
  const fake = fakeContext()
  const result = await new DshAutomationRunner(fake.ctx).run(task, {
    ...run,
    sessionId: 'automation-persisted',
  })
  assert.equal(result.sessionId, 'automation-persisted')
  assert.deepEqual(fake.createdIds, ['automation-persisted'])
})

test('runner stores a bounded summary from the final assistant message', async () => {
  const fake = fakeContext({ kind: 'completed' }, `  Finished\n\n${'x'.repeat(600)}  `)
  const result = await new DshAutomationRunner(fake.ctx).run(task, run)
  assert.match(result.summary ?? '', /^Finished x+/)
  assert.equal([...(result.summary ?? '')].length, 500)
  assert.ok(result.summary?.endsWith('…'))
})

test('non-completed turn is reported as failed while preserving its session id', async () => {
  const fake = fakeContext({ kind: 'error', error: { message: 'model unavailable' } })
  const result = await new DshAutomationRunner(fake.ctx).run(task, run)
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /model unavailable/)
  assert.match(result.sessionId, /^automation-/)
  assert.equal(fake.disposed(), 0)
})

test('workspace attachment failure still disposes the created Agent', async () => {
  const fake = fakeContext()
  fake.workspace.attachSession = async () => { throw new Error('attach failed') }
  await assert.rejects(() => new DshAutomationRunner(fake.ctx).run(task, run), /attach failed/)
  assert.equal(fake.disposed(), 1)
})

test('cancellation requested during Agent creation prevents execution', async () => {
  const fake = fakeContext()
  const agents = (fake.ctx as any).agents
  const create = agents.create.bind(agents)
  let releaseCreate!: () => void
  let markCreateEntered!: () => void
  const createEntered = new Promise<void>((resolve) => { markCreateEntered = resolve })
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
  agents.create = async (options: unknown) => {
    markCreateEntered()
    await createGate
    return create(options)
  }
  const runner = new DshAutomationRunner(fake.ctx)

  const resultPromise = runner.run(task, run)
  await createEntered
  assert.equal(runner.cancel(run.id, 'manual'), true)
  releaseCreate()
  const result = await resultPromise

  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /before execution: manual/)
  assert.equal(fake.messages.length, 0)
  assert.equal(fake.disposed(), 0)
})

test('active cancellation reaches Agent.cancel and preserves the session', async () => {
  const fake = fakeContext()
  const agents = (fake.ctx as any).agents
  const create = agents.create.bind(agents)
  let markIdleStarted!: () => void
  let releaseIdle!: () => void
  const idleStarted = new Promise<void>((resolve) => { markIdleStarted = resolve })
  const idleGate = new Promise<void>((resolve) => { releaseIdle = resolve })
  agents.create = async (options: unknown) => {
    const handle = await create(options)
    const events = handle.agent.session.events as Array<Record<string, unknown>>
    handle.agent.followup = (message: unknown) => {
      fake.order.push('followup')
      fake.messages.push(message)
    }
    handle.agent.whenIdle = async () => {
      fake.order.push('idle')
      markIdleStarted()
      await idleGate
    }
    handle.agent.cancel = (cause: { kind: string; reason?: string }) => {
      fake.order.push(`cancel:${cause.kind}:${cause.reason}`)
      events.push({ type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'aborted', reason: cause } } })
      releaseIdle()
    }
    return handle
  }
  const runner = new DshAutomationRunner(fake.ctx)

  const resultPromise = runner.run(task, run)
  await idleStarted
  assert.equal(runner.cancel(run.id, 'timeout'), true)
  const result = await resultPromise

  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /aborted/)
  assert.ok(fake.order.includes('cancel:hook:automation_timeout'))
  assert.equal(fake.disposed(), 0)
})
