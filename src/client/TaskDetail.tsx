import React from 'react'
import {
  Button,
  DisclosureRow,
  Menu,
  StateDot,
  Tooltip,
  IconAgentPresetOutline16,
  IconChevronLeftOutline14,
  IconClockOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderOpenOutline16,
  IconPauseOutline16,
  IconPlayOutline16,
  IconRightUpOutline14,
  IconRightUpOutline16,
  IconStopFill16,
  IconTrashOutline16,
  IconWarningOutline16,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AutomationTaskView } from '../types.js'
import { t as translate } from './i18n.js'
import { parseCommonRRule, WEEKDAYS, type Weekday } from './rrule-editor.js'
import {
  basename,
  CopyButton,
  Fact,
  formatDate,
  formatRelative,
  formatRunDuration,
  IconBell,
  IconCalendar,
  IconShield,
  statusLabel,
  statusState,
  triggerLabel,
} from './shared.js'

const WEEKDAY_KEYS = {
  MO: 'weekdayMonday',
  TU: 'weekdayTuesday',
  WE: 'weekdayWednesday',
  TH: 'weekdayThursday',
  FR: 'weekdayFriday',
  SA: 'weekdaySaturday',
  SU: 'weekdaySunday',
} as const satisfies Record<Weekday, string>

/** Human sentence for a task's schedule, whichever kind it is. */
export function scheduleLabel(task: AutomationTaskView, locale: string, t: typeof translate): string {
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
    detail = WEEKDAYS.filter((day) => rule.weekdays.includes(day))
      .map((day) => t('weekdayLabel', { day: t(WEEKDAY_KEYS[day]) }))
      .join(t('weekdaySeparator'))
  }
  if (rule.frequency === 'MONTHLY' && rule.monthDay) detail = t('dayOfMonth', { day: rule.monthDay })
  return [repeat, detail, task.schedule.startAt.slice(11, 16), task.schedule.timeZone].filter(Boolean).join(' · ')
}

/** Localized notification policy. */
function notificationPolicyLabel(policy: AutomationTaskView['notificationPolicy'], t: typeof translate): string {
  if (policy === 'always') return t('notificationAlways')
  if (policy === 'never') return t('notificationNever')
  return t('notificationFailures')
}

/** Resolved agent preset / model / skills, with Host defaults named. */
function executionLabel(task: AutomationTaskView, t: typeof translate): string {
  const preset = task.execution.agentPreset ?? t('hostDefault')
  const model = task.execution.provider === undefined ? t('hostDefault') : `${task.execution.provider}/${task.execution.model}`
  const skills = task.execution.skills.length === 0 ? t('noSelectedSkills') : task.execution.skills.join(', ')
  return `${preset} · ${model} · ${skills}`
}

/** Display name for a permission preset, preferring the Host's own label. */
export function permissionLabel(preset: string, t: typeof translate, displayName?: string): string {
  if (displayName !== undefined) return displayName
  if (preset === 'read-only') return t('permissionReadOnly')
  if (preset === 'danger-full-access') return t('permissionFullAccess')
  return preset
}

function deliveryStatusLabel(status: NonNullable<AutomationTaskView['runs'][number]['delivery']>['status'], t: typeof translate): string {
  const keys = { sending: 'deliverySending', sent: 'deliverySent', failed: 'deliveryFailed', unknown: 'deliveryUnknown' } as const
  return t(keys[status])
}

/** Statuses whose run row offers a retry. */
const RETRYABLE = ['failed', 'timed_out', 'interrupted', 'outcome_unknown']

/**
 * One run in the history list: collapsed to a single scannable line, expanded
 * to every field the API records for it.
 */
