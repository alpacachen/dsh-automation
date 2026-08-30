import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AutomationDomain } from '../src/domain.js'
import { AutomationStore } from '../src/store.js'
import { AutomationScheduler, MAX_TIMER_DELAY_MS, type AutomationRunner, type Clock } from '../src/scheduler.js'
import type { AutomationRun, AutomationTask } from '../src/types.js'
import { createRequest, flushAsync, temporaryDirectory } from './helpers.js'

interface FakeTimer {
  readonly callback: () => void
  readonly at: number
  cancelled: boolean
}

class FakeClock implements Clock {
  readonly timers: FakeTimer[] = []
  constructor(private value: number) {}
  now(): number { return this.value }
  setTimeout(callback: () => void, delay: number): () => void {
    const timer = { callback, at: this.value + delay, cancelled: false }
    this.timers.push(timer)
    return () => { timer.cancelled = true }
  }
  active(): FakeTimer[] { return this.timers.filter((timer) => !timer.cancelled && timer.at >= this.value) }
  async advanceTo(target: number): Promise<void> {
    while (true) {
      const next = this.active().filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0]
      if (next === undefined) break
      this.value = next.at
      next.cancelled = true
      next.callback()
      await flushAsync()
    }
    this.value = target
    await flushAsync()
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    if (predicate()) return
    await flushAsync()
  }
  throw new Error('Condition did not settle.')
}

class RecordingRunner implements AutomationRunner {
  readonly calls: Array<{ task: AutomationTask; run: AutomationRun }> = []
  async run(task: AutomationTask, run: AutomationRun) {
    this.calls.push({ task, run })
    return { status: 'succeeded' as const, sessionId: `session-${run.id}` }
  }
}

async function setup(t: test.TestContext, now: number) {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const domain = new AutomationDomain(new AutomationStore(join(directory.path, 'state.json')))
  await domain.init(now)
  return domain
}

test('scheduler arms one timer and executes one-time task once', async (t) => {
  const now = Date.parse('2026-03-20T00:00:00.000Z')
  const domain = await setup(t, now)
  const task = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-20T01:00:00.000Z' }), now)
  const clock = new FakeClock(now)
  const runner = new RecordingRunner()
  const scheduler = new AutomationScheduler(domain, runner, clock)
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(clock.active().length, 1)
  assert.equal(clock.active()[0]?.at, Date.parse('2026-03-20T01:00:00.000Z'))
  await clock.advanceTo(Date.parse('2026-03-20T01:00:00.000Z'))
  await scheduler.whenSettled()
  assert.equal(runner.calls.length, 1)
  assert.equal(domain.get(task.id).runs.at(-1)?.status, 'succeeded')
  await clock.advanceTo(Date.parse('2026-03-21T00:00:00.000Z'))
  assert.equal(runner.calls.length, 1)
  await scheduler.stop()
})

test('far future targets use bounded timer segments', async (t) => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const domain = await setup(t, now)
  await domain.create(createRequest({ kind: 'once', fireAt: '2027-01-01T00:00:00.000Z' }), now)
  const clock = new FakeClock(now)
  const scheduler = new AutomationScheduler(domain, new RecordingRunner(), clock)
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(clock.active()[0]!.at - now, MAX_TIMER_DELAY_MS)
  await scheduler.stop()
})

test('global runner is serial and drains queued work in order', async (t) => {
  const now = Date.parse('2026-03-20T00:00:00.000Z')
  const domain = await setup(t, now)
  const first = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }, 'First'), now)
  const second = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }, 'Second'), now)
  await domain.runNow(first.id, now)
  await domain.runNow(second.id, now + 1)
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const calls: string[] = []
  const runner: AutomationRunner = {
    async run(task, run) {
      calls.push(task.name)
      if (task.id === first.id) await firstGate
      return { status: 'succeeded', sessionId: `session-${run.id}` }
    },
  }
  const clock = new FakeClock(now)
  const scheduler = new AutomationScheduler(domain, runner, clock)
  scheduler.start()
  await waitFor(() => calls.length === 1)
  assert.deepEqual(calls, ['First'])
  releaseFirst()
  await waitFor(() => calls.length === 2)
  await scheduler.whenSettled()
  assert.deepEqual(calls, ['First', 'Second'])
  await scheduler.stop()
})

test('runner failure is recorded and does not block the next task', async (t) => {
  const now = Date.parse('2026-03-20T00:00:00.000Z')
  const domain = await setup(t, now)
  const first = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }, 'Fails'), now)
  const second = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }, 'Succeeds'), now)
  await domain.runNow(first.id, now)
  await domain.runNow(second.id, now + 1)
  const runner: AutomationRunner = {
    async run(task, run) {
      if (task.id === first.id) throw new Error('injected runner failure')
      return { status: 'succeeded', sessionId: `session-${run.id}` }
    },
  }
  const scheduler = new AutomationScheduler(domain, runner, new FakeClock(now))
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(domain.get(first.id).runs.at(-1)?.status, 'failed')
  assert.equal(domain.get(second.id).runs.at(-1)?.status, 'succeeded')
  await scheduler.stop()
})

test('stale cancelled timer callback cannot wake a paused task', async (t) => {
  const now = Date.parse('2026-03-20T00:00:00.000Z')
  const domain = await setup(t, now)
  const task = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-20T01:00:00.000Z' }), now)
  const clock = new FakeClock(now)
  const runner = new RecordingRunner()
  const scheduler = new AutomationScheduler(domain, runner, clock)
  scheduler.start()
  await scheduler.whenSettled()
  const stale = clock.active()[0]!
  await domain.pause(task.id, now + 1000)
  scheduler.requestDrive()
  await scheduler.whenSettled()
  stale.callback()
  await flushAsync()
  await clock.advanceTo(Date.parse('2026-03-20T02:00:00.000Z'))
  assert.equal(runner.calls.length, 0)
  await scheduler.stop()
})
