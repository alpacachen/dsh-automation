import { z } from 'zod'

export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

const Instant = z.string().regex(ISO_INSTANT)
const LocalDateTime = z.string().regex(LOCAL_DATE_TIME)

export const OnceScheduleSchema = z.strictObject({
  kind: z.literal('once'),
  fireAt: Instant,
})

export const RecurringScheduleSchema = z.strictObject({
  kind: z.literal('recurring'),
  rrule: z.string().trim().min(1),
  timeZone: z.string().trim().min(1),
  startAt: LocalDateTime,
})

export const AutomationScheduleSchema = z.discriminatedUnion('kind', [
  OnceScheduleSchema,
  RecurringScheduleSchema,
])

export const AutomationExecutionSchema = z.strictObject({
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  agentPreset: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
})

export const AutomationSecuritySchema = z.strictObject({
  permissionPreset: z.literal('danger-full-access'),
  source: z.literal('plugin-default'),
  grantedAt: Instant,
})

export const AutomationRunSchema = z.strictObject({
  id: z.string().min(1),
  trigger: z.enum(['scheduled', 'manual']),
  scheduledAt: Instant.optional(),
  enqueuedAt: Instant,
  startedAt: Instant.optional(),
  finishedAt: Instant.optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted', 'timed_out', 'canceled']),
  sessionId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
})

export const AutomationTaskSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  createdAt: Instant,
  createdBySessionId: z.string().min(1),
  status: z.enum(['active', 'paused', 'completed']),
  schedule: AutomationScheduleSchema,
  nextRunAt: Instant.nullable(),
  pausedAt: Instant.optional(),
  pausedNextRunAt: Instant.optional(),
  execution: AutomationExecutionSchema,
  security: AutomationSecuritySchema,
  runs: z.array(AutomationRunSchema),
})

export const AutomationStateSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  tasks: z.record(z.string(), AutomationTaskSchema),
})

export type OnceSchedule = z.infer<typeof OnceScheduleSchema>
export type RecurringSchedule = z.infer<typeof RecurringScheduleSchema>
export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>
export type AutomationExecution = z.infer<typeof AutomationExecutionSchema>
export type AutomationSecurity = z.infer<typeof AutomationSecuritySchema>
export type AutomationRun = z.infer<typeof AutomationRunSchema>
export type AutomationTask = z.infer<typeof AutomationTaskSchema>
export type AutomationState = z.infer<typeof AutomationStateSchema>
export type AutomationStatus = AutomationTask['status']
export type AutomationRunStatus = AutomationRun['status']

export interface CreateAutomationRequest {
  readonly name: string
  readonly prompt: string
  readonly schedule: AutomationSchedule
  readonly execution: AutomationExecution
  readonly createdBySessionId: string
}

export interface UpdateAutomationRequest {
  readonly name?: string
  readonly prompt?: string
  readonly schedule?: AutomationSchedule
}

export interface AutomationTaskView extends AutomationTask {
  readonly running: boolean
}

export interface ResumeOptions {
  readonly runNow: boolean
}

export interface AutomationSchedulerHealth {
  readonly status: 'healthy' | 'retrying' | 'stopped'
  readonly consecutiveFailures: number
  readonly lastError?: string
  readonly lastFailedAt?: string
  readonly retryAt?: string
}

export interface AutomationConfig {
  readonly root: string
  readonly executionPermissionPreset: 'danger-full-access'
  readonly maxRunHistory: number
}

export function emptyAutomationState(): AutomationState {
  return { version: 1, revision: 0, tasks: {} }
}
