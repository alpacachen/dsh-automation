import type { AutomationTask, AutomationRun } from './types.js'
import { AutomationDomain, type RunOutcome } from './domain.js'

export const MAX_TIMER_DELAY_MS = 2_147_483_647

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

  constructor(
    readonly domain: AutomationDomain,
    readonly runner: AutomationRunner,
    readonly clock: Clock = systemClock,
    private readonly onError: (error: unknown) => void = (error) => console.error(error),
  ) {}

  start(): void {
    this.requestDrive()
  }

  requestDrive(): void {
    if (this.stopped) return
    this.clearTimer()
    this.requested = true
    if (this.driving !== undefined) return
    const driving = this.drive().catch((error) => {
      this.stopped = true
      this.requested = false
      this.onError(error)
    })
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
    await this.driving
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

  private async drive(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false
      const now = this.clock.now()
      await this.domain.claimDue(now)
      const claimed = await this.domain.takeNextQueued(this.clock.now())
      if (claimed !== undefined) {
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
        }
        await this.domain.finishRun(claimed.task.id, claimed.run.id, outcome, this.clock.now())
        this.requested = true
        continue
      }
      const target = this.domain.nextWakeAt(this.clock.now())
      if (target !== undefined) this.arm(target)
    }
  }
}
