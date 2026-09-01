import { randomUUID } from 'node:crypto'
import { instant, latestDueOccurrence, nextOccurrence, validateSchedule } from './recurrence.js'
import { AutomationStore } from './store.js'
import type {
  AutomationRun,
  AutomationSchedule,
  AutomationTask,
  AutomationTaskView,
  CreateAutomationRequest,
  ResumeOptions,
  UpdateAutomationRequest,
} from './types.js'

export class AutomationDomainError extends Error {
  constructor(
    readonly code:
      | 'task_not_found'
      | 'invalid_state'
      | 'run_in_progress'
      | 'schedule_exhausted',
    message: string,
  ) {
    super(message)
    this.name = 'AutomationDomainError'
  }
}

export interface ClaimedRun {
  readonly task: AutomationTask
  readonly run: AutomationRun
}

export interface RunOutcome {
  readonly status: 'succeeded' | 'failed' | 'interrupted' | 'timed_out' | 'canceled'
  readonly sessionId?: string
  readonly summary?: string
  readonly error?: string
}

function nonTerminal(run: AutomationRun): boolean {
  return run.status === 'queued' || run.status === 'running'
}

function makeRun(trigger: AutomationRun['trigger'], now: number, scheduledAt?: number): AutomationRun {
  return {
    id: `run-${randomUUID()}`,
    trigger,
    ...(scheduledAt === undefined ? {} : { scheduledAt: instant(scheduledAt) }),
    enqueuedAt: instant(now),
    status: 'queued',
  }
}

function pruneRuns(task: AutomationTask, maxHistory: number): void {
  if (task.runs.length <= maxHistory) return
  const active = task.runs.filter(nonTerminal)
  const terminal = task.runs.filter((run) => !nonTerminal(run)).slice(-Math.max(0, maxHistory - active.length))
  task.runs = [...terminal, ...active]
}

export class AutomationDomain {
  constructor(
    readonly store: AutomationStore,
    readonly maxRunHistory = 20,
  ) {}

  async init(now: number): Promise<void> {
    await this.store.init()
    const hasRunning = Object.values(this.store.snapshot().tasks).some((task) =>
      task.runs.some((run) => run.status === 'running'),
    )
    if (!hasRunning) return
    await this.store.mutate((state) => {
      for (const task of Object.values(state.tasks)) {
        for (const run of task.runs) {
          if (run.status !== 'running') continue
          run.status = 'outcome_unknown'
          run.finishedAt = instant(now)
          run.error = 'DSH restarted before this automation run reported its outcome; it may have completed.'
        }
        pruneRuns(task, this.maxRunHistory)
      }
    })
  }

  list(): AutomationTaskView[] {
    return Object.values(this.store.snapshot().tasks)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((task) => ({
        ...task,
        running: task.runs.some((run) => nonTerminal(run)),
      }))
  }

  get(id: string): AutomationTask {
    const task = this.store.snapshot().tasks[id]
    if (task === undefined) throw new AutomationDomainError('task_not_found', `Automation ${id} was not found.`)
    return task
  }

  async create(request: CreateAutomationRequest, now: number): Promise<AutomationTask> {
    const name = request.name.trim()
    const prompt = request.prompt.trim()
    if (!name) throw new Error('Automation name must not be empty.')
    if (!prompt) throw new Error('Automation prompt must not be empty.')
    const schedule = validateSchedule(request.schedule, now)
    const first = nextOccurrence(schedule, now)
    if (first === undefined) {
      throw new AutomationDomainError('schedule_exhausted', 'The recurring schedule has no future occurrence.')
    }
    const task: AutomationTask = {
      id: `automation-${randomUUID()}`,
      name,
      prompt,
      createdAt: instant(now),
      createdBySessionId: request.createdBySessionId,
      status: 'active',
      schedule,
      nextRunAt: instant(first),
      execution: request.execution,
      security: {
        permissionPreset: 'danger-full-access',
        source: 'plugin-default',
        grantedAt: instant(now),
      },
      runs: [],
    }
    await this.store.mutate((state) => {
      state.tasks[task.id] = task
    })
    return structuredClone(task)
  }

