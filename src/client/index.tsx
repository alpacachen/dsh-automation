import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// 仅取模块增强：ctx.slots 由 renderer 声明，useSessions/sessionId 由 ui-session 声明，
// useWorkspaces/ctx.uiWorkspace 由 ui-workspace 声明。类型导入会被编译擦除，
// 不会在 lib/client.js 里留下 require()。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  Button,
  HoverCard,
  Input,
  Modal,
  Pill,
  StateDot,
  Tooltip,
  IconAlarmClockOutline16,
  IconCloseOutline16,
  IconLoadingOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconWarningOutline16,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AutomationSchedulerHealth, AutomationTaskView } from '../types.js'
import { installLocale, t as translate, useLocale } from './i18n.js'
import { TaskDetail, type TaskDetailActions } from './TaskDetail.js'
import { TaskEditor, type TaskUpdateBody } from './TaskEditor.js'
import {
  formatDate,
  formatRelative,
  statusState,
  StatusTag,
  IconCalendar,
  IconShield,
} from './shared.js'
import {
  clearError,
  clearUnread,
  consumeDraft,
  queueDraft,
  refresh,
  reportError,
  request,
  resetStore,
  setPanelOpen,
  useAutomations,
  useDraftRevision,
  usePanelOpen,
} from './store.js'
import styles from './styles.css'

import '@deepseek-ai/dsh-client-ui-layout/client'
import '@deepseek-ai/dsh-client-ui-sidebar/client'

export const inject = ['slots', 'sessions', 'uiWorkspace', 'locale']

const STYLE_ATTRIBUTE = 'data-dsh-automation-style'

type OverlayProps = PropsRuntime<'shell.overlay'>
type InputDockProps = PropsRuntime<'conversation.input.dock'>
type StatusFilter = 'all' | 'active' | 'paused' | 'completed'

function installStyles(): () => void {
  if (document.querySelector(`style[${STYLE_ATTRIBUTE}]`) !== null) return () => undefined
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTRIBUTE, '')
  element.textContent = styles
  document.head.appendChild(element)
  return () => element.remove()
}

/** Push a queued prompt into the composer once its session mounts. */
function DraftInjector({ sessionId, inputActions }: InputDockProps) {
  const revision = useDraftRevision()
  React.useEffect(() => {
    const text = consumeDraft(sessionId)
    if (text !== undefined) inputActions.setDraft(text)
  }, [revision, sessionId, inputActions])
  return null
}

