import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { AutomationController } from '../src/controller.js'
import { registerAutomationApi } from '../src/api.js'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

test('HTTP API lists and manages automations with CSRF header enforcement', async (t) => {
  let route: { handler: (req: any, res: any) => unknown } | undefined
  const calls: string[] = []
  const controller = {
    list: () => [{ id: 'task-1' }],
    runNow: async (id: string) => { calls.push(`run:${id}`); return { id: 'run-1' } },
    pause: async (id: string) => { calls.push(`pause:${id}`); return { id, status: 'paused' } },
    resume: async (id: string, options: { runNow: boolean }) => { calls.push(`resume:${id}:${options.runNow}`); return { id, status: 'active' } },
    delete: async (id: string) => { calls.push(`delete:${id}`); return id === 'task-1' },
  } as unknown as AutomationController
  const ctx = {
    webServer: {
      register(value: typeof route) { route = value; return () => { route = undefined } },
    },
  } as unknown as Context
  const dispose = registerAutomationApi(ctx, controller)
  const server = createServer((req, res) => { void route!.handler(req, res) })
  t.after(async () => {
    dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const base = await listen(server)

  const listed = await fetch(`${base}/api/automation/v1/tasks`)
  assert.equal(listed.status, 200)
  assert.deepEqual(await listed.json(), { tasks: [{ id: 'task-1' }] })

  const denied = await fetch(`${base}/api/automation/v1/tasks/task-1/run`, { method: 'POST' })
  assert.equal(denied.status, 403)

  const headers = { 'x-dsh-automation': '1', 'content-type': 'application/json' }
  assert.equal((await fetch(`${base}/api/automation/v1/tasks/task-1/run`, { method: 'POST', headers })).status, 202)
  assert.equal((await fetch(`${base}/api/automation/v1/tasks/task-1/pause`, { method: 'POST', headers })).status, 200)
  assert.equal((await fetch(`${base}/api/automation/v1/tasks/task-1/resume`, { method: 'POST', headers, body: '{"runNow":true}' })).status, 200)
  assert.equal((await fetch(`${base}/api/automation/v1/tasks/task-1`, { method: 'DELETE', headers })).status, 200)
  assert.deepEqual(calls, ['run:task-1', 'pause:task-1', 'resume:task-1:true', 'delete:task-1'])
})

test('HTTP API rejects cross-origin, invalid bodies, methods and unknown routes', async (t) => {
  let route: { handler: (req: any, res: any) => unknown } | undefined
  const ctx = {
    webServer: { register(value: typeof route) { route = value; return () => undefined } },
  } as unknown as Context
  const controller = {
    list: () => [],
    resume: async () => ({ id: 'task', status: 'active' }),
  } as unknown as AutomationController
  registerAutomationApi(ctx, controller)
  const server = createServer((req, res) => { void route!.handler(req, res) })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = await listen(server)

  const crossOrigin = await fetch(`${base}/api/automation/v1/tasks`, { headers: { origin: 'https://evil.example' } })
  assert.equal(crossOrigin.status, 403)
  const headers = { 'x-dsh-automation': '1', 'content-type': 'application/json' }
  assert.equal((await fetch(`${base}/api/automation/v1/tasks/task/resume`, { method: 'POST', headers, body: '{"runNow":"yes"}' })).status, 400)
  assert.equal((await fetch(`${base}/api/automation/v1/tasks/task`, { method: 'PATCH', headers })).status, 405)
  assert.equal((await fetch(`${base}/api/automation/v1/unknown`, { headers })).status, 404)
})
