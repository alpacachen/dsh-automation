import React from 'react'
import {
  Button,
  Input,
  IconQuestionOutline14,
  IconSearchOutline16,
  Switch,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AgentConfigurationOptions, AutomationDelivery, AutomationDeliveryOptions, AutomationExecutionPatch, AutomationTaskView } from '../types.js'
import { t as translate } from './i18n.js'
import { ScheduleSection, useScheduleEditor } from './ScheduleSection.js'
import { Select, type SelectOption } from './shared.js'
import { request } from './store.js'
import { Disclosure, Field, Section } from './editor-layout.js'
import { SkillPicker } from './SkillPicker.js'

/** The PATCH body shape the controller accepts. */
export type TaskUpdateBody = Partial<Pick<AutomationTaskView, 'name' | 'prompt' | 'schedule' | 'notificationPolicy' | 'pauseAfterConsecutiveFailures'>> & {
  permissionPreset?: AutomationTaskView['security']['permissionPreset']
  confirmPermissionChange?: true
  confirmSessionTargetChange?: true
  delivery?: AutomationDelivery | null
  confirmDeliveryChange?: true
  execution?: Omit<AutomationExecutionPatch, 'target' | 'sessionTargetConfirmed'> & {
    target?: { mode: 'fresh' } | { mode: 'pinned-session'; sessionId: string }
  }
}

/**
 * Edit one automation in place in the detail pane.
 * @param props.task - the automation being edited.
 * @param props.saving - a write is in flight; every control locks.
 * @returns the editor form.
 */
