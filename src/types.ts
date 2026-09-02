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
  skills: z.array(z.string().min(1)).default([]),
  target: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('fresh') }),
    z.strictObject({
      mode: z.literal('pinned-session'),
      sessionId: z.string().min(1),
      workspaceId: z.string().min(1),
      cwd: z.string().min(1),
      fallback: z.literal('fail'),
    }),
  ]).default({ mode: 'fresh' }),
})

export const AutomationPermissionPresetSchema = z.string().trim().min(1)

export const AutomationSecuritySchema = z.strictObject({
  permissionPreset: AutomationPermissionPresetSchema,
  source: z.enum(['plugin-default', 'user-confirmed']),
  grantedAt: Instant,
})

export const NotificationPolicySchema = z.enum(['failures', 'always', 'never'])

export const AutomationRunSchema = z.strictObject({
  id: z.string().min(1),
  trigger: z.enum(['scheduled', 'manual']),
  scheduledAt: Instant.optional(),
  enqueuedAt: Instant,
  startedAt: Instant.optional(),
  finishedAt: Instant.optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted', 'outcome_unknown', 'timed_out', 'canceled']),
  sessionId: z.string().min(1).optional(),
  executionTarget: z.strictObject({ mode: z.enum(['fresh', 'pinned-session']), sessionId: z.string().min(1).optional() }).optional(),
  summary: z.string().min(1).optional(),
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
  notificationPolicy: NotificationPolicySchema.default('failures'),
  pauseAfterConsecutiveFailures: z.boolean().default(false),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  unreadNotifications: z.number().int().nonnegative().default(0),
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
export type AutomationExecutionTarget = z.infer<typeof AutomationExecutionSchema>['target']
export type AutomationExecution = Omit<z.infer<typeof AutomationExecutionSchema>, 'target'> & { target?: AutomationExecutionTarget }
export type AutomationSecurity = z.infer<typeof AutomationSecuritySchema>
export type AutomationPermissionPreset = z.infer<typeof AutomationPermissionPresetSchema>
export type NotificationPolicy = z.infer<typeof NotificationPolicySchema>
export type AutomationRun = z.infer<typeof AutomationRunSchema>
export type AutomationTask = Omit<z.infer<typeof AutomationTaskSchema>, 'execution'> & { execution: AutomationExecution }
export type AutomationState = Omit<z.infer<typeof AutomationStateSchema>, 'tasks'> & { tasks: Record<string, AutomationTask> }
export type AutomationStatus = AutomationTask['status']
export type AutomationRunStatus = AutomationRun['status']

export interface CreateAutomationRequest {
  readonly name: string
  readonly prompt: string
  readonly schedule: AutomationSchedule
  readonly execution: AutomationExecution
  readonly createdBySessionId: string
  readonly permissionPreset: AutomationPermissionPreset
  readonly sessionTargetConfirmed?: true
  readonly notificationPolicy?: NotificationPolicy
  readonly pauseAfterConsecutiveFailures?: boolean
}

export interface UpdateAutomationRequest {
  readonly name?: string
  readonly prompt?: string
  readonly schedule?: AutomationSchedule
  readonly notificationPolicy?: NotificationPolicy
  readonly pauseAfterConsecutiveFailures?: boolean
  readonly permissionPreset?: AutomationPermissionPreset
  readonly permissionChangeConfirmed?: true
  readonly execution?: AutomationExecutionPatch
}

export interface AutomationExecutionPatch {
  readonly agentPreset?: string | null
  readonly provider?: string | null
  readonly model?: string | null
  readonly skills?: readonly string[]
  readonly target?: AutomationExecutionTarget
  readonly sessionTargetConfirmed?: true
}

export interface AgentConfigurationOptions {
  readonly presets: readonly {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly trust: 'system' | 'user'
    readonly broken?: string
    readonly default: boolean
  }[]
  readonly models: readonly {
    readonly provider: string
    readonly name: string
    readonly models: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  }[]
  readonly modelFailures: readonly { readonly provider: string; readonly error: string }[]
  readonly permissions: readonly {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly sandbox: string
    readonly approval: 'ask' | 'never'
    readonly default: boolean
  }[]
  readonly skills: readonly {
    readonly name: string
    readonly description: string
    readonly whenToUse?: string
    readonly modelInvocable: boolean
    readonly source: string
    readonly provider: string
  }[]
}

export interface AutomationTaskView extends AutomationTask {
  readonly running: boolean
  readonly permissionDisplayName?: string
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
  readonly maxRunHistory: number
}

export function emptyAutomationState(): AutomationState {
  return { version: 1, revision: 0, tasks: {} }
}
