import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AutomationController } from '../src/controller.js'
import { registerAutomationTools } from '../src/tools.js'
import { unattendedAgents } from '../src/runtime-marker.js'
import { AgentConfiguration } from '../src/agent-configuration.js'

function setup(missingTarget = false) {
  const definitions: any[] = []
  let disposed = 0
  const agent = {
    id: 'creator-session',
    session: { header: { cwd: '/tmp/workspace' }, snapshotEvents: () => [] },
    options: { provider: 'provider', model: 'model' },
    ctx: {},
  } as unknown as Agent
  const task = {
    id: 'automation-task',
    name: 'Task',
    status: 'active',
    nextRunAt: '2026-03-21T00:00:00.000Z',
    schedule: { kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' },
    notificationPolicy: 'failures',
    pauseAfterConsecutiveFailures: false,
    consecutiveFailures: 0,
    unreadNotifications: 0,
    execution: { workspaceId: 'workspace', cwd: '/tmp/workspace', agentPreset: 'standard', provider: 'provider', model: 'model', skills: [] },
    security: { permissionPreset: 'danger-full-access', source: 'plugin-default', grantedAt: '2026-03-20T00:00:00.000Z' },
    runs: [],
  }
  const rootCtx = {
    get(name: string) { return (this as unknown as Record<string, unknown>)[name] },
    workspaceRegistry: { create: async () => ({ id: 'workspace', path: '/tmp/workspace' }) },
    agentPresets: { composedPreset: () => 'standard' },
    sessionPersistence: { stat: async (id: SessionId) => missingTarget ? undefined : ({ header: { id, cwd: '/tmp/workspace' } }) },
  } as unknown as Context
  const toolCtx = {
    tools: {
      register(definition: unknown) {
        definitions.push(definition)
        return () => { disposed += 1 }
      },
    },
  } as unknown as Context
  const calls: string[] = []
  const createRequests: Parameters<AutomationController['create']>[0][] = []
  const updateRequests: Parameters<AutomationController['update']>[1][] = []
  const optionCalls: unknown[][] = []
  const options = { presets: [], models: [], modelFailures: [], permissions: [], skills: [] }
  const controller = {
    options: async (...args: unknown[]) => { optionCalls.push(args); return options },
    create: async (request: Parameters<AutomationController['create']>[0]) => {
      createRequests.push(request)
      calls.push(`create:${request.notificationPolicy}:${request.pauseAfterConsecutiveFailures}:${request.permissionPreset}`)
      return { ...task, notificationPolicy: request.notificationPolicy ?? 'failures', pauseAfterConsecutiveFailures: request.pauseAfterConsecutiveFailures ?? false, security: { ...task.security, permissionPreset: request.permissionPreset } }
    },
    update: async (_id: string, request: Parameters<AutomationController['update']>[1]) => {
      updateRequests.push(request)
      calls.push(`update:${request.notificationPolicy}:${request.pauseAfterConsecutiveFailures}:${request.permissionPreset}`)
      return { ...task, ...request, security: { ...task.security, permissionPreset: request.permissionPreset ?? task.security.permissionPreset } }
    },
    get: () => task,
    list: () => [{ ...task, running: false }],
    delete: async () => { calls.push('delete'); return true },
    pause: async () => { calls.push('pause'); return { ...task, status: 'paused' } },
    resume: async () => { calls.push('resume'); return task },
    runNow: async (id: string) => {
      calls.push('run')
      if (id === 'busy') throw new Error('Automation busy already has a queued or running run.')
      return { id: 'run-manual', status: 'queued' }
    },
  } as unknown as AutomationController
  const agentConfiguration = new AgentConfiguration(rootCtx)
  agentConfiguration.options = async (...args) => { optionCalls.push(args); return options }
  const dispose = registerAutomationTools(rootCtx, toolCtx, agent, controller, agentConfiguration)
  const byName = (name: string) => definitions.find((definition) => definition.name === name)
  const exec = { agent, signal: new AbortController().signal }
  return { definitions, byName, exec, calls, createRequests, updateRequests, optionCalls, rootCtx, controller, dispose, disposed: () => disposed }
}

test('registers complete Agent management tool surface and disposes it', async () => {
  const fixture = setup()
  assert.deepEqual(fixture.definitions.map((entry) => entry.name).sort(), [
    'automation_create',
    'automation_delete',
    'automation_list',
    'automation_options',
    'automation_pause',
    'automation_resume',
    'automation_run',
    'automation_update',
  ])
  const create = fixture.byName('automation_create')
  assert.match(create.description, /Agent preset, provider\/model, ordered selected skills/)
  const created = await create.execute({
    name: 'Task',
    prompt: 'Do work.',
    once_at: '2026-03-21T00:00:00.000Z',
    notification_policy: 'always',
    pause_after_failures: true,
    permission_preset: 'read-only',
    creation_confirmed: true,
  }, fixture.exec)
  assert.equal(created.ok, true)
  assert.match(created.message, /read-only/)
  assert.equal((await fixture.byName('automation_list').execute({}, fixture.exec)).tasks.length, 1)
  const run = await fixture.byName('automation_run').execute({ id: 'automation-task' }, fixture.exec)
  assert.deepEqual(run, {
    ok: true,
    id: 'run-manual',
    status: 'queued',
    message: 'Queued manual run run-manual for automation-task.',
  })
  await fixture.byName('automation_update').execute({ id: 'automation-task', prompt: 'Updated work.', notification_policy: 'never', pause_after_failures: false, permission_preset: 'read-only', permission_confirmed: true }, fixture.exec)
  await fixture.byName('automation_pause').execute({ id: 'automation-task' }, fixture.exec)
  await fixture.byName('automation_resume').execute({ id: 'automation-task', run_now: true }, fixture.exec)
  await fixture.byName('automation_delete').execute({ id: 'automation-task' }, fixture.exec)
  assert.deepEqual(fixture.calls, ['create:always:true:read-only', 'run', 'update:never:false:read-only', 'pause', 'resume', 'delete'])
  fixture.dispose()
  assert.equal(fixture.disposed(), 8)
})

test('a borrowed Agent cannot use existing automation tools until its unattended run ends', async () => {
  const fixture = setup()
  unattendedAgents.add(fixture.exec.agent)
  try {
    for (const tool of fixture.definitions) {
      const args = tool.name === 'automation_create'
        ? { name: 'Task', prompt: 'Do work.', permission_preset: 'read-only', creation_confirmed: true, once_at: '2026-03-21T00:00:00.000Z' }
        : { id: 'automation-task' }
      const result = await tool.execute(args, fixture.exec)
      assert.equal(result.ok, false, tool.name)
      assert.match(result.error, /unavailable during an unattended run/, tool.name)
    }
    assert.deepEqual(fixture.calls, [])
  } finally { unattendedAgents.delete(fixture.exec.agent) }
  assert.equal((await fixture.byName('automation_run').execute({ id: 'automation-task' }, fixture.exec)).ok, true)
  fixture.dispose()
})

test('create rejects mixed or incomplete schedule selectors and wrong agent scope', async () => {
  const fixture = setup()
  const create = fixture.byName('automation_create')
  const confirmed = { permission_preset: 'read-only', creation_confirmed: true }
  const incomplete = await create.execute({ name: 'Task', prompt: 'Do work.', rrule: 'FREQ=DAILY', ...confirmed }, fixture.exec)
  assert.equal(incomplete.ok, false)
  assert.match(incomplete.error, /either once_at/)
  const mixed = await create.execute({
    name: 'Task',
    prompt: 'Do work.',
    once_at: '2026-03-21T00:00:00.000Z',
    rrule: 'FREQ=DAILY',
    time_zone: 'UTC',
    start_at: '2026-03-20T09:00:00',
    ...confirmed,
  }, fixture.exec)
  assert.equal(mixed.ok, false)
  const update = fixture.byName('automation_update')
  assert.equal((await update.execute({ id: 'automation-task' }, fixture.exec)).ok, false)
  const incompleteUpdate = await update.execute({ id: 'automation-task', rrule: 'FREQ=DAILY' }, fixture.exec)
  assert.equal(incompleteUpdate.ok, false)
  assert.match(incompleteUpdate.error, /either once_at/)
  const unconfirmed = await create.execute({ name: 'Task', prompt: 'Do work.', once_at: '2026-03-21T00:00:00.000Z', permission_preset: 'danger-full-access', creation_confirmed: false }, fixture.exec)
  assert.equal(unconfirmed.ok, false)
  assert.match(unconfirmed.error, /confirmation/)
  const unconfirmedUpdate = await update.execute({ id: 'automation-task', permission_preset: 'read-only' }, fixture.exec)
  assert.equal(unconfirmedUpdate.ok, false)
  assert.match(unconfirmedUpdate.error, /confirmation/)
  const wrongScope = await create.execute({ name: 'Task', prompt: 'Do work.', once_at: '2026-03-21T00:00:00.000Z', ...confirmed }, {
    ...fixture.exec,
    agent: {} as Agent,
  })
  assert.equal(wrongScope.ok, false)
  assert.match(wrongScope.error, /owning agent scope/)
  const busyRun = await fixture.byName('automation_run').execute({ id: 'busy' }, fixture.exec)
  assert.equal(busyRun.ok, false)
  assert.match(busyRun.error, /queued or running run/)
})

test('pinned create requires durable target confirmation and update rejects target mutation', async () => {
  const fixture = setup()
  const create = fixture.byName('automation_create')
  const result = await create.execute({
    name: 'Pinned', prompt: 'Continue.', once_at: '2026-03-21T00:00:00.000Z',
    permission_preset: 'read-only', execution_mode: 'pinned-session', target_session_id: 'target',
    session_target_confirmed: true, creation_confirmed: true,
  }, fixture.exec)
  assert.equal(result.ok, true)
  const missing = setup(true)
  const rejected = await missing.byName('automation_create').execute({
    name: 'Pinned', prompt: 'Continue.', once_at: '2026-03-21T00:00:00.000Z',
    permission_preset: 'read-only', execution_mode: 'pinned-session', target_session_id: 'missing',
    session_target_confirmed: true, creation_confirmed: true,
  }, missing.exec)
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /pinned session could not be resolved/)
  assert.equal(missing.calls.length, 0)
  const definition = fixture.byName('automation_update')
  for (const key of ['execution_mode', 'target_session_id', 'session_target_confirmed']) assert.equal(Object.hasOwn(definition.parameters, key), false)
  for (const injection of [{ execution_mode: 'fresh' }, { target_session_id: 'other' }, { session_target_confirmed: true }, { execution: { target: { mode: 'fresh' } } }]) {
    const update = await definition.execute({ id: 'automation-task', name: 'Changed', ...injection }, fixture.exec)
    assert.equal(update.ok, false)
    assert.match(update.error, /target changes are unsupported/)
  }
  for (const key of ['delivery', 'confirmDeliveryChange', 'deliveryChangeConfirmed']) {
    assert.equal(Object.hasOwn(definition.parameters, key), false)
    const update = await definition.execute({ id: 'automation-task', name: 'Changed', [key]: true }, fixture.exec)
    assert.equal(update.ok, false)
    assert.match(update.error, /Message delivery changes are manual-only/)
  }
  assert.equal(fixture.calls.some((call) => call.startsWith('update:')), false)
})

