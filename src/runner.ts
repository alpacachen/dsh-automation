import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { AutomationRun, AutomationTask } from './types.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AutomationRunner, AutomationRunnerResult, AutomationRunCancelReason } from './scheduler.js'

import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-permission-presets'
import '@deepseek-ai/dsh-session-title'
import '@deepseek-ai/dsh-workspace'

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
    `Permission preset: danger-full-access. Do not create or modify automations from this run.`,
    '',
    task.prompt,
  ].join('\n')
}

export class DshAutomationRunner implements AutomationRunner {
  private readonly active = new Map<string, { agent?: Agent; cancelReason?: AutomationRunCancelReason }>()

  constructor(
    private readonly ctx: Context,
    private readonly permissionPreset: 'danger-full-access',
  ) {}

  cancel(runId: string, reason: AutomationRunCancelReason): boolean {
    const active = this.active.get(runId)
    if (active === undefined) return false
    if (active.cancelReason !== undefined) return true
    try {
      active.agent?.cancel({ kind: 'hook', reason: `automation_${reason}` })
    } catch {
      return false
    }
    active.cancelReason = reason
    return true
  }

  async run(task: AutomationTask, run: AutomationRun): Promise<AutomationRunnerResult> {
    const active: { agent?: Agent; cancelReason?: AutomationRunCancelReason } = {}
    this.active.set(run.id, active)
    const sessionId = SessionId(`automation-${randomUUID()}`)
    let handle: Awaited<ReturnType<Context['agents']['create']>> | undefined
    let keepSessionLive = false
    try {
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
      this.ctx.permissionPresets.set(handle.agent.session, this.permissionPreset)
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

      const turnEnd = handle.agent.session.events
        .slice(baseline)
        .filter((event) => event.type === 'turn/end')
        .at(-1)
      let result: AutomationRunnerResult = { status: 'succeeded', sessionId }
      if (turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind !== 'completed') {
        const reason = turnEnd.data.reason
        const detail = reason.kind === 'error' ? reason.error.message : reason.kind
        result = { status: 'failed', sessionId, error: `Automation turn ended with ${detail}.` }
      }
      // The owner fiber disposes this handle on plugin shutdown. Disposing it here
      // emits session/removed, so the sidebar drops the new persisted session.
      keepSessionLive = true
      return result
    } finally {
      this.active.delete(run.id)
      if (handle !== undefined && !keepSessionLive) await handle.dispose()
    }
  }
}
