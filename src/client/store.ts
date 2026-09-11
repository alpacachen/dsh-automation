import React from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AutomationSchedulerHealth, AutomationTaskView } from '../types.js'
import { t as translate } from './i18n.js'

const API = '/api/automation/v1'
/** Poll cadence while the panel is open, matching the previous panel timer. */
const OPEN_INTERVAL = 5_000
/** Poll cadence while only the sidebar badge consumes the data. */
const IDLE_INTERVAL = 30_000

/** Send one Automation API request, unwrapping the shared error envelope. */
export async function request(path: string, options: RequestInit = {}): Promise<unknown> {
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

/** Everything the panel and the sidebar badge read from one shared poll. */
export interface AutomationSnapshot {
  tasks: readonly AutomationTaskView[]
  scheduler: AutomationSchedulerHealth | undefined
  /** Unread notifications summed across every task. */
  unread: number
  /** True until the first response settles, so the panel can show a skeleton. */
  loading: boolean
  /** Set when the first load failed; later failures keep the last good data. */
  error: string | undefined
}

let snapshot: AutomationSnapshot = { tasks: [], scheduler: undefined, unread: 0, loading: false, error: undefined }
const listeners = new Set<() => void>()
let timer: number | undefined
let inflight: Promise<void> | undefined
let loaded = false
let panelOpen = false

function emit(next: AutomationSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/** Fetch once and publish; a concurrent call joins the in-flight request. */
export function refresh(): Promise<void> {
  if (inflight !== undefined) return inflight
  const first = !loaded
  if (first) emit({ ...snapshot, loading: true })
  inflight = (async () => {
    try {
      const value = await request('/tasks') as { tasks: AutomationTaskView[]; scheduler: AutomationSchedulerHealth }
      loaded = true
      emit({
        tasks: value.tasks,
        scheduler: value.scheduler,
        unread: value.tasks.reduce((sum, task) => sum + task.unreadNotifications, 0),
        loading: false,
        error: undefined,
      })
    } catch (reason) {
      // Only a failed first load is worth reporting: later failures keep the
      // last good list on screen instead of blanking it every poll.
      if (first) {
        loaded = true
        emit({ ...snapshot, loading: false, error: reason instanceof Error ? reason.message : String(reason) })
      }
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

function reschedule(): void {
  if (timer !== undefined) window.clearInterval(timer)
  timer = listeners.size === 0
    ? undefined
    : window.setInterval(() => void refresh(), panelOpen ? OPEN_INTERVAL : IDLE_INTERVAL)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    void refresh()
    reschedule()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }
}

/** Subscribe to the shared task snapshot. */
export function useAutomations(): AutomationSnapshot {
  return React.useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

/** Drop the recorded error so a retry starts from a clean banner. */
export function clearError(): void {
  if (snapshot.error !== undefined) emit({ ...snapshot, error: undefined })
}

/** Publish a request failure as the panel's banner without touching the list. */
export function reportError(message: string): void {
  emit({ ...snapshot, error: message })
}

/** Zero the badge locally after the server marked notifications read. */
export function clearUnread(): void {
  if (snapshot.unread !== 0) emit({ ...snapshot, unread: 0 })
}

let panelListeners = new Set<() => void>()

/** Open or close the overlay, retuning the poll cadence to match. */
export function setPanelOpen(open: boolean): void {
  if (panelOpen === open) return
  panelOpen = open
  reschedule()
  for (const listener of panelListeners) listener()
}

/** Subscribe to overlay visibility. */
export function usePanelOpen(): boolean {
  return React.useSyncExternalStore(
    (listener) => {
      panelListeners.add(listener)
      return () => panelListeners.delete(listener)
    },
    () => panelOpen,
  )
}

const pendingDrafts = new Map<SessionId, string>()
const draftListeners = new Set<() => void>()
let draftRevision = 0

/** Stage prompt text for the next render of a session's composer. */
export function queueDraft(sessionId: SessionId, text: string): void {
  pendingDrafts.set(sessionId, text)
  draftRevision += 1
  for (const listener of draftListeners) listener()
}

/** Take a session's staged prompt, if any. */
export function consumeDraft(sessionId: SessionId): string | undefined {
  const text = pendingDrafts.get(sessionId)
  if (text === undefined) return undefined
  pendingDrafts.delete(sessionId)
  draftRevision += 1
  for (const listener of draftListeners) listener()
  return text
}

/** Subscribe to draft-queue changes. */
export function useDraftRevision(): number {
  return React.useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener)
      return () => draftListeners.delete(listener)
    },
    () => draftRevision,
  )
}

/** Reset module state when the plugin unloads. */
export function resetStore(): void {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
  panelOpen = false
  loaded = false
  panelListeners = new Set()
}
