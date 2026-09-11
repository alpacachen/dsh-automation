import React from 'react'
import {
  Button,
  Input,
  Pill,
  Switch,
  Tag,
  IconCloseOutline16,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentConfigurationOptions, AutomationExecutionPatch, AutomationTaskView } from '../types.js'
import { t as translate } from './i18n.js'
import { buildCommonRRule, defaultCommonRRule, parseCommonRRule, WEEKDAYS, type CommonRRule, type Weekday } from './rrule-editor.js'
import { Select, type SelectOption } from './shared.js'
import { request } from './store.js'

/** The PATCH body shape the controller accepts. */
export type TaskUpdateBody = Partial<Pick<AutomationTaskView, 'name' | 'prompt' | 'schedule' | 'notificationPolicy' | 'pauseAfterConsecutiveFailures'>> & {
  permissionPreset?: AutomationTaskView['security']['permissionPreset']
  confirmPermissionChange?: true
  execution?: AutomationExecutionPatch
}

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

/** One labelled form row. */
function Field({ label, children, full, hint, htmlFor }: {
  label: string
  children: React.ReactNode
  full?: boolean
  hint?: string | undefined
  htmlFor?: string | undefined
}) {
  return (
    <div className={full === true ? 'am-field is-full' : 'am-field'}>
      <label className="am-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint !== undefined && <small className="am-field-hint">{hint}</small>}
    </div>
  )
}

/** One titled group of form rows. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="am-form-section">
      <h4 className="am-form-section-title">{title}</h4>
      <div className="am-form-grid">{children}</div>
    </section>
  )
}

/**
 * Filterable skill picker showing each skill's description and invocability,
 * with the current selection restated as removable chips.
 */
function SkillPicker({ skills, options, disabled, t, onChange }: {
  skills: readonly string[]
  options: AgentConfigurationOptions | undefined
  disabled: boolean
  t: typeof translate
  onChange: (next: string[]) => void
}) {
  const [query, setQuery] = React.useState('')
  // Selected-but-missing skills stay listed so a stale selection is visible
  // rather than silently dropped.
  const names = [...new Set([...skills, ...(options?.skills.map((entry) => entry.name) ?? [])])]
  const needle = query.trim().toLowerCase()
  const shown = needle === '' ? names : names.filter((name) => {
    const option = options?.skills.find((entry) => entry.name === name)
    return name.toLowerCase().includes(needle) || (option?.description ?? '').toLowerCase().includes(needle)
  })
  return (
    <div className="am-skills">
      <div className="am-skills-bar">
        <Input
          icon={<IconSearchOutline16 />}
          value={query}
          disabled={disabled}
          placeholder={t('skillSearchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {skills.length > 0 && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange([])}>
            {t('clearSkills')}
          </Button>
        )}
      </div>
      {skills.length > 0 && (
        <div className="am-skill-chips">
          <span className="am-skills-count">{t('selectedCount', { count: skills.length })}</span>
          {skills.map((name) => (
            <button
              key={name}
              type="button"
              className="am-chip-remove"
              disabled={disabled}
              aria-label={`${name} · ${t('cancel')}`}
              onClick={() => onChange(skills.filter((entry) => entry !== name))}
            >
              {name}
              <IconCloseOutline16 size={12} />
            </button>
          ))}
        </div>
      )}
      <div className="am-skill-list">
        {shown.map((name) => {
          const option = options?.skills.find((entry) => entry.name === name)
          return (
            <label key={name} className={option === undefined ? 'am-skill is-unavailable' : 'am-skill'}>
              <input
                type="checkbox"
                checked={skills.includes(name)}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked ? [...skills, name] : skills.filter((entry) => entry !== name))}
              />
              <span className="am-skill-copy">
                <b>{name}</b>
                <small>
                  {option === undefined ? t('unavailable') : option.description}
                  {option?.modelInvocable === true ? ` · ${t('modelInvocable')}` : ''}
                </small>
              </span>
            </label>
          )
        })}
        {shown.length === 0 && (
          <small className="am-empty-note">{names.length === 0 ? t('noSkills') : t('noSkillMatches')}</small>
        )}
      </div>
    </div>
  )
}

/**
 * Edit one automation in place in the detail pane.
 * @param props.task - the automation being edited.
 * @param props.saving - a write is in flight; every control locks.
 * @returns the editor form.
 */
