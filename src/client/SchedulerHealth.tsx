import React from 'react'
import { HoverCard, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AutomationSchedulerHealth } from '../types.js'
import type { t as translate } from './i18n.js'
import { formatDate } from './shared.js'

/** Scheduler state as a dot whose hover card carries every health field. */
export function SchedulerHealth({ health, locale, t }: {
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
