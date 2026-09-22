import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AutomationError } from './errors.js'
import type { AutomationRun, AutomationTask } from './types.js'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AutomationRunner, AutomationRunnerResult, AutomationRunCancelReason } from './scheduler.js'
import { AgentConfiguration } from './agent-configuration.js'
import { unattendedAgents } from './runtime-marker.js'

import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-permission-presets'
import '@deepseek-ai/dsh-session-title'
import '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-api-session-controller'

const RUN_SUMMARY_MAX_CHARS = 500

function assistantText(event: SessionEvent<'assistant/message'>): string {
  return event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
}

function assistantSummary(text: string): string | undefined {
  const summary = text.replace(/\s+/g, ' ').trim()
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

type ActiveRun = {
  cancelReason?: AutomationRunCancelReason
  cancelValidation?: () => void
  cancelTurn?: () => void
}

export class DshAutomationRunner implements AutomationRunner {
  private readonly active = new Map<string, ActiveRun>()

  constructor(
    private readonly ctx: Context,
    private readonly agentConfiguration = new AgentConfiguration(ctx),
  ) {}

  cancel(runId: string, reason: AutomationRunCancelReason): boolean {
    const active = this.active.get(runId)
    if (active === undefined) return false
    if (active.cancelReason !== undefined) return true
    const cancelPreparation = active.cancelValidation
    if (cancelPreparation === undefined && active.cancelTurn === undefined) return false
    active.cancelReason = reason
    cancelPreparation?.()
    try {
      active.cancelTurn?.()
    } catch {
      if (cancelPreparation !== undefined) return true
      delete active.cancelReason
      return false
    }
    return true
  }

  /** Follow one identified message, not the lifetime of the whole shared Agent. */
  private async runTurn(
    agent: Agent,
    task: AutomationTask,
    run: AutomationRun,
    active: ActiveRun,
    skills: Awaited<ReturnType<AgentConfiguration['loadSelectedSkills']>>,
  ): Promise<AutomationRunnerResult> {
    const message = createUserMessage({
      content: [{ type: 'text', text: promptFor(task, run) }],
      source: { kind: 'plugin', plugin: 'automation' },
    })
    let turn: number | undefined
    let summary: string | undefined
    let output: string | undefined
    let settled = false
    let marked = false
    const disposers: Array<() => void> = []
    let resolveCompletion!: (result: AutomationRunnerResult) => void
    const completion = new Promise<AutomationRunnerResult>((resolve) => { resolveCompletion = resolve })
    const cleanup = () => {
      delete active.cancelTurn
      if (marked) { unattendedAgents.delete(agent); marked = false }
      for (const dispose of disposers.splice(0)) dispose()
    }
    const finish = (status: AutomationRunnerResult['status'], error?: string) => {
      if (settled) return
      settled = true
      // Synchronous turn/end cleanup: the driver may start a human follow-up
      // before the Promise continuation below gets a chance to run.
      cleanup()
      resolveCompletion({ status, sessionId: agent.session.header.id,
        ...(summary === undefined ? {} : { summary }), ...(output === undefined ? {} : { output }),
        ...(error === undefined ? {} : { error }) })
    }
    try {
      disposers.push(this.ctx.on('agent/inbox/claimed', (event) => {
        if (settled || event.agent !== agent || event.message.id !== message.id) return
        turn = event.turn
        unattendedAgents.add(agent)
        marked = true
        if (active.cancelReason !== undefined) agent.cancel({ kind: 'hook', reason: `automation_${active.cancelReason}` }, { keepInbox: true })
      }))
      disposers.push(this.ctx.on('agent/inbox/discarded', (event) => {
        if (event.agent === agent && event.message.id === message.id && turn === undefined) {
          finish('failed', 'Automation input was removed before execution.')
        }
      }))
      disposers.push(this.ctx.on('agent/disposed', (event) => {
        if (event.agent === agent) finish('failed', 'Automation Agent was disposed before its turn completed.')
      }))
      disposers.push(this.ctx.on('session/event', (session, event) => {
        if (session !== agent.session || turn === undefined) return
        if (event.type === 'assistant/message' && event.data.turn === turn) {
          output = assistantText(event) || undefined
          summary = assistantSummary(output ?? '')
        }
        if (event.type === 'turn/end' && event.data.turn === turn) {
          const reason = event.data.reason
          finish(reason.kind === 'completed' ? 'succeeded' : 'failed', reason.kind === 'completed' ? undefined
            : `Automation turn ended with ${reason.kind === 'error' ? reason.error.message : reason.kind}.`)
        }
      }))
      disposers.push(this.ctx.effect(() => () => {
        if (settled) return
        try { active.cancelTurn?.() } finally { finish('failed', 'Automation runner stopped before its turn completed.') }
      }, 'automation.turn()'))
      let admitted = false
      try {
        // Public status also reports maintenance as idle. The official maintenance
        // reservation is the atomic true-idle check; enqueue synchronously under it.
        await agent.runMaintenance(async () => {
          admitted = true
          if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0 || unattendedAgents.has(agent)) {
            throw new AutomationError('target_session_busy', 'target session has pending work.')
          }
          if (active.cancelReason !== undefined) {
            finish('failed', `Automation run canceled before execution: ${active.cancelReason}.`)
            return
          }
          this.ctx.permissionPresets.set(agent.session, task.security.permissionPreset)
          delete active.cancelValidation
          active.cancelTurn = () => {
            if (turn === undefined) {
              // Never cancel maintenance or discard someone else's queued prompt.
              // A claimed notification may already be dispatching. If removal
              // loses that race, the claimed listener applies the pending cancel.
              if (agent.inbox.remove(message.id)) finish('failed', 'Automation input was canceled before execution.')
            } else {
              agent.cancel({ kind: 'hook', reason: `automation_${active.cancelReason}` }, { keepInbox: true })
            }
          }
          for (const skill of skills) agent.inject(createUserMessage({ content: [{ type: 'text', text: skill.text }], source: skill.source }))
          agent.followup(message)
        })
      } catch (error) {
        if (!admitted) throw new AutomationError('target_session_busy', 'target session has active work or maintenance.')
        throw error
      }
      return await completion
    } finally {
      cleanup()
    }
  }

  async run(task: AutomationTask, run: AutomationRun): Promise<AutomationRunnerResult> {
    const active: ActiveRun = {}
    const configuredTarget = task.execution.target ?? { mode: 'fresh' as const }
    const pinned = (run.executionTarget?.mode ?? configuredTarget.mode) === 'pinned-session'
    const target = pinned && configuredTarget.mode === 'pinned-session'
      ? { ...configuredTarget, sessionId: run.executionTarget?.sessionId ?? configuredTarget.sessionId }
      : undefined
    if (pinned && target === undefined) throw new AutomationError('target_resume_failed', 'pinned target snapshot is unavailable.')
    if (pinned && run.sessionId !== undefined && run.sessionId !== target?.sessionId) {
      throw new AutomationError('target_resume_failed', 'run target snapshot does not match its session id.')
    }
    const sessionId = SessionId(target !== undefined ? target.sessionId : (run.sessionId ?? `automation-${randomUUID()}`))
    let handle: AgentHandle | undefined
    let agent: Agent | undefined
    let keepSessionLive = false
    this.active.set(run.id, active)
    try {
      const canceledDuringValidation = new Promise<never>((_resolve, reject) => {
        active.cancelValidation = () => reject(new Error(`Automation run canceled before Agent creation: ${active.cancelReason}.`))
      })
      const validationExecution = pinned
        ? { ...task.execution, agentPreset: undefined, provider: undefined, model: undefined, reasoningEffort: undefined, skills: [] }
        : task.execution
      await Promise.race([
        this.agentConfiguration.validate(validationExecution, task.security.permissionPreset, { allowLegacyPartialModel: true }),
        canceledDuringValidation,
      ])
      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(target?.workspaceId ?? task.execution.workspaceId))
        ?? (pinned ? undefined : await this.ctx.workspaceRegistry.create(task.execution.cwd))
      if (workspace === undefined) throw new AutomationError('target_workspace_mismatch', 'target workspace is unavailable.')
      if (target !== undefined && workspace.path !== target.cwd) throw new AutomationError('target_workspace_mismatch', 'target cwd does not match.')
      if (pinned) {
        const persistence = this.ctx.get('sessionPersistence')
        if (persistence === undefined) throw new AutomationError('target_session_unavailable', 'persisted session inspection is unavailable.')
        const snapshot = await persistence.stat(sessionId)
        if (snapshot === undefined || snapshot.header.id !== sessionId) throw new AutomationError('target_session_not_found', 'pinned session could not be resolved.')
        if (snapshot.header.cwd !== target?.cwd) throw new AutomationError('target_workspace_mismatch', 'target session cwd does not match.')
        agent = this.ctx.agents.get(sessionId)
        if (agent === undefined && active.cancelReason === undefined) {
          // Bare agents.resume does not restore the Session's preset or model
          // selection. Let the same owner used by Web restore and retain it.
          const controller = this.ctx.get('sessionController')
          if (controller === undefined) throw new AutomationError('target_session_unavailable', 'Host session controller is unavailable.')
          const resolved = await controller.resolveAgent(sessionId)
          if ('error' in resolved) throw new AutomationError('target_resume_failed', resolved.error.message)
          agent = resolved.agent
        }
      } else {
        handle = await this.ctx.agents.create({
          sessionId,
          meta: { cwd: workspace.path, ...(task.execution.agentPreset === undefined ? {} : { agentPreset: task.execution.agentPreset }) },
          agentOptions: {
            ...(task.execution.provider === undefined ? {} : { provider: task.execution.provider }),
            ...(task.execution.model === undefined ? {} : { model: task.execution.model }),
            ...(task.execution.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(task.execution.reasoningEffort) }),
          },
          setup: async (agentCtx) => { await this.ctx.agentPresets.mount(agentCtx, task.execution.agentPreset) },
        })
        agent = handle.agent
      }
      if (active.cancelReason !== undefined) {
        keepSessionLive = !pinned
        return { status: 'failed', sessionId, error: `Automation run canceled before execution: ${active.cancelReason}.` }
      }
      if (agent === undefined) throw new AutomationError('target_resume_failed', 'unable to create agent runtime.')
      if (pinned && agent.session.header.id !== sessionId) throw new AutomationError('target_session_not_found', 'resumed session id does not match target.')
      if (pinned && agent.session.header.cwd !== target?.cwd) throw new AutomationError('target_workspace_mismatch', 'resumed session cwd does not match.')
      if (pinned && (agent.status !== 'idle' || unattendedAgents.has(agent))) throw new AutomationError('target_session_busy', 'target session is busy.')
      const selectedSkills = pinned ? [] : await Promise.race([
        this.agentConfiguration.loadSelectedSkills(agent, task), canceledDuringValidation,
      ])
      if (!pinned) {
        this.ctx.sessionTitle.rename(agent.session, titleFor(task, run))
        await this.ctx.sessions.flush(agent.session)
        await workspace.attachSession(sessionId)
      }
      // Once the session can accept shared input, retiring this run must not
      // dispose it and abort a queued human turn. Its owning fiber retains it.
      keepSessionLive = true
      const result = await this.runTurn(agent, task, run, active, selectedSkills)
      await this.ctx.sessions.flush(agent.session)
      return result
    } finally {
      delete active.cancelValidation
      this.active.delete(run.id)
      if (handle !== undefined && !keepSessionLive) await handle.dispose()
    }
  }
}