const createArgs = {
  name: 'Task', prompt: 'Do work.', permission_preset: 'read-only',
  creation_confirmed: true, once_at: '2026-03-21T00:00:00.000Z',
}

test('reasoning tools forward exact selections, clear with null, and never capture the creator effort', async () => {
  const fixture = setup()
  Object.assign(fixture.exec.agent.options, { reasoningEffort: 'creator-high' })
  const create = fixture.byName('automation_create')
  assert.ok(create.parameters.properties.reasoning_effort)
  assert.equal((await create.execute(createArgs, fixture.exec)).ok, true)
  assert.equal(Object.hasOwn(fixture.createRequests[0]!.execution, 'reasoningEffort'), false)
  assert.equal((await create.execute({ ...createArgs, provider: 'p', model: 'm', reasoning_effort: ' vendor: auto ' }, fixture.exec)).ok, true)
  assert.equal(fixture.createRequests[1]!.execution.reasoningEffort, ' vendor: auto ')
  const update = fixture.byName('automation_update')
  for (const effort of ['off', null]) assert.equal((await update.execute({ id: 'task', reasoning_effort: effort }, fixture.exec)).ok, true)
  assert.deepEqual(fixture.updateRequests, [{ execution: { reasoningEffort: 'off' } }, { execution: { reasoningEffort: null } }])
  const options = fixture.byName('automation_options')
  assert.equal((await options.execute({ provider: 'p', model: 'm' }, fixture.exec)).ok, true)
  assert.equal((await options.execute({ id: 'task', provider: 'p', model: 'm' }, fixture.exec)).ok, true)
  assert.equal((await options.execute({ id: 'task', provider: '', model: '' }, fixture.exec)).ok, true)
  assert.equal((await options.execute({ provider: 'p' }, fixture.exec)).ok, false)
  assert.deepEqual(fixture.optionCalls, [['/tmp/workspace', 'standard', 'p', 'm'], ['task', undefined, 'p', 'm'], ['task', undefined, '', '']])
})

