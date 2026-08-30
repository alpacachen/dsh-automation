import test from 'node:test'
import assert from 'node:assert/strict'
import type { AutomationDomain } from '../src/domain.js'
import type { AutomationScheduler } from '../src/scheduler.js'
import { AutomationController } from '../src/controller.js'
import { createRequest } from './helpers.js'

const task = { id: 'task', status: 'active' }
const run = { id: 'run', status: 'queued' }

test('controller delegates mutations and requests scheduler recomputation', async () => {
  const calls: string[] = []
  const domain = {
    list: () => [task],
    get: (id: string) => ({ ...task, id }),
    create: async (_request: unknown, now: number) => { calls.push(`create:${now}`); return task },
    delete: async (id: string) => { calls.push(`delete:${id}`); return true },
    pause: async (id: string, now: number) => { calls.push(`pause:${id}:${now}`); return task },
    resume: async (id: string, options: { runNow: boolean }, now: number) => { calls.push(`resume:${id}:${options.runNow}:${now}`); return task },
    runNow: async (id: string, now: number) => { calls.push(`run:${id}:${now}`); return run },
  } as unknown as AutomationDomain
  const scheduler = { requestDrive: () => calls.push('drive') } as unknown as AutomationScheduler
  const controller = new AutomationController(domain, scheduler, () => 123)

  assert.deepEqual(controller.list(), [task])
  assert.equal(controller.get('other').id, 'other')
  await controller.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }))
  await controller.pause('task')
  await controller.resume('task', { runNow: true })
  await controller.runNow('task')
  assert.equal(await controller.delete('task'), true)
  assert.deepEqual(calls, [
    'create:123', 'drive',
    'pause:task:123', 'drive',
    'resume:task:true:123', 'drive',
    'run:task:123', 'drive',
    'delete:task', 'drive',
  ])
})

test('controller does not wake scheduler for idempotent delete miss', async () => {
  let drives = 0
  const domain = { delete: async () => false } as unknown as AutomationDomain
  const scheduler = { requestDrive: () => { drives += 1 } } as unknown as AutomationScheduler
  const controller = new AutomationController(domain, scheduler)
  assert.equal(await controller.delete('missing'), false)
  assert.equal(drives, 0)
})
