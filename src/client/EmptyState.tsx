import React from 'react'
import { IconAlarmClockOutline16, IconRightUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { t as translate } from './i18n.js'
import { IconCalendar, IconShield } from './shared.js'

/** Templates offered when no automation exists yet. */
export function EmptyState({ t, creating, disabled, onStart }: {
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
            <IconRightUpOutline14 className="am-example-arrow" />
          </button>
        ))}
      </div>
      <small>{disabled ? t('requiresWorkspace') : t('exampleDraftHint')}</small>
    </div>
  )
}