test('every tool rejects missing or foreign owner before side effects', async () => {
  const fixture = setup()
  for (const tool of fixture.definitions) {
    for (const agent of [undefined, {}]) {
      const args = tool.name === 'automation_create' ? createArgs : { id: 'task' }
      assert.deepEqual(await tool.execute(args, { ...fixture.exec, agent }), {
        ok: false, error: `${tool.name} must run in its owning agent scope.`,
      })
    }
  }
  assert.deepEqual(fixture.calls, [])
  assert.deepEqual(fixture.optionCalls, [])
})

test('guard envelopes synchronous throws, asynchronous rejections, and missing deletes', async () => {
  const fixture = setup()
  fixture.controller.list = () => { throw new Error('list failed') }
  fixture.controller.runNow = async () => { throw 'run failed' }
  fixture.controller.delete = async () => false
  for (const [name, error] of [
    ['automation_list', 'list failed'], ['automation_run', 'run failed'],
    ['automation_delete', 'Automation missing was not found.'],
  ] as const) {
    const tool = fixture.byName(name)
    const result = await tool.execute({ id: 'missing' }, fixture.exec)
    assert.deepEqual(result, { ok: false, error })
    assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: JSON.stringify(result) }])
  }
})

test('options preserves omitted, explicit, and Host-default preset selection and workspace guards', async () => {
  const fixture = setup()
  const tool = fixture.byName('automation_options')
  for (const args of [{}, { agent_preset: '' }, { agent_preset: 'custom' }, { id: 'task' }, { id: 'task', agent_preset: '' }, { id: 'task', agent_preset: 'custom' }]) {
    assert.equal((await tool.execute(args, fixture.exec)).ok, true)
  }
  assert.deepEqual(fixture.optionCalls, [
    ['/tmp/workspace', 'standard', undefined, undefined], ['/tmp/workspace', undefined, undefined, undefined], ['/tmp/workspace', 'custom', undefined, undefined],
    ['task', undefined, undefined, undefined], ['task', null, undefined, undefined], ['task', 'custom', undefined, undefined],
  ])
  Object.defineProperty(fixture.exec.agent.session.header, 'cwd', { value: undefined })
  for (const [name, args] of [['automation_options', {}], ['automation_create', createArgs]] as const) {
    assert.deepEqual(await fixture.byName(name).execute(args, fixture.exec), {
      ok: false, error: 'The current session has no workspace directory.',
    })
  }
  assert.equal((await tool.execute({ id: 'task' }, fixture.exec)).ok, true)
  assert.deepEqual(fixture.calls, [])
})

