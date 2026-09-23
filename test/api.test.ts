import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { AutomationController } from '../src/controller.js'
import { registerAutomationApi } from '../src/api.js'
import { AutomationDomainError } from '../src/domain.js'

type Route = { handler: (req: any, res: any) => Promise<void> }

async function invoke(route: Route, method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  let status = 0
  let text = ''
  const req = {
    method, url, headers: { host: 'localhost', ...headers },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
  }
  const res = { writeHead(value: number) { status = value }, end(value: string) { text = value } }
  await route.handler(req, res)
  return { status, value: JSON.parse(text) }
}

function setup(controller: AutomationController) {
  let route: Route | undefined
  const ctx = { webServer: { register(value: Route) { route = value; return () => { route = undefined } } } } as unknown as Context
  const dispose = registerAutomationApi(ctx, controller)
  return { route: () => route!, dispose }
}

test('run deletion returns precise results and route-specific conflict/not-found errors', async () => {
  const calls: string[][] = []
  let exists = true
  const controller = {
    deleteRun: async (taskId: string, runId: string) => {
      calls.push([taskId, runId])
      if (taskId === 'missing') throw new AutomationDomainError('task_not_found', 'Task not found')
      if (runId === 'active' || runId === 'sending') throw new AutomationDomainError('run_in_progress', 'Run is active')
      if (runId === 'broken') throw new Error('Write failed')
      const deleted = runId === 'run-1' && exists
      if (deleted) exists = false
      return deleted
    },
  } as unknown as AutomationController
  const route = setup(controller).route()
  const headers = { 'x-dsh-automation': '1', origin: 'http://localhost' }
  const remove = (taskId: string, runId: string) => invoke(route, 'DELETE', `/api/automation/v1/tasks/${taskId}/runs/${runId}`, undefined, headers)
  assert.deepEqual(await remove('task-1', 'run%2D1'), { status: 200, value: { deleted: true } })
  for (const id of ['run-1', 'missing', 'foreign']) {
    assert.deepEqual(await remove('task-1', id), { status: 200, value: { deleted: false } })
  }
  assert.deepEqual(await remove('missing', 'run-1'), { status: 404, value: { error: 'Task not found' } })
  for (const id of ['active', 'sending']) {
    assert.deepEqual(await remove('task-1', id), { status: 409, value: { error: 'Run is active' } })
  }
  assert.deepEqual(await remove('task-1', 'broken'), { status: 400, value: { error: 'Write failed' } })
  assert.deepEqual(calls[0], ['task-1', 'run-1'])
})

test('run deletion validates origin, header, method, path, and decoded IDs before delegation', async () => {
  const route = setup({ deleteRun: async () => assert.fail('Invalid requests must not delete a record') } as unknown as AutomationController).route()
  const path = '/api/automation/v1/tasks/task-1/runs/run-1'
  const headers = { 'x-dsh-automation': '1' }
  assert.equal((await invoke(route, 'DELETE', path)).status, 403)
  assert.equal((await invoke(route, 'DELETE', path, undefined, { 'x-dsh-automation': '0' })).status, 403)
  for (const origin of ['https://evil.example', 'null', 'not a URL']) {
    assert.equal((await invoke(route, 'DELETE', path, undefined, { ...headers, origin })).status, 403)
  }
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'HEAD']) {
    assert.equal((await invoke(route, method, path, undefined, headers)).status, 405)
  }
  for (const invalid of ['%', '%2F', '%5C', '%00', '%20', '%252F', 'x'.repeat(257)]) {
    for (const url of [`/api/automation/v1/tasks/${invalid}/runs/run-1`, `/api/automation/v1/tasks/task-1/runs/${invalid}`]) {
      assert.equal((await invoke(route, 'DELETE', url, undefined, headers)).status, 400)
    }
  }
  for (const invalidPath of [
    '/api/automation/v1/tasks//runs/run-1', '/api/automation/v1/tasks/task-1/runs/',
    `${path}/extra`, `${path}/`, '/api/automation/v1/tasks/task-1/runs',
  ]) assert.equal((await invoke(route, 'DELETE', invalidPath, undefined, headers)).status, 404)
})

test('HTTP reasoning options preserve candidate identity and patches preserve null versus omission', async () => {
  const calls: unknown[][] = []
  const controller = {
    get: () => ({ security: { permissionPreset: 'read-only' }, execution: {} }),
    options: async (...args: unknown[]) => { calls.push(args); return {} },
    update: async (_id: string, request: unknown) => request,
  } as unknown as AutomationController
  const route = setup(controller).route()
  for (const query of ['', '?provider=p&model=m', '?provider=&model=']) {
    assert.equal((await invoke(route, 'GET', `/api/automation/v1/tasks/task/options${query}`)).status, 200)
  }
  assert.deepEqual(calls, [['task', undefined, undefined, undefined], ['task', undefined, 'p', 'm'], ['task', undefined, '', '']])
  assert.equal((await invoke(route, 'GET', '/api/automation/v1/tasks/task/options?provider=p')).status, 400)
  const patch = (body: unknown) => invoke(route, 'PATCH', '/api/automation/v1/tasks/task', JSON.stringify(body), { 'x-dsh-automation': '1' })
  for (const effort of [' vendor: auto ', null]) {
    const response = await patch({ execution: { reasoningEffort: effort } })
    assert.equal(response.status, 200)
    assert.deepEqual(response.value.task.execution, { reasoningEffort: effort })
  }
  assert.equal(Object.hasOwn((await patch({ execution: { skills: [] } })).value.task.execution, 'reasoningEffort'), false)
  for (const effort of ['', 2, false, {}]) assert.equal((await patch({ execution: { reasoningEffort: effort } })).status, 400)
})

