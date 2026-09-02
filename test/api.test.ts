import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { AutomationController } from '../src/controller.js'
import { registerAutomationApi } from '../src/api.js'

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
  assert.equal(pinned.value.error, 'Pinned session target changes are unsupported via REST in MVP.')
  assert.equal((await invoke(route, 'POST', '/api/automation/v1/tasks/task/resume', '{"runNow":"yes"}', headers)).status, 400)
  assert.equal((await invoke(route, 'PUT', '/api/automation/v1/tasks/task', undefined, headers)).status, 405)
  assert.equal((await invoke(route, 'GET', '/api/automation/v1/unknown')).status, 404)
})
