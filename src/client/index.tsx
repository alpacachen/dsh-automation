import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only augmentation: renderer declares ctx.slots without adding a require() call to lib/client.js.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { IconClockOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { installLocale, t as translate, useLocale } from './i18n.js'
import { AutomationPanel } from './AutomationPanel.js'
import {
  clearUnread,
  consumeDraft,
  request,
  resetStore,
  setPanelOpen,
  useAutomations,
  usePanelOpen,
  useDraftRevision,
} from './store.js'
import styles from './styles.css'

import '@deepseek-ai/dsh-client-ui-layout/client'
import '@deepseek-ai/dsh-client-ui-sidebar/client'

export const inject = ['slots', 'sessions', 'uiWorkspace', 'locale']

const STYLE_ATTRIBUTE = 'data-dsh-automation-style'

type OverlayProps = PropsRuntime<'shell.overlay'>
type InputDockProps = PropsRuntime<'conversation.input.dock'>

function installStyles(): () => void {
  if (document.querySelector(`style[${STYLE_ATTRIBUTE}]`) !== null) return () => undefined
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTRIBUTE, '')
  element.textContent = styles
  document.head.appendChild(element)
  return () => element.remove()
}

/** Push a queued prompt into the composer once its session mounts. */
function DraftInjector({ sessionId, inputActions }: InputDockProps) {
  const revision = useDraftRevision()
  React.useEffect(() => {
    const text = consumeDraft(sessionId)
    if (text !== undefined) inputActions.setDraft(text)
  }, [revision, sessionId, inputActions])
  return null
}

/** Sidebar entry point carrying the unread-notification badge. */
function AutomationButton({ wide }: { wide: boolean }) {
  const { t } = useLocale()
  const { unread } = useAutomations()
  const open = usePanelOpen()
  return (
    <button
      type="button"
      className={`am-nav ${wide ? 'is-wide' : 'is-rail'}`}
      aria-label={unread > 0 ? `${t('openAutomations')}. ${t('unreadNotifications', { count: unread })}` : t('openAutomations')}
      title={t('automations')}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => {
        setPanelOpen(true)
        void request('/notifications/read', { method: 'POST' }).then(clearUnread).catch(() => undefined)
      }}
    >
      <span className="am-nav-icon"><IconClockOutline16 size={wide ? 16 : 18} /></span>
      {wide && <span className="am-nav-label">{t('automations')}</span>}
      {unread > 0 && <span className="am-nav-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </button>
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
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
      { name: 'conversation.input.dock', id: 'automation-example-draft', order: 100 },
      DraftInjector,
    )),
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'automation-panel', order: 50, label: () => translate('automations') },
      (props: OverlayProps) => <AutomationPanel {...props} ctx={ctx} />,
    )),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    resetStore()
  }
}
