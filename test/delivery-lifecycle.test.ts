import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AutomationDomain } from '../src/domain.js'
import { AutomationStore, writeJsonAtomic, type AtomicWriter } from '../src/store.js'
import { AutomationDeliverySchema, AutomationStateSchema, type AutomationRun } from '../src/types.js'
import { AutomationScheduler, DELIVERY_TIMEOUT_MS, RETRY_BASE_DELAY_MS, type AutomationRunner, type Clock } from '../src/scheduler.js'
import { createRequest, temporaryDirectory } from './helpers.js'

const now = Date.parse('2026-03-20T00:00:00.000Z')
const target = { botId: 'bot-test', targetId: 'reminders' }
const schedule = { kind: 'once' as const, fireAt: '2026-03-21T00:00:00.000Z' }

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

class FakeClock implements Clock {
  value = now
  timers: Array<{ at: number; callback: () => void; canceled: boolean }> = []
  now() { return this.value }
  setTimeout(callback: () => void, delay: number) {
    const timer = { at: this.value + delay, callback, canceled: false }
    this.timers.push(timer)
    return () => { timer.canceled = true }
  }
  advance(milliseconds: number) {
    this.value += milliseconds
    for (const timer of this.timers.filter((entry) => !entry.canceled && entry.at <= this.value)) {
      timer.canceled = true
      timer.callback()
    }
  }
}

async function setup(t: test.TestContext, writer?: AtomicWriter) {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const path = join(directory.path, 'state.json')
  const domain = new AutomationDomain(new AutomationStore(path, writer))
  await domain.init(now)
  const task = await domain.create(createRequest(schedule), now)
  const enable = () => domain.update(task.id, { delivery: target, deliveryChangeConfirmed: true }, now)
  const latest = () => domain.get(task.id).runs.at(-1)!
  return { domain, task, enable, latest, path, clock: new FakeClock() }
}

function runner(output = 'Full result') {
  let calls = 0
  return {
    calls: () => calls,
    async run() { calls++; return { status: 'succeeded' as const, sessionId: 'session-test', summary: 'Short result', output } },
  }
}

test('delivery configuration is optional for legacy state and confirmed atomically only for actual enabling or changing', async (t) => {
  const f = await setup(t)
  const before = await readFile(f.path, 'utf8')
  const legacy = new AutomationDomain(new AutomationStore(f.path))
  await legacy.init(now)
  assert.equal(legacy.get(f.task.id).delivery, undefined)
  assert.equal(await readFile(f.path, 'utf8'), before, 'Loading old state must not rewrite it')
  assert.equal(AutomationDeliverySchema.safeParse({ ...target, route: 'secret' }).success, false)
  assert.deepEqual(AutomationDeliverySchema.parse({ botId: ' bot-test ', targetId: ' reminders ' }), target)
  await assert.rejects(f.domain.update(f.task.id, { delivery: target }, now), /confirmation/)
  await f.enable()
  await assert.rejects(f.domain.update(f.task.id, { delivery: { ...target, targetId: 'other' } }, now), /confirmation/)
  const queued = await f.domain.runNow(f.task.id, now)
  await f.domain.update(f.task.id, { delivery: target }, now) // no-op needs no reconfirmation
  await assert.rejects(f.domain.update(f.task.id, { delivery: null }, now), /queued or running/)
  await assert.rejects(f.domain.update(f.task.id, { delivery: { ...target, targetId: 'other' }, deliveryChangeConfirmed: true }, now), /queued or running/)
  await f.domain.takeNextQueued(now)
  await assert.rejects(f.domain.update(f.task.id, { delivery: null }, now), /queued or running/)
  await f.domain.finishRun(f.task.id, queued.id, { status: 'succeeded' }, now)
  await f.domain.update(f.task.id, { delivery: null }, now)
  assert.equal(f.domain.get(f.task.id).delivery, undefined)
  await f.domain.update(f.task.id, { delivery: null }, now) // disabling an absent target is also a no-op
  const state = f.domain.store.snapshot()
  const run = state.tasks[f.task.id]!.runs[0]!
  run.delivery = { ...target, status: 'sending', attemptedAt: '2026-99-99T00:00:00.000Z' }
  assert.equal(AutomationStateSchema.safeParse(state).success, false)
})

test('execution and send intent reach disk before sending; full output is ephemeral', async (t) => {
  const f = await setup(t)
  await f.enable()
  await f.domain.runNow(f.task.id, now)
  const execution = runner('Full result '.repeat(1_000))
  let sends = 0
  const scheduler = new AutomationScheduler(f.domain, execution, f.clock, (error) => assert.fail(String(error)), undefined, async (task, run, outcome) => {
    sends++
    const stored = JSON.parse(await readFile(f.path, 'utf8')).tasks[task.id].runs[0]
    assert.equal(stored.status, 'succeeded')
    assert.equal(stored.delivery.status, 'sending')
    assert.deepEqual(task.delivery, target)
    assert.equal(run.delivery?.status, 'sending')
    assert.equal(outcome.output, 'Full result '.repeat(1_000))
    assert.equal(stored.output, undefined)
    assert.equal(stored.summary, 'Short result')
  })
  t.after(() => scheduler.stop())
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(sends, 1)
  assert.equal(execution.calls(), 1)
  assert.equal(f.latest().delivery?.status, 'sent')
  assert.equal(f.latest().delivery?.finishedAt, new Date(now).toISOString())
  assert.equal((f.latest() as AutomationRun & { output?: string }).output, undefined)
})

