import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AutomationSchedulerHealth, AutomationTaskView } from '../types.js'
import { installLocale, t as translate, useLocale } from './i18n.js'
import { buildCommonRRule, defaultCommonRRule, parseCommonRRule, WEEKDAYS, type CommonRRule, type Weekday } from './rrule-editor.js'
import styles from './styles.css'

import '@deepseek-ai/dsh-client-runtime/client'
import '@deepseek-ai/dsh-client-ui-layout/client'
import '@deepseek-ai/dsh-client-ui-sidebar/client'

export const inject = ['slots', 'sessions', 'workspaces', 'locale']

const API = '/api/automation/v1'
const STYLE_ATTRIBUTE = 'data-dsh-automation-style'
let panelOpen = false
const panelListeners = new Set<() => void>()
const pendingDrafts = new Map<SessionId, string>()
const draftListeners = new Set<() => void>()
let draftRevision = 0

type OverlayProps = PropsRuntime<'shell.overlay'>
type InputDockProps = PropsRuntime<'conversation.input.dock'>
type IconName = 'calendar' | 'chevron' | 'clock' | 'close' | 'edit' | 'external' | 'folder' | 'pause' | 'play' | 'refresh' | 'shield' | 'trash'

const iconPaths: Record<IconName, string[]> = {
  calendar: ['M3 9h18', 'M7 3v4', 'M17 3v4', 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z'],
  chevron: ['m8 10 4 4 4-4'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 6v6l4 2'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
  external: ['M15 3h6v6', 'm10 14 11-11', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  folder: ['M3 7h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M3 7V5a2 2 0 0 1 2-2h4l2 2'],
  pause: ['M9 5v14', 'M15 5v14'],
  play: ['m8 5 11 7-11 7Z'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 8a8 8 0 0 1 13.4 2.5L20 12', 'M4 12l.5 1.5A8 8 0 0 0 17.9 16'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'm9 12 2 2 4-4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'm6 7 1 14h10l1-14', 'M10 11v6', 'M14 11v6'],
}

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {iconPaths[name].map((path) => <path key={path} d={path} />)}
    </svg>
  )
}

function installStyles(): () => void {
  if (document.querySelector(`style[${STYLE_ATTRIBUTE}]`) !== null) return () => undefined
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTRIBUTE, '')
  element.textContent = styles
  document.head.appendChild(element)
  return () => element.remove()
}

function setPanelOpen(open: boolean): void {
  panelOpen = open
  for (const listener of panelListeners) listener()
}

function usePanelOpen(): boolean {
  return React.useSyncExternalStore(
    (listener) => {
      panelListeners.add(listener)
      return () => panelListeners.delete(listener)
    },
    () => panelOpen,
  )
}

function queueDraft(sessionId: SessionId, text: string): void {
  pendingDrafts.set(sessionId, text)
  draftRevision += 1
  for (const listener of draftListeners) listener()
}

function consumeDraft(sessionId: SessionId): string | undefined {
  const text = pendingDrafts.get(sessionId)
  if (text === undefined) return undefined
  pendingDrafts.delete(sessionId)
  draftRevision += 1
  for (const listener of draftListeners) listener()
  return text
}

function DraftInjector({ sessionId, inputActions }: InputDockProps) {
  const revision = React.useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener)
      return () => draftListeners.delete(listener)
    },
    () => draftRevision,
  )

  React.useEffect(() => {
    const text = consumeDraft(sessionId)
    if (text !== undefined) inputActions.setDraft(text)
  }, [revision, sessionId, inputActions])

  return null
}

async function request(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'x-dsh-automation': '1',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
  })
  const value: unknown = await response.json()
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value
      ? String(value.error)
      : translate('requestFailed', { status: response.status })
    throw new Error(message)
  }
  return value
}

function AutomationButton({ wide }: { wide: boolean }) {
  const { t } = useLocale()
  return (
    <button
      type="button"
      className={`automation-nav-trigger ${wide ? 'is-wide' : 'is-rail'}`}
      aria-label={t('openAutomations')}
      title={t('automations')}
      onClick={() => setPanelOpen(true)}
    >
      <span className="automation-nav-icon"><Icon name="clock" size={18} /></span>
      {wide && <span className="automation-nav-label">{t('automations')}</span>}
    </button>
  )
}

