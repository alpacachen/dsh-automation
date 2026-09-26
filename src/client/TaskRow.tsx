import React from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconWarningOutline16 } from './icons.js'
import type { AutomationTaskView } from '../types.js'
import type { t as translate } from './i18n.js'
import { formatRelative, statusState, statusLabel } from './shared.js'

/** One scannable row in the master list. */
export function TaskRow({ task, locale, t, selected, onSelect }: {
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
          {statusLabel(displayStatus, t)}
          {task.nextRunAt !== null && <> · {formatRelative(task.nextRunAt, locale)}</>}
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
