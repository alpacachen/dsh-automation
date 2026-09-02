import { randomUUID } from 'node:crypto'
import { instant, latestDueOccurrence, nextOccurrence, validateSchedule } from './recurrence.js'
import { AutomationStore } from './store.js'
import type {
  AutomationRun,
  AutomationRunStatus,
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

function failedOutcome(status: AutomationRunStatus): boolean {
  return status === 'failed' || status === 'timed_out'
}

function shouldNotify(task: AutomationTask, status: AutomationRunStatus): boolean {
  if (task.notificationPolicy === 'never') return false
  if (task.notificationPolicy === 'always') return true
  return failedOutcome(status) || status === 'interrupted' || status === 'outcome_unknown'
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

function snapshotTarget(execution: AutomationTask['execution']): AutomationRun['executionTarget'] {
  const target = execution.target ?? { mode: 'fresh' as const }
  return target.mode === 'pinned-session'
    ? { mode: 'pinned-session', sessionId: target.sessionId }
    : { mode: 'fresh' }
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
          if (shouldNotify(task, run.status)) task.unreadNotifications += 1
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
    if ((request.execution.provider === undefined) !== (request.execution.model === undefined)) {
      throw new Error('provider and model must be set together.')
    }
    validateTarget({ ...request.execution, target: request.execution.target ?? { mode: 'fresh' } }, request.sessionTargetConfirmed === true)
    for (const value of [request.execution.agentPreset, request.execution.provider, request.execution.model]) {
      if (value !== undefined && !value.trim()) throw new Error('Execution override ids must not be empty.')
    }
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
      notificationPolicy: request.notificationPolicy ?? 'failures',
      pauseAfterConsecutiveFailures: request.pauseAfterConsecutiveFailures ?? false,
      consecutiveFailures: 0,
      unreadNotifications: 0,
      execution: {
        ...request.execution,
        ...(request.execution.agentPreset === undefined ? {} : { agentPreset: request.execution.agentPreset.trim() }),
        ...(request.execution.provider === undefined ? {} : { provider: request.execution.provider.trim() }),
        ...(request.execution.model === undefined ? {} : { model: request.execution.model.trim() }),
        skills: normalizeSkills(request.execution.skills),
        ...(request.execution.target === undefined ? { target: { mode: 'fresh' as const } } : { target: request.execution.target }),
      },
      security: {
        permissionPreset: request.permissionPreset,
        source: 'user-confirmed',
        grantedAt: instant(now),
      },
      runs: [],
    }
    await this.store.mutate((state) => {
      state.tasks[task.id] = task
    })
    return structuredClone(task)
  }

  async update(
    id: string,
    request: UpdateAutomationRequest,
    now: number,
    beforeCommit?: (current: AutomationTask) => Promise<void>,
  ): Promise<AutomationTask> {
    if (this.store.snapshot().tasks[id] === undefined) {
      throw new AutomationDomainError('task_not_found', `Automation ${id} was not found.`)
    }
    if (request.name === undefined && request.prompt === undefined && request.schedule === undefined && request.notificationPolicy === undefined && request.pauseAfterConsecutiveFailures === undefined && request.permissionPreset === undefined && (request.execution === undefined || Object.keys(request.execution).length === 0)) {
      throw new Error('Supply at least one field to update.')
    }
    if (request.execution !== undefined) {
      validateExecutionPatch(request.execution)
      if (request.execution.target !== undefined) validateTarget({ ...this.get(id).execution, target: request.execution.target }, request.execution.sessionTargetConfirmed === true)
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

    return this.store.mutate(async (state) => {
      const task = state.tasks[id]
      if (task === undefined) throw new AutomationDomainError('task_not_found', `Automation ${id} was not found.`)
      await beforeCommit?.(structuredClone(task))
      if (name !== undefined) task.name = name
      if (prompt !== undefined) task.prompt = prompt
      if (request.notificationPolicy !== undefined) task.notificationPolicy = request.notificationPolicy
      if (request.pauseAfterConsecutiveFailures !== undefined) {
        task.pauseAfterConsecutiveFailures = request.pauseAfterConsecutiveFailures
      }
      if (request.permissionPreset !== undefined && request.permissionPreset !== task.security.permissionPreset) {
        task.security.permissionPreset = request.permissionPreset
        task.security.source = 'user-confirmed'
        task.security.grantedAt = instant(now)
      }
      if (request.execution !== undefined) {
        const patch = request.execution
        if (patch.target !== undefined) {
          validateTarget({ ...task.execution, target: patch.target }, patch.sessionTargetConfirmed === true)
          task.execution.target = patch.target
        }
        for (const key of ['agentPreset', 'provider', 'model'] as const) {
          if (patch[key] === undefined) continue
          if (patch[key] === null) delete task.execution[key]
          else task.execution[key] = patch[key].trim()
        }
        if (patch.skills !== undefined) task.execution.skills = normalizeSkills(patch.skills)
      }
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
      const result = structuredClone(task)
      if (result.execution.target?.mode === 'fresh') {
        const { target: _target, ...execution } = result.execution
        return { ...result, execution }
      }
      return result
    })
  }

  async delete(id: string): Promise<boolean> {
    if (this.store.snapshot().tasks[id] === undefined) return false
    await this.store.mutate((state) => {
      delete state.tasks[id]
    })
    return true
  }

  async markNotificationsRead(): Promise<void> {
    if (!Object.values(this.store.snapshot().tasks).some((task) => task.unreadNotifications > 0)) return
    await this.store.mutate((state) => {
      for (const task of Object.values(state.tasks)) task.unreadNotifications = 0
    })
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
      if (options.runNow) task.runs.push({ ...makeRun('manual', now), executionTarget: snapshotTarget(task.execution) })
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
      const run = { ...makeRun('manual', now), executionTarget: snapshotTarget(task.execution) }
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
          const run = { ...makeRun('scheduled', now, occurrence), executionTarget: snapshotTarget(task.execution) }
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
      run.sessionId ??= run.executionTarget?.mode === 'pinned-session' ? run.executionTarget.sessionId : `automation-${randomUUID()}`
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
      if (outcome.status === 'succeeded') current.consecutiveFailures = 0
      else if (failedOutcome(outcome.status)) current.consecutiveFailures += 1
      if (shouldNotify(current, outcome.status)) current.unreadNotifications += 1
      if (current.pauseAfterConsecutiveFailures && current.consecutiveFailures >= 3 && current.status === 'active') {
        current.status = 'paused'
        current.pausedAt = instant(now)
        if (current.nextRunAt !== null) current.pausedNextRunAt = current.nextRunAt
        current.nextRunAt = null
      }
      pruneRuns(current, this.maxRunHistory)
    })
  }
}