function formatDate(value: string, locale: string): string {
  return new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

function scheduleLabel(task: AutomationTaskView, locale: string, t: typeof translate): string {
  if (task.schedule.kind === 'once') return `${t('once')} · ${formatDate(task.schedule.fireAt, locale)}`
  const rule = parseCommonRRule(task.schedule.rrule)
  if (rule === undefined) return `${task.schedule.rrule} · ${task.schedule.timeZone}`
  const interval = Number(rule.interval)
  const repeat = rule.frequency === 'DAILY'
    ? t(interval === 1 ? 'everyDay' : 'everyDays', { count: interval })
    : rule.frequency === 'WEEKLY'
      ? t(interval === 1 ? 'everyWeek' : 'everyWeeks', { count: interval })
      : t(interval === 1 ? 'everyMonth' : 'everyMonths', { count: interval })
  let detail = ''
  if (rule.frequency === 'WEEKLY' && rule.weekdays.length > 0) {
    const chinese = locale.toLowerCase().startsWith('zh')
    detail = rule.weekdays.map((day) => `${chinese ? '周' : ''}${t(WEEKDAY_KEYS[day])}`).join(chinese ? '、' : ', ')
  }
  if (rule.frequency === 'MONTHLY' && rule.monthDay) detail = t('dayOfMonth', { day: rule.monthDay })
  return [repeat, detail, task.schedule.timeZone].filter(Boolean).join(' · ')
}

function statusLabel(status: string, t: typeof translate): string {
  if (status === 'active') return t('statusActive')
  if (status === 'paused') return t('statusPaused')
  if (status === 'completed') return t('statusCompleted')
  if (status === 'queued') return t('statusQueued')
  if (status === 'running') return t('statusRunning')
  if (status === 'succeeded') return t('statusSucceeded')
  if (status === 'failed') return t('statusFailed')
  if (status === 'interrupted') return t('statusInterrupted')
  return status
}

function triggerLabel(trigger: string, t: typeof translate): string {
  if (trigger === 'manual') return t('triggerManual')
  if (trigger === 'scheduled') return t('triggerScheduled')
  return trigger
}

function statusClass(status: string): string {
  return ['active', 'paused', 'completed', 'queued', 'running', 'succeeded', 'failed', 'interrupted'].includes(status)
    ? `is-${status}`
    : 'is-neutral'
}

type TaskUpdateBody = Partial<Pick<AutomationTaskView, 'name' | 'prompt' | 'schedule'>>

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

function toLocalDateTime(value: string): string {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
}

function EditTaskForm({
  task,
  saving,
  t,
  onSave,
  onCancel,
}: {
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
  const changed = name.trim() !== task.name || prompt.trim() !== task.prompt || scheduleChanged

  return (
    <form
      className="automation-editor"
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
        })
      }}
    >
      <div className="automation-editor-heading">
        <span><Icon name="edit" />{t('editTask')}</span>
        <small>{t('editFutureRunsHint')}</small>
      </div>
      <fieldset disabled={saving}>
        <label className="automation-field">
          <span>{t('nameLabel')}</span>
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="automation-field is-full">
          <span>{t('promptLabel')}</span>
          <textarea required rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </label>
        <label className="automation-field">
          <span>{t('scheduleType')}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as AutomationTaskView['schedule']['kind'])}>
            <option value="once">{t('oneTimeSchedule')}</option>
            <option value="recurring">{t('recurringSchedule')}</option>
          </select>
        </label>
        {kind === 'once' ? (
          <label className="automation-field">
            <span>{t('runAt')}</span>
            <input required type="datetime-local" step="1" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} />
          </label>
        ) : (
          <>
            <div className="automation-field is-full">
              <span>{t('recurrenceRule')}</span>
              <div className="automation-rule-mode" role="group" aria-label={t('ruleMode')}>
                <button
                  type="button"
                  className={!advancedRule ? 'is-active' : undefined}
                  disabled={advancedRule && parsedRawRule === undefined}
                  title={advancedRule && parsedRawRule === undefined ? t('unsupportedRuleHint') : undefined}
                  onClick={() => {
                    if (parsedRawRule === undefined) return
                    setCommonRule(parsedRawRule)
                    setAdvancedRule(false)
                  }}
                >
                  {t('visualMode')}
                </button>
                <button
                  type="button"
                  className={advancedRule ? 'is-active' : undefined}
                  onClick={() => {
                    if (!advancedRule) setRrule(buildCommonRRule(commonRule))
                    setAdvancedRule(true)
                  }}
                >
                  {t('advancedMode')}
                </button>
              </div>
              {advancedRule ? (
                <div className="automation-rule-advanced">
                  <input required value={rrule} placeholder="FREQ=WEEKLY;BYDAY=MO" onChange={(event) => setRrule(event.target.value)} />
                  <small>{parsedRawRule === undefined ? t('unsupportedRuleHint') : t('advancedRuleHint')}</small>
                </div>
              ) : (
                <div className="automation-rule-builder">
                  <label className="automation-field">
                    <span>{t('frequency')}</span>
                    <select value={commonRule.frequency} onChange={(event) => setCommonRule({ ...commonRule, frequency: event.target.value as CommonRRule['frequency'] })}>
                      <option value="DAILY">{t('frequencyDaily')}</option>
                      <option value="WEEKLY">{t('frequencyWeekly')}</option>
                      <option value="MONTHLY">{t('frequencyMonthly')}</option>
                    </select>
                  </label>
                  <label className="automation-field">
                    <span>{t('repeatEvery')}</span>
                    <span className="automation-interval-control">
                      <input required type="number" min="1" step="1" value={commonRule.interval} onChange={(event) => setCommonRule({ ...commonRule, interval: event.target.value })} />
                      <b>{t(INTERVAL_UNIT_KEYS[commonRule.frequency])}</b>
                    </span>
                  </label>
                  {commonRule.frequency === 'WEEKLY' && (
                    <div className="automation-field is-full">
                      <span>{t('repeatOn')}</span>
                      <div className="automation-weekdays">
                        {WEEKDAYS.map((day) => (
                          <label key={day}>
                            <input
                              type="checkbox"
                              checked={commonRule.weekdays.includes(day)}
                              onChange={(event) => setCommonRule({
                                ...commonRule,
                                weekdays: event.target.checked
                                  ? [...commonRule.weekdays, day]
                                  : commonRule.weekdays.filter((value) => value !== day),
                              })}
                            />
                            <span>{t(WEEKDAY_KEYS[day])}</span>
                          </label>
                        ))}
                      </div>
                      {commonRule.weekdays.length === 0 && <small>{t('useStartDayHint')}</small>}
                    </div>
                  )}
                  {commonRule.frequency === 'MONTHLY' && (
                    <label className="automation-field">
                      <span>{t('monthlyOnDay')}</span>
                      <input required type="number" min="1" max="31" step="1" value={commonRule.monthDay} onChange={(event) => setCommonRule({ ...commonRule, monthDay: event.target.value })} />
                    </label>
                  )}
                  <label className="automation-field">
                    <span>{t('ends')}</span>
                    <select value={commonRule.end} onChange={(event) => setCommonRule({ ...commonRule, end: event.target.value as CommonRRule['end'] })}>
                      <option value="never">{t('endsNever')}</option>
                      <option value="count">{t('endsAfter')}</option>
                      <option value="until">{t('endsOnDate')}</option>
                    </select>
                  </label>
                  {commonRule.end === 'count' && (
                    <label className="automation-field">
                      <span>{t('occurrences')}</span>
                      <input required type="number" min="1" step="1" value={commonRule.count} onChange={(event) => setCommonRule({ ...commonRule, count: event.target.value })} />
                    </label>
                  )}
                  {commonRule.end === 'until' && (
                    <label className="automation-field">
                      <span>{t('endDate')}</span>
                      <input required type="date" value={commonRule.until} onChange={(event) => setCommonRule({ ...commonRule, until: event.target.value })} />
                    </label>
                  )}
                </div>
              )}
            </div>
            <label className="automation-field">
              <span>{t('timeZone')}</span>
              <input required value={timeZone} placeholder="Asia/Shanghai" onChange={(event) => setTimeZone(event.target.value)} />
            </label>
            <label className="automation-field">
              <span>{t('startsAt')}</span>
              <input required type="datetime-local" step="1" value={startAt} onChange={(event) => setStartAt(event.target.value)} />
            </label>
          </>
        )}
      </fieldset>
      <div className="automation-editor-actions">
        <button type="button" className="automation-button" disabled={saving} onClick={onCancel}>{t('cancel')}</button>
        <button type="submit" className="automation-button is-primary" disabled={saving || !changed}>
          {saving ? t('saving') : t('saveChanges')}
        </button>
      </div>
    </form>
  )
}

