import React from 'react'
import {
  Button,
  Menu,
  StateDot,
  Tag,
  Tooltip,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconCopyOutline16,
  type MenuEntry,
  type StateDotState,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AutomationTaskView } from '../types.js'
import { t as translate } from './i18n.js'

/** Task/run status strings the API can return, mapped onto platform semantics. */
const STATE: Record<string, StateDotState> = {
  active: 'done',
  paused: 'idle',
  completed: 'idle',
  queued: 'idle',
  running: 'ongoing',
  succeeded: 'done',
  failed: 'error',
  interrupted: 'warning',
  outcome_unknown: 'warning',
  timed_out: 'warning',
  canceled: 'idle',
}

const TONE: Record<string, TagTone> = {
  active: 'success',
  paused: 'neutral',
  completed: 'quiet',
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  interrupted: 'warning',
  outcome_unknown: 'warning',
  timed_out: 'warning',
  canceled: 'quiet',
}

/** Platform state-dot semantic for a task or run status. */
export function statusState(status: string): StateDotState {
  return STATE[status] ?? 'idle'
}

/** Platform tag tone for a task or run status. */
export function statusTone(status: string): TagTone {
  return TONE[status] ?? 'neutral'
}

/** Localized label for every task and run status the API can return. */
export function statusLabel(status: string, t: typeof translate): string {
  if (status === 'active') return t('statusActive')
  if (status === 'paused') return t('statusPaused')
  if (status === 'completed') return t('statusCompleted')
  if (status === 'queued') return t('statusQueued')
  if (status === 'running') return t('statusRunning')
  if (status === 'succeeded') return t('statusSucceeded')
  if (status === 'failed') return t('statusFailed')
  if (status === 'interrupted') return t('statusInterrupted')
  if (status === 'outcome_unknown') return t('statusOutcomeUnknown')
  if (status === 'timed_out') return t('statusTimedOut')
  if (status === 'canceled') return t('statusCanceled')
  return status
}

/** Localized label for a run's trigger. */
export function triggerLabel(trigger: string, t: typeof translate): string {
  if (trigger === 'manual') return t('triggerManual')
  if (trigger === 'scheduled') return t('triggerScheduled')
  return trigger
}

/** Absolute instant in the active locale. */
export function formatDate(value: string, locale: string): string {
  return new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Signed relative time using the largest natural clock unit. */
export function formatRelative(value: string, locale: string): string {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1_000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}

/** Wall-clock span between a run's start and finish, absent while either is. */
export function formatRunDuration(startedAt: string | undefined, finishedAt: string | undefined, locale: string): string | undefined {
  if (startedAt === undefined || finishedAt === undefined) return undefined
  let seconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1_000))
  const hours = Math.floor(seconds / 3_600)
  seconds %= 3_600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const format = (value: number, unit: 'hour' | 'minute' | 'second') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value)
  if (hours > 0) return [format(hours, 'hour'), minutes > 0 && format(minutes, 'minute')].filter(Boolean).join(' ')
  if (minutes > 0) return [format(minutes, 'minute'), seconds > 0 && format(seconds, 'second')].filter(Boolean).join(' ')
  return format(seconds, 'second')
}

/** Trailing path segment, for showing a workspace by folder name. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** One option of a {@link Select}. */
export interface SelectOption {
  value: string
  label: string
  /** Secondary line under the label inside the menu. */
  hint?: string | undefined
  disabled?: boolean | undefined
}

/**
 * Menu-backed replacement for a native `<select>`.
 * @param props.value - the selected option's value.
 * @param props.options - the choices, in display order.
 * @returns a trigger button that opens the platform menu.
 */
export function Select({ value, options, onChange, disabled, id, ariaLabel }: {
  value: string
  options: readonly SelectOption[]
  onChange: (next: string) => void
  disabled?: boolean | undefined
  id?: string | undefined
  ariaLabel?: string | undefined
}) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((option) => option.value === value)
  const entries: MenuEntry[] = options.map((option) => ({
    id: option.value,
    label: option.hint === undefined ? option.label : (
      <span className="am-option">
        <span>{option.label}</span>
        <small>{option.hint}</small>
      </span>
    ),
    ...(option.disabled === true ? { disabled: true } : {}),
  }))
  return (
    <Menu
      open={open && !disabled}
      portal
      align="start"
      selectedId={value}
      items={entries}
      onSelect={(next) => {
        setOpen(false)
        if (next !== value) onChange(next)
      }}
      onClose={() => setOpen(false)}
      className="am-select-menu"
      anchor={
        <button
          type="button"
          id={id}
          className="am-select"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="am-select-value">{selected?.label ?? value}</span>
          <IconChevronDownOutline14 />
        </button>
      }
    />
  )
}

/**
 * Copy an identifier to the clipboard with inline confirmation.
 * @param props.value - the exact text to copy.
 * @returns a compact icon button.
 */
export function CopyButton({ value, t }: { value: string; t: typeof translate }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <Tooltip label={copied ? t('copied') : t('copy')} side="top">
      <button
        type="button"
        className="am-copy"
        aria-label={t('copy')}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1_500)
          }).catch(() => undefined)
        }}
      >
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
      </button>
    </Tooltip>
  )
}

/** One labelled fact in the detail overview grid. */
export function Fact({ icon, label, children, full }: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  full?: boolean
}) {
  return (
    <div className={full === true ? 'am-fact is-full' : 'am-fact'}>
      <span className="am-fact-icon" aria-hidden="true">{icon}</span>
      <span className="am-fact-body">
        <span className="am-fact-label">{label}</span>
        <span className="am-fact-value">{children}</span>
      </span>
    </div>
  )
}

/** Status dot plus its localized label, the shared status pairing. */
export function StatusTag({ status, t }: { status: string; t: typeof translate }) {
  return (
    <Tag tone={statusTone(status)} className="am-status">
      <StateDot state={statusState(status)} size={8} />
      {statusLabel(status, t)}
    </Tag>
  )
}

/** Icons the platform set does not ship, drawn at the platform's 16px weight. */
function Glyph({ paths, size = 16 }: { paths: readonly string[]; size?: number | undefined }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {paths.map((path) => <path key={path} d={path} />)}
    </svg>
  )
}

/** Permission shield; the platform icon set has no equivalent. */
export const IconShield = ({ size }: { size?: number }) =>
  <Glyph size={size} paths={['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'm9 12 2 2 4-4']} />

/** Notification bell; the platform icon set has no equivalent. */
export const IconBell = ({ size }: { size?: number }) =>
  <Glyph size={size} paths={['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0']} />

/** Calendar; the platform icon set has no equivalent. */
export const IconCalendar = ({ size }: { size?: number }) =>
  <Glyph size={size} paths={['M3 9h18', 'M7 3v4', 'M17 3v4', 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z']} />

/** Primary action button, re-exported so call sites import one module. */
export { Button }