function RunRow({ run, locale, t, disabled, pending, onRetry, onOpen, onDelete }: {
  run: AutomationTaskView['runs'][number]
  locale: string
  t: typeof translate
  disabled: boolean
  pending: boolean
  onRetry: () => void
  onOpen: (sessionId: SessionId) => void
  onDelete: (trigger: HTMLButtonElement) => void
}) {
  const [open, setOpen] = React.useState(false)
  const duration = formatRunDuration(run.startedAt, run.finishedAt, locale)
  const deleteBlocked = run.status === 'queued' || run.status === 'running' || run.delivery?.status === 'sending'
  return (
    <DisclosureRow
      className="am-run"
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => setOpen((current) => !current)}
      icon={<StateDot state={statusState(run.status)} size={8} />}
      title={statusLabel(run.status, t)}
      collapsedContent={
        <span className="am-run-line">
          <span>{triggerLabel(run.trigger, t)}</span>
          {duration !== undefined && <><span aria-hidden="true">·</span><span>{duration}</span></>}
          <span aria-hidden="true">·</span>
          <time dateTime={run.startedAt ?? run.enqueuedAt}>{formatDate(run.startedAt ?? run.enqueuedAt, locale)}</time>
          {run.delivery !== undefined && <span className={run.delivery.status === 'failed' ? 'am-status am-danger' : 'am-status'}>
            {t('messageDelivery')} · {deliveryStatusLabel(run.delivery.status, t)}
          </span>}
        </span>
      }
    >
      <div className="am-run-body">
        {run.summary !== undefined && <p className="am-run-summary">{run.summary}</p>}
        {run.error !== undefined && <p className="am-alert is-error">{run.error}</p>}
        {run.delivery?.error !== undefined && <p className="am-alert is-error">{t('deliveryError', { error: run.delivery.error })}</p>}
        <dl className="am-run-facts">
          <dt>{t('trigger')}</dt><dd>{triggerLabel(run.trigger, t)}</dd>
          {run.scheduledAt !== undefined && <><dt>{t('schedule')}</dt><dd>{formatDate(run.scheduledAt, locale)}</dd></>}
          <dt>{t('enqueuedAt')}</dt><dd>{formatDate(run.enqueuedAt, locale)}</dd>
          {run.startedAt !== undefined && <><dt>{t('startedAt')}</dt><dd>{formatDate(run.startedAt, locale)}</dd></>}
          {run.finishedAt !== undefined && <><dt>{t('finishedAt')}</dt><dd>{formatDate(run.finishedAt, locale)}</dd></>}
          {duration !== undefined && <><dt>{t('duration')}</dt><dd>{duration}</dd></>}
          {run.executionTarget !== undefined && (
            <>
              <dt>{t('runTarget')}</dt>
              <dd>
                {run.executionTarget.mode === 'pinned-session'
                  ? t('executionPinned', { sessionId: `${(run.executionTarget.sessionId ?? '').slice(0, 12)}…` })
                  : t('executionFresh')}
              </dd>
            </>
          )}
          {run.sessionId !== undefined && (
            <>
              <dt>{t('openSession')}</dt>
              <dd className="am-mono-row"><code>{run.sessionId}</code><CopyButton value={run.sessionId} t={t} /></dd>
            </>
          )}
          {run.delivery !== undefined && <>
            <dt>{t('messageDelivery')}</dt><dd>{deliveryStatusLabel(run.delivery.status, t)}</dd>
            <dt>{t('deliveryBot')}</dt><dd><code>{run.delivery.botId}</code></dd>
            <dt>{t('deliveryTarget')}</dt><dd><code>{run.delivery.targetId}</code></dd>
            <dt>{t('deliveryAttemptedAt')}</dt><dd>{formatDate(run.delivery.attemptedAt, locale)}</dd>
            {run.delivery.finishedAt !== undefined && <><dt>{t('deliveryFinishedAt')}</dt><dd>{formatDate(run.delivery.finishedAt, locale)}</dd></>}
          </>}
          <dt>{t('runId')}</dt>
          <dd className="am-mono-row"><code>{run.id}</code><CopyButton value={run.id} t={t} /></dd>
        </dl>
        <div className="am-run-actions">
          {RETRYABLE.includes(run.status) && (
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onRetry}>{t('retry')}</Button>
          )}
          {run.sessionId !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<IconRightUpOutline14 />}
              onClick={() => onOpen(run.sessionId as SessionId)}
            >
              {t('open')}
            </Button>
          )}
          <span className="am-spacer" />
          <Tooltip label={t('deleteRunBlocked')} disabled={!deleteBlocked} side="top">
            <span>
              <Button type="button" variant="ghost" size="sm" data-am-delete-run={run.id} disabled={pending || deleteBlocked} onClick={(event) => onDelete(event.currentTarget)}>
                {t('deleteRun')}
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>
    </DisclosureRow>
  )
}