test('create captures one preset value, omits unavailable defaults, and validates schedule selectors', async () => {
  const fixture = setup()
  let presetReads = 0
  fixture.rootCtx.agentPresets.composedPreset = () => { presetReads += 1; return undefined }
  assert.equal((await fixture.byName('automation_create').execute(createArgs, fixture.exec)).ok, true)
  assert.equal(presetReads, 1)
  assert.equal(Object.hasOwn(fixture.createRequests[0]?.execution ?? {}, 'agentPreset'), false)
  assert.deepEqual(fixture.createRequests[0]?.execution.target, { mode: 'fresh' })
  const selectors = { once_at: createArgs.once_at, rrule: 'FREQ=DAILY', time_zone: 'UTC', start_at: '2026-03-20T09:00:00' }
  for (let mask = 0; mask < 16; mask += 1) {
    const schedule = Object.fromEntries(Object.entries(selectors).filter((_, index) => (mask & (1 << index)) !== 0))
    const { once_at: _onceAt, ...confirmed } = createArgs
    const result = await fixture.byName('automation_create').execute({ ...confirmed, ...schedule }, fixture.exec)
    assert.equal(result.ok, mask === 1 || mask === 14, `selector mask ${mask}`)
    if (!result.ok) assert.match(result.error, /either once_at/)
  }
  assert.deepEqual(fixture.createRequests.at(-1)?.schedule, { kind: 'recurring', rrule: 'FREQ=DAILY', timeZone: 'UTC', startAt: '2026-03-20T09:00:00' })
  await assert.rejects(fixture.byName('automation_create').execute({ ...createArgs, once_at: 123 }, fixture.exec), /invalid arguments/)
})