export function TaskEditor({ task, saving, t, onSave, onCancel }: {
  task: AutomationTaskView
  saving: boolean
  t: typeof translate
  onSave: (body: TaskUpdateBody) => void
  onCancel: () => void
}) {
  const fallbackInstant = task.schedule.kind === 'once'
    ? task.schedule.fireAt
    : task.nextRunAt ?? new Date(Date.now() + 60 * 60_000).toISOString()
  const [name, setName] = React.useState(task.name)
  const [prompt, setPrompt] = React.useState(task.prompt)
  const [notificationPolicy, setNotificationPolicy] = React.useState(task.notificationPolicy)
  const [pauseAfterFailures, setPauseAfterFailures] = React.useState(task.pauseAfterConsecutiveFailures)
  const [permissionPreset, setPermissionPreset] = React.useState(task.security.permissionPreset)
  const [permissionConfirmed, setPermissionConfirmed] = React.useState(false)
  const [agentPreset, setAgentPreset] = React.useState(task.execution.agentPreset ?? '')
  const [provider, setProvider] = React.useState(task.execution.provider ?? '')
  const [model, setModel] = React.useState(task.execution.model ?? '')
  const [skills, setSkills] = React.useState<string[]>(task.execution.skills)
  const [options, setOptions] = React.useState<AgentConfigurationOptions>()
  const [optionsLoading, setOptionsLoading] = React.useState(true)
  const [optionsError, setOptionsError] = React.useState<string>()
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
  const permissionChanged = permissionPreset !== task.security.permissionPreset
  const modelChanged = provider !== (task.execution.provider ?? '') || model !== (task.execution.model ?? '')
  const executionChanged = agentPreset !== (task.execution.agentPreset ?? '') || modelChanged ||
    skills.join('\0') !== task.execution.skills.join('\0')
  const changed = name.trim() !== task.name || prompt.trim() !== task.prompt || scheduleChanged || permissionChanged ||
    executionChanged || notificationPolicy !== task.notificationPolicy || pauseAfterFailures !== task.pauseAfterConsecutiveFailures
  const selectedPermission = options?.permissions.find((entry) => entry.id === permissionPreset)
  const selectedProvider = options?.models.find((entry) => entry.provider === provider)
  const selectedPresetAvailable = agentPreset === '' || options?.presets.some((entry) => entry.id === agentPreset && entry.broken === undefined)
  const skillsAvailable = skills.every((entry) => options?.skills.some((option) => option.name === entry))
  const legacyPartialModelUnchanged = !modelChanged && ((task.execution.provider === undefined) !== (task.execution.model === undefined))
  const configValid = selectedPresetAvailable !== false && skillsAvailable && selectedPermission !== undefined &&
    (((provider === '') === (model === '')) || legacyPartialModelUnchanged)
  const blocked = saving || optionsLoading || !configValid || !changed || (permissionChanged && !permissionConfirmed)

  const loadOptions = React.useCallback(async (candidate?: string) => {
    try {
      setOptionsLoading(true)
      setOptionsError(undefined)
      const query = candidate === undefined ? '' : `?agentPreset=${encodeURIComponent(candidate)}`
      const value = await request(`/tasks/${encodeURIComponent(task.id)}/options${query}`) as { options: AgentConfigurationOptions }
      setOptions(value.options)
    } catch (reason) {
      setOptionsError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOptionsLoading(false)
    }
  }, [task.id])

  React.useEffect(() => { void loadOptions() }, [loadOptions])

  const presetOptions: SelectOption[] = [
    { value: '', label: t('hostDefault') },
    ...(agentPreset !== '' && options?.presets.some((entry) => entry.id === agentPreset) !== true
      ? [{ value: agentPreset, label: `${agentPreset} · ${t('unavailable')}` }]
      : []),
    ...(options?.presets ?? []).map((entry) => ({
      value: entry.id,
      label: `${entry.name} · ${entry.trust}${entry.broken === undefined ? '' : ` · ${t('unavailable')}`}`,
      ...(entry.description === undefined ? {} : { hint: entry.description }),
      ...(entry.broken === undefined ? {} : { disabled: true }),
    })),
  ]
  const providerOptions: SelectOption[] = [
    { value: '', label: t('hostDefault') },
    ...(provider !== '' && options?.models.some((entry) => entry.provider === provider) !== true
      ? [{ value: provider, label: `${provider} · ${t('unavailable')}` }]
      : []),
    ...(options?.models ?? []).map((entry) => ({ value: entry.provider, label: entry.name })),
  ]
  const modelOptions: SelectOption[] = [
    { value: '', label: provider === '' ? t('hostDefault') : t('selectModel') },
    ...(model !== '' && selectedProvider?.models.some((entry) => entry.id === model) !== true
      ? [{ value: model, label: `${model} · ${t('notInCatalog')}` }]
      : []),
    ...(selectedProvider?.models ?? []).map((entry) => ({
      value: entry.id,
      label: entry.name,
      ...(entry.description === undefined ? {} : { hint: entry.description }),
    })),
  ]
  const permissionOptions: SelectOption[] = [
    ...(options?.permissions.some((entry) => entry.id === permissionPreset) !== true
      ? [{ value: permissionPreset, label: `${permissionPreset} · ${t('unavailable')}` }]
      : []),
    ...(options?.permissions ?? []).map((entry) => ({
      value: entry.id,
      label: entry.name,
      ...(entry.description === undefined ? {} : { hint: entry.description }),
    })),
  ]

  return (
    <form
      className="am-editor"
      onSubmit={(event) => {
        event.preventDefault()
        const schedule: AutomationTaskView['schedule'] | undefined = !scheduleChanged
          ? undefined
          : kind === 'once'
            ? { kind: 'once', fireAt: new Date(onceAt).toISOString() }
            : { kind: 'recurring', rrule: effectiveRrule, timeZone, startAt: normalizedStartAt }
        onSave({
          ...(name.trim() === task.name ? {} : { name }),
          ...(prompt.trim() === task.prompt ? {} : { prompt }),
          ...(schedule === undefined ? {} : { schedule }),
          ...(notificationPolicy === task.notificationPolicy ? {} : { notificationPolicy }),
          ...(pauseAfterFailures === task.pauseAfterConsecutiveFailures ? {} : { pauseAfterConsecutiveFailures: pauseAfterFailures }),
          ...(permissionChanged ? { permissionPreset, confirmPermissionChange: true as const } : {}),
          ...(executionChanged ? {
            execution: {
              ...(agentPreset === (task.execution.agentPreset ?? '') ? {} : { agentPreset: agentPreset || null }),
              ...((provider === (task.execution.provider ?? '') && model === (task.execution.model ?? '')) ? {} : {
                provider: provider || null,
                model: model || null,
              }),
              ...(skills.join('\0') === task.execution.skills.join('\0') ? {} : { skills }),
            },
          } : {}),
        })
      }}
    >
      <div className="am-editor-scroll">
        <p className="am-editor-hint">{t('editFutureRunsHint')}</p>

        <Section title={t('sectionBasics')}>
          <Field full label={t('nameLabel')} htmlFor="am-name">
            <input id="am-name" className="am-input" required disabled={saving} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field full label={t('promptLabel')} htmlFor="am-prompt">
            <textarea id="am-prompt" className="am-textarea" required rows={6} disabled={saving} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </Field>
        </Section>

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
              <input id="am-once" className="am-input" required type="datetime-local" step="1" disabled={saving} value={onceAt} onChange={(event) => setOnceAt(event.target.value)} />
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
                    <input className="am-input" required disabled={saving} value={rrule} placeholder="FREQ=WEEKLY;BYDAY=MO" onChange={(event) => setRrule(event.target.value)} />
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
                        <input id="am-interval" className="am-input" required type="number" min="1" step="1" disabled={saving} value={commonRule.interval} onChange={(event) => setCommonRule({ ...commonRule, interval: event.target.value })} />
                        <b>{t(INTERVAL_UNIT_KEYS[commonRule.frequency])}</b>
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
                        <input id="am-monthday" className="am-input" required type="number" min="1" max="31" step="1" disabled={saving} value={commonRule.monthDay} onChange={(event) => setCommonRule({ ...commonRule, monthDay: event.target.value })} />
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
                        <input id="am-count" className="am-input" required type="number" min="1" step="1" disabled={saving} value={commonRule.count} onChange={(event) => setCommonRule({ ...commonRule, count: event.target.value })} />
                      </Field>
                    )}
                    {commonRule.end === 'until' && (
                      <Field label={t('endDate')} htmlFor="am-until">
                        <input id="am-until" className="am-input" required type="date" disabled={saving} value={commonRule.until} onChange={(event) => setCommonRule({ ...commonRule, until: event.target.value })} />
                      </Field>
                    )}
                  </div>
                )}
              </div>
              <Field label={t('timeZone')} htmlFor="am-tz">
                <input id="am-tz" className="am-input" required disabled={saving} value={timeZone} placeholder="Asia/Shanghai" onChange={(event) => setTimeZone(event.target.value)} />
              </Field>
              <Field label={t('startsAt')} htmlFor="am-start">
                <input id="am-start" className="am-input" required type="datetime-local" step="1" disabled={saving} value={startAt} onChange={(event) => setStartAt(event.target.value)} />
              </Field>
            </>
          )}
        </Section>

        <Section title={t('agentExecution')}>
          {optionsError !== undefined && <p className="am-alert is-error is-full" role="alert">{t('optionsFailure', { error: optionsError })}</p>}
          {optionsLoading && <p className="am-alert is-info is-full" aria-live="polite">{t('optionsLoading')}</p>}
          <Field
            full
            label={t('agentPreset')}
            hint={agentPreset === '' ? undefined : options?.presets.find((entry) => entry.id === agentPreset)?.description}
          >
            <Select
              value={agentPreset}
              disabled={saving || optionsLoading}
              ariaLabel={t('agentPreset')}
              options={presetOptions}
              onChange={(next) => {
                setAgentPreset(next)
                void loadOptions(next)
              }}
            />
          </Field>
          <Field label={t('provider')}>
            <Select
              value={provider}
              disabled={saving || optionsLoading}
              ariaLabel={t('provider')}
              options={providerOptions}
              onChange={(next) => {
                setProvider(next)
                setModel('')
              }}
            />
          </Field>
          <Field label={t('model')}>
            <Select
              value={model}
              disabled={saving || optionsLoading || provider === ''}
              ariaLabel={t('model')}
              options={modelOptions}
              onChange={setModel}
            />
          </Field>
          {options?.modelFailures.map((failure) => (
            <p key={failure.provider} className="am-alert is-error is-full" role="alert">
              {t('providerFailure', { provider: failure.provider, error: failure.error })}
            </p>
          ))}
          <Field full label={t('selectedSkills')}>
            <SkillPicker skills={skills} options={options} disabled={saving || optionsLoading} t={t} onChange={setSkills} />
          </Field>
        </Section>

        <Section title={t('notifications')}>
          <Field label={t('notifications')}>
            <Select
              value={notificationPolicy}
              disabled={saving}
              ariaLabel={t('notifications')}
              options={[
                { value: 'failures', label: t('notificationFailures') },
                { value: 'always', label: t('notificationAlways') },
                { value: 'never', label: t('notificationNever') },
              ]}
              onChange={(next) => setNotificationPolicy(next as AutomationTaskView['notificationPolicy'])}
            />
          </Field>
          <Field label={t('pauseAfterFailures')}>
            <Switch
              checked={pauseAfterFailures}
              disabled={saving}
              label={t('pauseAfterFailures')}
              onChange={setPauseAfterFailures}
            />
          </Field>
        </Section>

        <Section title={t('permission')}>
          <Field
            full
            label={t('permission')}
            hint={selectedPermission === undefined
              ? undefined
              : [selectedPermission.description, `${selectedPermission.sandbox} · approval: ${selectedPermission.approval}`].filter(Boolean).join(' · ')}
          >
            <Select
              value={permissionPreset}
              disabled={saving || optionsLoading}
              ariaLabel={t('permission')}
              options={permissionOptions}
              onChange={(next) => {
                setPermissionPreset(next)
                setPermissionConfirmed(false)
              }}
            />
          </Field>
          {selectedPermission?.approval === 'ask' && (
            <p className="am-alert is-warning is-full" role="alert">{t('approvalAskWarning')}</p>
          )}
          {permissionChanged && (
            <div className="am-alert is-warning is-full am-confirm">
              <Switch
                checked={permissionConfirmed}
                disabled={saving}
                label={t('confirmPermissionChange', { permission: selectedPermission?.name ?? permissionPreset })}
                onChange={setPermissionConfirmed}
              />
              <span aria-hidden="true">{t('confirmPermissionChange', { permission: selectedPermission?.name ?? permissionPreset })}</span>
            </div>
          )}
        </Section>
      </div>

      <footer className="am-editor-footer">
        {!configValid && !optionsLoading && <Tag tone="danger">{t('unavailable')}</Tag>}
        <span className="am-spacer" />
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" size="sm" disabled={blocked}>
          {saving ? t('saving') : t('saveChanges')}
        </Button>
      </footer>
    </form>
  )
}