/** Callbacks the detail pane needs from the panel. */
export interface TaskDetailActions {
  run: () => void
  stop: () => void
  pause: () => void
  resume: (runNow: boolean) => void
  edit: () => void
  requestDelete: () => void
  requestDeleteRun: (run: AutomationTaskView['runs'][number], trigger: HTMLButtonElement) => void
  openSession: (sessionId: SessionId) => void
  back: () => void
}

/**
 * A focused overview with run history and configuration available on demand.
 * @param props.task - the selected automation.
 * @param props.pending - a write for this task is in flight.
 * @returns the detail pane.
 */
export function TaskDetail({ task, locale, t, pending, actions }: {
  task: AutomationTaskView
  locale: string
  t: typeof translate
  pending: boolean
  actions: TaskDetailActions
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [view, setView] = React.useState<'overview' | 'runHistory' | 'configuration'>('overview')
  const busy = task.running
  const disabled = busy || pending
  const displayStatus = busy ? 'running' : task.status
  const latestResult = [...task.runs].reverse().find((run) => run.summary !== undefined)
  const latestSession = [...task.runs].reverse().find((run) => run.sessionId !== undefined)?.sessionId
    ?? (task.execution.target?.mode === 'pinned-session' ? task.execution.target.sessionId : undefined)

  const menuItems: MenuEntry[] = [
    ...(latestSession === undefined ? [] : [{
      id: 'open-latest',
      label: t('openLatestSession'),
      icon: <IconRightUpOutline16 />,
    }]),
    ...(task.status === 'paused' ? [{ id: 'resume-run', label: t('resumeAndRun'), icon: <IconPlayOutline16 />, disabled }] : []),
    { type: 'separator' as const, id: 'sep' },
    { id: 'delete', label: t('delete'), icon: <IconTrashOutline16 />, danger: true, disabled: pending },
  ]

  return (
    <div className="am-detail">
      <header className="am-detail-header">
        <button type="button" className="am-back" aria-label={t('backToList')} onClick={actions.back}>
          <IconChevronLeftOutline14 />
        </button>
        <div className="am-detail-title">
          <h3>{task.name}</h3>
          <div className="am-detail-badges">
            <span className="am-status"><StateDot state={statusState(displayStatus)} size={7} />{statusLabel(displayStatus, t)}</span>
            <span className="am-detail-workspace" title={task.execution.cwd}>{basename(task.execution.cwd)}</span>
            {task.consecutiveFailures > 0 && (
              <Tooltip label={`${t('consecutiveFailures')} · ${task.consecutiveFailures}`} side="top">
                <span className="am-failure-chip">
                  <IconWarningOutline16 size={12} />
                  {task.consecutiveFailures}
                </span>
              </Tooltip>
            )}
          </div>
        </div>
        <Button type="button" data-am-edit variant="ghost" size="sm" icon={<IconEditOutline16 />} disabled={pending} onClick={actions.edit}>{t('edit')}</Button>
        <Menu
          open={menuOpen}
          portal
          align="end"
          items={menuItems}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'open-latest' && latestSession !== undefined) actions.openSession(latestSession as SessionId)
            if (id === 'resume-run') actions.resume(true)
            if (id === 'delete') actions.requestDelete()
          }}
          onClose={() => setMenuOpen(false)}
          anchor={
            <button type="button" className="am-icon-button" aria-label={t('moreActions')} onClick={() => setMenuOpen((current) => !current)}>
              <IconEllipsisOutline16 />
            </button>
          }
        />
      </header>

      <div className="am-detail-scroll">
        <div className="am-next-run">
          <span className="am-next-run-label">{t('next')}</span>
          {task.nextRunAt !== null ? (
            <>
              <strong>{formatRelative(task.nextRunAt, locale)}</strong>
              <span className="am-next-run-when">
                {formatDate(task.nextRunAt, locale, task.schedule.kind === 'recurring' ? task.schedule.timeZone : undefined)}
                {task.schedule.kind === 'recurring' ? ` · ${task.schedule.timeZone}` : ''}
              </span>
            </>
          ) : (
            <strong className="am-muted">{task.status === 'paused' ? t('statusPaused') : task.status === 'completed' ? t('statusCompleted') : t('noScheduledRun')}</strong>
          )}
          <span className="am-next-run-schedule">{scheduleLabel(task, locale, t)}</span>
        </div>

        <div className="am-actions">
          {!busy && <Button type="button" variant="outline" size="sm" icon={<IconPlayOutline16 />} disabled={disabled} onClick={actions.run}>
            {t('runNow')}
          </Button>}
          {busy && (
            <Button type="button" variant="outline" size="sm" icon={<IconStopFill16 />} disabled={pending} onClick={actions.stop}>
              {t('stopRun')}
            </Button>
          )}
          {task.status === 'active' && (
            <Button type="button" variant="outline" size="sm" icon={<IconPauseOutline16 />} disabled={pending} onClick={actions.pause}>
              {t('pause')}
            </Button>
          )}
          {task.status === 'paused' && (
            <>
              <Button type="button" variant="outline" size="sm" icon={<IconPlayOutline16 />} disabled={pending} onClick={() => actions.resume(false)}>
                {t('resume')}
              </Button>

            </>
          )}
        </div>

        <nav className="am-detail-nav" aria-label={t('details')}>
          {(['overview', 'runHistory', 'configuration'] as const).map((id) => (
            <button key={id} type="button" data-am-view={id} className={view === id ? 'am-tab is-active' : 'am-tab'} aria-pressed={view === id} onClick={() => setView(id)}>
              {t(id)}{id === 'runHistory' && task.runs.length > 0 && <span>{task.runs.length}</span>}
            </button>
          ))}
        </nav>

        {view === 'overview' && <>
        <section className="am-block">
          <h4 className="am-block-title">
            {t('promptLabel')}
            <span className="am-block-tools">
              <CopyButton value={task.prompt} t={t} />
            </span>
          </h4>
          <p className="am-prompt">{task.prompt}</p>
        </section>

        {latestResult?.summary !== undefined && (
          <section className="am-block">
            <h4 className="am-block-title">{t('latestResult')}
              {latestResult.sessionId !== undefined && <span className="am-block-tools"><Button type="button" variant="ghost" size="sm" icon={<IconRightUpOutline14 />} onClick={() => actions.openSession(latestResult.sessionId as SessionId)}>{t('openSession')}</Button></span>}
            </h4>
            <p className="am-summary">{latestResult.summary}</p>
          </section>
        )}

        {task.runs.length === 0 && <p className="am-detail-note">{t('noRuns')}</p>}
        </>}

        {view === 'configuration' && <section className="am-block">
          <h4 className="am-block-title">{t('configuration')}</h4>
          <div className="am-facts">
            <Fact icon={<IconCalendar />} label={t('schedule')}>{scheduleLabel(task, locale, t)}</Fact>
            <Fact icon={<IconFolderOpenOutline16 />} label={t('workspace')}>
              <code title={task.execution.cwd}>{basename(task.execution.cwd)}</code>
            </Fact>
            <Fact icon={<IconRightUpOutline16 />} label={t('executionDestination')}>
              {task.execution.target?.mode === 'pinned-session'
                ? t('executionPinned', { sessionId: `${task.execution.target.sessionId.slice(0, 12)}…` })
                : t('executionFresh')}
            </Fact>
            <Fact icon={<IconShield />} label={t('permission')}>
              <span className={task.security.permissionPreset === 'danger-full-access' ? 'am-danger' : undefined}>
                {permissionLabel(task.security.permissionPreset, t, task.permissionDisplayName)}
              </span>
            </Fact>
            <Fact icon={<IconAgentPresetOutline16 />} label={t('agentExecution')} full>
              {executionLabel(task, t)}
            </Fact>
            <Fact icon={<IconAgentPresetOutline16 />} label={t('reasoningEffort')} full>
              {task.execution.target?.mode === 'pinned-session'
                ? t('reasoningSession') : task.execution.reasoningEffort ?? t('reasoningDefault')}
            </Fact>
            <Fact icon={<IconRightUpOutline16 />} label={t('messageDelivery')} full>
              {task.delivery === undefined ? t('disabled') : <code>{task.delivery.botId} / {task.delivery.targetId}</code>}
            </Fact>
            <Fact icon={<IconBell />} label={t('notifications')}>{notificationPolicyLabel(task.notificationPolicy, t)}</Fact>
            <Fact icon={<IconPauseOutline16 />} label={t('pauseAfterFailures')}>
              {task.pauseAfterConsecutiveFailures ? t('enabled') : t('disabled')}
            </Fact>
            {task.consecutiveFailures > 0 && (
              <Fact icon={<IconWarningOutline16 />} label={t('consecutiveFailures')}>
                <span className="am-danger">{task.consecutiveFailures}</span>
              </Fact>
            )}
            <Fact icon={<IconClockOutline16 />} label={t('createdAt')}>{formatDate(task.createdAt, locale)}</Fact>
            {task.pausedAt !== undefined && (
              <Fact icon={<IconPauseOutline16 />} label={t('pausedAt')}>{formatDate(task.pausedAt, locale)}</Fact>
            )}
            {task.pausedNextRunAt !== undefined && (
              <Fact icon={<IconClockOutline16 />} label={t('pausedNextRunAt')}>{formatDate(task.pausedNextRunAt, locale)}</Fact>
            )}
            <Fact icon={<IconRightUpOutline16 />} label={t('createdBySession')} full>
              <span className="am-mono-row">
                <code>{task.createdBySessionId}</code>
                <CopyButton value={task.createdBySessionId} t={t} />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => actions.openSession(task.createdBySessionId as SessionId)}
                >
                  {t('open')}
                </Button>
              </span>
            </Fact>
            <Fact icon={<IconAgentPresetOutline16 />} label={t('taskId')} full>
              <span className="am-mono-row"><code>{task.id}</code><CopyButton value={task.id} t={t} /></span>
            </Fact>
          </div>
        </section>}

        {view === 'runHistory' && <section className="am-block">
          <h4 className="am-block-title">
            {task.runs.length === 0 ? t('runHistory') : t('recentRuns', { count: task.runs.length })}
          </h4>
          {task.runs.length === 0 ? (
            <p className="am-empty-note">{t('noRuns')}</p>
          ) : (
            <div className="am-runs">
              {[...task.runs].reverse().map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  locale={locale}
                  t={t}
                  disabled={disabled}
                  pending={pending}
                  onRetry={actions.run}
                  onOpen={actions.openSession}
                  onDelete={(trigger) => actions.requestDeleteRun(run, trigger)}
                />
              ))}
            </div>
          )}
        </section>}
      </div>
    </div>
  )
}