  async update(id: string, request: UpdateAutomationRequest, now: number): Promise<AutomationTask> {
    if (this.store.snapshot().tasks[id] === undefined) {
      throw new AutomationDomainError('task_not_found', `Automation ${id} was not found.`)
    }
    if (request.name === undefined && request.prompt === undefined && request.schedule === undefined) {
      throw new Error('Supply at least one field to update.')
    }
    const name = request.name?.trim()
    const prompt = request.prompt?.trim()
    if (name === '') throw new Error('Automation name must not be empty.')
    if (prompt === '') throw new Error('Automation prompt must not be empty.')
    const schedule = request.schedule === undefined ? undefined : validateSchedule(request.schedule, now)
    const next = schedule === undefined ? undefined : nextOccurrence(schedule, now)
    if (schedule !== undefined && next === undefined) {
      throw new AutomationDomainError('schedule_exhausted', 'The recurring schedule has no future occurrence.')
    }

    return this.store.mutate((state) => {
      const task = state.tasks[id]
      if (task === undefined) throw new AutomationDomainError('task_not_found', `Automation ${id} was not found.`)
      if (name !== undefined) task.name = name
      if (prompt !== undefined) task.prompt = prompt
      if (schedule !== undefined) {
        task.schedule = schedule
        if (task.status === 'paused') {
          task.pausedNextRunAt = instant(next!)
          task.nextRunAt = null
        } else {
          task.status = 'active'
          task.nextRunAt = instant(next!)
          delete task.pausedAt
          delete task.pausedNextRunAt
        }
      }
      return structuredClone(task)
    })
  }

  async delete(id: string): Promise<boolean> {
    if (this.store.snapshot().tasks[id] === undefined) return false
    await this.store.mutate((state) => {
      delete state.tasks[id]
    })
    return true
  }

  async pause(id: string, now: number): Promise<AutomationTask> {
    return this.store.mutate((state) => {
      const task = state.tasks[id]
      if (task === undefined) throw new AutomationDomainError('task_not_found', `Automation ${id} was not found.`)
      if (task.status !== 'active') {
        throw new AutomationDomainError('invalid_state', `Automation ${id} is not active.`)
      }
      task.status = 'paused'
      task.pausedAt = instant(now)
      if (task.nextRunAt !== null) task.pausedNextRunAt = task.nextRunAt
      task.nextRunAt = null
      return structuredClone(task)
    })
  }

  async resume(id: string, options: ResumeOptions, now: number): Promise<AutomationTask> {
    return this.store.mutate((state) => {
      const task = state.tasks[id]
      if (task === undefined) throw new AutomationDomainError('task_not_found', `Automation ${id} was not found.`)
      if (task.status !== 'paused') {
        throw new AutomationDomainError('invalid_state', `Automation ${id} is not paused.`)
      }
      if (options.runNow && task.runs.some(nonTerminal)) {
        throw new AutomationDomainError('run_in_progress', `Automation ${id} already has a queued or running run.`)
      }
      delete task.pausedAt
      delete task.pausedNextRunAt
      if (task.schedule.kind === 'once') {
        const fireAt = Date.parse(task.schedule.fireAt)
        if (fireAt <= now) {
          if (!options.runNow) {
            throw new AutomationDomainError(
              'invalid_state',
              'This one-time automation is overdue; resume it with runNow or delete it.',
            )
          }
          task.status = 'completed'
          task.nextRunAt = null
        } else {
          task.status = 'active'
          task.nextRunAt = instant(fireAt)
        }
      } else {
        const next = nextOccurrence(task.schedule, now)
        task.status = next === undefined ? 'completed' : 'active'
        task.nextRunAt = next === undefined ? null : instant(next)
      }
      if (options.runNow) task.runs.push(makeRun('manual', now))
      pruneRuns(task, this.maxRunHistory)
      return structuredClone(task)
    })
  }

  async runNow(id: string, now: number): Promise<AutomationRun> {
    return this.store.mutate((state) => {
      const task = state.tasks[id]
      if (task === undefined) throw new AutomationDomainError('task_not_found', `Automation ${id} was not found.`)
      if (task.runs.some(nonTerminal)) {
        throw new AutomationDomainError('run_in_progress', `Automation ${id} already has a queued or running run.`)
      }
      const run = makeRun('manual', now)
      task.runs.push(run)
      pruneRuns(task, this.maxRunHistory)
      return structuredClone(run)
    })
  }

