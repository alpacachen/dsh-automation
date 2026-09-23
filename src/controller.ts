import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { AutomationError } from './errors.js'
import { applyExecutionPatch, normalizeSkills } from './validation.js'
import { AutomationDomainError, type AutomationDomain } from './domain.js'
import type { AutomationScheduler } from './scheduler.js'
import type { AgentConfiguration } from './agent-configuration.js'
import type {
  AutomationDelivery,
  AutomationDeliveryOptions,
  AutomationRun,
  AutomationSchedulerHealth,
  AutomationTask,
  AutomationTaskView,
  CreateAutomationRequest,
  ResumeOptions,
  UpdateAutomationRequest,
} from './types.js'

export async function validatePersistedSessionTarget(ctx: Context, task: AutomationTask, sessionId: string): Promise<void> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new AutomationError('target_session_unavailable', 'persisted session inspection is unavailable.')
  const id = SessionId(sessionId)
  const snapshot = await persistence.stat(id)
  if (snapshot === undefined || snapshot.header.id !== id) throw new AutomationError('target_session_not_found', 'target session could not be resolved.')
  if (snapshot.header.cwd !== task.execution.cwd) throw new AutomationError('target_workspace_mismatch', 'target session cwd does not match the task.')
  const registry = ctx.get('workspaceRegistry')
  const workspace = registry?.get(WorkspaceId(task.execution.workspaceId))
  if (workspace === undefined || workspace.path !== task.execution.cwd || !workspace.sessionIds.includes(id)) {
    throw new AutomationError('target_workspace_mismatch', 'target session must belong to the task workspace.')
  }
  if (snapshot.header.origin === 'subagent' || registry?.archivedSessionIds.includes(id)) {
    throw new AutomationError('target_session_unavailable', 'select a visible ordinary session.')
  }
}

export class AutomationController {
  constructor(
    readonly domain: AutomationDomain,
    readonly scheduler: AutomationScheduler,
    private readonly now: () => number = () => Date.now(),
    private readonly agentConfiguration?: AgentConfiguration,
    private readonly validateSessionTarget?: (task: AutomationTask, sessionId: string) => Promise<void>,
    private readonly delivery?: {
      options(botId?: string): Promise<AutomationDeliveryOptions>
      validate(destination: AutomationDelivery): Promise<void>
    },
  ) {}

  async deliveryOptions(botId?: string): Promise<AutomationDeliveryOptions> {
    return this.delivery?.options(botId) ?? { available: false, bots: [], targets: [] }
  }

  list(): AutomationTaskView[] {
    return this.domain.list().map((task) => {
      const permissionDisplayName = this.agentConfiguration?.permissionName(task.security.permissionPreset)
      return permissionDisplayName === undefined ? task : { ...task, permissionDisplayName }
    })
  }

  get(id: string): AutomationTask {
    return this.domain.get(id)
  }

  schedulerHealth(): AutomationSchedulerHealth {
    return this.scheduler.health()
  }

  async create(request: CreateAutomationRequest): Promise<AutomationTask> {
    const execution = normalizedExecution(request.execution)
    await this.agentConfiguration?.validate(
      execution.target?.mode === 'pinned-session'
        ? { ...execution, agentPreset: undefined, provider: undefined, model: undefined, reasoningEffort: undefined, skills: [] }
        : execution,
      request.permissionPreset,
    )
    const task = await this.domain.create(request, this.now())
    this.scheduler.requestDrive()
    return task
  }

