import RRulePackage from 'rrule'
import type { RRule } from 'rrule'
import type { AutomationSchedule, RecurringSchedule } from './types.js'
import { ISO_INSTANT, LOCAL_DATE_TIME } from './types.js'

const { rrulestr } = RRulePackage

export class ScheduleInputError extends Error {
  constructor(
    readonly code: 'invalid_schedule' | 'invalid_time_zone' | 'not_future',
    message: string,
  ) {
    super(message)
    this.name = 'ScheduleInputError'
  }
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function instant(epoch: number): string {
  if (!Number.isFinite(epoch)) throw new ScheduleInputError('invalid_schedule', 'Time is not representable.')
  const value = new Date(epoch).toISOString()
  if (!ISO_INSTANT.test(value)) throw new ScheduleInputError('invalid_schedule', 'Time must use a four-digit UTC year.')
  return value
}

export function validateTimeZone(timeZone: string): string {
  if (!timeZone || timeZone.trim() !== timeZone) {
    throw new ScheduleInputError('invalid_time_zone', 'timeZone must be a non-empty IANA zone without surrounding whitespace.')
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    throw new ScheduleInputError('invalid_time_zone', `Unknown IANA time zone: ${timeZone}`)
  }
}

function parseLocalDateTime(value: string): LocalParts {
  if (!LOCAL_DATE_TIME.test(value)) {
    throw new ScheduleInputError('invalid_schedule', 'startAt must use YYYY-MM-DDTHH:mm:ss local wall-clock form.')
  }
  const [date = '', time = ''] = value.split('T')
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute, second] = time.split(':').map(Number)
  const candidate = new Date(0)
  candidate.setUTCFullYear(year!, month! - 1, day!)
  candidate.setUTCHours(hour!, minute!, second!, 0)
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day ||
    candidate.getUTCHours() !== hour ||
    candidate.getUTCMinutes() !== minute ||
    candidate.getUTCSeconds() !== second
  ) {
    throw new ScheduleInputError('invalid_schedule', 'startAt must be a real local calendar time.')
  }
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second! }
}

function normalizeRuleText(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || /(?:^|\n)DTSTART[:;]/i.test(trimmed)) {
    throw new ScheduleInputError('invalid_schedule', 'rrule must contain a rule only; startAt and timeZone are separate fields.')
  }
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    throw new ScheduleInputError('invalid_schedule', 'rrule must be a single RRULE line.')
  }
  return trimmed.replace(/^RRULE:/i, '')
}

function floatingDate(parts: LocalParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second))
}

function localPartsAt(epoch: number, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const values = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map((part) => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  }
}

function offsetAt(epoch: number, timeZone: string): number {
  const parts = localPartsAt(epoch, timeZone)
  return floatingDate(parts).getTime() - epoch
}

function equalParts(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second
}

/** Resolve one wall-clock occurrence. Gaps are skipped; overlaps choose the earlier instant. */
function resolveLocalOccurrence(date: Date, timeZone: string): number | undefined {
  const parts: LocalParts = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  }
  const localEpoch = date.getTime()
  const offsets = new Set([
    offsetAt(localEpoch - 172_800_000, timeZone),
    offsetAt(localEpoch, timeZone),
    offsetAt(localEpoch + 172_800_000, timeZone),
  ])
  const candidates = [...offsets]
    .map((offset) => localEpoch - offset)
    .filter((candidate) => equalParts(localPartsAt(candidate, timeZone), parts))
    .sort((a, b) => a - b)
  return candidates[0]
}

function floatingNow(epoch: number, timeZone: string): Date {
  return floatingDate(localPartsAt(epoch, timeZone))
}

export function buildRule(schedule: RecurringSchedule): RRule {
  const start = parseLocalDateTime(schedule.startAt)
  validateTimeZone(schedule.timeZone)
  const text = `DTSTART:${floatingDate(start).toISOString().replaceAll('-', '').replaceAll(':', '').replace('.000', '')}\nRRULE:${normalizeRuleText(schedule.rrule)}`
  try {
    const parsed = rrulestr(text, { forceset: false })
    if (!('after' in parsed) || !('before' in parsed)) throw new Error('RRULE sets are not supported')
    return parsed as RRule
  } catch (error) {
    if (error instanceof ScheduleInputError) throw error
    throw new ScheduleInputError('invalid_schedule', `Invalid RRULE: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function validateSchedule(schedule: AutomationSchedule, now: number): AutomationSchedule {
  if (schedule.kind === 'once') {
    const epoch = Date.parse(schedule.fireAt)
    if (!ISO_INSTANT.test(schedule.fireAt) || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== schedule.fireAt) {
      throw new ScheduleInputError('invalid_schedule', 'fireAt must be a canonical RFC 3339 UTC instant.')
    }
    if (epoch <= now) throw new ScheduleInputError('not_future', 'fireAt must be strictly in the future.')
    return schedule
  }
  buildRule(schedule)
  return {
    ...schedule,
    rrule: normalizeRuleText(schedule.rrule),
    timeZone: validateTimeZone(schedule.timeZone),
  }
}

function nextRecurring(schedule: RecurringSchedule, after: number): number | undefined {
  const rule = buildRule(schedule)
  let floating = rule.after(floatingNow(after, schedule.timeZone), false)
  for (let attempts = 0; floating !== null && attempts < 10_000; attempts += 1) {
    const resolved = resolveLocalOccurrence(floating, schedule.timeZone)
    if (resolved !== undefined && resolved > after) return resolved
    floating = rule.after(floating, false)
  }
  return undefined
}

export function nextOccurrence(schedule: AutomationSchedule, after: number): number | undefined {
  if (schedule.kind === 'once') {
    const target = Date.parse(schedule.fireAt)
    return target > after ? target : undefined
  }
  return nextRecurring(schedule, after)
}

export function firstOccurrence(schedule: AutomationSchedule): number | undefined {
  if (schedule.kind === 'once') return Date.parse(schedule.fireAt)
  const start = floatingDate(parseLocalDateTime(schedule.startAt)).getTime()
  const rule = buildRule(schedule)
  let floating = rule.after(new Date(start - 1), false)
  for (let attempts = 0; floating !== null && attempts < 10_000; attempts += 1) {
    const resolved = resolveLocalOccurrence(floating, schedule.timeZone)
    if (resolved !== undefined) return resolved
    floating = rule.after(floating, false)
  }
  return undefined
}

export function latestDueOccurrence(
  schedule: AutomationSchedule,
  floor: number,
  now: number,
): number | undefined {
  if (floor > now) return undefined
  if (schedule.kind === 'once') {
    const target = Date.parse(schedule.fireAt)
    return target >= floor && target <= now ? target : undefined
  }
  const rule = buildRule(schedule)
  let floating = rule.before(floatingNow(now, schedule.timeZone), true)
  for (let attempts = 0; floating !== null && attempts < 10_000; attempts += 1) {
    const resolved = resolveLocalOccurrence(floating, schedule.timeZone)
    if (resolved !== undefined && resolved <= now) return resolved >= floor ? resolved : undefined
    floating = rule.before(floating, false)
  }
  return undefined
}