  async cancelQueuedRun(id: string, runId: string, now: number): Promise<AutomationRun> {
    return this.store.mutate((state) => {
      const task = state.tasks[id]
      if (task === undefined) throw new AutomationDomainError('task_not_found', `Automation ${id} was not found.`)
      const run = task.runs.find((entry) => entry.id === runId)
      if (run === undefined || run.status !== 'queued') {
        throw new AutomationDomainError('invalid_state', `Automation ${id} does not have that queued run.`)
      }
      run.status = 'canceled'
      run.finishedAt = instant(now)
      run.error = 'Canceled before execution.'
      pruneRuns(task, this.maxRunHistory)
      return structuredClone(run)
    })
  }

  async claimDue(now: number): Promise<AutomationRun[]> {
    const due = Object.values(this.store.snapshot().tasks).some((task) =>
      task.status === 'active' && task.nextRunAt !== null && Date.parse(task.nextRunAt) <= now,
    )
    if (!due) return []
    return this.store.mutate((state) => {
      const claimed: AutomationRun[] = []
      for (const task of Object.values(state.tasks)) {
        if (task.status !== 'active' || task.nextRunAt === null) continue
        const floor = Date.parse(task.nextRunAt)
        const occurrence = latestDueOccurrence(task.schedule, floor, now)
        if (occurrence === undefined) continue
        if (!task.runs.some(nonTerminal)) {
          const run = makeRun('scheduled', now, occurrence)
          task.runs.push(run)
          claimed.push(structuredClone(run))
        }
        const next = nextOccurrence(task.schedule, now)
        task.nextRunAt = next === undefined ? null : instant(next)
        if (next === undefined) task.status = 'completed'
        pruneRuns(task, this.maxRunHistory)
      }
      return claimed
    })
  }

  nextWakeAt(now: number): number | undefined {
    const state = this.store.snapshot()
    if (Object.values(state.tasks).some((task) => task.runs.some((run) => run.status === 'queued'))) {
      return now
    }
    let next: number | undefined
    for (const task of Object.values(state.tasks)) {
      if (task.status !== 'active' || task.nextRunAt === null) continue
      const candidate = Date.parse(task.nextRunAt)
      if (next === undefined || candidate < next) next = candidate
    }
    return next
  }

  async takeNextQueued(now: number): Promise<ClaimedRun | undefined> {
    const candidate = Object.values(this.store.snapshot().tasks)
      .flatMap((task) => task.runs.filter((run) => run.status === 'queued').map((run) => ({ task, run })))
      .sort((a, b) => a.run.enqueuedAt.localeCompare(b.run.enqueuedAt))[0]
    if (candidate === undefined) return undefined
    return this.store.mutate((state) => {
      const task = state.tasks[candidate.task.id]
      const run = task?.runs.find((entry) => entry.id === candidate.run.id)
      if (task === undefined || run === undefined || run.status !== 'queued') return undefined
      run.status = 'running'
      run.startedAt = instant(now)
      run.sessionId ??= `automation-${randomUUID()}`
      return { task: structuredClone(task), run: structuredClone(run) }
    })
  }

  async finishRun(taskId: string, runId: string, outcome: RunOutcome, now: number): Promise<void> {
    const task = this.store.snapshot().tasks[taskId]
    if (task === undefined || !task.runs.some((run) => run.id === runId && run.status === 'running')) return
    await this.store.mutate((state) => {
      const current = state.tasks[taskId]
      const run = current?.runs.find((entry) => entry.id === runId)
      if (current === undefined || run === undefined || run.status !== 'running') return
      run.status = outcome.status
      run.finishedAt = instant(now)
      if (outcome.sessionId !== undefined) run.sessionId = outcome.sessionId
      if (outcome.summary !== undefined) run.summary = outcome.summary
      if (outcome.error !== undefined) run.error = outcome.error
      pruneRuns(current, this.maxRunHistory)
    })
  }
}
