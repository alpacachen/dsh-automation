import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { AutomationTaskView } from '../types.js'

import '@deepseek-ai/dsh-client-runtime/client'
import '@deepseek-ai/dsh-client-ui-layout/client'
import '@deepseek-ai/dsh-client-ui-sidebar/client'

export const inject = ['slots', 'sessions']

const API = '/api/automation/v1'
let panelOpen = false
const panelListeners = new Set<() => void>()

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
      : `Automation request failed (${response.status}).`
    throw new Error(message)
  }
  return value
}

const buttonStyle: React.CSSProperties = {
  border: '1px solid var(--dsh-border, #d0d0d0)',
  borderRadius: 8,
  background: 'var(--dsh-surface, #fff)',
  color: 'inherit',
  padding: '6px 10px',
  cursor: 'pointer',
  font: 'inherit',
}

function AutomationButton({ wide }: { wide: boolean }) {
  return (
    <button
      type="button"
      aria-label="Open Automations"
      title="Automations"
      onClick={() => setPanelOpen(true)}
      style={{ ...buttonStyle, width: wide ? '100%' : 36, overflow: 'hidden' }}
    >
      {wide ? '⏱ Automations' : '⏱'}
    </button>
  )
}

function scheduleLabel(task: AutomationTaskView): string {
  if (task.schedule.kind === 'once') return `Once · ${new Date(task.schedule.fireAt).toLocaleString()}`
  return `${task.schedule.rrule} · ${task.schedule.timeZone}`
}

function statusColor(status: string): string {
  if (status === 'failed' || status === 'interrupted') return '#c43d3d'
  if (status === 'succeeded' || status === 'active') return '#238636'
  if (status === 'paused') return '#9a6700'
  return '#57606a'
}

function AutomationPanel({ ctx }: { ctx: Context }) {
  const open = usePanelOpen()
  const [tasks, setTasks] = React.useState<AutomationTaskView[]>([])
  const [loading, setLoading] = React.useState(false)
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

  const act = React.useCallback(async (path: string, options: RequestInit) => {
    try {
      setError(undefined)
      await request(path, options)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [refresh])

  if (!open) return null

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPanelOpen(false)
      }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.32)', display: 'flex', justifyContent: 'flex-end' }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Automations"
        style={{ width: 'min(760px, 96vw)', height: '100%', overflow: 'auto', background: 'var(--dsh-background, #fff)', color: 'var(--dsh-foreground, #171717)', padding: 24, boxShadow: '-8px 0 30px rgba(0,0,0,.18)' }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h2 style={{ margin: 0, flex: 1 }}>Automations</h2>
          <button type="button" style={buttonStyle} onClick={() => void refresh()} disabled={loading}>Refresh</button>
          <button type="button" style={buttonStyle} onClick={() => setPanelOpen(false)}>Close</button>
        </header>

        <div role="alert" style={{ border: '1px solid #d1242f', borderRadius: 10, padding: 12, marginBottom: 16, background: 'rgba(209,36,47,.08)' }}>
          <strong>Full Access:</strong> every scheduled and manual run uses danger-full-access without approval prompts.
        </div>

        {error !== undefined && <p role="alert" style={{ color: '#c43d3d' }}>{error}</p>}
        {tasks.length === 0 && !loading && (
          <div style={{ padding: '48px 12px', textAlign: 'center', opacity: .75 }}>
            <p>No automations yet.</p>
            <p>Ask an Agent in any session to create one.</p>
          </div>
        )}

        <div style={{ display: 'grid', gap: 14 }}>
          {tasks.map((task) => {
            const busy = task.running
            const latestSession = [...task.runs].reverse().find((run) => run.sessionId !== undefined)?.sessionId
            return (
              <article key={task.id} style={{ border: '1px solid var(--dsh-border, #d0d0d0)', borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <h3 style={{ margin: 0, flex: 1 }}>{task.name}</h3>
                  <strong style={{ color: statusColor(busy ? 'running' : task.status) }}>{busy ? 'running' : task.status}</strong>
                </div>
                <p style={{ margin: '8px 0 4px' }}>{scheduleLabel(task)}</p>
                <p style={{ margin: '4px 0', opacity: .72 }}>Next: {task.nextRunAt === null ? '—' : new Date(task.nextRunAt).toLocaleString()}</p>
                <p style={{ margin: '4px 0', opacity: .72 }}>Workspace: {task.execution.cwd}</p>
                <p style={{ margin: '4px 0 12px', fontFamily: 'monospace', fontSize: 12 }}>{task.id}</p>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => void act(`/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST' })}>Run now</button>
                  {task.status === 'active' && (
                    <button type="button" style={buttonStyle} onClick={() => void act(`/tasks/${encodeURIComponent(task.id)}/pause`, { method: 'POST' })}>Pause</button>
                  )}
                  {task.status === 'paused' && (
                    <>
                      <button type="button" style={buttonStyle} onClick={() => void act(`/tasks/${encodeURIComponent(task.id)}/resume`, { method: 'POST', body: JSON.stringify({ runNow: false }) })}>Resume</button>
                      <button type="button" style={buttonStyle} disabled={busy} onClick={() => void act(`/tasks/${encodeURIComponent(task.id)}/resume`, { method: 'POST', body: JSON.stringify({ runNow: true }) })}>Resume & run</button>
                    </>
                  )}
                  {latestSession !== undefined && (
                    <button type="button" style={buttonStyle} onClick={() => ctx.sessions.open(latestSession as SessionId)}>Open latest session</button>
                  )}
                  <button
                    type="button"
                    style={{ ...buttonStyle, color: '#c43d3d' }}
                    onClick={() => {
                      if (window.confirm(`Delete “${task.name}”? Existing run sessions will remain.`)) {
                        void act(`/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' })
                      }
                    }}
                  >Delete</button>
                </div>

                {task.runs.length > 0 && (
                  <details style={{ marginTop: 14 }}>
                    <summary>Recent runs ({task.runs.length})</summary>
                    <ol style={{ paddingLeft: 20 }}>
                      {[...task.runs].reverse().map((run) => (
                        <li key={run.id} style={{ margin: '8px 0' }}>
                          <span style={{ color: statusColor(run.status) }}>{run.status}</span>
                          {' · '}{run.trigger}{' · '}{new Date(run.startedAt ?? run.enqueuedAt).toLocaleString()}
                          {run.sessionId !== undefined && (
                            <button type="button" style={{ ...buttonStyle, marginLeft: 8, padding: '2px 7px' }} onClick={() => ctx.sessions.open(run.sessionId as SessionId)}>Open</button>
                          )}
                          {run.error !== undefined && <div style={{ color: '#c43d3d' }}>{run.error}</div>}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}

export function apply(ctx: Context): () => void {
  const disposers = [
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'automation', order: 50, label: 'Automations' },
      AutomationButton,
    )),
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'automation-panel', order: 50, label: 'Automations' },
      () => <AutomationPanel ctx={ctx} />,
    )),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    setPanelOpen(false)
  }
}
