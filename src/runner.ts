import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { AutomationRun, AutomationTask } from './types.js'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AutomationRunner, AutomationRunnerResult, AutomationRunCancelReason } from './scheduler.js'
import { AgentConfiguration } from './agent-configuration.js'
import type { DshImService } from './controller.js'
import { unattendedAgents, pendingUnattendedSessionIds } from './runtime-marker.js'

import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-permission-presets'
import '@deepseek-ai/dsh-session-title'
import '@deepseek-ai/dsh-workspace'

type PersistedSessionInspector = { inspect(id: SessionId): Promise<{ meta: { id: SessionId; cwd?: string } }> }

const RUN_SUMMARY_MAX_CHARS = 500

function finalAssistantSummary(events: readonly SessionEvent[]): string | undefined {
  const event = [...events].reverse().find((entry) => entry.type === 'assistant/message')
  if (event?.type !== 'assistant/message') return undefined
  const summary = event.data.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
  if (!summary) return undefined
  const characters = [...summary]
  return characters.length <= RUN_SUMMARY_MAX_CHARS
    ? summary
    : `${characters.slice(0, RUN_SUMMARY_MAX_CHARS - 1).join('')}…`
}

function titleFor(task: AutomationTask, run: AutomationRun): string {
  const time = run.scheduledAt ?? run.enqueuedAt
  return `[Automation] ${task.name}${run.trigger === 'manual' ? ' · Manual' : ''} · ${time.slice(0, 16).replace('T', ' ')}`
}

function promptFor(task: AutomationTask, run: AutomationRun): string {
  return [
    `This is an unattended DSH Automation run.`,
    `Automation: ${task.name} (${task.id})`,
    `Run: ${run.id}`,
    `Trigger: ${run.trigger}`,
    ...(run.scheduledAt === undefined ? [] : [`Scheduled occurrence: ${run.scheduledAt}`]),
    `Permission preset: ${task.security.permissionPreset}. Do not create or modify automations from this run.`,
    '',
    task.prompt,
  ].join('\n')
}

export class DshAutomationRunner implements AutomationRunner {
  private readonly active = new Map<string, {
    agent?: Agent
    cancelReason?: AutomationRunCancelReason
    cancelValidation?: () => void
  }>()

  constructor(
    private readonly ctx: Context,
    private readonly agentConfiguration = new AgentConfiguration(ctx),
    private readonly dshIm = (ctx as Context & { dshIm?: DshImService }).dshIm,
  ) {}

  cancel(runId: string, reason: AutomationRunCancelReason): boolean {
    const active = this.active.get(runId)
    if (active === undefined) return false
    if (active.cancelReason !== undefined) return true
    const cancelPreparation = active.cancelValidation
    active.cancelReason = reason
    cancelPreparation?.()
    try {
      active.agent?.cancel({ kind: 'hook', reason: `automation_${reason}` })
    } catch {
      if (cancelPreparation !== undefined) return true
      delete active.cancelReason
      return false
    }
    return true
  }

