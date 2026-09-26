import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  Button,
  Input,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconCloseOutline16,
  IconLoadingOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconWarningOutline16,
} from './icons.js'
import type { AutomationTaskView } from '../types.js'
import { useLocale } from './i18n.js'
import { EmptyState } from './EmptyState.js'
import { SchedulerHealth } from './SchedulerHealth.js'
import { selectedSessionId } from './session-selection.js'
import { TaskRow } from './TaskRow.js'
import { TaskDetail, type TaskDetailActions } from './TaskDetail.js'
import { TaskEditor, type TaskUpdateBody } from './TaskEditor.js'
import { formatDate, StatusTag } from './shared.js'
import {
  clearError,
  deleteRunRecord,
  queueDraft,
  refresh,
  reportError,
  request,
  setPanelOpen,
  useAutomations,
  usePanelOpen,
} from './store.js'

type StatusFilter = 'all' | 'active' | 'paused' | 'completed'
type AutomationPanelProps = PropsRuntime<'shell.overlay'> & { ctx: Context }

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

export function AutomationPanel({ ctx, useSessions, useWorkspaces }: AutomationPanelProps) {
  const open = usePanelOpen()
  const { t, locale } = useLocale()
  const { tasks, scheduler, loading, error } = useAutomations()
  const sessions = useSessions((state: SessionListState) => state)
  const currentSessionId = selectedSessionId(sessions)
  const refreshSessions = React.useCallback(() => ctx.sessions.refresh(), [ctx])
  const workspaces: WorkspaceSnapshot = useWorkspaces((state: WorkspaceSnapshot) => state)
  const workspaceId = currentSessionId === undefined ? undefined : workspaces.items.find((workspace) =>
    workspace.sessionIds.includes(currentSessionId))?.workspaceId

  const [selectedId, setSelectedId] = React.useState<string>()
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<StatusFilter>('all')
  const [actingTaskId, setActingTaskId] = React.useState<string>()
  const [editing, setEditing] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string>()
  const [deletingRun, setDeletingRun] = React.useState<{ taskId: string; run: AutomationTaskView['runs'][number] }>()
  const [deleteRunError, setDeleteRunError] = React.useState<string>()
  const deletingRunPending = React.useRef(false)
  const deleteRunFocus = React.useRef<HTMLElement | null>(null)
  const [creatingExampleId, setCreatingExampleId] = React.useState<string>()
  const [narrowDetail, setNarrowDetail] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const [leaveAction, setLeaveAction] = React.useState<(() => void) | null>(null)
  const saving = actingTaskId !== undefined
  const guardLeave = React.useCallback((action: () => void) => {
    if (saving) return
    if (editing && dirty) setLeaveAction(() => action)
    else action()
  }, [editing, dirty, saving])
  const closePanel = React.useCallback(() => guardLeave(() => setPanelOpen(false)), [guardLeave])
  const cancelEditing = React.useCallback(() => guardLeave(() => { setEditing(false); setDirty(false) }), [guardLeave])
  const panelRef = React.useRef<HTMLElement | null>(null)
  const restoreFocusRef = React.useRef<HTMLElement | null>(null)
  const wasEditing = React.useRef(false)

  React.useEffect(() => {
    if (deletingRun !== undefined || deleteRunFocus.current === null) return
    const trigger = deleteRunFocus.current
    deleteRunFocus.current = null
    const frame = window.requestAnimationFrame(() => {
      const target = trigger.isConnected && !trigger.hasAttribute('disabled')
        ? trigger : panelRef.current?.querySelector<HTMLElement>('[data-am-view="runHistory"]')
      target?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [deletingRun])

  React.useEffect(() => {
    if (deletingRun === undefined) return
    const dialog = document.querySelector<HTMLElement>('.am-run-delete-modal')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!deletingRunPending.current) setDeletingRun(undefined)
        return
      }
      if (event.key !== 'Tab' || dialog === null) return
      const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const first = buttons[0]
      const last = buttons.at(-1)
      const focusIsEnabled = buttons.some((button) => button === document.activeElement)
      if (!focusIsEnabled) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    // Host Modal supplies the surface; contain its keyboard events here so the
    // same Escape cannot close the underlying panel after React commits.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [deletingRun])

  React.useEffect(() => {
    const changed = editing !== wasEditing.current
    wasEditing.current = editing
    if (!open || !changed) return
    const frame = window.requestAnimationFrame(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(editing ? '#am-name' : '[data-am-edit]')
      target?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, editing])

  React.useEffect(() => {
    if (!open || !editing || !dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [open, editing, dirty])

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
    if (selected !== undefined && (editing || visible.some((task) => task.id === selected.id))) return
    const next = visible[0]
    setSelectedId(next?.id)
    setEditing(false)
  }, [open, selected, visible, editing])

  React.useEffect(() => {
    if (open) void refresh()
  }, [open])

  React.useEffect(() => {
    if (!open) {
      setEditing(false)
      setDirty(false)
      setLeaveAction(null)
      setDeletingId(undefined)
      setDeletingRun(undefined)
      setDeleteRunError(undefined)
      setNarrowDetail(false)
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      // Portaled menus and confirmation dialogs own their keyboard events.
      if (!panelRef.current?.contains(event.target as Node)) return
      if (event.key === 'Escape') {
        if (saving || leaveAction !== null || deletingId !== undefined || deletingRun !== undefined) return
        event.preventDefault()
        if (editing) cancelEditing()
        else if (narrowDetail) setNarrowDetail(false)
        else closePanel()
        return
      }
      if (editing || deletingId !== undefined || deletingRun !== undefined || leaveAction !== null) return
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || !active.classList.contains('am-row')) return
      if (visible.length === 0) return
      event.preventDefault()
      const index = visible.findIndex((task) => task.id === selectedId)
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = visible[Math.max(0, Math.min(visible.length - 1, (index === -1 ? 0 : index) + step))]
      if (next !== undefined) {
        setSelectedId(next.id)
        const rows = panelRef.current?.querySelectorAll<HTMLButtonElement>('.am-row')
        rows?.[visible.indexOf(next)]?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, editing, deletingId, deletingRun, narrowDetail, visible, selectedId, saving, leaveAction, cancelEditing, closePanel])

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
        'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
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

  const confirmDeleteRun = async () => {
    if (deletingRun === undefined || deletingRunPending.current || saving) return
    deletingRunPending.current = true
    setActingTaskId(deletingRun.taskId)
    setDeleteRunError(undefined)
    try {
      await deleteRunRecord(deletingRun.taskId, deletingRun.run.id)
      setDeletingRun(undefined)
    } catch (reason) {
      setDeleteRunError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      deletingRunPending.current = false
      setActingTaskId(undefined)
    }
  }

  const closeDeleteRun = () => {
    if (!deletingRunPending.current) setDeletingRun(undefined)
  }

  const updateTask = React.useCallback(async (taskId: string, body: TaskUpdateBody) => {
    try {
      setActingTaskId(taskId)
      clearError()
      await request(`/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(body) })
      await refresh()
      setDirty(false)
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
      ctx.uiWorkspace.openSession(sessionId)
      setPanelOpen(false)
    } catch (reason) {
      reportError(t('newConversationFailed', { error: reason instanceof Error ? reason.message : String(reason) }))
    } finally {
      setCreatingExampleId(undefined)
    }
  }, [ctx, t, workspaceId])

  if (!open) return null

  const openSession = (sessionId: SessionId) => {
    ctx.uiWorkspace.openSession(sessionId)
    setPanelOpen(false)
  }

  const actions: TaskDetailActions | undefined = selected === undefined ? undefined : {
    run: () => void act(selected.id, `/tasks/${encodeURIComponent(selected.id)}/run`, { method: 'POST' }),
    stop: () => void act(selected.id, `/tasks/${encodeURIComponent(selected.id)}/stop`, { method: 'POST' }),
    pause: () => void act(selected.id, `/tasks/${encodeURIComponent(selected.id)}/pause`, { method: 'POST' }),
    resume: (runNow: boolean) => void act(selected.id, `/tasks/${encodeURIComponent(selected.id)}/resume`, { method: 'POST', body: JSON.stringify({ runNow }) }),
    edit: () => { setDirty(false); setEditing(true) },
    requestDelete: () => setDeletingId(selected.id),
    requestDeleteRun: (run, trigger) => {
      deleteRunFocus.current = trigger
      setDeleteRunError(undefined)
      setDeletingRun({ taskId: selected.id, run })
    },
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
        if (event.target === event.currentTarget && leaveAction === null && deletingId === undefined && deletingRun === undefined) closePanel()
      }}
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        className={`am-panel${narrowDetail ? ' is-detail' : ''}${tasks.length === 0 ? ' is-empty' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('automations')}
        aria-busy={loading}
      >
        <header className="am-header">
          <div className="am-header-heading">
            <h2 className="am-header-title">{t('tasksHeading')}</h2>
            <span className="am-header-count">{t('taskCount', { count: tasks.length })}</span>
          </div>
          <span className="am-spacer" />
          <Tooltip label={creationBlocked ? t('requiresWorkspace') : t('newAutomation')} side="bottom" disabled={false}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              icon={<IconPlusOutline16 />}
              disabled={creationBlocked || creatingExampleId !== undefined}
              onClick={() => guardLeave(() => void startExample('new', t('guidedCreationPrompt')))}
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
            <button type="button" className="am-icon-button" aria-label={t('close')} onClick={closePanel}>
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
            ) : error !== undefined ? (
              <div className="am-onboarding">
                <IconWarningOutline16 size={24} />
                <h3>{t('loadFailed')}</h3>
                <p>{t('loadFailedHint')}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>{t('retry')}</Button>
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
                  onChange={(event) => { const value = event.target.value; guardLeave(() => { setEditing(false); setQuery(value) }) }}
                />
                <div className="am-pill-group" role="group" aria-label={t('filterAll')}>
                  {filters.map((entry) => (
                    <button
                      className={filter === entry.id ? 'am-tab is-active' : 'am-tab'}
                      key={entry.id}
                      type="button"
                      aria-pressed={filter === entry.id}
                      onClick={() => guardLeave(() => { setEditing(false); setFilter(entry.id) })}
                    >
                      {entry.label}
                    </button>
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
                      if (task.id === selectedId) { setNarrowDetail(true); return }
                      guardLeave(() => {
                        setSelectedId(task.id)
                        setEditing(false)
                        setNarrowDetail(true)
                      })
                    }}
                  />
                ))}
                {visible.length === 0 && (
                  <div className="am-list-empty">
                    <p>{needle === '' ? t('noFilteredTasks') : t('noMatches', { query: query.trim() })}</p>
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setQuery(''); setFilter('all') }}>{t('resetFilters')}</Button>
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
                      <button type="button" className="am-icon-button" aria-label={t('cancel')} onClick={cancelEditing}>
                        <IconCloseOutline16 />
                      </button>
                    </Tooltip>
                  </header>
                  <TaskEditor
                    key={selected.id}
                    onDirtyChange={setDirty}
                    task={selected}
                    sessions={sessions}
                    workspaceSessionIds={workspaces.items.find((workspace) => workspace.workspaceId === selected.execution.workspaceId)?.sessionIds.filter((id) => !workspaces.archivedSessionIds.includes(id)) ?? []}
                    refreshSessions={refreshSessions}
                    saving={actingTaskId === selected.id}
                    t={t}
                    onSave={(body) => void updateTask(selected.id, body)}
                    onCancel={cancelEditing}
                  />
                </div>
              ) : (
                <TaskDetail
                  key={selected.id}
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
        <footer className="am-panel-footer"><SchedulerHealth health={scheduler} locale={locale} t={t} />{dirty && editing && <span>{t('unsavedChanges')}</span>}</footer>
      </section>

      <Modal
        open={leaveAction !== null}
        onClose={() => setLeaveAction(null)}
        title={t('discardTitle')}
        closeLabel={t('close')}
        description={t('discardDescription')}
        footer={<>
          <Button type="button" variant="ghost" size="sm" onClick={() => setLeaveAction(null)}>{t('keepEditing')}</Button>
          <Button type="button" variant="primary" size="sm" onClick={() => {
            const action = leaveAction
            setLeaveAction(null)
            setDirty(false)
            setEditing(false)
            action?.()
          }}>{t('discardChanges')}</Button>
        </>}
      />
      <Modal
        open={deletingRun !== undefined}
        className="am-run-delete-modal"
        onClose={closeDeleteRun}
        title={t('deleteRunTitle')}
        closeLabel={t('close')}
        description={t('deleteRunConfirm')}
        footer={<>
          <Button type="button" variant="ghost" size="sm" autoFocus disabled={saving} onClick={closeDeleteRun}>{t('cancel')}</Button>
          <Button type="button" variant="primary" size="sm" icon={<IconWarningOutline16 />} data-am-confirm-delete-run disabled={saving} onClick={() => void confirmDeleteRun()}>
            {saving ? t('deletingRun') : t('deleteRun')}
          </Button>
        </>}
      >
        {deletingRun !== undefined && <div className="am-run-delete-confirm">
          <div className="am-run-delete-context">
            <StatusTag status={deletingRun.run.status} t={t} />
            <time dateTime={deletingRun.run.startedAt ?? deletingRun.run.enqueuedAt}>
              {formatDate(deletingRun.run.startedAt ?? deletingRun.run.enqueuedAt, locale)}
            </time>
          </div>
          {deleteRunError !== undefined && <p className="am-alert is-error" role="alert">{t('deleteRunFailed', { error: deleteRunError })}</p>}
        </div>}
      </Modal>
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