/** Sidebar entry point carrying the unread-notification badge. */
function AutomationButton({ wide }: { wide: boolean }) {
  const { t } = useLocale()
  const { unread } = useAutomations()
  return (
    <button
      type="button"
      className={`am-nav ${wide ? 'is-wide' : 'is-rail'}`}
      aria-label={unread > 0 ? `${t('openAutomations')}. ${t('unreadNotifications', { count: unread })}` : t('openAutomations')}
      title={t('automations')}
      onClick={() => {
        setPanelOpen(true)
        void request('/notifications/read', { method: 'POST' }).then(clearUnread).catch(() => undefined)
      }}
    >
      <span className="am-nav-icon"><IconAlarmClockOutline16 /></span>
      {wide && <span className="am-nav-label">{t('automations')}</span>}
      {unread > 0 && <span className="am-nav-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </button>
  )
}

/** Scheduler state as a dot whose hover card carries every health field. */
function SchedulerHealth({ health, locale, t }: {
  health: AutomationSchedulerHealth | undefined
  locale: string
  t: typeof translate
}) {
  if (health === undefined) return null
  const state: StateDotState = health.status === 'healthy' ? 'done' : health.status === 'retrying' ? 'warning' : 'error'
  const label = health.status === 'healthy'
    ? t('schedulerHealthy')
    : health.status === 'retrying' ? t('schedulerHealthRetrying') : t('schedulerHealthStopped')
  const detailed = health.consecutiveFailures > 0 || health.lastError !== undefined ||
    health.lastFailedAt !== undefined || health.retryAt !== undefined
  const chip = (
    <span className="am-scheduler">
      <StateDot state={state} size={8} />
      <span>{label}</span>
    </span>
  )
  if (!detailed) return chip
  return (
    <HoverCard
      anchor={chip}
      copyLabel={t('copy')}
      copiedLabel={t('copied')}
      {...(health.lastError !== undefined ? { copyText: health.lastError } : {})}
      content={
        <dl className="am-scheduler-card">
          <dt>{t('schedulerFailureCount')}</dt><dd>{health.consecutiveFailures}</dd>
          {health.lastFailedAt !== undefined && <><dt>{t('schedulerLastFailedAt')}</dt><dd>{formatDate(health.lastFailedAt, locale)}</dd></>}
          {health.retryAt !== undefined && <><dt>{t('schedulerRetryAt')}</dt><dd>{formatDate(health.retryAt, locale)}</dd></>}
          {health.lastError !== undefined && <><dt>{t('schedulerLastError')}</dt><dd>{health.lastError}</dd></>}
        </dl>
      }
    />
  )
}

/** One scannable row in the master list. */
function TaskRow({ task, locale, t, selected, onSelect }: {
  task: AutomationTaskView
  locale: string
  t: typeof translate
  selected: boolean
  onSelect: () => void
}) {
  const displayStatus = task.running ? 'running' : task.status
  return (
    <button
      type="button"
      className={selected ? 'am-row is-selected' : 'am-row'}
      aria-current={selected}
      onClick={onSelect}
    >
      <StateDot state={statusState(displayStatus)} size={8} className="am-row-dot" />
      <span className="am-row-body">
        <span className="am-row-name">{task.name}</span>
        <span className="am-row-meta">
          {task.nextRunAt !== null
            ? formatRelative(task.nextRunAt, locale)
            : task.status === 'completed' ? t('statusCompleted') : t('statusPaused')}
        </span>
      </span>
      {task.consecutiveFailures > 0 && (
        <span className="am-failure-chip" title={`${t('consecutiveFailures')} · ${task.consecutiveFailures}`}>
          <IconWarningOutline16 size={12} />
          {task.consecutiveFailures}
        </span>
      )}
    </button>
  )
}

/** Templates offered when no automation exists yet. */
function EmptyState({ t, creating, disabled, onStart }: {
  t: typeof translate
  creating: string | undefined
  disabled: boolean
  onStart: (id: string, prompt: string) => void
}) {
  const examples = [
    { id: 'release', icon: <IconCalendar size={18} />, title: t('exampleReleaseTitle'), description: t('exampleReleaseDescription'), prompt: t('exampleReleasePrompt') },
    { id: 'dependencies', icon: <IconShield size={18} />, title: t('exampleDependenciesTitle'), description: t('exampleDependenciesDescription'), prompt: t('exampleDependenciesPrompt') },
    { id: 'handoff', icon: <IconAlarmClockOutline16 size={18} />, title: t('exampleHandoffTitle'), description: t('exampleHandoffDescription'), prompt: t('exampleHandoffPrompt') },
  ]
  return (
    <div className="am-onboarding">
      <span className="am-onboarding-icon"><IconAlarmClockOutline16 size={28} /></span>
      <h3>{t('noAutomations')}</h3>
      <p>{t('createHint')}</p>
      <div className="am-examples">
        {examples.map((example) => (
          <button
            key={example.id}
            type="button"
            className="am-example"
            disabled={disabled || creating !== undefined}
            aria-busy={creating === example.id}
            onClick={() => onStart(example.id, example.prompt)}
          >
            <span className="am-example-icon" aria-hidden="true">{example.icon}</span>
            <span className="am-example-copy">
              <strong>{example.title}</strong>
              <span>{creating === example.id ? t('creatingConversation') : example.description}</span>
            </span>
          </button>
        ))}
      </div>
      <small>{disabled ? t('requiresWorkspace') : t('exampleDraftHint')}</small>
    </div>
  )
}

type AutomationPanelProps = OverlayProps & { ctx: Context }

/** Running first, then soonest next run; tasks without one sort last. */
function orderTasks(tasks: readonly AutomationTaskView[]): AutomationTaskView[] {
  return [...tasks].sort((left, right) => {
    if (left.running !== right.running) return left.running ? -1 : 1
    if (left.nextRunAt === null || right.nextRunAt === null) {
      if (left.nextRunAt === right.nextRunAt) return left.name.localeCompare(right.name)
      return left.nextRunAt === null ? 1 : -1
    }
    const delta = Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt)
    return delta === 0 ? left.name.localeCompare(right.name) : delta
  })
}

