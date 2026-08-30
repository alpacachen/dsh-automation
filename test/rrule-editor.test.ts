import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCommonRRule, parseCommonRRule } from '../src/client/rrule-editor.js'

test('visual RRULE editor round-trips common schedules', () => {
  const weekly = parseCommonRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO;COUNT=8')
  assert.ok(weekly)
  assert.equal(weekly.frequency, 'WEEKLY')
  assert.deepEqual(weekly.weekdays, ['FR', 'MO'])
  assert.equal(buildCommonRRule(weekly), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=8')

  const monthly = parseCommonRRule('FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231T235959Z')
  assert.ok(monthly)
  assert.equal(monthly.until, '2026-12-31')
  assert.equal(buildCommonRRule(monthly), 'FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231T235959Z')

  const anchoredMonthly = parseCommonRRule('FREQ=MONTHLY', '23')
  assert.ok(anchoredMonthly)
  assert.equal(anchoredMonthly.monthDay, '23')
  assert.equal(buildCommonRRule(anchoredMonthly), 'FREQ=MONTHLY;BYMONTHDAY=23')
})

test('visual RRULE editor leaves uncommon or invalid rules in advanced mode', () => {
  assert.equal(parseCommonRRule('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1'), undefined)
  assert.equal(parseCommonRRule('FREQ=WEEKLY;BYDAY=XX'), undefined)
  assert.equal(parseCommonRRule('FREQ=DAILY;INTERVAL=0'), undefined)
  assert.equal(parseCommonRRule('FREQ=YEARLY'), undefined)
})
