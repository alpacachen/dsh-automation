import React from 'react'
import { IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'

/** One labelled form row. */
export function Field({ label, children, full, hint, htmlFor }: {
  label: string
  children: React.ReactNode
  full?: boolean
  hint?: string | undefined
  htmlFor?: string | undefined
}) {
  return (
    <div className={full === true ? 'am-field is-full' : 'am-field'}>
      <label className="am-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint !== undefined && <small className="am-field-hint">{hint}</small>}
    </div>
  )
}

/** One titled group of form rows. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="am-form-section">
      <h4 className="am-form-section-title">{title}</h4>
      <div className="am-form-grid">{children}</div>
    </section>
  )
}

/** Advanced settings stay available without crowding the primary editing flow. */
export function Disclosure({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="am-editor-disclosure">
      <summary className="am-form-section-title">
        <IconChevronRightOutline14 className="am-disclosure-chevron" />
        <span>{title}</span>
      </summary>
      <div className="am-form-grid">{children}</div>
    </details>
  )
}
