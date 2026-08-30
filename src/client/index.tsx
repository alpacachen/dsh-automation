import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { AutomationTaskView } from '../types.js'
import { installLocale, t as translate, useLocale } from './i18n.js'
import styles from './styles.css'

import '@deepseek-ai/dsh-client-runtime/client'
import '@deepseek-ai/dsh-client-ui-layout/client'
import '@deepseek-ai/dsh-client-ui-sidebar/client'

export const inject = ['slots', 'sessions', 'locale']

const API = '/api/automation/v1'
const STYLE_ATTRIBUTE = 'data-dsh-automation-style'
let panelOpen = false
const panelListeners = new Set<() => void>()

type IconName = 'calendar' | 'chevron' | 'clock' | 'close' | 'external' | 'folder' | 'pause' | 'play' | 'refresh' | 'shield' | 'trash'

const iconPaths: Record<IconName, string[]> = {
  calendar: ['M3 9h18', 'M7 3v4', 'M17 3v4', 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z'],
  chevron: ['m8 10 4 4 4-4'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 6v6l4 2'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
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
  return `${task.schedule.rrule} · ${task.schedule.timeZone}`
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

function AutomationPanel({ ctx }: { ctx: Context }) {
  const open = usePanelOpen()
  const { t, locale } = useLocale()
  const [tasks, setTasks] = React.useState<AutomationTaskView[]>([])
  const [loading, setLoading] = React.useState(false)
  const [actingTaskId, setActingTaskId] = React.useState<string>()
  const [error, setError] = React.useState<string>()

  const refresh = React.useCallback(async () => {
    try {
      setLoading(true)
      const value = await request('/tasks') as { tasks: AutomationTaskView[] }
      setTasks(value.tasks)
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
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanelOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

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
          <div className="automation-access-note">
            <span className="automation-access-icon"><Icon name="shield" /></span>
            <div>
              <strong>{t('fullAccessTitle')}</strong>
              <p>{t('fullAccessMessage')}</p>
            </div>
          </div>

          {error !== undefined && <div className="automation-error" role="alert">{error}</div>}

          {tasks.length === 0 && loading && (
            <div className="automation-empty" aria-live="polite">
              <span className="automation-empty-icon automation-spin"><Icon name="refresh" size={24} /></span>
              <h3>{t('loading')}</h3>
            </div>
          )}

          {tasks.length === 0 && !loading && (
            <div className="automation-empty">
              <span className="automation-empty-icon"><Icon name="clock" size={28} /></span>
              <h3>{t('noAutomations')}</h3>
              <p>{t('createHint')}</p>
            </div>
          )}

          <div className="automation-task-list">
            {tasks.map((task) => {
              const busy = task.running
              const pending = actingTaskId === task.id
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
                      className="automation-icon-button is-danger automation-delete"
                      disabled={pending}
                      aria-label={t('delete')}
                      title={t('delete')}
                      onClick={() => {
                        if (window.confirm(t('deleteConfirm', { name: task.name }))) {
                          void act(task.id, `/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' })
                        }
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>

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
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'automation-panel', order: 50, label: () => translate('automations') },
      () => <AutomationPanel ctx={ctx} />,
    )),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    setPanelOpen(false)
  }
}
