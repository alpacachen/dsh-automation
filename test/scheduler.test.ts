import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AutomationDomain } from '../src/domain.js'
import { AutomationStore, writeJsonAtomic } from '../src/store.js'
import {
  AutomationScheduler,
  MAX_TIMER_DELAY_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  type AutomationRunner,
  type AutomationRunCancelReason,
  type Clock,
} from '../src/scheduler.js'
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

class RecordingRunner implements AutomationRunner {
  readonly calls: Array<{ task: AutomationTask; run: AutomationRun }> = []
  cancel(): boolean { return false }
  async run(task: AutomationTask, run: AutomationRun) {
    this.calls.push({ task, run })
    return { status: 'succeeded' as const, sessionId: `session-${run.id}`, summary: `Completed ${task.name}.` }
  }
}

class CancelableRunner implements AutomationRunner {
  readonly calls: string[] = []
  readonly cancellations: Array<{ runId: string; reason: AutomationRunCancelReason }> = []
  readonly started: Promise<void>
  private markStarted!: () => void
  private blockedRun: { id: string; resolve: (result: { status: 'failed'; sessionId: string; error: string }) => void } | undefined

  constructor() {
    this.started = new Promise((resolve) => { this.markStarted = resolve })
  }

  run(task: AutomationTask, run: AutomationRun) {
    this.calls.push(task.name)
    if (this.calls.length > 1) return Promise.resolve({ status: 'succeeded' as const, sessionId: `session-${run.id}` })
    this.markStarted()
    return new Promise<{ status: 'failed'; sessionId: string; error: string }>((resolve) => {
      this.blockedRun = { id: run.id, resolve }
    })
  }

  cancel(runId: string, reason: AutomationRunCancelReason): boolean {
    if (this.blockedRun?.id !== runId) return false
    this.cancellations.push({ runId, reason })
    const blocked = this.blockedRun
    this.blockedRun = undefined
    blocked.resolve({ status: 'failed', sessionId: `session-${runId}`, error: `canceled: ${reason}` })
    return true
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
  assert.equal(domain.get(task.id).runs.at(-1)?.summary, 'Completed Test automation.')
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
  let markFirstStarted!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
  const calls: string[] = []
  const runner: AutomationRunner = {
    cancel: () => false,
    async run(task, run) {
      calls.push(task.name)
      if (task.id === first.id) {
        markFirstStarted()
        await firstGate
      }
      return { status: 'succeeded', sessionId: `session-${run.id}` }
    },
  }
  const clock = new FakeClock(now)
  const scheduler = new AutomationScheduler(domain, runner, clock)
  scheduler.start()
  await firstStarted
  assert.deepEqual(calls, ['First'])
  releaseFirst()
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
    cancel: () => false,
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

test('transient state failures back off and recover without duplicate execution', async (t) => {
  const createdAt = Date.parse('2026-03-20T00:00:00.000Z')
  const dueAt = Date.parse('2026-03-20T01:00:00.000Z')
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  let failuresRemaining = 0
  const store = new AutomationStore(join(directory.path, 'state.json'), async (path, content) => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      throw new Error('injected write failure')
    }
    await writeJsonAtomic(path, content)
  })
  const domain = new AutomationDomain(store)
  await domain.init(createdAt)
  const task = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-20T01:00:00.000Z' }), createdAt)
  failuresRemaining = 2
  const clock = new FakeClock(dueAt)
  const runner = new RecordingRunner()
  const errors: string[] = []
  const scheduler = new AutomationScheduler(domain, runner, clock, (error) => errors.push(String(error)))

  scheduler.start()
  await scheduler.whenSettled()
  assert.deepEqual(scheduler.health(), {
    status: 'retrying',
    consecutiveFailures: 1,
    lastError: 'injected write failure',
    lastFailedAt: '2026-03-20T01:00:00.000Z',
    retryAt: '2026-03-20T01:00:01.000Z',
  })

  await clock.advanceTo(dueAt + RETRY_BASE_DELAY_MS)
  await scheduler.whenSettled()
  assert.equal(scheduler.health().consecutiveFailures, 2)
  assert.equal(scheduler.health().retryAt, '2026-03-20T01:00:03.000Z')

  await clock.advanceTo(dueAt + RETRY_BASE_DELAY_MS * 3)
  await scheduler.whenSettled()
  assert.equal(scheduler.health().status, 'healthy')
  assert.equal(scheduler.health().consecutiveFailures, 0)
  assert.equal(runner.calls.length, 1)
  assert.equal(domain.get(task.id).runs.at(-1)?.status, 'succeeded')
  assert.equal(errors.length, 2)
  await scheduler.stop()
})

test('stop cancels a pending retry and reports stopped health', async (t) => {
  const createdAt = Date.parse('2026-03-20T00:00:00.000Z')
  const dueAt = Date.parse('2026-03-20T01:00:00.000Z')
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  let failWrites = false
  let failedWrites = 0
  const store = new AutomationStore(join(directory.path, 'state.json'), async (path, content) => {
    if (failWrites) {
      failedWrites += 1
      throw new Error('persistent write failure')
    }
    await writeJsonAtomic(path, content)
  })
  const domain = new AutomationDomain(store)
  await domain.init(createdAt)
  await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-20T01:00:00.000Z' }), createdAt)
  failWrites = true
  const clock = new FakeClock(dueAt)
  const runner = new RecordingRunner()
  const scheduler = new AutomationScheduler(domain, runner, clock, () => undefined)

  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(scheduler.health().status, 'retrying')
  assert.equal(clock.active().length, 1)
  await scheduler.stop()
  assert.equal(scheduler.health().status, 'stopped')
  assert.equal(clock.active().length, 0)
  await clock.advanceTo(dueAt + RETRY_BASE_DELAY_MS * 10)
  assert.equal(failedWrites, 1)
  assert.equal(runner.calls.length, 0)
})

