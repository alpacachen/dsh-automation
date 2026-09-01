import type { AutomationTask, AutomationRun, AutomationSchedulerHealth } from './types.js'
import { AutomationDomain, type RunOutcome } from './domain.js'

export const MAX_TIMER_DELAY_MS = 2_147_483_647
export const RETRY_BASE_DELAY_MS = 1_000
export const RETRY_MAX_DELAY_MS = 60_000
export const DEFAULT_MAX_RUN_DURATION_MS = 60 * 60_000

export type AutomationRunCancelReason = 'manual' | 'timeout' | 'shutdown'

export interface Clock {
  now(): number
  setTimeout(callback: () => void, delay: number): () => void
}

export interface AutomationRunnerResult {
  readonly status: 'succeeded' | 'failed'
  readonly sessionId: string
  readonly error?: string
}

export interface AutomationRunner {
  run(task: AutomationTask, run: AutomationRun): Promise<AutomationRunnerResult>
  cancel?(runId: string, reason: AutomationRunCancelReason): boolean
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, delay) {
    const handle = setTimeout(callback, delay)
    return () => clearTimeout(handle)
  },
}

export class AutomationScheduler {
  private cancelTimer: (() => void) | undefined
  private generation = 0
  private requested = false
  private stopped = false
  private driving: Promise<void> | undefined
  private healthState: AutomationSchedulerHealth = { status: 'healthy', consecutiveFailures: 0 }
  private pendingFinish: { taskId: string; runId: string; outcome: RunOutcome } | undefined
  private activeRun: {
    taskId: string
    runId: string
    cancelReason: AutomationRunCancelReason | undefined
    cancelTimeout: (() => void) | undefined
  } | undefined

  constructor(
    readonly domain: AutomationDomain,
    readonly runner: AutomationRunner,
    readonly clock: Clock = systemClock,
    private readonly onError: (error: unknown) => void = (error) => console.error(error),
    readonly maxRunDurationMs = DEFAULT_MAX_RUN_DURATION_MS,
  ) {}

  start(): void {
    this.requestDrive()
  }

  health(): AutomationSchedulerHealth {
    return structuredClone(this.healthState)
  }

  cancelRun(taskId: string, runId: string): boolean {
    const active = this.activeRun
    if (active === undefined || active.taskId !== taskId || active.runId !== runId) return false
    return this.cancelActiveRun('manual')
  }

  requestDrive(): void {
    if (this.stopped) return
    this.clearTimer()
    this.requested = true
    if (this.driving !== undefined) return
    const driving = this.drive().then(
      () => this.markHealthy(),
      (error) => this.scheduleRetry(error),
    )
    this.driving = driving
    void driving.finally(() => {
      if (this.driving === driving) this.driving = undefined
      if (this.requested && !this.stopped) this.requestDrive()
    })
  }

  async whenSettled(): Promise<void> {
    while (this.driving !== undefined) {
      const current = this.driving
      await current
      if (this.driving === current) await Promise.resolve()
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.requested = false
    this.clearTimer()
    this.cancelActiveRun('shutdown')
    const { retryAt: _retryAt, ...health } = this.healthState
    this.healthState = { ...health, status: 'stopped' }
    await this.driving
  }

  private markHealthy(): void {
    if (this.stopped || this.healthState.status === 'healthy') return
    const { lastError, lastFailedAt } = this.healthState
    this.healthState = {
      status: 'healthy',
      consecutiveFailures: 0,
      ...(lastError === undefined ? {} : { lastError }),
      ...(lastFailedAt === undefined ? {} : { lastFailedAt }),
    }
  }

  private scheduleRetry(error: unknown): void {
    if (this.stopped) return
    this.requested = false
    const now = this.clock.now()
    const consecutiveFailures = this.healthState.consecutiveFailures + 1
    const delay = Math.min(RETRY_BASE_DELAY_MS * (2 ** (consecutiveFailures - 1)), RETRY_MAX_DELAY_MS)
    this.healthState = {
      status: 'retrying',
      consecutiveFailures,
      lastError: error instanceof Error ? error.message : String(error),
      lastFailedAt: new Date(now).toISOString(),
      retryAt: new Date(now + delay).toISOString(),
    }
    try {
      this.onError(error)
    } catch {}
    this.arm(now + delay)
  }

  private cancelActiveRun(reason: AutomationRunCancelReason): boolean {
    const active = this.activeRun
    if (active === undefined) return false
    if (active.cancelReason !== undefined) return true
    if (this.runner.cancel?.(active.runId, reason) !== true) return false
    active.cancelReason = reason
    active.cancelTimeout?.()
    active.cancelTimeout = undefined
    return true
  }

  private clearTimer(): void {
    this.generation += 1
    this.cancelTimer?.()
    this.cancelTimer = undefined
  }

  private arm(target: number): void {
    const now = this.clock.now()
    const delay = Math.max(0, Math.min(target - now, MAX_TIMER_DELAY_MS))
    const generation = ++this.generation
    this.cancelTimer = this.clock.setTimeout(() => {
      if (this.stopped || generation !== this.generation) return
      this.cancelTimer = undefined
      this.requestDrive()
    }, delay)
  }

  private async finishPendingRun(now: number): Promise<void> {
    const pending = this.pendingFinish
    if (pending === undefined) return
    await this.domain.finishRun(pending.taskId, pending.runId, pending.outcome, now)
    if (this.pendingFinish === pending) this.pendingFinish = undefined
  }

  private async drive(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false
      if (this.pendingFinish !== undefined) {
        await this.finishPendingRun(this.clock.now())
        this.requested = true
        continue
      }
      const now = this.clock.now()
      await this.domain.claimDue(now)
      const claimed = await this.domain.takeNextQueued(this.clock.now())
      if (claimed !== undefined) {
        const active: NonNullable<typeof this.activeRun> = {
          taskId: claimed.task.id,
          runId: claimed.run.id,
          cancelReason: undefined,
          cancelTimeout: undefined,
        }
        this.activeRun = active
        active.cancelTimeout = this.clock.setTimeout(() => {
          active.cancelTimeout = undefined
          if (this.activeRun === active) this.cancelActiveRun('timeout')
        }, Math.min(this.maxRunDurationMs, MAX_TIMER_DELAY_MS))
        let outcome: RunOutcome
        try {
          const result = await this.runner.run(claimed.task, claimed.run)
          outcome = {
            status: result.status,
            sessionId: result.sessionId,
            ...(result.error === undefined ? {} : { error: result.error }),
          }
        } catch (error) {
          outcome = {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }
        } finally {
          active.cancelTimeout?.()
          active.cancelTimeout = undefined
        }
        const session = outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }
        if (active.cancelReason === 'timeout') {
          outcome = { status: 'timed_out', error: `Automation exceeded its ${this.maxRunDurationMs}ms run limit.`, ...session }
        } else if (active.cancelReason === 'manual') {
          outcome = { status: 'canceled', error: 'Automation run was stopped by the user.', ...session }
        } else if (active.cancelReason === 'shutdown') {
          outcome = { status: 'interrupted', error: 'DSH stopped while this automation run was active.', ...session }
        }
        if (this.activeRun === active) this.activeRun = undefined
        this.pendingFinish = { taskId: claimed.task.id, runId: claimed.run.id, outcome }
        await this.finishPendingRun(this.clock.now())
        this.requested = true
        continue
      }
      const target = this.domain.nextWakeAt(this.clock.now())
      if (target !== undefined) this.arm(target)
    }
  }
}
