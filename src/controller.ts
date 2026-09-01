import { AutomationDomainError, type AutomationDomain } from './domain.js'
import type { AutomationScheduler } from './scheduler.js'
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
  ) {}

  list(): AutomationTaskView[] {
    return this.domain.list()
  }

  get(id: string): AutomationTask {
    return this.domain.get(id)
  }

  schedulerHealth(): AutomationSchedulerHealth {
    return this.scheduler.health()
  }

  async create(request: CreateAutomationRequest): Promise<AutomationTask> {
    const task = await this.domain.create(request, this.now())
    this.scheduler.requestDrive()
    return task
  }

  async update(id: string, request: UpdateAutomationRequest): Promise<AutomationTask> {
    const task = await this.domain.update(id, request, this.now())
    this.scheduler.requestDrive()
    return task
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