test('HTTP API lists options and manages automations with confirmation and CSRF enforcement', async () => {
  const calls: string[] = []
  const task = { id: 'task-1', security: { permissionPreset: 'danger-full-access' } }
  const controller = {
    list: () => [task], get: () => task,
    schedulerHealth: () => ({ status: 'healthy', consecutiveFailures: 0 }),
    options: async (_id: string, preset?: string | null) => ({ preset: preset === null ? 'default' : preset ?? 'saved' }),
    markNotificationsRead: async () => { calls.push('read') },
    update: async (id: string, request: any) => { calls.push(`update:${id}`); return { id, ...request } },
    runNow: async (id: string) => { calls.push(`run:${id}`); return { id: 'run-1' } },
    stop: async (id: string) => { calls.push(`stop:${id}`); return { runId: 'run-1', status: 'canceling' } },
    pause: async (id: string) => { calls.push(`pause:${id}`); return { id, status: 'paused' } },
    resume: async (id: string, options: { runNow: boolean }) => { calls.push(`resume:${id}:${options.runNow}`); return { id, status: 'active' } },
    delete: async (id: string) => { calls.push(`delete:${id}`); return id === 'task-1' },
  } as unknown as AutomationController
  const fixture = setup(controller)
  const route = fixture.route()

  assert.deepEqual((await invoke(route, 'GET', '/api/automation/v1/tasks')).value.scheduler, { status: 'healthy', consecutiveFailures: 0 })
  assert.deepEqual((await invoke(route, 'GET', '/api/automation/v1/tasks/task-1/options?agentPreset=')).value, { options: { preset: 'default' } })
  assert.equal((await invoke(route, 'POST', '/api/automation/v1/tasks/task-1/run')).status, 403)

  const headers = { 'x-dsh-automation': '1', 'content-type': 'application/json' }
  assert.equal((await invoke(route, 'POST', '/api/automation/v1/notifications/read', undefined, headers)).status, 200)
  const update = await invoke(route, 'PATCH', '/api/automation/v1/tasks/task-1', JSON.stringify({
    name: 'Updated', permissionPreset: 'workspace-safe', confirmPermissionChange: true,
    execution: { agentPreset: null, provider: null, model: null, skills: ['report'] },
  }), headers)
  assert.equal(update.status, 200)
  assert.deepEqual(update.value.task.execution, { agentPreset: null, provider: null, model: null, skills: ['report'] })
  assert.equal((await invoke(route, 'POST', '/api/automation/v1/tasks/task-1/run', undefined, headers)).status, 202)
  assert.equal((await invoke(route, 'POST', '/api/automation/v1/tasks/task-1/stop', undefined, headers)).status, 202)
  assert.equal((await invoke(route, 'POST', '/api/automation/v1/tasks/task-1/pause', undefined, headers)).status, 200)
  assert.equal((await invoke(route, 'POST', '/api/automation/v1/tasks/task-1/resume', '{"runNow":true}', headers)).status, 200)
  assert.equal((await invoke(route, 'DELETE', '/api/automation/v1/tasks/task-1', undefined, headers)).status, 200)
  assert.deepEqual(calls, ['read', 'update:task-1', 'run:task-1', 'stop:task-1', 'pause:task-1', 'resume:task-1:true', 'delete:task-1'])
  fixture.dispose()
})