test('pinned creation checks target, confirmation, persistence identity, and workspace', async () => {
  for (const [overrides, persistence, error] of [
    [{}, undefined, /target_session_id is required/],
    [{ target_session_id: 'target' }, undefined, /confirmation is required for a pinned/],
    [{ target_session_id: 'target', session_target_confirmed: true }, undefined, /inspection is unavailable/],
    [{ target_session_id: 'target', session_target_confirmed: true }, { stat: async () => ({ header: { id: 'wrong', cwd: '/tmp/workspace' } }) }, /could not be resolved/],
    [{ target_session_id: 'target', session_target_confirmed: true }, { stat: async () => ({ header: { id: 'target', cwd: '/other' } }) }, /cwd does not match/],
  ] as const) {
    const fixture = setup()
    Object.defineProperty(fixture.rootCtx, 'sessionPersistence', { value: persistence })
    const result = await fixture.byName('automation_create').execute({ ...createArgs, execution_mode: 'pinned-session', ...overrides }, fixture.exec)
    assert.equal(result.ok, false)
    assert.match(result.error, error)
    assert.deepEqual(fixture.createRequests, [])
  }
})

test('update preserves omission versus null, false, empty skills, and permission confirmations', async () => {
  const fixture = setup()
  const update = fixture.byName('automation_update')
  for (const args of [
    { name: 'Changed' },
    { agent_preset: null, provider: null, model: null, skills: [], pause_after_failures: false },
    { agent_preset: 'custom', provider: 'p', model: 'm', skills: ['second', 'first'] },
    { permission_preset: 'danger-full-access' },
    { permission_preset: 'read-only', permission_confirmed: true },
  ]) assert.equal((await update.execute({ id: 'task', ...args }, fixture.exec)).ok, true)
  assert.deepEqual(fixture.updateRequests, [
    { name: 'Changed' },
    { execution: { agentPreset: null, provider: null, model: null, skills: [] }, pauseAfterConsecutiveFailures: false },
    { execution: { agentPreset: 'custom', provider: 'p', model: 'm', skills: ['second', 'first'] } },
    { permissionPreset: 'danger-full-access' },
    { permissionPreset: 'read-only', permissionChangeConfirmed: true },
  ])
})