test('failed outcome persistence delays sending without repeating execution', async (t) => {
  let fail = true
  const f = await setup(t, async (path, content) => {
    if (fail && content.includes('"status": "sending"')) { fail = false; throw new Error('disk unavailable') }
    await writeJsonAtomic(path, content)
  })
  await f.enable()
  await f.domain.runNow(f.task.id, now)
  const execution = runner()
  let sends = 0
  const scheduler = new AutomationScheduler(f.domain, execution, f.clock, () => {}, undefined, async () => { sends++ })
  t.after(() => scheduler.stop())
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(execution.calls(), 1)
  assert.equal(sends, 0)
  assert.equal(f.latest().status, 'running')
  assert.equal(scheduler.health().status, 'retrying')
  f.clock.advance(RETRY_BASE_DELAY_MS)
  await scheduler.whenSettled()
  assert.equal(sends, 1)
  assert.equal(execution.calls(), 1)
  assert.equal(f.latest().delivery?.status, 'sent')
})

test('failed post-send persistence retries only the result write', async (t) => {
  let fail = true
  const f = await setup(t, async (path, content) => {
    if (fail && content.includes('"status": "sent"')) { fail = false; throw new Error('disk unavailable after send') }
    await writeJsonAtomic(path, content)
  })
  await f.enable()
  await f.domain.runNow(f.task.id, now)
  const execution = runner()
  let sends = 0
  const scheduler = new AutomationScheduler(f.domain, execution, f.clock, () => {}, undefined, async () => { sends++ })
  t.after(() => scheduler.stop())
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(sends, 1)
  assert.equal(f.latest().status, 'succeeded')
  assert.equal(f.latest().delivery?.status, 'sending')
  f.clock.advance(RETRY_BASE_DELAY_MS)
  await scheduler.whenSettled()
  assert.equal(sends, 1)
  assert.equal(execution.calls(), 1)
  assert.equal(f.latest().delivery?.status, 'sent')
})

test('delivery rejection does not turn successful execution into failure or auto-pause it', async (t) => {
  const f = await setup(t)
  await f.enable()
  await f.domain.update(f.task.id, { pauseAfterConsecutiveFailures: true }, now)
  await f.domain.runNow(f.task.id, now)
  const scheduler = new AutomationScheduler(f.domain, runner(), f.clock, (error) => assert.fail(String(error)), undefined, async () => { throw new Error('bot offline') })
  t.after(() => scheduler.stop())
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(f.latest().status, 'succeeded')
  assert.equal(f.latest().delivery?.status, 'failed')
  assert.equal(f.latest().delivery?.error, 'bot offline')
  assert.equal(f.domain.get(f.task.id).consecutiveFailures, 0)
  assert.equal(f.domain.get(f.task.id).status, 'active')
  assert.equal(f.domain.get(f.task.id).unreadNotifications, 1)
  await f.domain.finishDelivery(f.task.id, f.latest().id, f.latest().delivery!)
  assert.equal(f.domain.get(f.task.id).unreadNotifications, 1, 'Settlement retries must not duplicate notifications')
  assert.equal(scheduler.health().status, 'healthy')
})

test('failed execution sends its terminal error without repeating the model', async (t) => {
  const f = await setup(t)
  await f.enable()
  await f.domain.runNow(f.task.id, now)
  let sends = 0
  let calls = 0
  const scheduler = new AutomationScheduler(f.domain, {
    async run() { calls++; throw new Error('model unavailable') },
  }, f.clock, (error) => assert.fail(String(error)), undefined, async (_task, run, outcome) => {
    sends++
    assert.equal(run.status, 'failed')
    assert.equal(outcome.error, 'model unavailable')
  })
  t.after(() => scheduler.stop())
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(sends, 1)
  assert.equal(calls, 1)
  assert.equal(f.latest().status, 'failed')
  assert.equal(f.latest().delivery?.status, 'sent')
  assert.equal(f.domain.get(f.task.id).consecutiveFailures, 1)
})