test('REST derives target metadata and forwards only explicit boolean confirmation', async () => {
  const task = { security: { permissionPreset: 'read-only' }, execution: { workspaceId: 'w', cwd: '/task' } }
  const controller = { get: () => task, update: async (_id: string, request: unknown) => request } as unknown as AutomationController
  const route = setup(controller).route()
  const headers = { 'x-dsh-automation': '1' }
  const patch = (body: unknown) => invoke(route, 'PATCH', '/api/automation/v1/tasks/task', JSON.stringify(body), headers)
  const pinned = await patch({ execution: { target: { mode: 'pinned-session', sessionId: 's' } }, confirmSessionTargetChange: true })
  assert.equal(pinned.status, 200)
  assert.deepEqual(pinned.value.task.execution, { target: { mode: 'pinned-session', sessionId: 's', workspaceId: 'w', cwd: '/task', fallback: 'fail' }, sessionTargetConfirmed: true })
  const fresh = await patch({ execution: { target: { mode: 'fresh' } }, confirmSessionTargetChange: true })
  assert.deepEqual(fresh.value.task.execution, { target: { mode: 'fresh' }, sessionTargetConfirmed: true })
  const unconfirmed = await patch({ execution: { target: { mode: 'fresh' } } })
  assert.equal(unconfirmed.value.task.execution.sessionTargetConfirmed, undefined)
  for (const body of [
    { execution: { target: { mode: 'fresh', cwd: '/evil' } } },
    { execution: { target: { mode: 'pinned-session', sessionId: '' } } },
    { execution: { target: { mode: 'fresh' } }, confirmSessionTargetChange: 'true' },
    { execution: { target: { mode: 'fresh' }, sessionTargetConfirmed: true } },
  ]) assert.equal((await patch(body)).status, 400)
})

test('delivery discovery and patches expose only explicit saved target configuration', async () => {
  const current = { security: { permissionPreset: 'read-only' }, execution: { workspaceId: 'w', cwd: '/w' } }
  const controller = {
    get: () => current,
    deliveryOptions: async (botId?: string) => ({ available: true, bots: [], targets: botId === 'bot' ? [{ targetId: 'phone', kind: 'user' }] : [] }),
    update: async (_id: string, request: unknown) => request,
  } as unknown as AutomationController
  const route = setup(controller).route()
  const headers = { 'x-dsh-automation': '1' }
  const patch = (body: unknown) => invoke(route, 'PATCH', '/api/automation/v1/tasks/task', JSON.stringify(body), headers)
  const options = await invoke(route, 'GET', '/api/automation/v1/delivery-options?botId=bot')
  assert.equal(options.status, 200)
  assert.deepEqual(options.value.options.targets, [{ targetId: 'phone', kind: 'user' }])
  assert.equal((await invoke(route, 'GET', '/api/automation/v1/delivery-options?botId=')).status, 400)
  assert.equal((await invoke(route, 'GET', '/api/automation/v1/delivery-options', undefined, { origin: 'https://evil.example' })).status, 403)
  assert.deepEqual((await patch({ delivery: { botId: 'bot', targetId: 'phone' }, confirmDeliveryChange: true })).value.task,
    { delivery: { botId: 'bot', targetId: 'phone' }, deliveryChangeConfirmed: true })
  assert.deepEqual((await patch({ delivery: null })).value.task, { delivery: null })
  assert.equal((await patch({ delivery: { botId: 'bot', targetId: 'phone' }, confirmDeliveryChange: false })).value.task.deliveryChangeConfirmed, undefined)
  for (const body of [
    { delivery: { botId: 'bot', targetId: 'phone', route: { chatId: 'forged' } } },
    { delivery: { botId: '', targetId: 'phone' } },
    { delivery: { botId: 'bot' } },
    { delivery: { botId: 'bot', targetId: 'phone' }, confirmDeliveryChange: 'true' },
    { deliveryChangeConfirmed: true },
  ]) assert.equal((await patch(body)).status, 400)
})

test('HTTP API rejects cross-origin, unconfirmed, partial and unknown nested updates', async () => {
  const controller = {
    list: () => [], schedulerHealth: () => ({ status: 'healthy', consecutiveFailures: 0 }),
    get: () => ({ security: { permissionPreset: 'danger-full-access' } }), update: async () => ({}), resume: async () => ({}),
  } as unknown as AutomationController
  const route = setup(controller).route()
  const headers = { 'x-dsh-automation': '1', 'content-type': 'application/json' }
  assert.equal((await invoke(route, 'GET', '/api/automation/v1/tasks', undefined, { origin: 'https://evil.example', host: 'localhost' })).status, 403)
  for (const body of [
    { name: 1 }, { permissionPreset: 'workspace-safe' }, { execution: {} }, { execution: { provider: 'only' } },
    { execution: { skills: [1] } }, { execution: { unknown: true } },
  ]) {
    assert.equal((await invoke(route, 'PATCH', '/api/automation/v1/tasks/task', JSON.stringify(body), headers)).status, 400)
  }
  const pinned = await invoke(route, 'PATCH', '/api/automation/v1/tasks/task', JSON.stringify({
    execution: { target: { mode: 'pinned-session', sessionId: 's', workspaceId: 'w', cwd: '/w', fallback: 'fail' } },
    confirmSessionTargetChange: true,
  }), headers)
  assert.equal(pinned.status, 400)
  assert.equal(pinned.value.error, 'execution.target is invalid.')
  assert.equal((await invoke(route, 'POST', '/api/automation/v1/tasks/task/resume', '{"runNow":"yes"}', headers)).status, 400)
  assert.equal((await invoke(route, 'PUT', '/api/automation/v1/tasks/task', undefined, headers)).status, 405)
  assert.equal((await invoke(route, 'GET', '/api/automation/v1/unknown')).status, 404)
})
