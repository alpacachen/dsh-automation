import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AutomationDomain, AutomationDomainError } from '../src/domain.js'
import { AutomationStore } from '../src/store.js'
import { AutomationTaskSchema } from '../src/types.js'
import { createRequest, temporaryDirectory } from './helpers.js'

async function setup(t: test.TestContext, maxHistory = 20) {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const store = new AutomationStore(join(directory.path, 'state.json'))
  const domain = new AutomationDomain(store, maxHistory)
  await domain.init(Date.parse('2026-03-20T00:00:00.000Z'))
  return { domain, store }
}

const daily = {
  kind: 'recurring' as const,
  rrule: 'FREQ=DAILY',
  timeZone: 'UTC',
  startAt: '2026-03-20T09:00:00',
}

test('create trims input and stores execution and full-access audit state', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(
    { ...createRequest(daily), name: ' Daily review ', prompt: ' Review the project. ' },
    Date.parse('2026-03-20T00:00:00.000Z'),
  )
  assert.equal(task.name, 'Daily review')
  assert.equal(task.prompt, 'Review the project.')
  assert.equal(task.nextRunAt, '2026-03-20T09:00:00.000Z')
  assert.equal(task.security.permissionPreset, 'danger-full-access')
  assert.equal(task.notificationPolicy, 'failures')
  assert.equal(task.pauseAfterConsecutiveFailures, false)
  assert.deepEqual(domain.list().map((entry) => entry.id), [task.id])
})

test('v0.3.6 tasks load with safe notification defaults', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest(daily), Date.parse('2026-03-20T00:00:00.000Z'))
  const legacy: Record<string, unknown> = { ...task }
  delete legacy.notificationPolicy
  delete legacy.pauseAfterConsecutiveFailures
  delete legacy.consecutiveFailures
  delete legacy.unreadNotifications
  const parsed = AutomationTaskSchema.parse(legacy)
  assert.equal(parsed.notificationPolicy, 'failures')
  assert.equal(parsed.pauseAfterConsecutiveFailures, false)
  assert.equal(parsed.consecutiveFailures, 0)
  assert.equal(parsed.unreadNotifications, 0)
})

test('update replaces requested fields and preserves paused state', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest(daily), Date.parse('2026-03-20T00:00:00.000Z'))
  const updated = await domain.update(task.id, {
    name: ' Release check ',
    prompt: ' Check the release. ',
    schedule: { kind: 'once', fireAt: '2026-03-22T10:00:00.000Z' },
    notificationPolicy: 'always',
    pauseAfterConsecutiveFailures: true,
  }, Date.parse('2026-03-20T01:00:00.000Z'))
  assert.equal(updated.name, 'Release check')
  assert.equal(updated.prompt, 'Check the release.')
  assert.equal(updated.status, 'active')
  assert.equal(updated.nextRunAt, '2026-03-22T10:00:00.000Z')
  assert.equal(updated.notificationPolicy, 'always')
  assert.equal(updated.pauseAfterConsecutiveFailures, true)

  await domain.pause(task.id, Date.parse('2026-03-20T02:00:00.000Z'))
  const paused = await domain.update(task.id, { schedule: daily }, Date.parse('2026-03-20T03:00:00.000Z'))
  assert.equal(paused.status, 'paused')
  assert.equal(paused.nextRunAt, null)
  assert.equal(paused.pausedNextRunAt, '2026-03-20T09:00:00.000Z')
  await assert.rejects(() => domain.update(task.id, {}, Date.now()), /at least one field/)
})

