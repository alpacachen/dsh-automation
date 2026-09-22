import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs, { readFile, writeFile } from 'node:fs/promises'
import pathApi, { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
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
  const path = join(directory.path, 'nested space 中文', 'state.json')
  await writeJsonAtomic(path, '{"value":"old"}\n')
  await writeJsonAtomic(path, '{"value":"new"}\n')
  assert.equal(await readFile(path, 'utf8'), '{"value":"new"}\n')
  assert.deepEqual(await fs.readdir(pathApi.dirname(path)), ['state.json'])
})

// Builtin named ESM exports must follow the test doubles and be restored before
// the next test. No filesystem abstraction is needed in the production writer.
function restoreBuiltins(t: TestContext): void {
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

for (const path of [String.raw`C:\Users\Alice\任务 space\state.json`, String.raw`\\server\share\任务 space\state.json`]) {
  test(`temporary file stays beside its Windows destination: ${path}`, async (t) => {
    restoreBuiltins(t)
    for (const key of ['basename', 'dirname', 'join'] as const) t.mock.method(pathApi, key, pathApi.win32[key])
    t.mock.method(fs, 'mkdir', async () => undefined)
    t.mock.method(fs, 'rm', async () => undefined)
    let temporary = ''
    const failure = new Error('stop before filesystem access')
    t.mock.method(fs, 'open', async (file: Parameters<typeof fs.open>[0]) => { temporary = String(file); throw failure })
    syncBuiltinESMExports()
    await assert.rejects(writeJsonAtomic(path, '{}'), (error) => error === failure)
    assert.equal(pathApi.win32.dirname(temporary), pathApi.win32.dirname(path))
    assert.match(pathApi.win32.basename(temporary), /^\.state\.json\.[\da-f-]+\.tmp$/)
  })
}

for (const phase of ['open', 'write', 'sync', 'close', 'rename'] as const) {
  test(`failure before commit (${phase}) preserves disk and memory and cleans temporary files`, async (t) => {
    const directory = await temporaryDirectory()
    t.after(directory.cleanup)
    restoreBuiltins(t)
    const path = join(directory.path, 'state.json')
    const initial = '{"version":1,"revision":0,"tasks":{}}\n'
    await writeFile(path, initial)
    const store = new AutomationStore(path)
    await store.init()
    const failure = Object.assign(new Error(`injected ${phase} failure`), { code: 'EIO' })
    const open = fs.open
    const rename = fs.rename
    let fail = true
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[1] === 'wx' && fail && phase === 'open') throw failure
      const handle = await open(...args)
      if (args[1] === 'wx' && fail) {
        if (phase === 'write') t.mock.method(handle, 'writeFile', async () => { throw failure })
        if (phase === 'sync') t.mock.method(handle, 'sync', async () => { throw failure })
        if (phase === 'close') {
          const close = handle.close.bind(handle)
          t.mock.method(handle, 'close', async () => { await close(); throw failure })
        }
      }
      return handle
    })
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (fail && phase === 'rename') throw failure
      return rename(...args)
    })
    syncBuiltinESMExports()
    await assert.rejects(store.mutate(() => undefined), (error) => error === failure)
    assert.equal(store.snapshot().revision, 0)
    assert.equal(await readFile(path, 'utf8'), initial)
    assert.deepEqual(await fs.readdir(directory.path), ['state.json'])
    fail = false
    await store.mutate(() => undefined)
    assert.equal(store.snapshot().revision, 1)
  })
}

for (const phase of ['open', 'sync', 'close'] as const) {
  test(`directory ${phase} failure after commit warns without leaving stale state`, { skip: process.platform === 'win32' }, async (t) => {
    const directory = await temporaryDirectory()
    t.after(directory.cleanup)
    restoreBuiltins(t)
    const path = join(directory.path, 'state.json')
    const store = new AutomationStore(path)
    await store.init()
    const failure = Object.assign(new Error(`injected directory ${phase} failure`), { code: 'EIO' })
    const open = fs.open
    let fail = true
    let closed = 0
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const isDirectory = args[0] === directory.path && args[1] === 'r'
      if (isDirectory && fail && phase === 'open') throw failure
      const handle = await open(...args)
      if (isDirectory) {
        if (fail && phase === 'sync') t.mock.method(handle, 'sync', async () => { throw failure })
        const close = handle.close.bind(handle)
        t.mock.method(handle, 'close', async () => {
          await close()
          closed += 1
          if (fail && phase === 'close') throw failure
        })
      }
      return handle
    })
    const warning = t.mock.method(process, 'emitWarning', () => undefined)
    syncBuiltinESMExports()
    assert.equal(await store.mutate(() => 'committed'), 'committed')
    assert.equal(store.snapshot().revision, 1)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), store.snapshot())
    assert.equal(warning.mock.callCount(), 1)
    assert.match(String(warning.mock.calls[0]?.arguments[0]), /committed.*crash durability is not guaranteed/)
    assert.deepEqual(warning.mock.calls[0]?.arguments[1], {
      code: 'AUTOMATION_DIRECTORY_SYNC_FAILED', detail: failure.stack,
    })
    assert.equal(closed, phase === 'open' ? 0 : 1)
    fail = false
    await store.mutate((draft) => assert.equal(draft.revision, 1))
    assert.equal(store.snapshot().revision, 2)
    assert.equal(warning.mock.callCount(), 1)
    const reopened = new AutomationStore(path)
    await reopened.init()
    assert.deepEqual(reopened.snapshot(), store.snapshot())
    assert.deepEqual(await fs.readdir(directory.path), ['state.json'])
  })
}

test('Windows still syncs the file but never opens the directory', async (t) => {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  restoreBuiltins(t)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  t.after(() => Object.defineProperty(process, 'platform', platform))
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const path = join(directory.path, 'state.json')
  const open = fs.open
  const opened: unknown[] = []
  let synced = 0
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    opened.push(args[0])
    const handle = await open(...args)
    const sync = handle.sync.bind(handle)
    t.mock.method(handle, 'sync', async () => { await sync(); synced += 1 })
    return handle
  })
  const warning = t.mock.method(process, 'emitWarning', () => undefined)
  syncBuiltinESMExports()
  await writeJsonAtomic(path, '{"value":"committed"}\n')
  assert.equal(opened.includes(directory.path), false, 'Windows must not open a directory for fsync')
  assert.equal(warning.mock.callCount(), 0)
  assert.equal(synced, 1)
  assert.equal(await readFile(path, 'utf8'), '{"value":"committed"}\n')
})