function AutomationPanel({ ctx, useSessions, useWorkspaces }: AutomationPanelProps) {
  const open = usePanelOpen()
  const { t, locale } = useLocale()
  const { tasks, scheduler, loading, error } = useAutomations()
  const currentSessionId = useSessions((state: SessionListState) => state.current)
  const workspaceId = useWorkspaces((state: WorkspaceSnapshot) => {
    if (currentSessionId === undefined) return undefined
    const current = state.items.find((workspace: WorkspaceSnapshot['items'][number]) => workspace.sessionIds.includes(currentSessionId))
    return current?.workspaceId
  })

  const [selectedId, setSelectedId] = React.useState<string>()
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<StatusFilter>('all')
  const [actingTaskId, setActingTaskId] = React.useState<string>()
  const [editing, setEditing] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string>()
  const [creatingExampleId, setCreatingExampleId] = React.useState<string>()
  const [narrowDetail, setNarrowDetail] = React.useState(false)
  const panelRef = React.useRef<HTMLElement | null>(null)
  const restoreFocusRef = React.useRef<HTMLElement | null>(null)

  const ordered = React.useMemo(() => orderTasks(tasks), [tasks])
  const needle = query.trim().toLowerCase()
  const visible = React.useMemo(() => ordered.filter((task) => {
    if (filter !== 'all' && task.status !== filter) return false
    if (needle === '') return true
    return task.name.toLowerCase().includes(needle) || task.prompt.toLowerCase().includes(needle)
  }), [ordered, filter, needle])

  const selected = selectedId === undefined ? undefined : tasks.find((task) => task.id === selectedId)
  // Keep a selection on screen as the list changes underneath (a poll that
  // dropped the selected task, or a filter that excluded it).
  React.useEffect(() => {
    if (!open) return
    if (selected !== undefined && visible.some((task) => task.id === selected.id)) return
    const next = visible[0]
    setSelectedId(next?.id)
    setEditing(false)
  }, [open, selected, visible])

  React.useEffect(() => {
    if (open) void refresh()
  }, [open])

  React.useEffect(() => {
    if (!open) {
      setEditing(false)
      setDeletingId(undefined)
      setNarrowDetail(false)
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (deletingId !== undefined) setDeletingId(undefined)
        else if (editing) setEditing(false)
        else if (narrowDetail) setNarrowDetail(false)
        else setPanelOpen(false)
        return
      }
      if (editing || deletingId !== undefined) return
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const active = document.activeElement
      if (active instanceof HTMLElement && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
      if (visible.length === 0) return
      event.preventDefault()
      const index = visible.findIndex((task) => task.id === selectedId)
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = visible[Math.max(0, Math.min(visible.length - 1, (index === -1 ? 0 : index) + step))]
      if (next !== undefined) setSelectedId(next.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, editing, deletingId, narrowDetail, visible, selectedId])

  React.useEffect(() => {
    if (!open) {
      if (restoreFocusRef.current !== null) {
        restoreFocusRef.current.focus()
        restoreFocusRef.current = null
      }
      return
    }
    if (restoreFocusRef.current === null && document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement
    }
    const container = panelRef.current
    if (container === null) return
    container.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const current = panelRef.current
      if (current === null) return
      // Modal and Menu portal outside the panel and run their own focus
      // management; trapping into the panel would fight them.
      if (!current.contains(document.activeElement)) return
      const focusables = Array.from(current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null)
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || active === current) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const act = React.useCallback(async (taskId: string, path: string, options: RequestInit) => {
    try {
      setActingTaskId(taskId)
      clearError()
      await request(path, options)
      await refresh()
    } catch (reason) {
      reportError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActingTaskId(undefined)
    }
  }, [])

  const updateTask = React.useCallback(async (taskId: string, body: TaskUpdateBody) => {
    try {
      setActingTaskId(taskId)
      clearError()
      await request(`/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(body) })
      await refresh()
      setEditing(false)
    } catch (reason) {
      reportError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActingTaskId(undefined)
    }
  }, [])

  const startExample = React.useCallback(async (exampleId: string, prompt: string) => {
    if (workspaceId === undefined) {
      reportError(t('workspaceUnavailable'))
      return
    }
    try {
      setCreatingExampleId(exampleId)
      clearError()
      const sessionId = await ctx.uiWorkspace.connectWorkspace(workspaceId)
      queueDraft(sessionId, prompt)
      ctx.sessions.open(sessionId)
      setPanelOpen(false)
    } catch (reason) {
      reportError(t('newConversationFailed', { error: reason instanceof Error ? reason.message : String(reason) }))
    } finally {
      setCreatingExampleId(undefined)
    }
  }, [ctx, t, workspaceId])

  if (!open) return null

  const openSession = (sessionId: SessionId) => {
    ctx.sessions.open(sessionId)
    setPanelOpen(false)
  }

  const actions: TaskDetailActions | undefined = selected === undefined ? undefined : {
    run: () => void act(selected.id, `/tasks/${encodeURIComponent(selected.id)}/run`, { method: 'POST' }),
    stop: () => void act(selected.id, `/tasks/${encodeURIComponent(selected.id)}/stop`, { method: 'POST' }),
    pause: () => void act(selected.id, `/tasks/${encodeURIComponent(selected.id)}/pause`, { method: 'POST' }),
    resume: (runNow: boolean) => void act(selected.id, `/tasks/${encodeURIComponent(selected.id)}/resume`, { method: 'POST', body: JSON.stringify({ runNow }) }),
    edit: () => setEditing(true),
    requestDelete: () => setDeletingId(selected.id),
    openSession,
    back: () => setNarrowDetail(false),
  }

  const deletingTask = deletingId === undefined ? undefined : tasks.find((task) => task.id === deletingId)
  const creationBlocked = workspaceId === undefined
  const filters: Array<{ id: StatusFilter; label: string }> = [
    { id: 'all', label: t('filterAll') },
    { id: 'active', label: t('filterActive') },
    { id: 'paused', label: t('filterPaused') },
    { id: 'completed', label: t('filterCompleted') },
  ]

  return (
    <div
      className="am-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPanelOpen(false)
      }}
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        className={narrowDetail ? 'am-panel is-detail' : 'am-panel'}
        role="dialog"
        aria-modal="true"
        aria-label={t('automations')}
        aria-busy={loading}
      >
        <header className="am-header">
          <span className="am-header-icon" aria-hidden="true"><IconAlarmClockOutline16 /></span>
          <h2 className="am-header-title">{t('tasksHeading')}</h2>
          <span className="am-header-count">{t('taskCount', { count: tasks.length })}</span>
          <SchedulerHealth health={scheduler} locale={locale} t={t} />
          <span className="am-spacer" />
          <Tooltip label={creationBlocked ? t('requiresWorkspace') : t('newAutomation')} side="bottom" disabled={false}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              icon={<IconPlusOutline16 />}
              disabled={creationBlocked || creatingExampleId !== undefined}
              onClick={() => void startExample('new', t('guidedCreationPrompt'))}
            >
              {creatingExampleId === 'new' ? t('creatingConversation') : t('newAutomation')}
            </Button>
          </Tooltip>
          <Tooltip label={t('refresh')} side="bottom">
            <button type="button" className="am-icon-button" disabled={loading} aria-label={t('refresh')} onClick={() => void refresh()}>
              {loading ? <span className="am-spin"><IconLoadingOutline16 /></span> : <IconRefreshOutline16 />}
            </button>
          </Tooltip>
          <Tooltip label={t('close')} side="bottom">
            <button type="button" className="am-icon-button" aria-label={t('close')} onClick={() => setPanelOpen(false)}>
              <IconCloseOutline16 />
            </button>
          </Tooltip>
        </header>

        {(error !== undefined || scheduler?.status === 'retrying' || scheduler?.status === 'stopped') && (
          <div className="am-banners">
            {error !== undefined && <p className="am-alert is-error" role="alert">{error}</p>}
            {scheduler?.status === 'retrying' && (
              <p className="am-alert is-warning" role="alert">
                {t('schedulerRetrying', { error: scheduler.lastError ?? t('unknownError') })}
              </p>
            )}
            {scheduler?.status === 'stopped' && <p className="am-alert is-error" role="alert">{t('schedulerStopped')}</p>}
          </div>
        )}

        {tasks.length === 0 ? (
          <div className="am-body is-single">
            {loading ? (
              <div className="am-onboarding" aria-live="polite">
                <span className="am-onboarding-icon am-spin"><IconLoadingOutline16 size={24} /></span>
                <h3>{t('loading')}</h3>
              </div>
            ) : (
              <EmptyState t={t} creating={creatingExampleId} disabled={creationBlocked} onStart={(id, prompt) => void startExample(id, prompt)} />
            )}
          </div>
        ) : (
          <div className="am-body">
            <div className="am-list-pane">
              <div className="am-list-tools">
                <Input
                  icon={<IconSearchOutline16 />}
                  value={query}
                  placeholder={t('searchPlaceholder')}
                  aria-label={t('searchPlaceholder')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className="am-pill-group" role="group" aria-label={t('filterAll')}>
                  {filters.map((entry) => (
                    <Pill
                      key={entry.id}
                      type="button"
                      active={filter === entry.id}
                      aria-pressed={filter === entry.id}
                      onClick={() => setFilter(entry.id)}
                    >
                      {entry.label}
                    </Pill>
                  ))}
                </div>
              </div>
              <div className="am-list">
                {visible.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    locale={locale}
                    t={t}
                    selected={task.id === selectedId}
                    onSelect={() => {
                      setSelectedId(task.id)
                      setEditing(false)
                      setNarrowDetail(true)
                    }}
                  />
                ))}
                {visible.length === 0 && (
                  <div className="am-list-empty">
                    <p>{needle === '' ? t('noAutomations') : t('noMatches', { query: query.trim() })}</p>
                    {needle !== '' && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="am-detail-pane">
              {selected === undefined || actions === undefined ? (
                <p className="am-detail-hint">{t('selectTaskHint')}</p>
              ) : editing ? (
                <div className="am-detail">
                  <header className="am-detail-header">
                    <div className="am-detail-title">
                      <h3>{t('editTask')}</h3>
                      <span className="am-muted">{t('editingTask', { name: selected.name })}</span>
                    </div>
                    <Tooltip label={t('cancel')} side="bottom">
                      <button type="button" className="am-icon-button" aria-label={t('cancel')} onClick={() => setEditing(false)}>
                        <IconCloseOutline16 />
                      </button>
                    </Tooltip>
                  </header>
                  <TaskEditor
                    task={selected}
                    saving={actingTaskId === selected.id}
                    t={t}
                    onSave={(body) => void updateTask(selected.id, body)}
                    onCancel={() => setEditing(false)}
                  />
                </div>
              ) : (
                <TaskDetail
                  task={selected}
                  locale={locale}
                  t={t}
                  pending={actingTaskId === selected.id}
                  actions={actions}
                />
              )}
            </div>
          </div>
        )}
      </section>

      <Modal
        open={deletingTask !== undefined}
        onClose={() => setDeletingId(undefined)}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={deletingTask === undefined ? '' : t('deleteConfirm', { name: deletingTask.name })}
        footer={
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => setDeletingId(undefined)}>{t('cancel')}</Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              icon={<IconWarningOutline16 />}
              onClick={() => {
                const id = deletingId
                setDeletingId(undefined)
                if (id !== undefined) void act(id, `/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
              }}
            >
              {t('confirmDelete')}
            </Button>
          </>
        }
      >
        {deletingTask !== undefined && <StatusTag status={deletingTask.running ? 'running' : deletingTask.status} t={t} />}
      </Modal>
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
    resetStore()
  }
}
