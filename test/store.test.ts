import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AutomationStore, writeJsonAtomic } from '../src/store.js'
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
