import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRule,
  firstOccurrence,
  latestDueOccurrence,
  nextOccurrence,
  ScheduleInputError,
  validateSchedule,
  validateTimeZone,
} from '../src/recurrence.js'

const shanghaiDaily = {
  kind: 'recurring' as const,
  rrule: 'FREQ=DAILY;COUNT=3',
  timeZone: 'Asia/Shanghai',
  startAt: '2026-03-20T09:00:00',
}

test('once schedule is canonical and future-only', () => {
  const now = Date.parse('2026-03-20T00:00:00.000Z')
  const schedule = { kind: 'once' as const, fireAt: '2026-03-20T01:00:00.000Z' }
  assert.deepEqual(validateSchedule(schedule, now), schedule)
  assert.equal(firstOccurrence(schedule), Date.parse(schedule.fireAt))
  assert.equal(nextOccurrence(schedule, now), Date.parse(schedule.fireAt))
  assert.equal(nextOccurrence(schedule, Date.parse(schedule.fireAt)), undefined)
  assert.throws(
    () => validateSchedule({ ...schedule, fireAt: '2026-03-19T01:00:00.000Z' }, now),
    (error: unknown) => error instanceof ScheduleInputError && error.code === 'not_future',
  )
  assert.throws(() => validateSchedule({ ...schedule, fireAt: '2026-03-20T01:00:00Z' }, now), /canonical/)
})

test('RRULE honors local start, interval, count, and latest due occurrence', () => {
  const expected = [
    '2026-03-20T01:00:00.000Z',
    '2026-03-21T01:00:00.000Z',
    '2026-03-22T01:00:00.000Z',
  ]
  assert.deepEqual(buildRule(shanghaiDaily).all().map((date) => date.toISOString()), [
    '2026-03-20T09:00:00.000Z',
    '2026-03-21T09:00:00.000Z',
    '2026-03-22T09:00:00.000Z',
  ])
  assert.equal(firstOccurrence(shanghaiDaily), Date.parse(expected[0]!))
  assert.equal(nextOccurrence(shanghaiDaily, Date.parse(expected[0]!)), Date.parse(expected[1]!))
  assert.equal(
    latestDueOccurrence(shanghaiDaily, Date.parse(expected[0]!), Date.parse('2026-03-22T12:00:00.000Z')),
    Date.parse(expected[2]!),
  )
  assert.equal(nextOccurrence(shanghaiDaily, Date.parse(expected[2]!)), undefined)
})

test('weekly BYDAY rules generate expected instants', () => {
  const schedule = {
    kind: 'recurring' as const,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4',
    timeZone: 'UTC',
    startAt: '2026-03-20T09:30:00',
  }
  assert.deepEqual(buildRule(schedule).all().map((date) => date.toISOString()), [
    '2026-03-20T09:30:00.000Z',
    '2026-03-23T09:30:00.000Z',
    '2026-03-25T09:30:00.000Z',
    '2026-03-27T09:30:00.000Z',
  ])
})

test('IANA timezone keeps wall-clock time across DST', () => {
  const schedule = {
    kind: 'recurring' as const,
    rrule: 'FREQ=DAILY;COUNT=3',
    timeZone: 'America/New_York',
    startAt: '2026-03-07T09:00:00',
  }
  const first = firstOccurrence(schedule)!
  const second = nextOccurrence(schedule, first)!
  const third = nextOccurrence(schedule, second)!
  assert.deepEqual([first, second, third].map((value) => new Date(value).toISOString()), [
    '2026-03-07T14:00:00.000Z',
    '2026-03-08T13:00:00.000Z',
    '2026-03-09T13:00:00.000Z',
  ])
})

test('invalid timezone, local time, RRULE sets and malformed rules fail closed', () => {
  assert.throws(() => validateTimeZone('Mars/Olympus'), /Unknown IANA/)
  assert.throws(() => validateTimeZone(' UTC'), /without surrounding whitespace/)
  assert.throws(() => buildRule({ ...shanghaiDaily, startAt: '2026-02-30T09:00:00' }), /real local calendar/)
  assert.throws(() => buildRule({ ...shanghaiDaily, rrule: 'DTSTART:20260320T090000\nRRULE:FREQ=DAILY' }), /rule only/)
  assert.throws(() => buildRule({ ...shanghaiDaily, rrule: 'FREQ=NOTREAL' }), /Invalid RRULE/)
})

test('latest due respects the durable floor and future targets are not due', () => {
  const floor = Date.parse('2026-03-22T01:00:00.000Z')
  assert.equal(latestDueOccurrence(shanghaiDaily, floor, Date.parse('2026-03-21T12:00:00.000Z')), undefined)
  assert.equal(latestDueOccurrence(shanghaiDaily, floor, Date.parse('2026-03-22T12:00:00.000Z')), floor)
})