test('notification policy tracks failures, resets on success, and auto-pauses after three', async (t) => {
  const { domain } = await setup(t)
  const start = Date.parse('2026-03-20T00:00:00.000Z')
  const task = await domain.create({
    ...createRequest(daily),
    notificationPolicy: 'failures',
    pauseAfterConsecutiveFailures: true,
  }, start)
  let minute = 1
  const finish = async (status: 'succeeded' | 'failed') => {
    const queued = await domain.runNow(task.id, start + minute++ * 60_000)
    await domain.takeNextQueued(start + minute++ * 60_000)
    await domain.finishRun(task.id, queued.id, { status }, start + minute++ * 60_000)
  }

  await finish('failed')
  assert.equal(domain.get(task.id).consecutiveFailures, 1)
  assert.equal(domain.get(task.id).unreadNotifications, 1)
  await domain.markNotificationsRead()
  await finish('succeeded')
  assert.equal(domain.get(task.id).consecutiveFailures, 0)
  assert.equal(domain.get(task.id).unreadNotifications, 0)

  await domain.update(task.id, { notificationPolicy: 'never' }, start + minute++ * 60_000)
  await finish('failed')
  assert.equal(domain.get(task.id).unreadNotifications, 0)
  await finish('succeeded')
  await domain.update(task.id, { notificationPolicy: 'always' }, start + minute++ * 60_000)
  await finish('succeeded')
  assert.equal(domain.get(task.id).unreadNotifications, 1)
  await domain.markNotificationsRead()

  await domain.update(task.id, { notificationPolicy: 'failures' }, start + minute++ * 60_000)
  await finish('failed')
  await finish('failed')
  await finish('failed')
  const paused = domain.get(task.id)
  assert.equal(paused.consecutiveFailures, 3)
  assert.equal(paused.unreadNotifications, 3)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.nextRunAt, null)
  assert.equal(paused.pausedNextRunAt, '2026-03-20T09:00:00.000Z')
})

test('misfire latest-once creates one run and advances recurring anchor', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest(daily), Date.parse('2026-03-20T00:00:00.000Z'))
  const claimed = await domain.claimDue(Date.parse('2026-03-23T12:00:00.000Z'))
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0]?.scheduledAt, '2026-03-23T09:00:00.000Z')
  assert.equal(domain.get(task.id).nextRunAt, '2026-03-24T09:00:00.000Z')
  assert.equal((await domain.claimDue(Date.parse('2026-03-23T13:00:00.000Z'))).length, 0)
})

test('one-time due task is completed and queued exactly once', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-20T01:00:00.000Z' }), Date.parse('2026-03-20T00:00:00.000Z'))
  assert.equal((await domain.claimDue(Date.parse('2026-03-20T02:00:00.000Z'))).length, 1)
  assert.equal(domain.get(task.id).status, 'completed')
  assert.equal(domain.get(task.id).nextRunAt, null)
  assert.equal((await domain.claimDue(Date.parse('2026-03-21T00:00:00.000Z'))).length, 0)
})

test('runNow does not change schedule and rejects overlapping run', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest(daily), Date.parse('2026-03-20T00:00:00.000Z'))
  const before = domain.get(task.id).nextRunAt
  const run = await domain.runNow(task.id, Date.parse('2026-03-20T01:00:00.000Z'))
  assert.equal(run.trigger, 'manual')
  assert.equal(domain.get(task.id).nextRunAt, before)
  await assert.rejects(
    () => domain.runNow(task.id, Date.parse('2026-03-20T02:00:00.000Z')),
    (error: unknown) => error instanceof AutomationDomainError && error.code === 'run_in_progress',
  )
})

test('queued run can be canceled without changing its schedule', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest(daily), Date.parse('2026-03-20T00:00:00.000Z'))
  const nextRunAt = task.nextRunAt
  const queued = await domain.runNow(task.id, Date.parse('2026-03-20T01:00:00.000Z'))
  const canceled = await domain.cancelQueuedRun(task.id, queued.id, Date.parse('2026-03-20T01:01:00.000Z'))
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.finishedAt, '2026-03-20T01:01:00.000Z')
  assert.equal(domain.get(task.id).nextRunAt, nextRunAt)
  assert.equal(domain.get(task.id).runs.at(-1)?.status, 'canceled')
  await assert.rejects(() => domain.cancelQueuedRun(task.id, queued.id, Date.now()), /does not have that queued run/)
})

test('pause skips recurring occurrences and resume preserves wall-clock anchor', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest(daily), Date.parse('2026-03-20T00:00:00.000Z'))
  const paused = await domain.pause(task.id, Date.parse('2026-03-20T02:00:00.000Z'))
  assert.equal(paused.status, 'paused')
  assert.equal(paused.nextRunAt, null)
  assert.equal(paused.pausedNextRunAt, '2026-03-20T09:00:00.000Z')
  assert.equal((await domain.claimDue(Date.parse('2026-03-23T12:00:00.000Z'))).length, 0)
  const resumed = await domain.resume(task.id, { runNow: false }, Date.parse('2026-03-23T12:00:00.000Z'))
  assert.equal(resumed.status, 'active')
  assert.equal(resumed.nextRunAt, '2026-03-24T09:00:00.000Z')
  assert.equal(resumed.runs.length, 0)
})

