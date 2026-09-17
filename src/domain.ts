import { randomUUID } from 'node:crypto'
import { instant, latestDueOccurrence, nextOccurrence, validateSchedule } from './recurrence.js'
import { AutomationStore } from './store.js'
import { AutomationDeliverySchema, type AutomationDelivery, type AutomationRunDelivery } from './types.js'
import { AutomationError } from './errors.js'
import { assertOverrideId, assertProviderModelPair, applyExecutionPatch, normalizeSkills, validateExecutionPatch, validateTarget } from './validation.js'
import type {
  AutomationRun,
  AutomationRunStatus,
  AutomationTask,
  AutomationTaskView,
  CreateAutomationRequest,
  ResumeOptions,
  UpdateAutomationRequest,
} from './types.js'

export class AutomationDomainError extends AutomationError {
  constructor(
    readonly code: 'task_not_found' | 'invalid_state' | 'run_in_progress' | 'schedule_exhausted',
    message: string,
  ) {
    super(code, message)
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
  /** Full own-turn text for delivery only; never persisted in the run record. */
  readonly output?: string
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
  const retained = (run: AutomationRun) => nonTerminal(run) || run.delivery?.status === 'sending'
  const active = task.runs.filter(retained)
  const slots = Math.max(0, maxHistory - active.length)
  const terminal = slots === 0 ? [] : task.runs.filter((run) => !retained(run)).slice(-slots)
  task.runs = [...terminal, ...active]
}

export class AutomationDomain {
  constructor(
    readonly store: AutomationStore,
    readonly maxRunHistory = 20,
  ) {}

  async init(now: number): Promise<void> {
    await this.store.init()
    const needsRecovery = Object.values(this.store.snapshot().tasks).some((task) =>
      task.runs.some((run) => run.status === 'running' || run.delivery?.status === 'sending'),
    )
    if (!needsRecovery) return
    await this.store.mutate((state) => {
      for (const task of Object.values(state.tasks)) {
        for (const run of task.runs) {
          if (run.delivery?.status === 'sending') {
            run.delivery.status = 'unknown'
            run.delivery.finishedAt = instant(now)
            run.delivery.error = 'DSH restarted before delivery was recorded; the message may have been sent. It will not be resent automatically.'
            if (run.status !== 'running' && task.notificationPolicy !== 'never' && !shouldNotify(task, run.status)) task.unreadNotifications += 1
          }
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
    assertProviderModelPair(request.execution.provider, request.execution.model)
    validateTarget({ ...request.execution, target: request.execution.target ?? { mode: 'fresh' } }, request.sessionTargetConfirmed === true)
    for (const value of [request.execution.agentPreset, request.execution.provider, request.execution.model]) {
      assertOverrideId(value, 'Execution override ids')
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
    if (request.name === undefined && request.prompt === undefined && request.schedule === undefined && request.notificationPolicy === undefined && request.pauseAfterConsecutiveFailures === undefined && request.permissionPreset === undefined && request.delivery === undefined && (request.execution === undefined || Object.keys(request.execution).length === 0)) {
      throw new Error('Supply at least one field to update.')
    }
    if (request.execution !== undefined) {
      validateExecutionPatch(request.execution)
    }
    const delivery = request.delivery == null ? request.delivery : AutomationDeliverySchema.parse(request.delivery)
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
      const target = request.execution?.target
      if (target !== undefined) {
        const current = task.execution.target ?? { mode: 'fresh' as const }
        const changed = target.mode !== current.mode || (target.mode === 'pinned-session' && current.mode === 'pinned-session' && target.sessionId !== current.sessionId)
        if (changed) {
          if (request.execution?.sessionTargetConfirmed !== true) throw new Error('Explicit user confirmation is required to change the session target.')
          if (task.runs.some(nonTerminal)) throw new AutomationDomainError('invalid_state', 'Session target cannot change while an automation has a queued or running run.')
        }
        validateTarget({ ...task.execution, target }, true)
      }
      if (delivery !== undefined) {
        const changed = delivery === null ? task.delivery !== undefined
          : task.delivery?.botId !== delivery.botId || task.delivery?.targetId !== delivery.targetId
        if (changed) {
          if (delivery !== null && request.deliveryChangeConfirmed !== true) throw new Error('Explicit user confirmation is required to enable or change message delivery.')
          if (task.runs.some(nonTerminal)) throw new AutomationDomainError('invalid_state', 'Message delivery cannot change while an automation has a queued or running run.')
        }
      }
      await beforeCommit?.(structuredClone(task))
      if (delivery === null) delete task.delivery
      else if (delivery !== undefined) task.delivery = delivery
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
        task.execution = applyExecutionPatch(task.execution, request.execution)
      }
      if (schedule !== undefined && next !== undefined) {
        task.schedule = schedule
        if (task.status === 'paused') {
          task.pausedNextRunAt = instant(next)
          task.nextRunAt = null
        } else {
          task.status = 'active'
          task.nextRunAt = instant(next)
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

  async finishRun(taskId: string, runId: string, outcome: RunOutcome, now: number, delivery?: AutomationDelivery): Promise<void> {
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
      if (delivery !== undefined && (outcome.status === 'succeeded' || failedOutcome(outcome.status))) {
        run.delivery = { ...AutomationDeliverySchema.parse(delivery), status: 'sending', attemptedAt: instant(now) }
      }
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

  /** Delivery settlement never changes execution status or failure counters. */
  async finishDelivery(taskId: string, runId: string, delivery: AutomationRunDelivery): Promise<void> {
    const matches = (run: AutomationRun | undefined) => run?.delivery?.status === 'sending'
      && run.delivery.botId === delivery.botId && run.delivery.targetId === delivery.targetId
      && run.delivery.attemptedAt === delivery.attemptedAt
    if (!matches(this.store.snapshot().tasks[taskId]?.runs.find((run) => run.id === runId))) return
    await this.store.mutate((state) => {
      const task = state.tasks[taskId]
      const run = task?.runs.find((entry) => entry.id === runId)
      if (task === undefined || run === undefined || !matches(run)) return
      run.delivery = { ...delivery }
      if ((delivery.status === 'failed' || delivery.status === 'unknown') && task.notificationPolicy !== 'never' && !shouldNotify(task, run.status)) task.unreadNotifications += 1
      pruneRuns(task, this.maxRunHistory)
    })
  }
}