test('restart marks uncertain delivery unknown without changing execution or resending', async (t) => {
  const f = await setup(t)
  await f.enable()
  const run = await f.domain.runNow(f.task.id, now)
  await f.domain.takeNextQueued(now)
  await f.domain.finishRun(f.task.id, run.id, { status: 'succeeded', summary: 'Done' }, now, target)
  const restarted = new AutomationDomain(new AutomationStore(f.path))
  await restarted.init(now + 1)
  const recovered = restarted.get(f.task.id)
  assert.equal(recovered.runs[0]?.status, 'succeeded')
  assert.equal(recovered.runs[0]?.delivery?.status, 'unknown')
  assert.equal(recovered.consecutiveFailures, 0)
  assert.equal(recovered.unreadNotifications, 1)
  let sends = 0
  const execution = runner()
  const scheduler = new AutomationScheduler(restarted, execution, f.clock, (error) => assert.fail(String(error)), undefined, async () => { sends++ })
  t.after(() => scheduler.stop())
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(sends, 0)
  assert.equal(execution.calls(), 0)
})

test('unconfigured tasks do not send', async (t) => {
  const f = await setup(t)
  await f.domain.runNow(f.task.id, now)
  let sends = 0
  const scheduler = new AutomationScheduler(f.domain, runner(), f.clock, (error) => assert.fail(String(error)), undefined, async () => { sends++ })
  t.after(() => scheduler.stop())
  scheduler.start()
  await scheduler.whenSettled()
  assert.equal(sends, 0)
  assert.equal(f.latest().delivery, undefined)
})

for (const reason of ['manual', 'shutdown', 'timeout'] as const) {
  test(`execution ${reason} only delivers if its outcome is timed_out`, async (t) => {
    const f = await setup(t)
    await f.enable()
    const run = await f.domain.runNow(f.task.id, now)
    const started = deferred()
    const ended = deferred<{ status: 'failed'; sessionId: string }>()
    const execution: AutomationRunner = {
      async run() { started.resolve(); return ended.promise },
      cancel() { ended.resolve({ status: 'failed', sessionId: 'session-test' }); return true },
    }
    let sends = 0
    const scheduler = new AutomationScheduler(f.domain, execution, f.clock, (error) => assert.fail(String(error)), 100, async (_task, _run, outcome) => {
      sends++
      assert.equal(outcome.status, 'timed_out')
    })
    t.after(() => scheduler.stop())
    scheduler.start()
    await started.promise
    if (reason === 'shutdown') await scheduler.stop()
    else if (reason === 'manual') assert.equal(scheduler.cancelRun(f.task.id, run.id), true)
    else f.clock.advance(100)
    await scheduler.whenSettled()
    assert.equal(sends, reason === 'timeout' ? 1 : 0)
    assert.equal(f.latest().delivery?.status, reason === 'timeout' ? 'sent' : undefined)
  })
}

for (const shutdown of [false, true]) {
  test(`delivery ${shutdown ? 'shutdown' : 'timeout'} settles unknown even when sender ignores cancellation`, async (t) => {
    const f = await setup(t)
    await f.enable()
    await f.domain.runNow(f.task.id, now)
    const entered = deferred<AbortSignal>()
    const scheduler = new AutomationScheduler(f.domain, runner(), f.clock, (error) => assert.fail(String(error)), undefined, async (_task, _run, _outcome, signal) => {
      entered.resolve(signal)
      return new Promise<void>(() => {})
    })
    t.after(() => scheduler.stop())
    scheduler.start()
    const signal = await entered.promise
    const next = await f.domain.create(createRequest(schedule, 'Next task'), now)
    await f.domain.runNow(next.id, now)
    if (shutdown) await scheduler.stop()
    else f.clock.advance(DELIVERY_TIMEOUT_MS)
    await scheduler.whenSettled()
    assert.equal(f.domain.get(next.id).runs[0]?.status, shutdown ? 'queued' : 'succeeded')
    assert.equal(signal.aborted, true)
    assert.equal(f.latest().status, 'succeeded')
    assert.equal(f.latest().delivery?.status, 'unknown')
  })
}

for (const stage of ['execution', 'delivery'] as const) {
  test(`removing task during ${stage} persistence retry drops pending finish without resending`, async (t) => {
    let fail = true
    const f = await setup(t, async (path, content) => {
      const status = stage === 'execution' ? 'sending' : 'sent'
      if (fail && content.includes(`"status": "${status}"`)) { fail = false; throw new Error('disk failure') }
      await writeJsonAtomic(path, content)
    })
    await f.enable()
    await f.domain.runNow(f.task.id, now)
    const execution = runner()
    let sends = 0
    const scheduler = new AutomationScheduler(f.domain, execution, f.clock, () => {}, undefined, async () => { sends++ })
    t.after(() => scheduler.stop())
    scheduler.start()
    await scheduler.whenSettled()
    await f.domain.delete(f.task.id)
    f.clock.advance(RETRY_BASE_DELAY_MS)
    await scheduler.whenSettled()
    assert.equal(sends, stage === 'execution' ? 0 : 1)
    assert.equal(execution.calls(), 1)
    assert.equal(scheduler.health().status, 'healthy')
    assert.equal(f.clock.timers.some((timer) => !timer.canceled), false)
  })
}
