import React from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCloseOutline16, IconSearchOutline16 } from './icons.js'
import type { AgentConfigurationOptions } from '../types.js'
import { t as translate } from './i18n.js'

/**
 * Filterable skill picker showing each skill's description and invocability,
 * with the current selection restated as removable chips.
 */
export function SkillPicker({ skills, options, disabled, t, onChange }: {
  skills: readonly string[]
  options: AgentConfigurationOptions | undefined
  disabled: boolean
  t: typeof translate
  onChange: (next: string[]) => void
}) {
  const [query, setQuery] = React.useState('')
  // Selected-but-missing skills stay listed so a stale selection is visible
  // rather than silently dropped.
  const names = [...new Set([...skills, ...(options?.skills.map((entry) => entry.name) ?? [])])]
  const needle = query.trim().toLowerCase()
  const shown = needle === '' ? names : names.filter((name) => {
    const option = options?.skills.find((entry) => entry.name === name)
    return name.toLowerCase().includes(needle) || (option?.description ?? '').toLowerCase().includes(needle)
  })
  return (
    <div className="am-skills">
      <div className="am-skills-bar">
        <Input
          icon={<IconSearchOutline16 />}
          value={query}
          disabled={disabled}
          placeholder={t('skillSearchPlaceholder')}
          aria-label={t('skillSearchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {skills.length > 0 && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange([])}>
            {t('clearSkills')}
          </Button>
        )}
      </div>
      {skills.length > 0 && (
        <div className="am-skill-chips">
          <span className="am-skills-count">{t('selectedCount', { count: skills.length })}</span>
          {skills.map((name) => (
            <button
              key={name}
              type="button"
              className="am-chip-remove"
              disabled={disabled}
              aria-label={`${name} · ${t('cancel')}`}
              onClick={() => onChange(skills.filter((entry) => entry !== name))}
            >
              {name}
              <IconCloseOutline16 size={12} />
            </button>
          ))}
        </div>
      )}
      <div className="am-skill-list">
        {shown.map((name) => {
          const option = options?.skills.find((entry) => entry.name === name)
          return (
            <label key={name} className={option === undefined ? 'am-skill is-unavailable' : 'am-skill'}>
              <input
                type="checkbox"
                checked={skills.includes(name)}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked ? [...skills, name] : skills.filter((entry) => entry !== name))}
              />
              <span className="am-skill-copy">
                <b>{name}</b>
                <small>
                  {option === undefined ? t('unavailable') : option.description}
                  {option?.modelInvocable === true ? ` · ${t('modelInvocable')}` : ''}
                </small>
              </span>
            </label>
          )
        })}
        {shown.length === 0 && (
          <small className="am-empty-note">{names.length === 0 ? t('noSkills') : t('noSkillMatches')}</small>
        )}
      </div>
    </div>
  )
}
