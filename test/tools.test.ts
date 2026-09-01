import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AutomationController } from '../src/controller.js'
import { registerAutomationTools } from '../src/tools.js'

function setup() {
  const definitions: any[] = []
  let disposed = 0
  const agent = {
    id: 'creator-session',
    session: { header: { cwd: '/tmp/workspace' } },
    options: { provider: 'provider', model: 'model' },
    ctx: {},
  } as unknown as Agent
  const task = {
    id: 'automation-task',
    name: 'Task',
    status: 'active',
    nextRunAt: '2026-03-21T00:00:00.000Z',
    schedule: { kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' },
    runs: [],
  }
  const rootCtx = {
    workspaceRegistry: { create: async () => ({ id: 'workspace', path: '/tmp/workspace' }) },
    agentPresets: { composedPreset: () => 'standard' },
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
  const controller = {
    create: async () => { calls.push('create'); return task },
    update: async () => { calls.push('update'); return task },
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
  const dispose = registerAutomationTools(rootCtx, toolCtx, agent, controller)
  const byName = (name: string) => definitions.find((definition) => definition.name === name)
  const exec = { agent, signal: new AbortController().signal }
  return { definitions, byName, exec, calls, dispose, disposed: () => disposed }
}

test('registers complete Agent management tool surface and disposes it', async () => {
  const fixture = setup()
  assert.deepEqual(fixture.definitions.map((entry) => entry.name).sort(), [
    'automation_create',
    'automation_delete',
    'automation_list',
    'automation_pause',
    'automation_resume',
    'automation_run',
    'automation_update',
  ])
  const created = await fixture.byName('automation_create').execute({
    name: 'Task',
    prompt: 'Do work.',
    once_at: '2026-03-21T00:00:00.000Z',
  }, fixture.exec)
  assert.equal(created.ok, true)
  assert.match(created.message, /danger-full-access/)
  assert.equal((await fixture.byName('automation_list').execute({}, fixture.exec)).tasks.length, 1)
  const run = await fixture.byName('automation_run').execute({ id: 'automation-task' }, fixture.exec)
  assert.deepEqual(run, {
    ok: true,
    id: 'run-manual',
    status: 'queued',
    message: 'Queued manual run run-manual for automation-task.',
  })
  await fixture.byName('automation_update').execute({ id: 'automation-task', prompt: 'Updated work.' }, fixture.exec)
  await fixture.byName('automation_pause').execute({ id: 'automation-task' }, fixture.exec)
  await fixture.byName('automation_resume').execute({ id: 'automation-task', run_now: true }, fixture.exec)
  await fixture.byName('automation_delete').execute({ id: 'automation-task' }, fixture.exec)
  assert.deepEqual(fixture.calls, ['create', 'run', 'update', 'pause', 'resume', 'delete'])
  fixture.dispose()
  assert.equal(fixture.disposed(), 7)
})

test('create rejects mixed or incomplete schedule selectors and wrong agent scope', async () => {
  const fixture = setup()
  const create = fixture.byName('automation_create')
  const incomplete = await create.execute({ name: 'Task', prompt: 'Do work.', rrule: 'FREQ=DAILY' }, fixture.exec)
  assert.equal(incomplete.ok, false)
  assert.match(incomplete.error, /either once_at/)
  const mixed = await create.execute({
    name: 'Task',
    prompt: 'Do work.',
    once_at: '2026-03-21T00:00:00.000Z',
    rrule: 'FREQ=DAILY',
    time_zone: 'UTC',
    start_at: '2026-03-20T09:00:00',
  }, fixture.exec)
  assert.equal(mixed.ok, false)
  const update = fixture.byName('automation_update')
  assert.equal((await update.execute({ id: 'automation-task' }, fixture.exec)).ok, false)
  const incompleteUpdate = await update.execute({ id: 'automation-task', rrule: 'FREQ=DAILY' }, fixture.exec)
  assert.equal(incompleteUpdate.ok, false)
  assert.match(incompleteUpdate.error, /either once_at/)
  const wrongScope = await create.execute({ name: 'Task', prompt: 'Do work.', once_at: '2026-03-21T00:00:00.000Z' }, {
    ...fixture.exec,
    agent: {} as Agent,
  })
  assert.equal(wrongScope.ok, false)
  assert.match(wrongScope.error, /owning agent scope/)
  const busyRun = await fixture.byName('automation_run').execute({ id: 'busy' }, fixture.exec)
  assert.equal(busyRun.ok, false)
  assert.match(busyRun.error, /queued or running run/)
})
