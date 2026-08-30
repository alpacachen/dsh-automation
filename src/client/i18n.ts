import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleSnapshot, TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { AutomationLocaleKey } from './locales.js'
import { en, zh } from './locales.js'

import '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-automation': AutomationLocaleKey
  }
}

const NAMESPACE = 'dsh-automation'
let localeService: Context['locale'] | undefined
let translate: TranslateNS<typeof NAMESPACE> | undefined

export function installLocale(ctx: Context): () => void {
  const locale = ctx.locale
  const dispose = locale.register(NAMESPACE, { en, zh })
  localeService = locale
  translate = locale.bind(NAMESPACE)
  return () => {
    dispose()
    if (localeService === locale) {
      localeService = undefined
      translate = undefined
    }
  }
}

export function t(key: AutomationLocaleKey, params?: Record<string, unknown>): string {
  return translate?.(key, params) ?? en[key]
}

const subscribe = (listener: () => void): (() => void) => localeService?.subscribe(listener) ?? (() => undefined)
const snapshot = (): LocaleSnapshot | undefined => localeService?.getSnapshot()

export function useLocale(): { t: typeof t; locale: string } {
  const current = React.useSyncExternalStore(subscribe, snapshot, snapshot)
  return { t, locale: current?.active ?? 'en' }
}