function normalizeSkills(skills: readonly string[]): string[] {
  const normalized = skills.map((name) => name.trim())
  if (normalized.some((name) => !name)) throw new Error('Skill names must not be empty.')
  if (new Set(normalized).size !== normalized.length) throw new Error('Skill names must be unique.')
  return normalized
}

function validateExecutionPatch(patch: NonNullable<UpdateAutomationRequest['execution']>): void {
  const providerSupplied = patch.provider !== undefined
  const modelSupplied = patch.model !== undefined
  if (providerSupplied !== modelSupplied || (providerSupplied && ((patch.provider === null) !== (patch.model === null)))) {
    throw new Error('provider and model must be set or cleared together.')
  }
  for (const value of [patch.agentPreset, patch.provider, patch.model]) {
    if (typeof value === 'string' && !value.trim()) throw new Error('Execution override ids must not be empty.')
  }
  if (patch.skills !== undefined) normalizeSkills(patch.skills)
}

function validateTarget(execution: AutomationTask['execution'], confirmed: boolean): void {
  const target = execution.target ?? { mode: 'fresh' as const }
  if (target.mode === 'pinned-session') {
    if (!confirmed) throw new Error('Explicit user confirmation is required for a pinned session target.')
    if (target.workspaceId !== execution.workspaceId || target.cwd !== execution.cwd) {
      throw new Error('Pinned session target workspace and cwd must match execution settings.')
    }
  }
}
