export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type Weekday = typeof WEEKDAYS[number]

export interface CommonRRule {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  interval: string
  weekdays: Weekday[]
  monthDay: string
  end: 'never' | 'count' | 'until'
  count: string
  until: string
}

export function defaultCommonRRule(monthDay = '1'): CommonRRule {
  return { frequency: 'DAILY', interval: '1', weekdays: [], monthDay, end: 'never', count: '10', until: '' }
}

export function parseCommonRRule(value: string, defaultMonthDay = ''): CommonRRule | undefined {
  const text = value.trim().replace(/^RRULE:/i, '')
  if (!text || text.includes('\n') || text.includes('\r')) return undefined
  const fields = new Map<string, string>()
  for (const part of text.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) return undefined
    const key = part.slice(0, separator).toUpperCase()
    const field = part.slice(separator + 1).toUpperCase()
    if (!field || fields.has(key) || !['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL'].includes(key)) return undefined
    fields.set(key, field)
  }

  const frequency = fields.get('FREQ')
  if (frequency !== 'DAILY' && frequency !== 'WEEKLY' && frequency !== 'MONTHLY') return undefined
  const interval = fields.get('INTERVAL') ?? '1'
  if (!/^[1-9]\d*$/.test(interval)) return undefined

  const byDay = fields.get('BYDAY')
  const weekdays = byDay === undefined ? [] : byDay.split(',')
  if (byDay !== undefined && (frequency !== 'WEEKLY' || weekdays.some((day) => !WEEKDAYS.includes(day as Weekday)) || new Set(weekdays).size !== weekdays.length)) return undefined
  const byMonthDay = fields.get('BYMONTHDAY')
  if (byMonthDay !== undefined && (frequency !== 'MONTHLY' || !/^(?:[1-9]|[12]\d|3[01])$/.test(byMonthDay))) return undefined

  const count = fields.get('COUNT')
  const untilValue = fields.get('UNTIL')
  if (count !== undefined && (untilValue !== undefined || !/^[1-9]\d*$/.test(count))) return undefined
  const untilMatch = untilValue?.match(/^(\d{4})(\d{2})(\d{2})(?:T235959Z)?$/)
  if (untilValue !== undefined && untilMatch === null) return undefined
  const until = untilMatch == null ? '' : `${untilMatch[1]}-${untilMatch[2]}-${untilMatch[3]}`
  const untilEpoch = until ? Date.parse(`${until}T00:00:00Z`) : 0
  if (until && (!Number.isFinite(untilEpoch) || new Date(untilEpoch).toISOString().slice(0, 10) !== until)) return undefined

  return {
    frequency,
    interval,
    weekdays: weekdays as Weekday[],
    monthDay: byMonthDay ?? defaultMonthDay,
    end: count === undefined ? (until ? 'until' : 'never') : 'count',
    count: count ?? '10',
    until,
  }
}

export function buildCommonRRule(rule: CommonRRule): string {
  const fields = [`FREQ=${rule.frequency}`]
  if (rule.interval !== '1') fields.push(`INTERVAL=${rule.interval}`)
  if (rule.frequency === 'WEEKLY' && rule.weekdays.length > 0) {
    fields.push(`BYDAY=${WEEKDAYS.filter((day) => rule.weekdays.includes(day)).join(',')}`)
  }
  if (rule.frequency === 'MONTHLY' && rule.monthDay) fields.push(`BYMONTHDAY=${rule.monthDay}`)
  if (rule.end === 'count') fields.push(`COUNT=${rule.count}`)
  if (rule.end === 'until') fields.push(`UNTIL=${rule.until.replaceAll('-', '')}T235959Z`)
  return fields.join(';')
}