test('resume and run queues one manual run without changing next recurring occurrence', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest(daily), Date.parse('2026-03-20T00:00:00.000Z'))
  await domain.pause(task.id, Date.parse('2026-03-20T01:00:00.000Z'))
  const resumed = await domain.resume(task.id, { runNow: true }, Date.parse('2026-03-21T12:00:00.000Z'))
  assert.equal(resumed.nextRunAt, '2026-03-22T09:00:00.000Z')
  assert.equal(resumed.runs.at(-1)?.trigger, 'manual')
  assert.equal(resumed.runs.at(-1)?.status, 'queued')
})

test('overdue paused one-time task requires resume-and-run', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest({ kind: 'once', fireAt: '2026-03-20T01:00:00.000Z' }), Date.parse('2026-03-20T00:00:00.000Z'))
  await domain.pause(task.id, Date.parse('2026-03-20T00:30:00.000Z'))
  await assert.rejects(() => domain.resume(task.id, { runNow: false }, Date.parse('2026-03-21T00:00:00.000Z')), /overdue/)
  const resumed = await domain.resume(task.id, { runNow: true }, Date.parse('2026-03-21T00:00:00.000Z'))
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.runs.at(-1)?.status, 'queued')
})

test('queued run is claimed, completed, and persisted with session id', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest(daily), Date.parse('2026-03-20T00:00:00.000Z'))
  const queued = await domain.runNow(task.id, Date.parse('2026-03-20T01:00:00.000Z'))
  const claimed = await domain.takeNextQueued(Date.parse('2026-03-20T01:01:00.000Z'))
  assert.equal(claimed?.run.id, queued.id)
  assert.equal(claimed?.run.status, 'running')
  assert.match(claimed?.run.sessionId ?? '', /^automation-/)
  await domain.finishRun(task.id, queued.id, { status: 'succeeded', sessionId: 'session-run', summary: 'Review complete.' }, Date.parse('2026-03-20T01:02:00.000Z'))
  assert.deepEqual(domain.get(task.id).runs.at(-1), {
    ...queued,
    status: 'succeeded',
    startedAt: '2026-03-20T01:01:00.000Z',
    finishedAt: '2026-03-20T01:02:00.000Z',
    sessionId: 'session-run',
    summary: 'Review complete.',
  })
})

test('restart marks running work outcome unknown but leaves queued work recoverable', async (t) => {
  const directory = await temporaryDirectory()
  t.after(directory.cleanup)
  const path = join(directory.path, 'state.json')
  const first = new AutomationDomain(new AutomationStore(path))
  await first.init(Date.parse('2026-03-20T00:00:00.000Z'))
  const runningTask = await first.create(createRequest(daily, 'Running'), Date.parse('2026-03-20T00:00:00.000Z'))
  const queuedTask = await first.create(createRequest(daily, 'Queued'), Date.parse('2026-03-20T00:00:00.000Z'))
  await first.runNow(runningTask.id, Date.parse('2026-03-20T01:00:00.000Z'))
  await first.takeNextQueued(Date.parse('2026-03-20T01:01:00.000Z'))
  await first.runNow(queuedTask.id, Date.parse('2026-03-20T01:02:00.000Z'))

  const restored = new AutomationDomain(new AutomationStore(path))
  await restored.init(Date.parse('2026-03-20T02:00:00.000Z'))
  const restoredRun = restored.get(runningTask.id).runs.at(-1)
  assert.equal(restoredRun?.status, 'outcome_unknown')
  assert.match(restoredRun?.sessionId ?? '', /^automation-/)
  assert.match(restoredRun?.error ?? '', /may have completed/)
  assert.equal(restored.get(runningTask.id).unreadNotifications, 1)
  assert.equal(restored.get(queuedTask.id).runs.at(-1)?.status, 'queued')
})

test('delete is idempotent and removes future scheduling', async (t) => {
  const { domain } = await setup(t)
  const task = await domain.create(createRequest(daily), Date.parse('2026-03-20T00:00:00.000Z'))
  assert.equal(await domain.delete(task.id), true)
  assert.equal(await domain.delete(task.id), false)
  assert.throws(() => domain.get(task.id), /not found/)
})
