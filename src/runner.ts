import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { AutomationRun, AutomationTask } from './types.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AutomationRunner, AutomationRunnerResult, AutomationRunCancelReason } from './scheduler.js'
import { AgentConfiguration } from './agent-configuration.js'

import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-permission-presets'
import '@deepseek-ai/dsh-session-title'
import '@deepseek-ai/dsh-workspace'

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
    const sessionId = SessionId(run.sessionId ?? `automation-${randomUUID()}`)
    let handle: Awaited<ReturnType<Context['agents']['create']>> | undefined
    let keepSessionLive = false
    try {
      const canceledDuringValidation = new Promise<never>((_resolve, reject) => {
        active.cancelValidation = () => reject(new Error(`Automation run canceled before Agent creation: ${active.cancelReason}.`))
      })
      // Older state could capture provider/model independently. Preserve that
      // runtime behavior while new create/update requests require a complete pair.
      await Promise.race([
        this.agentConfiguration.validate(task.execution, task.security.permissionPreset, { allowLegacyPartialModel: true }),
        canceledDuringValidation,
      ])
      const workspace =
        this.ctx.workspaceRegistry.get(WorkspaceId(task.execution.workspaceId)) ??
        (await this.ctx.workspaceRegistry.create(task.execution.cwd))
      handle = await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd: workspace.path,
          ...(task.execution.agentPreset === undefined ? {} : { agentPreset: task.execution.agentPreset }),
        },
        agentOptions: {
          ...(task.execution.provider === undefined ? {} : { provider: task.execution.provider }),
          ...(task.execution.model === undefined ? {} : { model: task.execution.model }),
        },
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, task.execution.agentPreset)
        },
      })
      active.agent = handle.agent
      this.ctx.permissionPresets.set(handle.agent.session, task.security.permissionPreset)
      const selectedSkills = await Promise.race([
        this.agentConfiguration.loadSelectedSkills(handle.agent, task),
        canceledDuringValidation,
      ])
      delete active.cancelValidation
      for (const skill of selectedSkills) {
        handle.agent.inject(createUserMessage({
          content: [{ type: 'text', text: skill.text }],
          source: skill.source,
        }))
      }
      this.ctx.sessionTitle.rename(handle.agent.session, titleFor(task, run))
      await this.ctx.sessions.flush(handle.agent.session)
      await workspace.attachSession(sessionId)

      if (active.cancelReason !== undefined) {
        keepSessionLive = true
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
      // The owner fiber disposes this handle on plugin shutdown. Disposing it here
      // emits session/removed, so the sidebar drops the new persisted session.
      keepSessionLive = true
      return result
    } finally {
      delete active.cancelValidation
      this.active.delete(run.id)
      if (handle !== undefined && !keepSessionLive) await handle.dispose()
    }
  }
}