export function TaskEditor({ task, sessions, workspaceSessionIds, refreshSessions, saving, t, onSave, onCancel, onDirtyChange }: {
  task: AutomationTaskView
  sessions: SessionListState
  workspaceSessionIds: readonly string[]
  refreshSessions: () => Promise<void>
  saving: boolean
  t: typeof translate
  onSave: (body: TaskUpdateBody) => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const initialTarget = task.execution.target
  const [targetMode, setTargetMode] = React.useState(initialTarget?.mode ?? 'fresh')
  const [targetSessionId, setTargetSessionId] = React.useState(initialTarget?.mode === 'pinned-session' ? initialTarget.sessionId : '')
  const [sessionQuery, setSessionQuery] = React.useState('')
  const [sessionsLoading, setSessionsLoading] = React.useState(true)
  const [sessionsError, setSessionsError] = React.useState<string>()
  const [sessionRefresh, setSessionRefresh] = React.useState(0)
  React.useEffect(() => {
    let active = true
    setSessionsLoading(true)
    setSessionsError(undefined)
    void refreshSessions().then(() => {
      if (active) setSessionsError(undefined)
    }, (error: unknown) => {
      if (active) setSessionsError(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (active) setSessionsLoading(false) })
    return () => { active = false }
  }, [refreshSessions, sessionRefresh])
  // refresh() can resolve after a remote failure. Derive readiness from the
  // latest render, not the snapshot captured when the refresh began.
  const sessionLoadError = sessionsError ?? (!sessionsLoading && sessions.phase !== 'ready' ? t('sessionsNotReady') : undefined)
  const pinned = targetMode === 'pinned-session'
  const targetChanged = targetMode !== (initialTarget?.mode ?? 'fresh') ||
    (pinned && targetSessionId !== (initialTarget?.mode === 'pinned-session' ? initialTarget.sessionId : ''))
  const targetLocked = task.running || task.runs.some((run) => run.status === 'queued' || run.status === 'running')
  const candidates = sessions.ids.map((id) => sessions.byId[id])
    .filter((session) => session !== undefined)
    .filter((session) => workspaceSessionIds.includes(session.id) && session.cwd === task.execution.cwd && session.origin !== 'subagent')
  const selectedSession = candidates.find((session) => session.id === targetSessionId)
  const targetValid = !targetChanged || (!targetLocked && (!pinned ||
    (!sessionsLoading && sessionLoadError === undefined && sessions.phase === 'ready' && selectedSession !== undefined)))
  const needle = sessionQuery.trim().toLowerCase()
  const sessionOptions: SelectOption[] = [
    { value: '', label: t('selectSession'), disabled: true },
    ...(targetSessionId !== '' && selectedSession === undefined
      ? [{ value: targetSessionId, label: `${targetSessionId} · ${t('unavailable')}`, disabled: true }] : []),
    ...candidates.filter((session) => session.id === targetSessionId ||
      `${session.displayTitle} ${session.id}`.toLowerCase().includes(needle)).map((session) => ({
      value: session.id,
      label: `${session.displayTitle}${session.id === sessions.current ? ` · ${t('currentSession')}` : ''}${session.running ? ` · ${t('statusRunning')}` : ''}`,
      hint: `${session.id} · ${new Date(session.updatedAt).toLocaleString()}`,
    })),
  ]
  const [deliveryEnabled, setDeliveryEnabled] = React.useState(task.delivery !== undefined)
  const [deliveryBotId, setDeliveryBotId] = React.useState(task.delivery?.botId ?? '')
  const [deliveryTargetId, setDeliveryTargetId] = React.useState(task.delivery?.targetId ?? '')
  const [deliveryCatalog, setDeliveryCatalog] = React.useState<{ botId: string; options: AutomationDeliveryOptions }>()
  const [deliveryLoading, setDeliveryLoading] = React.useState(false)
  const [deliveryError, setDeliveryError] = React.useState<string>()
  const [deliveryRefresh, setDeliveryRefresh] = React.useState(0)
  React.useEffect(() => {
    if (!deliveryEnabled) return
    const controller = new AbortController()
    setDeliveryLoading(true)
    setDeliveryError(undefined)
    const query = deliveryBotId === '' ? '' : `?botId=${encodeURIComponent(deliveryBotId)}`
    void request(`/delivery-options${query}`, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setDeliveryCatalog({ botId: deliveryBotId, options: (value as { options: AutomationDeliveryOptions }).options })
    }, (error: unknown) => {
      if (!controller.signal.aborted) setDeliveryError(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (!controller.signal.aborted) setDeliveryLoading(false) })
    return () => controller.abort()
  }, [deliveryEnabled, deliveryBotId, deliveryRefresh])
  const deliveryOptions = deliveryCatalog?.options
  // A previous bot's catalog must never validate or label the new target.
  const deliveryTargets = deliveryCatalog?.botId === deliveryBotId ? deliveryOptions?.targets ?? [] : []
  const selectedDeliveryBot = deliveryOptions?.bots.find((entry) => entry.botId === deliveryBotId)
  const selectedDeliveryTarget = deliveryTargets.find((entry) => entry.targetId === deliveryTargetId)
  const deliveryChanged = deliveryEnabled !== (task.delivery !== undefined) || (deliveryEnabled &&
    (deliveryBotId !== task.delivery?.botId || deliveryTargetId !== task.delivery?.targetId))
  const deliveryValid = !deliveryChanged || (!targetLocked && (!deliveryEnabled ||
    (!deliveryLoading && deliveryError === undefined && deliveryOptions?.available === true &&
      selectedDeliveryBot !== undefined && selectedDeliveryTarget !== undefined)))
  const deliveryBotOptions: SelectOption[] = [
    { value: '', label: t('selectDeliveryBot'), disabled: true },
    ...(deliveryBotId !== '' && selectedDeliveryBot === undefined
      ? [{ value: deliveryBotId, label: `${deliveryBotId} · ${t('unavailable')}`, disabled: true }] : []),
    ...(deliveryOptions?.bots ?? []).map((entry) => ({ value: entry.botId, label: `${entry.channel} · ${entry.botId}` })),
  ]
  const deliveryTargetOptions: SelectOption[] = [
    { value: '', label: t('selectDeliveryTarget'), disabled: true },
    ...(deliveryTargetId !== '' && selectedDeliveryTarget === undefined
      ? [{ value: deliveryTargetId, label: `${deliveryTargetId} · ${t('unavailable')}`, disabled: true }] : []),
    ...deliveryTargets.map((entry) => ({ value: entry.targetId,
      label: entry.name ? `${entry.name} · ${entry.targetId}` : entry.targetId, hint: entry.kind })),
  ]
  const [name, setName] = React.useState(task.name)
  const [prompt, setPrompt] = React.useState(task.prompt)
  const [notificationPolicy, setNotificationPolicy] = React.useState(task.notificationPolicy)
  const [pauseAfterFailures, setPauseAfterFailures] = React.useState(task.pauseAfterConsecutiveFailures)
  const [permissionPreset, setPermissionPreset] = React.useState(task.security.permissionPreset)
  const [permissionConfirmed, setPermissionConfirmed] = React.useState(false)
  const [agentPreset, setAgentPreset] = React.useState(task.execution.agentPreset ?? '')
  const [provider, setProvider] = React.useState(task.execution.provider ?? '')
  const [model, setModel] = React.useState(task.execution.model ?? '')
  const [skills, setSkills] = React.useState<string[]>(task.execution.skills)
  const [options, setOptions] = React.useState<AgentConfigurationOptions>()
  const [optionsLoading, setOptionsLoading] = React.useState(true)
  const [optionsError, setOptionsError] = React.useState<string>()
  const scheduleEditor = useScheduleEditor(task)
  const { scheduleChanged } = scheduleEditor
  const permissionChanged = permissionPreset !== task.security.permissionPreset
  const modelChanged = provider !== (task.execution.provider ?? '') || model !== (task.execution.model ?? '')
  const agentExecutionChanged = !pinned && (agentPreset !== (task.execution.agentPreset ?? '') || modelChanged ||
    skills.join('\0') !== task.execution.skills.join('\0'))
  const executionChanged = targetChanged || agentExecutionChanged
  const changed = name.trim() !== task.name || prompt.trim() !== task.prompt || scheduleChanged || permissionChanged ||
    executionChanged || deliveryChanged || notificationPolicy !== task.notificationPolicy || pauseAfterFailures !== task.pauseAfterConsecutiveFailures
  const selectedPermission = options?.permissions.find((entry) => entry.id === permissionPreset)
  const selectedProvider = options?.models.find((entry) => entry.provider === provider)
  const selectedPresetAvailable = agentPreset === '' || options?.presets.some((entry) => entry.id === agentPreset && entry.broken === undefined)
  const skillsAvailable = skills.every((entry) => options?.skills.some((option) => option.name === entry))
  const legacyPartialModelUnchanged = !modelChanged && ((task.execution.provider === undefined) !== (task.execution.model === undefined))
  const configValid = selectedPermission !== undefined && (pinned || (selectedPresetAvailable !== false && skillsAvailable &&
    (((provider === '') === (model === '')) || legacyPartialModelUnchanged)))
  const requiredFieldsValid = name.trim() !== '' && prompt.trim() !== '' && scheduleEditor.valid
  const blocked = saving || optionsLoading || optionsError !== undefined || !configValid || !targetValid || !deliveryValid || !requiredFieldsValid || !changed || (permissionChanged && !permissionConfirmed)

  React.useEffect(() => {
    onDirtyChange?.(changed)
  }, [changed, onDirtyChange])

  const optionsRequestSequence = React.useRef(0)
  const loadOptions = React.useCallback(async (candidate?: string) => {
    const sequence = ++optionsRequestSequence.current
    try {
      setOptionsLoading(true)
      setOptionsError(undefined)
      const query = candidate === undefined ? '' : `?agentPreset=${encodeURIComponent(candidate)}`
      const value = await request(`/tasks/${encodeURIComponent(task.id)}/options${query}`) as { options: AgentConfigurationOptions }
      if (sequence === optionsRequestSequence.current) setOptions(value.options)
    } catch (reason) {
      if (sequence === optionsRequestSequence.current) {
        setOptionsError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (sequence === optionsRequestSequence.current) setOptionsLoading(false)
    }
  }, [task.id])

  React.useEffect(() => {
    void loadOptions()
    return () => { optionsRequestSequence.current += 1 }
  }, [loadOptions])

  const presetOptions: SelectOption[] = [
    { value: '', label: t('hostDefault') },
    ...(agentPreset !== '' && options?.presets.some((entry) => entry.id === agentPreset) !== true
      ? [{ value: agentPreset, label: `${agentPreset} · ${t('unavailable')}` }]
      : []),
    ...(options?.presets ?? []).map((entry) => ({
      value: entry.id,
      label: `${entry.name} · ${entry.trust}${entry.broken === undefined ? '' : ` · ${t('unavailable')}`}`,
      ...(entry.description === undefined ? {} : { hint: entry.description }),
      ...(entry.broken === undefined ? {} : { disabled: true }),
    })),
  ]
  const providerOptions: SelectOption[] = [
    { value: '', label: t('hostDefault') },
    ...(provider !== '' && options?.models.some((entry) => entry.provider === provider) !== true
      ? [{ value: provider, label: `${provider} · ${t('unavailable')}` }]
      : []),
    ...(options?.models ?? []).map((entry) => ({ value: entry.provider, label: entry.name })),
  ]
  const modelOptions: SelectOption[] = [
    { value: '', label: provider === '' ? t('hostDefault') : t('selectModel') },
    ...(model !== '' && selectedProvider?.models.some((entry) => entry.id === model) !== true
      ? [{ value: model, label: `${model} · ${t('notInCatalog')}` }]
      : []),
    ...(selectedProvider?.models ?? []).map((entry) => ({
      value: entry.id,
      label: entry.name,
      ...(entry.description === undefined ? {} : { hint: entry.description }),
    })),
  ]
  const permissionOptions: SelectOption[] = [
    ...(options?.permissions.some((entry) => entry.id === permissionPreset) !== true
      ? [{ value: permissionPreset, label: `${permissionPreset} · ${t('unavailable')}` }]
      : []),
    ...(options?.permissions ?? []).map((entry) => ({
      value: entry.id,
      label: entry.name,
      ...(entry.description === undefined ? {} : { hint: entry.description }),
    })),
  ]

  return (
    <form
      className="am-editor"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked || !event.currentTarget.reportValidity()) return
        const schedule = scheduleEditor.getSchedule()
        onSave({
          ...(name.trim() === task.name ? {} : { name }),
          ...(prompt.trim() === task.prompt ? {} : { prompt }),
          ...(schedule === undefined ? {} : { schedule }),
          ...(notificationPolicy === task.notificationPolicy ? {} : { notificationPolicy }),
          ...(pauseAfterFailures === task.pauseAfterConsecutiveFailures ? {} : { pauseAfterConsecutiveFailures: pauseAfterFailures }),
          ...(permissionChanged ? { permissionPreset, confirmPermissionChange: true as const } : {}),
          ...(targetChanged ? { confirmSessionTargetChange: true as const } : {}),
          ...(deliveryChanged ? deliveryEnabled
            ? { delivery: { botId: deliveryBotId, targetId: deliveryTargetId }, confirmDeliveryChange: true as const }
            : { delivery: null } : {}),
          ...(executionChanged ? {
            execution: {
              ...(targetChanged ? { target: pinned ? { mode: 'pinned-session' as const, sessionId: targetSessionId } : { mode: 'fresh' as const } } : {}),
              ...(!agentExecutionChanged ? {} : {
                ...(agentPreset === (task.execution.agentPreset ?? '') ? {} : { agentPreset: agentPreset || null }),
                ...((provider === (task.execution.provider ?? '') && model === (task.execution.model ?? '')) ? {} : {
                  provider: provider || null,
                  model: model || null,
                }),
                ...(skills.join('\0') === task.execution.skills.join('\0') ? {} : { skills }),
              }),
            },
          } : {}),
        })
      }}
    >
      <div className="am-editor-scroll">
        <p className="am-editor-hint">{t('editFutureRunsHint')}</p>

        <Section title={t('sectionBasics')}>
          <Field full label={t('nameLabel')} htmlFor="am-name">
            <Input id="am-name" className="am-input" required disabled={saving} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field full label={t('promptLabel')} htmlFor="am-prompt">
            <textarea id="am-prompt" className="am-textarea" required rows={6} disabled={saving} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </Field>
        </Section>

        <ScheduleSection schedule={scheduleEditor} saving={saving} t={t} />

        {optionsLoading && <p className="am-alert is-info" role="status">{t('optionsLoading')}</p>}
        {optionsError !== undefined && <p className="am-alert is-error" role="alert">{t('optionsFailure', { error: optionsError })}</p>}
        {options?.modelFailures.map((failure) => (
          <p key={failure.provider} className="am-alert is-error" role="alert">
            {t('providerFailure', { provider: failure.provider, error: failure.error })}
          </p>
        ))}
        {!configValid && !optionsLoading && optionsError === undefined && (
          <p className="am-alert is-error" role="alert">{t('editorConfigInvalid')}</p>
        )}
        {(optionsError !== undefined || !configValid || (options?.modelFailures.length ?? 0) > 0) && !optionsLoading && (
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => { void loadOptions(agentPreset) }}>
            {t('retry')}
          </Button>
        )}
        {!requiredFieldsValid && <p className="am-alert is-error" role="alert">{t('editorRequiredFields')}</p>}
        {permissionChanged && !permissionConfirmed && (
          <p className="am-alert is-warning" role="status">{t('permission')} · {t('confirmPermissionChange', { permission: selectedPermission?.name ?? permissionPreset })}</p>
        )}

        <Section title={t('executionDestination')}>
          <Field full label={t('executionMode')} hint={t('sessionWorkspaceHint', { cwd: task.execution.cwd })}>
            <Select
              value={targetMode}
              ariaLabel={t('executionMode')}
              disabled={saving || targetLocked}
              options={[{ value: 'fresh', label: t('executionFresh') }, { value: 'pinned-session', label: t('executionExisting') }]}
              onChange={(value) => setTargetMode(value as 'fresh' | 'pinned-session')}
            />
          </Field>
          {targetLocked && <p className="am-alert is-info is-full">{t('sessionTargetLocked')}</p>}
          {pinned && <>
            <Field full label={t('targetSession')} hint={t('pinnedSessionHint')}>
              <Input
                icon={<IconSearchOutline16 />}
                value={sessionQuery}
                disabled={saving || targetLocked}
                placeholder={t('sessionSearch')}
                aria-label={t('sessionSearch')}
                onChange={(event) => setSessionQuery(event.target.value)}
              />
              <Select
                value={targetSessionId}
                ariaLabel={t('targetSession')}
                disabled={saving || targetLocked || sessionsLoading || sessionLoadError !== undefined || sessions.phase !== 'ready'}
                options={sessionOptions}
                onChange={setTargetSessionId}
              />
              {!sessionsLoading && sessionLoadError === undefined && sessionOptions.length === 1 && <small className="am-field-hint">{t('noSessionMatches')}</small>}
            </Field>
            {(sessionsLoading || sessions.phase !== 'ready') && sessionLoadError === undefined && <p className="am-alert is-info is-full" role="status">{t('sessionsLoading')}</p>}
            {sessionLoadError !== undefined && <div className="is-full">
              <p className="am-alert is-error" role="alert">{t('sessionsFailure', { error: sessionLoadError })}</p>
              <Button type="button" variant="ghost" size="sm" disabled={saving || sessionsLoading} onClick={() => setSessionRefresh((value) => value + 1)}>{t('retry')}</Button>
            </div>}
            {!sessionsLoading && sessionLoadError === undefined && targetSessionId !== '' && selectedSession === undefined &&
              <p className="am-alert is-warning is-full">{t('targetSessionUnavailable')}</p>}
          </>}
          {targetChanged && (!pinned || targetSessionId !== '') &&
            <small className="am-field-hint is-full">{t('sessionTargetSaveHint', { target: pinned ? selectedSession?.displayTitle ?? targetSessionId : t('executionFresh') })}</small>}
        </Section>

        {!pinned && <Disclosure title={t('agentExecution')}>
          <Field
            full
            label={t('agentPreset')}
            hint={agentPreset === '' ? undefined : options?.presets.find((entry) => entry.id === agentPreset)?.description}
          >
            <Select
              value={agentPreset}
              disabled={saving || optionsLoading}
              ariaLabel={t('agentPreset')}
              options={presetOptions}
              onChange={(next) => {
                setAgentPreset(next)
                void loadOptions(next)
              }}
            />
          </Field>
          <Field label={t('provider')}>
            <Select
              value={provider}
              disabled={saving || optionsLoading}
              ariaLabel={t('provider')}
              options={providerOptions}
              onChange={(next) => {
                setProvider(next)
                setModel('')
              }}
            />
          </Field>
          <Field label={t('model')}>
            <Select
              value={model}
              disabled={saving || optionsLoading || provider === ''}
              ariaLabel={t('model')}
              options={modelOptions}
              onChange={setModel}
            />
          </Field>
          <Field full label={t('selectedSkills')}>
            <SkillPicker skills={skills} options={options} disabled={saving || optionsLoading} t={t} onChange={setSkills} />
          </Field>
        </Disclosure>}

        <Disclosure title={<>{t('messageDelivery')}
          <Tooltip label={t('deliveryHelpText')} side="bottom" maxWidth={320}>
            <button type="button" className="am-icon-button am-help-button" aria-label={t('deliveryHelp')} aria-description={t('deliveryHelpText')}
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus() }}>
              <IconQuestionOutline14 />
            </button>
          </Tooltip>
        </>}>
          <Field full label={t('deliveryEnabled')} hint={t('deliveryHint')}>
            <Switch checked={deliveryEnabled} disabled={saving || targetLocked} label={t('deliveryEnabled')}
              onChange={setDeliveryEnabled} />
          </Field>
          {targetLocked && <p className="am-alert is-info is-full">{t('deliveryLocked')}</p>}
          {deliveryEnabled && <>
            <Field full label={t('deliveryBot')}>
              <Select value={deliveryBotId} options={deliveryBotOptions} ariaLabel={t('deliveryBot')}
                disabled={saving || targetLocked || deliveryOptions?.available !== true}
                onChange={(id) => { setDeliveryBotId(id); setDeliveryTargetId('') }} />
            </Field>
            <Field full label={t('deliveryTarget')}>
              <Select value={deliveryTargetId} options={deliveryTargetOptions} ariaLabel={t('deliveryTarget')}
                disabled={saving || targetLocked || deliveryLoading || deliveryError !== undefined || deliveryOptions?.available !== true || deliveryBotId === ''}
                onChange={setDeliveryTargetId} />
            </Field>
            {deliveryLoading && <p className="am-alert is-info is-full" role="status">{t('deliveryLoading')}</p>}
            {!deliveryLoading && deliveryError === undefined && deliveryOptions?.available === true && <div className="is-full">
              {deliveryOptions.bots.length === 0 && <p className="am-alert is-info">{t('deliveryNoBots')}</p>}
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setDeliveryRefresh((value) => value + 1)}>{t('refresh')}</Button>
            </div>}
            {!deliveryLoading && (deliveryError !== undefined || deliveryOptions?.available === false) && <div className="is-full">
              <p className="am-alert is-warning" role="alert">{deliveryError !== undefined
                ? t('deliveryLoadFailed', { error: deliveryError }) : t('deliveryUnavailable')}</p>
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setDeliveryRefresh((value) => value + 1)}>{t('retry')}</Button>
            </div>}
            {!deliveryLoading && deliveryError === undefined && deliveryOptions?.available === true &&
              ((deliveryBotId !== '' && selectedDeliveryBot === undefined) || (deliveryTargetId !== '' && selectedDeliveryTarget === undefined)) &&
              <p className="am-alert is-warning is-full">{t('deliverySavedUnavailable')}</p>}
            {!deliveryLoading && deliveryError === undefined && deliveryOptions?.available === true && deliveryBotId !== '' &&
              selectedDeliveryBot !== undefined && deliveryTargets.length === 0 &&
              <p className="am-alert is-info is-full">{t('deliveryNoTargets')}</p>}
            {deliveryChanged && deliveryBotId !== '' && deliveryTargetId !== '' &&
              <small className="am-field-hint is-full">{t('deliverySaveHint', { bot: deliveryBotId, target: deliveryTargetId })}</small>}
          </>}
        </Disclosure>

        <Disclosure title={t('notifications')}>
          <Field label={t('notifications')}>
            <Select
              value={notificationPolicy}
              disabled={saving}
              ariaLabel={t('notifications')}
              options={[
                { value: 'failures', label: t('notificationFailures') },
                { value: 'always', label: t('notificationAlways') },
                { value: 'never', label: t('notificationNever') },
              ]}
              onChange={(next) => setNotificationPolicy(next as AutomationTaskView['notificationPolicy'])}
            />
          </Field>
          <Field label={t('pauseAfterFailures')}>
            <Switch
              checked={pauseAfterFailures}
              disabled={saving}
              label={t('pauseAfterFailures')}
              onChange={setPauseAfterFailures}
            />
          </Field>
        </Disclosure>

        <Disclosure title={t('permission')}>
          <Field
            full
            label={t('permission')}
            hint={selectedPermission === undefined
              ? undefined
              : [selectedPermission.description, `${selectedPermission.sandbox} · approval: ${selectedPermission.approval}`].filter(Boolean).join(' · ')}
          >
            <Select
              value={permissionPreset}
              disabled={saving || optionsLoading}
              ariaLabel={t('permission')}
              options={permissionOptions}
              onChange={(next) => {
                setPermissionPreset(next)
                setPermissionConfirmed(false)
              }}
            />
          </Field>
          {selectedPermission?.approval === 'ask' && (
            <p className="am-alert is-warning is-full" role="alert">{t('approvalAskWarning')}</p>
          )}
          {permissionChanged && (
            <div className="am-alert is-warning is-full am-confirm">
              <Switch
                checked={permissionConfirmed}
                disabled={saving}
                label={t('confirmPermissionChange', { permission: selectedPermission?.name ?? permissionPreset })}
                onChange={setPermissionConfirmed}
              />
              <span aria-hidden="true">{t('confirmPermissionChange', { permission: selectedPermission?.name ?? permissionPreset })}</span>
            </div>
          )}
        </Disclosure>
      </div>

      <footer className="am-editor-footer">
        {!configValid && !optionsLoading && <Tag tone="danger">{t('unavailable')}</Tag>}
        <span className="am-spacer" />
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" size="sm" disabled={blocked}>
          {saving ? t('saving') : t('saveChanges')}
        </Button>
      </footer>
    </form>
  )
}