  async update(id: string, request: UpdateAutomationRequest): Promise<AutomationTask> {
    const agentConfiguration = this.agentConfiguration
    const beforeCommit = async (current: AutomationTask) => {
      if (request.delivery != null && (request.delivery.botId !== current.delivery?.botId || request.delivery.targetId !== current.delivery?.targetId)) {
        if (this.delivery === undefined) throw new Error('dsh-im direct delivery is unavailable on this Host.')
        await this.delivery.validate(request.delivery)
      }
      if (request.execution?.target?.mode === 'pinned-session') {
        if (this.validateSessionTarget === undefined) throw new Error('target_session_unavailable: persisted session validation is unavailable.')
        await this.validateSessionTarget(current, request.execution.target.sessionId)
      }
      if (request.permissionPreset !== undefined && request.permissionPreset !== current.security.permissionPreset && request.permissionChangeConfirmed !== true) {
        throw new Error('Explicit user confirmation is required to change permissions.')
      }
      const execution = applyExecutionPatch(current.execution, request.execution)
      const preservesLegacyPartialModel = request.execution?.provider === undefined
        && request.execution?.model === undefined
        && ((current.execution.provider === undefined) !== (current.execution.model === undefined))
      await agentConfiguration?.validate(
        execution.target?.mode === 'pinned-session'
          ? { ...execution, agentPreset: undefined, provider: undefined, model: undefined, reasoningEffort: undefined, skills: [] }
          : execution,
        request.permissionPreset ?? current.security.permissionPreset,
        { allowLegacyPartialModel: preservesLegacyPartialModel },
      )
    }
    const task = await this.domain.update(id, request, this.now(), beforeCommit)
    this.scheduler.requestDrive()
    return task
  }

  async options(id: string, agentPreset?: string | null, provider?: string, model?: string) {
    if (this.agentConfiguration === undefined) throw new Error('Agent configuration is unavailable.')
    const task = this.domain.get(id)
    const savedModel = provider === undefined && model === undefined && task.execution.target?.mode !== 'pinned-session'
      && task.execution.provider !== undefined && task.execution.model !== undefined
    return this.agentConfiguration.options(
      task.execution.cwd,
      agentPreset === undefined ? task.execution.agentPreset : agentPreset ?? undefined,
      savedModel ? task.execution.provider : provider,
      savedModel ? task.execution.model : model,
    )
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.domain.delete(id)
    if (deleted) this.scheduler.requestDrive()
    return deleted
  }

  async deleteRun(taskId: string, runId: string): Promise<boolean> {
    return this.domain.deleteRun(taskId, runId)
  }

  async markNotificationsRead(): Promise<void> {
    await this.domain.markNotificationsRead()
  }

  async pause(id: string): Promise<AutomationTask> {
    const task = await this.domain.pause(id, this.now())
    this.scheduler.requestDrive()
    return task
  }

  async resume(id: string, options: ResumeOptions): Promise<AutomationTask> {
    const task = await this.domain.resume(id, options, this.now())
    this.scheduler.requestDrive()
    return task
  }

  async runNow(id: string): Promise<AutomationRun> {
    const run = await this.domain.runNow(id, this.now())
    this.scheduler.requestDrive()
    return run
  }

  async stop(id: string): Promise<{ runId: string; status: 'canceling' | 'canceled' }> {
    const task = this.domain.get(id)
    const run = task.runs.find((entry) => entry.status === 'queued' || entry.status === 'running')
    if (run === undefined) {
      throw new AutomationDomainError('invalid_state', `Automation ${id} has no queued or running run.`)
    }
    if (run.status === 'queued') {
      await this.domain.cancelQueuedRun(id, run.id, this.now())
      this.scheduler.requestDrive()
      return { runId: run.id, status: 'canceled' }
    }
    if (!this.scheduler.cancelRun(id, run.id)) {
      throw new AutomationDomainError('invalid_state', `Automation ${id} is no longer cancelable.`)
    }
    return { runId: run.id, status: 'canceling' }
  }
}

function normalizedExecution(execution: AutomationTask['execution']): AutomationTask['execution'] {
  return {
    ...execution,
    target: execution.target ?? { mode: 'fresh' },
    ...(execution.agentPreset === undefined ? {} : { agentPreset: execution.agentPreset.trim() }),
    ...(execution.provider === undefined ? {} : { provider: execution.provider.trim() }),
    ...(execution.model === undefined ? {} : { model: execution.model.trim() }),
    skills: normalizeSkills(execution.skills),
  }
}