function AutomationPanel({ ctx, useSessions, useWorkspaces }: OverlayProps & { ctx: Context }) {
  const open = usePanelOpen()
  const { t, locale } = useLocale()
  const currentSessionId = useSessions((state) => state.current)
  const workspaceId = useWorkspaces((state) => {
    if (currentSessionId !== undefined) {
      const current = state.items.find((workspace) => workspace.sessionIds.includes(currentSessionId))
      if (current !== undefined) return current.workspaceId
    }
    return state.recentWorkspaceId
  })
  const [tasks, setTasks] = React.useState<AutomationTaskView[]>([])
  const [schedulerHealth, setSchedulerHealth] = React.useState<AutomationSchedulerHealth>()
  const [loading, setLoading] = React.useState(false)
  const [actingTaskId, setActingTaskId] = React.useState<string>()
  const [confirmingTaskId, setConfirmingTaskId] = React.useState<string>()
  const [editingTaskId, setEditingTaskId] = React.useState<string>()
  const [creatingExampleId, setCreatingExampleId] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const examples: Array<{ id: string; icon: IconName; title: string; description: string; prompt: string }> = [
    { id: 'release', icon: 'calendar', title: t('exampleReleaseTitle'), description: t('exampleReleaseDescription'), prompt: t('exampleReleasePrompt') },
    { id: 'dependencies', icon: 'shield', title: t('exampleDependenciesTitle'), description: t('exampleDependenciesDescription'), prompt: t('exampleDependenciesPrompt') },
    { id: 'handoff', icon: 'clock', title: t('exampleHandoffTitle'), description: t('exampleHandoffDescription'), prompt: t('exampleHandoffPrompt') },
  ]

  const refresh = React.useCallback(async () => {
    try {
      setLoading(true)
      const value = await request('/tasks') as { tasks: AutomationTaskView[]; scheduler: AutomationSchedulerHealth }
      setTasks(value.tasks)
      setSchedulerHealth(value.scheduler)
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  React.useEffect(() => {
    if (!open) {
      setConfirmingTaskId(undefined)
      setEditingTaskId(undefined)
      return
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (editingTaskId !== undefined) setEditingTaskId(undefined)
      else setPanelOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, editingTaskId])

  const act = React.useCallback(async (taskId: string, path: string, options: RequestInit) => {
    try {
      setActingTaskId(taskId)
      setError(undefined)
      await request(path, options)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActingTaskId(undefined)
    }
  }, [refresh])

  const updateTask = async (taskId: string, body: TaskUpdateBody): Promise<void> => {
    try {
      setActingTaskId(taskId)
      setError(undefined)
      await request(`/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(body) })
      await refresh()
      setEditingTaskId(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActingTaskId(undefined)
    }
  }

  const startExample = async (exampleId: string, prompt: string): Promise<void> => {
    if (workspaceId === undefined) {
      setError(t('workspaceUnavailable'))
      return
    }
    try {
      setCreatingExampleId(exampleId)
      setError(undefined)
      const sessionId = await ctx.workspaces.connectWorkspace(workspaceId)
      queueDraft(sessionId, prompt)
      ctx.sessions.open(sessionId)
      setPanelOpen(false)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(t('newConversationFailed', { error: message }))
    } finally {
      setCreatingExampleId(undefined)
    }
  }

  if (!open) return null

  return (
    <div
      className="automation-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPanelOpen(false)
      }}
    >
      <section className="automation-panel" role="dialog" aria-modal="true" aria-label={t('automations')} aria-busy={loading}>
        <header className="automation-panel-header">
          <div className="automation-heading-icon"><Icon name="clock" size={20} /></div>
          <div className="automation-heading-copy">
            <h2>{t('automations')}</h2>
            <p>{t('taskCount', { count: tasks.length })}</p>
          </div>
          <button type="button" className="automation-icon-button" onClick={() => void refresh()} disabled={loading} aria-label={t('refresh')} title={t('refresh')}>
            <span className={loading ? 'automation-spin' : undefined}><Icon name="refresh" /></span>
          </button>
          <button type="button" className="automation-icon-button" onClick={() => setPanelOpen(false)} aria-label={t('close')} title={t('close')}>
            <Icon name="close" />
          </button>
        </header>

        <div className="automation-panel-body automation-scroll">
          {error !== undefined && <div className="automation-error" role="alert">{error}</div>}
          {schedulerHealth?.status === 'retrying' && (
            <div className="automation-error" role="alert">{t('schedulerRetrying', { error: schedulerHealth.lastError ?? t('unknownError') })}</div>
          )}
          {schedulerHealth?.status === 'stopped' && (
            <div className="automation-error" role="alert">{t('schedulerStopped')}</div>
          )}

          {tasks.length === 0 && loading && (
            <div className="automation-empty" aria-live="polite">
              <span className="automation-empty-icon automation-spin"><Icon name="refresh" size={24} /></span>
              <h3>{t('loading')}</h3>
            </div>
          )}

          {tasks.length === 0 && !loading && (
            <div className="automation-empty is-examples">
              <span className="automation-empty-icon"><Icon name="clock" size={28} /></span>
              <h3>{t('noAutomations')}</h3>
              <p>{t('createHint')}</p>
              <div className="automation-examples">
                {examples.map((example) => (
                  <button
                    key={example.id}
                    type="button"
                    className="automation-example"
                    disabled={creatingExampleId !== undefined}
                    aria-busy={creatingExampleId === example.id}
                    onClick={() => void startExample(example.id, example.prompt)}
                  >
                    <span className="automation-example-icon"><Icon name={example.icon} /></span>
                    <span className="automation-example-copy">
                      <strong>{example.title}</strong>
                      <span>{creatingExampleId === example.id ? t('creatingConversation') : example.description}</span>
                    </span>
                    <Icon name="external" />
                  </button>
                ))}
              </div>
              <small>{t('exampleDraftHint')}</small>
            </div>
          )}

          <div className="automation-task-list">
            {tasks.map((task) => {
              const busy = task.running
              const pending = actingTaskId === task.id
              const confirming = confirmingTaskId === task.id
              const editing = editingTaskId === task.id
              const disabled = busy || pending
              const displayStatus = busy ? 'running' : task.status
              const latestSession = [...task.runs].reverse().find((run) => run.sessionId !== undefined)?.sessionId
              return (
                <article key={task.id} className={`automation-task-card ${statusClass(displayStatus)}`}>
                  <div className="automation-task-accent" />
                  <header className="automation-task-header">
                    <div className="automation-task-title">
                      <h3>{task.name}</h3>
                      <span className={`automation-status ${statusClass(displayStatus)}`}>
                        <span className="automation-status-dot" />
                        {statusLabel(displayStatus, t)}
                      </span>
                    </div>
                    <span className="automation-task-id" title={task.id}>{task.id}</span>
                  </header>

                  <div className="automation-task-facts">
                    <div className="automation-fact">
                      <Icon name="calendar" />
                      <span>{scheduleLabel(task, locale, t)}</span>
                    </div>
                    <div className="automation-fact">
                      <Icon name="clock" />
                      <span><b>{t('next')}</b>{task.nextRunAt === null ? '—' : formatDate(task.nextRunAt, locale)}</span>
                    </div>
                    <div className="automation-fact">
                      <Icon name="folder" />
                      <span><b>{t('workspace')}</b><code title={task.execution.cwd}>{task.execution.cwd}</code></span>
                    </div>
                  </div>

                  {editing ? (
                    <EditTaskForm
                      task={task}
                      saving={pending}
                      t={t}
                      onSave={(body) => void updateTask(task.id, body)}
                      onCancel={() => setEditingTaskId(undefined)}
                    />
                  ) : (
                  <div className="automation-task-actions">
                    <button type="button" className="automation-button is-primary" disabled={disabled} onClick={() => void act(task.id, `/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST' })}>
                      <Icon name="play" />{t('runNow')}
                    </button>
                    {task.status === 'active' && (
                      <button type="button" className="automation-button" disabled={pending} onClick={() => void act(task.id, `/tasks/${encodeURIComponent(task.id)}/pause`, { method: 'POST' })}>
                        <Icon name="pause" />{t('pause')}
                      </button>
                    )}
                    {task.status === 'paused' && (
                      <>
                        <button type="button" className="automation-button" disabled={pending} onClick={() => void act(task.id, `/tasks/${encodeURIComponent(task.id)}/resume`, { method: 'POST', body: JSON.stringify({ runNow: false }) })}>
                          <Icon name="play" />{t('resume')}
                        </button>
                        <button type="button" className="automation-button" disabled={disabled} onClick={() => void act(task.id, `/tasks/${encodeURIComponent(task.id)}/resume`, { method: 'POST', body: JSON.stringify({ runNow: true }) })}>
                          {t('resumeAndRun')}
                        </button>
                      </>
                    )}
                    {latestSession !== undefined && (
                      <button type="button" className="automation-button" onClick={() => ctx.sessions.open(latestSession as SessionId)}>
                        <Icon name="external" />{t('openLatestSession')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="automation-button"
                      disabled={pending}
                      onClick={() => {
                        setConfirmingTaskId(undefined)
                        setEditingTaskId(task.id)
                      }}
                    >
                      <Icon name="edit" />{t('edit')}
                    </button>
                    {confirming ? (
                      <div className="automation-delete-confirm" role="group" aria-label={t('deleteConfirm', { name: task.name })}>
                        <span>{t('deleteConfirm', { name: task.name })}</span>
                        <button type="button" className="automation-button" disabled={pending} onClick={() => setConfirmingTaskId(undefined)}>
                          {t('cancel')}
                        </button>
                        <button
                          type="button"
                          className="automation-button is-danger"
                          disabled={pending}
                          onClick={() => {
                            setConfirmingTaskId(undefined)
                            void act(task.id, `/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' })
                          }}
                        >
                          <Icon name="trash" />{t('confirmDelete')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="automation-icon-button is-danger automation-delete"
                        disabled={pending}
                        aria-label={t('delete')}
                        title={t('delete')}
                        onClick={() => setConfirmingTaskId(task.id)}
                      >
                        <Icon name="trash" />
                      </button>
                    )}
                  </div>
                  )}

                  {task.runs.length > 0 && (
                    <details className="automation-history">
                      <summary>
                        <span>{t('recentRuns', { count: task.runs.length })}</span>
                        <Icon name="chevron" />
                      </summary>
                      <ol>
                        {[...task.runs].reverse().map((run) => (
                          <li key={run.id}>
                            <span className={`automation-run-dot ${statusClass(run.status)}`} />
                            <div className="automation-run-copy">
                              <span className="automation-run-line">
                                <b>{statusLabel(run.status, t)}</b>
                                <span>·</span>
                                <span>{triggerLabel(run.trigger, t)}</span>
                              </span>
                              <time dateTime={run.startedAt ?? run.enqueuedAt}>{formatDate(run.startedAt ?? run.enqueuedAt, locale)}</time>
                              {run.error !== undefined && <p className="automation-run-error">{run.error}</p>}
                            </div>
                            {run.sessionId !== undefined && (
                              <button type="button" className="automation-button is-compact" onClick={() => ctx.sessions.open(run.sessionId as SessionId)}>
                                {t('open')}<Icon name="external" size={14} />
                              </button>
                            )}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </article>
              )
            })}
          </div>
        </div>
      </section>
    </div>
  )
}

export function apply(ctx: Context): () => void {
  const disposers = [
    installStyles(),
    installLocale(ctx),
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'automation', order: 50, label: () => translate('automations') },
      AutomationButton,
    )),
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
      { name: 'conversation.input.dock', id: 'automation-example-draft', order: 100 },
      DraftInjector,
    )),
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'automation-panel', order: 50, label: () => translate('automations') },
      (props: OverlayProps) => <AutomationPanel {...props} ctx={ctx} />,
    )),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    setPanelOpen(false)
  }
}
