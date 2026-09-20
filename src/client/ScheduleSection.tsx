import React from 'react'
import { Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AutomationTaskView } from '../types.js'
import { t as translate } from './i18n.js'
import { buildCommonRRule, defaultCommonRRule, parseCommonRRule, WEEKDAYS, type CommonRRule, type Weekday } from './rrule-editor.js'
import { Select } from './shared.js'
import { Field, Section } from './editor-layout.js'

const WEEKDAY_KEYS = {
  MO: 'weekdayMonday',
  TU: 'weekdayTuesday',
  WE: 'weekdayWednesday',
  TH: 'weekdayThursday',
  FR: 'weekdayFriday',
  SA: 'weekdaySaturday',
  SU: 'weekdaySunday',
} as const satisfies Record<Weekday, string>

const INTERVAL_UNIT_KEYS = {
  DAILY: 'intervalDays',
  WEEKLY: 'intervalWeeks',
  MONTHLY: 'intervalMonths',
} as const satisfies Record<CommonRRule['frequency'], string>

/** Instant as the value a `datetime-local` control expects. */
function toLocalDateTime(value: string): string {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
}

/** Keep both schedule modes while editing, and serialize only on valid submission. */
export function useScheduleEditor(task: AutomationTaskView) {
  const fallbackInstant = task.schedule.kind === 'once'
    ? task.schedule.fireAt
    : task.nextRunAt ?? new Date(Date.now() + 60 * 60_000).toISOString()
  const [kind, setKind] = React.useState<AutomationTaskView['schedule']['kind']>(task.schedule.kind)
  const [onceAt, setOnceAt] = React.useState(toLocalDateTime(fallbackInstant))
  const defaultMonthDay = String(Number((task.schedule.kind === 'recurring' ? task.schedule.startAt : toLocalDateTime(fallbackInstant)).slice(8, 10)))
  const initialRrule = task.schedule.kind === 'recurring' ? task.schedule.rrule : 'FREQ=DAILY'
  const initialCommonRule = parseCommonRRule(initialRrule, defaultMonthDay)
  const initialComparableRrule = initialCommonRule === undefined ? initialRrule : buildCommonRRule(initialCommonRule)
  const [rrule, setRrule] = React.useState(initialRrule)
  const [advancedRule, setAdvancedRule] = React.useState(initialCommonRule === undefined)
  const [commonRule, setCommonRule] = React.useState<CommonRRule>(initialCommonRule ?? defaultCommonRRule(defaultMonthDay))
  const [timeZone, setTimeZone] = React.useState(task.schedule.kind === 'recurring'
    ? task.schedule.timeZone
    : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [startAt, setStartAt] = React.useState(task.schedule.kind === 'recurring'
    ? task.schedule.startAt
    : toLocalDateTime(fallbackInstant))

  const normalizedStartAt = startAt.length === 16 ? `${startAt}:00` : startAt
  const effectiveRrule = advancedRule ? rrule : buildCommonRRule(commonRule)
  const parsedRawRule = parseCommonRRule(rrule, defaultMonthDay)
  const scheduleChanged = task.schedule.kind !== kind || (kind === 'once'
    ? task.schedule.kind !== 'once' || onceAt !== toLocalDateTime(task.schedule.fireAt)
    : task.schedule.kind !== 'recurring' || effectiveRrule !== initialComparableRrule || timeZone !== task.schedule.timeZone || normalizedStartAt !== task.schedule.startAt)
  const valid = kind === 'once'
    ? onceAt.trim() !== '' && Number.isFinite(new Date(onceAt).getTime())
    : effectiveRrule.trim() !== '' && timeZone.trim() !== '' && startAt.trim() !== ''
  const getSchedule = (): AutomationTaskView['schedule'] | undefined => !scheduleChanged
    ? undefined
    : kind === 'once'
      ? { kind: 'once', fireAt: new Date(onceAt).toISOString() }
      : { kind: 'recurring', rrule: effectiveRrule, timeZone, startAt: normalizedStartAt }

  return {
    kind, setKind, onceAt, setOnceAt, rrule, setRrule, advancedRule, setAdvancedRule,
    commonRule, setCommonRule, timeZone, setTimeZone, startAt, setStartAt, parsedRawRule,
    scheduleChanged, valid, getSchedule,
  }
}

/** One-time and recurring controls share the form's schedule draft. */
export function ScheduleSection({ schedule, saving, t }: {
  schedule: ReturnType<typeof useScheduleEditor>
  saving: boolean
  t: typeof translate
}) {
  const {
    kind, setKind, onceAt, setOnceAt, rrule, setRrule, advancedRule, setAdvancedRule,
    commonRule, setCommonRule, timeZone, setTimeZone, startAt, setStartAt, parsedRawRule,
  } = schedule
  return (
    <Section title={t('schedule')}>
      <Field label={t('scheduleType')}>
        <Select
          value={kind}
          disabled={saving}
          ariaLabel={t('scheduleType')}
          options={[
            { value: 'once', label: t('oneTimeSchedule') },
            { value: 'recurring', label: t('recurringSchedule') },
          ]}
          onChange={(next) => setKind(next as AutomationTaskView['schedule']['kind'])}
        />
      </Field>
      {kind === 'once' ? (
        <Field label={t('runAt')} htmlFor="am-once">
          <Input id="am-once" className="am-input" required type="datetime-local" step="1" disabled={saving} value={onceAt} onChange={(event) => setOnceAt(event.target.value)} />
        </Field>
      ) : (
        <>
          <div className="am-field is-full">
            <span className="am-field-label">{t('recurrenceRule')}</span>
            <div className="am-pill-group" role="group" aria-label={t('ruleMode')}>
              <Pill
                type="button"
                active={!advancedRule}
                disabled={saving || (advancedRule && parsedRawRule === undefined)}
                title={advancedRule && parsedRawRule === undefined ? t('unsupportedRuleHint') : undefined}
                onClick={() => {
                  if (parsedRawRule === undefined) return
                  setCommonRule(parsedRawRule)
                  setAdvancedRule(false)
                }}
              >
                {t('visualMode')}
              </Pill>
              <Pill
                type="button"
                active={advancedRule}
                disabled={saving}
                onClick={() => {
                  if (!advancedRule) setRrule(buildCommonRRule(commonRule))
                  setAdvancedRule(true)
                }}
              >
                {t('advancedMode')}
              </Pill>
            </div>
            {advancedRule ? (
              <div className="am-rule-advanced">
                <Input className="am-input" aria-label={t('recurrenceRule')} required disabled={saving} value={rrule} placeholder="FREQ=WEEKLY;BYDAY=MO" onChange={(event) => setRrule(event.target.value)} />
                <small className="am-field-hint">{parsedRawRule === undefined ? t('unsupportedRuleHint') : t('advancedRuleHint')}</small>
              </div>
            ) : (
              <div className="am-form-grid am-rule-builder">
                <Field label={t('frequency')}>
                  <Select
                    value={commonRule.frequency}
                    disabled={saving}
                    ariaLabel={t('frequency')}
                    options={[
                      { value: 'DAILY', label: t('frequencyDaily') },
                      { value: 'WEEKLY', label: t('frequencyWeekly') },
                      { value: 'MONTHLY', label: t('frequencyMonthly') },
                    ]}
                    onChange={(next) => setCommonRule({ ...commonRule, frequency: next as CommonRRule['frequency'] })}
                  />
                </Field>
                <Field label={t('repeatEvery')} htmlFor="am-interval">
                  <span className="am-interval">
                    <Input id="am-interval" className="am-input" required type="number" min="1" step="1" disabled={saving} value={commonRule.interval} onChange={(event) => setCommonRule({ ...commonRule, interval: event.target.value })} />
                    <span>{t(INTERVAL_UNIT_KEYS[commonRule.frequency])}</span>
                  </span>
                </Field>
                {commonRule.frequency === 'WEEKLY' && (
                  <Field
                    full
                    label={t('repeatOn')}
                    hint={commonRule.weekdays.length === 0 ? t('useStartDayHint') : undefined}
                  >
                    <div className="am-pill-group" role="group" aria-label={t('repeatOn')}>
                      {WEEKDAYS.map((day) => (
                        <Pill
                          key={day}
                          type="button"
                          active={commonRule.weekdays.includes(day)}
                          disabled={saving}
                          aria-pressed={commonRule.weekdays.includes(day)}
                          onClick={() => setCommonRule({
                            ...commonRule,
                            weekdays: commonRule.weekdays.includes(day)
                              ? commonRule.weekdays.filter((value) => value !== day)
                              : [...commonRule.weekdays, day],
                          })}
                        >
                          {t(WEEKDAY_KEYS[day])}
                        </Pill>
                      ))}
                    </div>
                  </Field>
                )}
                {commonRule.frequency === 'MONTHLY' && (
                  <Field label={t('monthlyOnDay')} htmlFor="am-monthday">
                    <Input id="am-monthday" className="am-input" required type="number" min="1" max="31" step="1" disabled={saving} value={commonRule.monthDay} onChange={(event) => setCommonRule({ ...commonRule, monthDay: event.target.value })} />
                  </Field>
                )}
                <Field label={t('ends')}>
                  <Select
                    value={commonRule.end}
                    disabled={saving}
                    ariaLabel={t('ends')}
                    options={[
                      { value: 'never', label: t('endsNever') },
                      { value: 'count', label: t('endsAfter') },
                      { value: 'until', label: t('endsOnDate') },
                    ]}
                    onChange={(next) => setCommonRule({ ...commonRule, end: next as CommonRRule['end'] })}
                  />
                </Field>
                {commonRule.end === 'count' && (
                  <Field label={t('occurrences')} htmlFor="am-count">
                    <Input id="am-count" className="am-input" required type="number" min="1" step="1" disabled={saving} value={commonRule.count} onChange={(event) => setCommonRule({ ...commonRule, count: event.target.value })} />
                  </Field>
                )}
                {commonRule.end === 'until' && (
                  <Field label={t('endDate')} htmlFor="am-until">
                    <Input id="am-until" className="am-input" required type="date" disabled={saving} value={commonRule.until} onChange={(event) => setCommonRule({ ...commonRule, until: event.target.value })} />
                  </Field>
                )}
              </div>
            )}
          </div>
          <Field label={t('timeZone')} htmlFor="am-tz">
            <Input id="am-tz" className="am-input" required disabled={saving} value={timeZone} placeholder="Asia/Shanghai" onChange={(event) => setTimeZone(event.target.value)} />
          </Field>
          <Field label={t('startsAt')} htmlFor="am-start">
            <Input id="am-start" className="am-input" required type="datetime-local" step="1" disabled={saving} value={startAt} onChange={(event) => setStartAt(event.target.value)} />
          </Field>
        </>
      )}
    </Section>
  )
}
