import { AutomationDomainError, type AutomationDomain } from './domain.js'
import type { AutomationScheduler } from './scheduler.js'
import type { AgentConfiguration } from './agent-configuration.js'
import type {
  AutomationRun,
  AutomationSchedulerHealth,
  AutomationTask,
  AutomationTaskView,
  CreateAutomationRequest,
  ResumeOptions,
  UpdateAutomationRequest,
} from './types.js'

export class AutomationController {
  constructor(
    readonly domain: AutomationDomain,
    readonly scheduler: AutomationScheduler,
    private readonly now: () => number = () => Date.now(),
    private readonly agentConfiguration?: AgentConfiguration,
  ) {}

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
    await this.agentConfiguration?.validate(normalizedExecution(request.execution), request.permissionPreset)
    const task = await this.domain.create(request, this.now())
    this.scheduler.requestDrive()
    return task
  }

  async update(id: string, request: UpdateAutomationRequest): Promise<AutomationTask> {
    const agentConfiguration = this.agentConfiguration
    const beforeCommit = agentConfiguration === undefined ? undefined : async (current: AutomationTask) => {
      if (request.permissionPreset !== undefined && request.permissionPreset !== current.security.permissionPreset && request.permissionChangeConfirmed !== true) {
        throw new Error('Explicit user confirmation is required to change permissions.')
      }
      const execution = applyExecutionPatch(current.execution, request.execution)
      const preservesLegacyPartialModel = request.execution?.provider === undefined
        && request.execution?.model === undefined
        && ((current.execution.provider === undefined) !== (current.execution.model === undefined))
      await agentConfiguration.validate(
        execution,
        request.permissionPreset ?? current.security.permissionPreset,
        { allowLegacyPartialModel: preservesLegacyPartialModel },
      )
    }
    const task = await this.domain.update(id, request, this.now(), beforeCommit)
    this.scheduler.requestDrive()
    return task
  }

  async options(id: string, agentPreset?: string | null) {
    if (this.agentConfiguration === undefined) throw new Error('Agent configuration is unavailable.')
    const task = this.domain.get(id)
    return this.agentConfiguration.options(task.execution.cwd, agentPreset === undefined ? task.execution.agentPreset : agentPreset ?? undefined)
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.domain.delete(id)
    if (deleted) this.scheduler.requestDrive()
    return deleted
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

function applyExecutionPatch(
  current: AutomationTask['execution'],
  patch: UpdateAutomationRequest['execution'],
): AutomationTask['execution'] {
  if (patch === undefined) return current
  const next = { ...current, ...(patch.skills === undefined ? {} : { skills: normalizedSkills(patch.skills) }) }
  for (const key of ['agentPreset', 'provider', 'model'] as const) {
    if (patch[key] === undefined) continue
    if (patch[key] === null) delete next[key]
    else next[key] = patch[key].trim()
  }
  return next
}

function normalizedSkills(skills: readonly string[]): string[] {
  return skills.map((name) => name.trim())
}

function normalizedExecution(execution: AutomationTask['execution']): AutomationTask['execution'] {
  return {
    ...execution,
    ...(execution.agentPreset === undefined ? {} : { agentPreset: execution.agentPreset.trim() }),
    ...(execution.provider === undefined ? {} : { provider: execution.provider.trim() }),
    ...(execution.model === undefined ? {} : { model: execution.model.trim() }),
    skills: normalizedSkills(execution.skills),
  }
}
