import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AutomationStore, writeJsonAtomic } from '../src/store.js'
import { AutomationRunSchema } from '../src/types.js'
import { temporaryDirectory } from './helpers.js'

test('missing state starts empty and survives atomic reopen', async (t) => {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const path = join(directory.path, 'automation', 'state.json')
  const store = new AutomationStore(path)
  await store.init()
  assert.deepEqual(store.snapshot(), { version: 1, revision: 0, tasks: {} })
  await store.mutate((state) => {
    assert.equal(state.revision, 0)
  })
  assert.equal(store.snapshot().revision, 1)
  const reopened = new AutomationStore(path)
  await reopened.init()
  assert.deepEqual(reopened.snapshot(), store.snapshot())
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1)
})

test('run records from v0.3.5 remain valid without a summary', () => {
  const run = {
    id: 'run-old',
    trigger: 'manual' as const,
    enqueuedAt: '2026-03-20T00:00:00.000Z',
    finishedAt: '2026-03-20T00:01:00.000Z',
    status: 'interrupted' as const,
    error: 'DSH stopped while this automation run was active.',
  }
  assert.deepEqual(AutomationRunSchema.parse(run), run)
})

test('legacy tasks gain skills in memory without startup rewrite', async (t) => {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const path = join(directory.path, 'state.json')
  const legacy = {
    version: 1, revision: 4, tasks: {
      old: {
        id: 'old', name: 'Old', prompt: 'Run.', createdAt: '2026-03-20T00:00:00.000Z', createdBySessionId: 'creator', status: 'active',
        schedule: { kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }, nextRunAt: '2026-03-21T00:00:00.000Z',
        execution: { workspaceId: 'workspace', cwd: '/tmp/workspace', agentPreset: 'standard' },
        security: { permissionPreset: 'read-only', source: 'plugin-default', grantedAt: '2026-03-20T00:00:00.000Z' }, runs: [{ id: 'old-run', trigger: 'manual', enqueuedAt: '2026-03-20T00:00:00.000Z', status: 'succeeded' }],
      },
    },
  }
  const original = `${JSON.stringify(legacy, null, 2)}\n`
  await writeFile(path, original)
  const store = new AutomationStore(path)
  await store.init()
  assert.deepEqual(store.snapshot().tasks.old?.execution.skills, [])
  assert.deepEqual(store.snapshot().tasks.old?.execution.target, { mode: 'fresh' })
  assert.deepEqual(store.snapshot().tasks.old?.runs[0]?.executionTarget, { mode: 'fresh' })
  assert.equal(await readFile(path, 'utf8'), original)
  await store.mutate(() => undefined)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).tasks.old.execution.skills, [])
})

test('corrupt JSON and unsupported state versions fail closed without overwrite', async (t) => {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const path = join(directory.path, 'state.json')
  for (const content of ['{"version":', '{"version":2,"revision":0,"tasks":{}}']) {
    await writeFile(path, content)
    const store = new AutomationStore(path)
    await assert.rejects(() => store.init(), /Automation state/)
    assert.equal(await readFile(path, 'utf8'), content)
  }
})

test('failed atomic writer does not publish draft in memory or on disk', async (t) => {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const path = join(directory.path, 'state.json')
  const store = new AutomationStore(path, async () => {
    throw new Error('injected write failure')
  })
  await store.init()
  await assert.rejects(() => store.mutate(() => undefined), /injected write failure/)
  assert.equal(store.snapshot().revision, 0)
  await assert.rejects(() => readFile(path, 'utf8'), { code: 'ENOENT' })
})

test('mutations are serialized in invocation order', async (t) => {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const store = new AutomationStore(join(directory.path, 'state.json'))
  await store.init()
  const observed: number[] = []
  await Promise.all([
    store.mutate(async (state) => {
      observed.push(state.revision)
      await Promise.resolve()
    }),
    store.mutate((state) => {
      observed.push(state.revision)
    }),
    store.mutate((state) => {
      observed.push(state.revision)
    }),
  ])
  assert.deepEqual(observed, [0, 1, 2])
  assert.equal(store.snapshot().revision, 3)
})

test('writeJsonAtomic replaces complete documents and creates parent directories', async (t) => {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const path = join(directory.path, 'nested', 'state.json')
  await writeJsonAtomic(path, '{"value":"old"}\n')
  await writeJsonAtomic(path, '{"value":"new"}\n')
  assert.equal(await readFile(path, 'utf8'), '{"value":"new"}\n')
})
