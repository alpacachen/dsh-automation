import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AutomationController, validatePersistedSessionTarget } from '../src/controller.js'
import { AutomationDomain } from '../src/domain.js'
import { AutomationStore } from '../src/store.js'
import type { AutomationScheduler } from '../src/scheduler.js'
import type { AgentConfiguration } from '../src/agent-configuration.js'
import { createRequest, temporaryDirectory } from './helpers.js'

const now = Date.parse('2026-03-20T00:00:00.000Z')

async function setup(t: test.TestContext) {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const domain = new AutomationDomain(new AutomationStore(join(directory.path, 'state.json')))
  await domain.init(now)
  const task = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }), now)
  const meta = { id: 'target', cwd: task.execution.cwd, origin: undefined as 'subagent' | undefined }
  const workspace = { path: task.execution.cwd, sessionIds: ['target', 'other'] }
  const archived: string[] = []
  let missing = false
  const services = {
    sessionPersistence: { stat: async () => missing ? undefined : { header: meta } },
    workspaceRegistry: { get: () => workspace, archivedSessionIds: archived },
  }
  const ctx = { get: (key: keyof typeof services) => services[key] } as unknown as Context
  const validations: Parameters<AgentConfiguration['validate']>[0][] = []
  const configuration = { validate: async (execution: Parameters<AgentConfiguration['validate']>[0]) => { validations.push(execution) } } as unknown as AgentConfiguration
  const controller = new AutomationController(domain, { requestDrive() {} } as AutomationScheduler, () => now, configuration,
    (current, id) => validatePersistedSessionTarget(ctx, current, id))
  const target = { mode: 'pinned-session' as const, sessionId: 'target', workspaceId: task.execution.workspaceId, cwd: task.execution.cwd, fallback: 'fail' as const }
  return { controller, domain, task, target, meta, workspace, archived, validations, setMissing: () => { missing = true } }
}

test('manual target save validates persistence, resumes configuration, and resets to fresh', async (t) => {
  const f = await setup(t)
  await assert.rejects(f.controller.update(f.task.id, { execution: { target: f.target } }), /confirmation/)
  await f.controller.update(f.task.id, { execution: { target: f.target, sessionTargetConfirmed: true } })
  assert.deepEqual(f.domain.get(f.task.id).execution.target, f.target)
  assert.equal(f.validations.at(-1)?.agentPreset, undefined)
  assert.equal(f.validations.at(-1)?.provider, undefined)
  assert.deepEqual(f.validations.at(-1)?.skills, [])
  await assert.rejects(f.controller.update(f.task.id, { execution: { target: { mode: 'fresh' } } }), /confirmation/)
  await f.controller.update(f.task.id, { execution: { target: { mode: 'fresh' }, sessionTargetConfirmed: true } })
  assert.deepEqual(f.domain.get(f.task.id).execution.target, { mode: 'fresh' })
  assert.equal(f.validations.at(-1)?.agentPreset, f.task.execution.agentPreset)
})

test('save rejects missing, wrong-workspace, nonmember, archived and subagent sessions', async (t) => {
  for (const kind of ['missing', 'cwd', 'membership', 'archived', 'subagent', 'id', 'workspacePath'] as const) {
    await t.test(kind, async (t) => {
      const f = await setup(t)
      if (kind === 'missing') f.setMissing()
      if (kind === 'cwd') f.meta.cwd = '/other'
      if (kind === 'membership') f.workspace.sessionIds = []
      if (kind === 'archived') f.archived.push('target')
      if (kind === 'subagent') f.meta.origin = 'subagent'
      if (kind === 'id') f.meta.id = 'other'
      if (kind === 'workspacePath') f.workspace.path = '/other'
      await assert.rejects(f.controller.update(f.task.id, { execution: { target: f.target, sessionTargetConfirmed: true } }), /target_(session|workspace)/)
      assert.deepEqual(f.domain.get(f.task.id).execution.target, { mode: 'fresh' })
    })
  }
})

test('atomic domain guard rejects mode and session changes while queued/running but allows no-ops', async (t) => {
  const f = await setup(t)
  await f.controller.update(f.task.id, { execution: { target: f.target, sessionTargetConfirmed: true } })
  await f.domain.runNow(f.task.id, now)
  for (const state of ['queued', 'running']) {
    for (const target of [{ mode: 'fresh' as const }, { ...f.target, sessionId: 'other' }]) {
      await assert.rejects(f.domain.update(f.task.id, { name: 'Must not persist', execution: { target, sessionTargetConfirmed: true } }, now), /queued or running/)
    }
    await f.controller.update(f.task.id, { name: state, execution: { target: f.target } })
    assert.equal(f.domain.get(f.task.id).name, state)
    assert.deepEqual(f.domain.get(f.task.id).execution.target, f.target)
    if (state === 'queued') await f.domain.takeNextQueued(now)
  }
})

test('target changes fail closed without persistence validation and reject forged workspace metadata', async (t) => {
  const f = await setup(t)
  const controller = new AutomationController(f.domain, { requestDrive() {} } as AutomationScheduler, () => now)
  await assert.rejects(controller.update(f.task.id, { execution: { target: f.target, sessionTargetConfirmed: true } }), /validation is unavailable/)
  await assert.rejects(f.controller.update(f.task.id, { execution: { target: { ...f.target, cwd: '/forged' }, sessionTargetConfirmed: true } }), /workspace and cwd/)
})