test('failed outcome persistence retries the write without running the Agent twice', async (t) => {
  const createdAt = Date.parse('2026-03-20T00:00:00.000Z')
  const dueAt = Date.parse('2026-03-20T01:00:00.000Z')
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  let rejectNextFinishedState = true
  const store = new AutomationStore(join(directory.path, 'state.json'), async (path, content) => {
    const state = JSON.parse(content) as { tasks: Record<string, { runs: Array<{ status: string }> }> }
    const containsFinishedRun = Object.values(state.tasks).some((task) =>
      task.runs.some((run) => run.status === 'succeeded'),
    )
    if (containsFinishedRun && rejectNextFinishedState) {
      rejectNextFinishedState = false
      throw new Error('injected finish write failure')
    }
    await writeJsonAtomic(path, content)
  })
  const domain = new AutomationDomain(store)
  await domain.init(createdAt)
  const task = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-20T01:00:00.000Z' }), createdAt)
  const clock = new FakeClock(dueAt)
  const runner = new RecordingRunner()
  const scheduler = new AutomationScheduler(domain, runner, clock, () => undefined)

  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(scheduler.health().status, 'retrying')
  assert.equal(domain.get(task.id).runs.at(-1)?.status, 'running')
  assert.equal(runner.calls.length, 1)

  await clock.advanceTo(dueAt + RETRY_BASE_DELAY_MS)
  await scheduler.whenSettled()
  assert.equal(scheduler.health().status, 'healthy')
  assert.equal(domain.get(task.id).runs.at(-1)?.status, 'succeeded')
  assert.equal(runner.calls.length, 1)
  await scheduler.stop()
})

test('retry backoff is capped', async () => {
  const now = Date.parse('2026-03-20T00:00:00.000Z')
  const clock = new FakeClock(now)
  const domain = {
    async claimDue() { throw new Error('persistent failure') },
  } as unknown as AutomationDomain
  const scheduler = new AutomationScheduler(domain, new RecordingRunner(), clock, () => undefined)
  const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]

  scheduler.start()
  for (const expected of expectedDelays) {
    await scheduler.whenSettled()
    const health = scheduler.health()
    assert.equal(Date.parse(health.retryAt!) - clock.now(), expected)
    assert.ok(expected <= RETRY_MAX_DELAY_MS)
    await clock.advanceTo(Date.parse(health.retryAt!))
  }
  await scheduler.stop()
})

test('run timeout cancels the active Agent and continues the global queue', async (t) => {
  const now = Date.parse('2026-03-20T01:00:00.000Z')
  const domain = await setup(t, now)
  const first = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }, 'First'), now)
  const second = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }, 'Second'), now)
  const firstRun = await domain.runNow(first.id, now)
  await domain.runNow(second.id, now + 1)
  const clock = new FakeClock(now)
  const runner = new CancelableRunner()
  const scheduler = new AutomationScheduler(domain, runner, clock, () => undefined, 1_000)

  scheduler.start()
  await runner.started
  await clock.advanceTo(now + 1_000)
  await scheduler.whenSettled()

  assert.deepEqual(runner.cancellations, [{ runId: firstRun.id, reason: 'timeout' }])
  assert.deepEqual(runner.calls, ['First', 'Second'])
  assert.equal(domain.get(first.id).runs.at(-1)?.status, 'timed_out')
  assert.match(domain.get(first.id).runs.at(-1)?.error ?? '', /1000ms/)
  assert.equal(domain.get(second.id).runs.at(-1)?.status, 'succeeded')
  await scheduler.stop()
})

test('manual stop cancels the active Agent and preserves its session id', async (t) => {
  const now = Date.parse('2026-03-20T01:00:00.000Z')
  const domain = await setup(t, now)
  const task = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }), now)
  const run = await domain.runNow(task.id, now)
  const runner = new CancelableRunner()
  const scheduler = new AutomationScheduler(domain, runner, new FakeClock(now))

  scheduler.start()
  await runner.started
  assert.equal(scheduler.cancelRun(task.id, run.id), true)
  await scheduler.whenSettled()

  const finished = domain.get(task.id).runs.at(-1)
  assert.equal(finished?.status, 'canceled')
  assert.equal(finished?.sessionId, `session-${run.id}`)
  assert.deepEqual(runner.cancellations, [{ runId: run.id, reason: 'manual' }])
  await scheduler.stop()
})

test('scheduler shutdown cancels and drains an active Agent', async (t) => {
  const now = Date.parse('2026-03-20T01:00:00.000Z')
  const domain = await setup(t, now)
  const task = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-21T00:00:00.000Z' }), now)
  const run = await domain.runNow(task.id, now)
  const runner = new CancelableRunner()
  const scheduler = new AutomationScheduler(domain, runner, new FakeClock(now))

  scheduler.start()
  await runner.started
  await scheduler.stop()

  assert.deepEqual(runner.cancellations, [{ runId: run.id, reason: 'shutdown' }])
  assert.equal(domain.get(task.id).runs.at(-1)?.status, 'interrupted')
  assert.equal(scheduler.health().status, 'stopped')
})
