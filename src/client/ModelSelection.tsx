import React from 'react'
import { Menu, type MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from './icons.js'
import { t as translate } from './i18n.js'
import type { SelectOption } from './shared.js'

/** Composer-style navigation, controlled by the task draft rather than a live Session. */
export function ModelSelection({ model, effort, models, efforts, disabled, modelDisabled, effortDisabled, onModel, onEffort, t }: {
  model: string
  effort: string
  models: readonly SelectOption[]
  efforts: readonly SelectOption[]
  disabled: boolean
  modelDisabled: boolean
  effortDisabled: boolean
  onModel: (value: string) => void
  onEffort: (value: string) => void
  t: typeof translate
}) {
  const [open, setOpen] = React.useState(false)
  const [pane, setPane] = React.useState<'root' | 'model' | 'effort'>('root')
  const firstEntry = React.useRef<HTMLSpanElement>(null)
  React.useEffect(() => {
    if (!open || disabled) return
    // The Host portal is initially hidden for measurement; focus after it is positioned.
    const frame = requestAnimationFrame(() => firstEntry.current?.closest('button')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, pane, disabled])
  const modelLabel = models.find((option) => option.value === model)?.label ?? model
  const effortLabel = effort === '' ? t('reasoningDefaultShort') : efforts.find((option) => option.value === effort)?.label ?? effort
  const choices = (options: readonly SelectOption[]): MenuItem[] => options.map((option) => ({
    id: option.value,
    label: <span ref={option === options.find((entry) => !entry.disabled) ? firstEntry : undefined} className={option.hint === undefined ? undefined : 'am-option'}>
      <span>{option.label}</span>{option.hint !== undefined && <small>{option.hint}</small>}
    </span>,
    ...(option.disabled === true ? { disabled: true } : {}),
  }))
  return (
    <Menu
      key={pane}
      open={open && !disabled}
      portal
      autoFocus
      align="start"
      className="am-model-menu"
      selectedId={pane === 'model' ? model : pane === 'effort' ? effort : undefined}
      items={pane === 'root' ? [
        { id: 'model', disabled: modelDisabled,
          label: <span ref={modelDisabled ? undefined : firstEntry} className="am-model-menu-row"><span>{t('model')}</span><span>{modelLabel}</span><IconChevronRightOutline14 /></span> },
        { id: 'effort', disabled: effortDisabled,
          label: <span ref={modelDisabled ? firstEntry : undefined} className="am-model-menu-row"><span>{t('reasoningEffort')}</span><span>{effortLabel}</span><IconChevronRightOutline14 /></span> },
      ] : choices(pane === 'model' ? models : efforts)}
      onSelect={(id) => {
        if (pane === 'root') { setPane(id === 'model' ? 'model' : 'effort'); return }
        setOpen(false)
        if (pane === 'model' && id !== model) onModel(id)
        if (pane === 'effort' && id !== effort) onEffort(id)
      }}
      onClose={() => setOpen(false)}
      anchor={
        <button type="button" className="am-select" disabled={disabled} aria-label={t('modelAndReasoning')}
          aria-haspopup="menu" aria-expanded={open && !disabled}
          onClick={() => { if (!open) setPane('root'); setOpen((value) => !value) }}>
          <span className="am-select-value am-model-summary"><span>{modelLabel}</span><span>{effortLabel}</span></span>
          <IconChevronDownOutline14 />
        </button>
      }
    />
  )
}