  async run(task: AutomationTask, run: AutomationRun): Promise<AutomationRunnerResult> {
    const active: {
      agent?: Agent
      cancelReason?: AutomationRunCancelReason
      cancelValidation?: () => void
    } = {}
    this.active.set(run.id, active)
    const configuredTarget = task.execution.target ?? { mode: 'fresh' as const }
    const configuredPinned = configuredTarget.mode === 'pinned-session' ? configuredTarget as { mode: 'pinned-session'; sessionId: string; workspaceId: string; cwd: string; fallback: 'fail' } : undefined
    const snapshot = run.executionTarget as { mode: string; sessionId?: string; workspaceId?: string; cwd?: string } | undefined
    const pinned = (run.executionTarget?.mode ?? configuredTarget.mode) === 'pinned-session'
    const executionTarget = pinned && configuredPinned !== undefined
      ? { ...configuredPinned, sessionId: snapshot?.sessionId ?? configuredPinned.sessionId, workspaceId: snapshot?.workspaceId ?? configuredPinned.workspaceId, cwd: snapshot?.cwd ?? configuredPinned.cwd }
      : undefined
    if (pinned && executionTarget === undefined) throw new Error('target_resume_failed: pinned target snapshot is unavailable.')
    if (pinned && run.sessionId !== undefined && run.sessionId !== executionTarget?.sessionId) {
      throw new Error('target_resume_failed: run target snapshot does not match its session id.')
    }
    if (pinned && snapshot?.mode === 'pinned-session' && (snapshot.workspaceId !== undefined && snapshot.workspaceId !== configuredPinned?.workspaceId || snapshot.cwd !== undefined && snapshot.cwd !== configuredPinned?.cwd)) {
      throw new Error('target_resume_failed: run target snapshot does not match configured target.')
    }
    const sessionId = SessionId(pinned ? executionTarget!.sessionId : (run.sessionId ?? `automation-${randomUUID()}`))
    let handle: AgentHandle | undefined
    let keepSessionLive = false
    try {
      const canceledDuringValidation = new Promise<never>((_resolve, reject) => {
        active.cancelValidation = () => reject(new Error(`Automation run canceled before Agent creation: ${active.cancelReason}.`))
      })
      // Older state could capture provider/model independently. Preserve that
      // runtime behavior while new create/update requests require a complete pair.
      const validationExecution = pinned
        ? { ...task.execution, agentPreset: undefined, provider: undefined, model: undefined, skills: [] }
        : task.execution
      await Promise.race([
        this.agentConfiguration.validate(validationExecution, task.security.permissionPreset, { allowLegacyPartialModel: true }),
        canceledDuringValidation,
      ])
      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(executionTarget?.workspaceId ?? task.execution.workspaceId))
        ?? (pinned ? undefined : await this.ctx.workspaceRegistry.create(task.execution.cwd))
      if (workspace === undefined) throw new Error('target_workspace_mismatch: target workspace is unavailable.')
      if (executionTarget !== undefined && workspace.path !== executionTarget.cwd) throw new Error('target_workspace_mismatch: target cwd does not match.')
      if (pinned) {
        pendingUnattendedSessionIds.add(sessionId)
        const persistence = (this.ctx as Context & { sessionPersistence?: PersistedSessionInspector }).sessionPersistence
        if (persistence === undefined) throw new Error('target_session_unavailable: persisted session inspection is unavailable.')
        let inspection: { meta: { id: SessionId; cwd?: string } }
        try { inspection = await persistence.inspect(sessionId) } catch { throw new Error('target_session_not_found: pinned session could not be resolved.') }
        if (inspection.meta.id !== sessionId) throw new Error('target_session_not_found: pinned session could not be resolved.')
        if (inspection.meta.cwd !== executionTarget?.cwd) throw new Error('target_workspace_mismatch: target session cwd does not match.')
        handle = await this.ctx.agents.resume({ resumeSessionId: sessionId })
        pendingUnattendedSessionIds.delete(sessionId)
      } else {
        handle = await this.ctx.agents.create({
          sessionId,
          meta: { cwd: workspace.path, ...(task.execution.agentPreset === undefined ? {} : { agentPreset: task.execution.agentPreset }) },
          agentOptions: {
            ...(task.execution.provider === undefined ? {} : { provider: task.execution.provider }),
            ...(task.execution.model === undefined ? {} : { model: task.execution.model }),
          },
          setup: async (agentCtx) => { await this.ctx.agentPresets.mount(agentCtx, task.execution.agentPreset) },
        })
      }
      if (handle === undefined) throw new Error('target_resume_failed: unable to create agent runtime.')
      active.agent = handle.agent
      if (pinned) unattendedAgents.add(handle.agent)
      if (pinned && handle.agent.session.header.id !== sessionId) throw new Error('target_session_not_found: resumed session id does not match target.')
      if (pinned && handle.agent.session.header.cwd !== executionTarget?.cwd) throw new Error('target_workspace_mismatch: resumed session cwd does not match.')
      if (pinned && handle.agent.status !== 'idle') throw new Error('target_session_busy: target session is busy.')
      this.ctx.permissionPresets.set(handle.agent.session, task.security.permissionPreset)
      const selectedSkills = pinned ? [] : await Promise.race([
        this.agentConfiguration.loadSelectedSkills(handle.agent, task), canceledDuringValidation,
      ])
      delete active.cancelValidation
      for (const skill of selectedSkills) {
        handle.agent.inject(createUserMessage({
          content: [{ type: 'text', text: skill.text }],
          source: skill.source,
        }))
      }
      if (!pinned) {
        this.ctx.sessionTitle.rename(handle.agent.session, titleFor(task, run))
        await this.ctx.sessions.flush(handle.agent.session)
        await workspace.attachSession(sessionId)
      }

      if (active.cancelReason !== undefined) {
        keepSessionLive = !pinned
        return { status: 'failed', sessionId, error: `Automation run canceled before execution: ${active.cancelReason}.` }
      }

      const baseline = handle.agent.session.events.length
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: promptFor(task, run) }],
        source: { kind: 'plugin', plugin: 'automation' },
      }))
      await handle.agent.whenIdle()
      await this.ctx.sessions.flush(handle.agent.session)

      const runEvents = handle.agent.session.events.slice(baseline)
      const summary = finalAssistantSummary(runEvents)
      const turnEnd = runEvents
        .filter((event) => event.type === 'turn/end')
        .at(-1)
      let result: AutomationRunnerResult = {
        status: 'succeeded',
        sessionId,
        ...(summary === undefined ? {} : { summary }),
      }
      if (turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind !== 'completed') {
        const reason = turnEnd.data.reason
        const detail = reason.kind === 'error' ? reason.error.message : reason.kind
        result = {
          status: 'failed',
          sessionId,
          ...(summary === undefined ? {} : { summary }),
          error: `Automation turn ended with ${detail}.`,
        }
      }
      const notificationTarget = task.notificationTarget
      const notify = notificationTarget !== undefined && summary !== undefined && (task.notificationPolicy === 'always' || (task.notificationPolicy === 'failures' && result.status !== 'succeeded'))
      if (notify && this.dshIm !== undefined) {
        try { await this.dshIm.send(notificationTarget!.botId, notificationTarget!.targetId, summary!) } catch (error) {
          this.ctx.logger?.warn?.(`automation notification failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // The owner fiber disposes this handle on plugin shutdown. Disposing it here
      // emits session/removed, so the sidebar drops the new persisted session.
      keepSessionLive = !pinned
      return result
    } finally {
      delete active.cancelValidation
      this.active.delete(run.id)
      if (handle !== undefined) unattendedAgents.delete(handle.agent)
      pendingUnattendedSessionIds.delete(sessionId)
      if (handle !== undefined && !keepSessionLive) await handle.dispose()
    }
  }
}
