import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { AutomationController } from './controller.js'
import type { AutomationSchedule, AutomationTaskView } from './types.js'

import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-workspace'

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: false },
    error: { type: 'string', required: true },
  },
} as const

const ACTION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true, const: true },
        id: { type: 'string', required: true },
        status: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    ERROR_SCHEMA,
  ],
} as const

const TASK_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    status: { type: 'string', required: true },
    schedule: { type: 'string', required: true },
    nextRunAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    running: { type: 'boolean', required: true },
    lastRunStatus: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    notificationPolicy: { type: 'string', required: true },
    permissionPreset: { type: 'string', required: true },
    consecutiveFailures: { type: 'number', required: true },
  },
} as const

const LIST_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true, const: true },
        tasks: {
          type: 'array',
          required: true,
          items: TASK_SUMMARY_SCHEMA,
        },
      },
    },
    ERROR_SCHEMA,
  ],
} as const

function render(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

function failure(error: unknown) {
  return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
}

function summary(task: AutomationTaskView) {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    schedule: task.schedule.kind === 'once'
      ? `once at ${task.schedule.fireAt}`
      : `${task.schedule.rrule} (${task.schedule.timeZone})`,
    nextRunAt: task.nextRunAt,
    running: task.running,
    lastRunStatus: task.runs.at(-1)?.status ?? null,
    notificationPolicy: task.notificationPolicy,
    permissionPreset: task.security.permissionPreset,
    consecutiveFailures: task.consecutiveFailures,
  }
}

function createSchedule(args: {
  once_at?: number | string
  rrule?: string
  time_zone?: string
  start_at?: string
}): AutomationSchedule {
  const hasOnce = args.once_at !== undefined
  const recurringFields = [args.rrule, args.time_zone, args.start_at]
  const hasAnyRecurring = recurringFields.some((value) => value !== undefined)
  const hasAllRecurring = recurringFields.every((value) => value !== undefined)
  if (hasOnce === hasAnyRecurring || (hasAnyRecurring && !hasAllRecurring)) {
    throw new Error('Supply either once_at, or all of rrule, time_zone, and start_at.')
  }
  if (hasOnce) {
    if (typeof args.once_at !== 'string') throw new Error('once_at must be an RFC 3339 UTC string.')
    return { kind: 'once', fireAt: args.once_at }
  }
  return {
    kind: 'recurring',
    rrule: args.rrule!,
    timeZone: args.time_zone!,
    startAt: args.start_at!,
  }
}

function updateSchedule(args: {
  once_at?: number | string
  rrule?: string
  time_zone?: string
  start_at?: string
}): AutomationSchedule | undefined {
  if (args.once_at === undefined && args.rrule === undefined && args.time_zone === undefined && args.start_at === undefined) {
    return undefined
  }
  return createSchedule(args)
}

export function registerAutomationTools(
  rootCtx: Context,
  toolCtx: Context,
  agent: Agent,
  controller: AutomationController,
): () => void {
  const disposers: Array<() => void> = []

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'automation_create',
    description: 'Create one durable unattended automation. Every run starts a fresh visible session. Before calling, show one concise preview with name, schedule and time zone, current workspace, permission, notification policy, and failure-pause policy; wait for explicit user confirmation, then set creation_confirmed to true. Use read-only for inspection/reporting that must not modify files, or danger-full-access for tasks that need unrestricted writes. Supply either once_at, or rrule + time_zone + start_at. Ask for a notification policy when the user intent is ambiguous; otherwise default to failures.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short task name.' },
      prompt: { type: 'string', required: true, description: 'Self-contained prompt for every fresh run session.' },
      once_at: { type: 'string', description: 'One-time canonical RFC 3339 UTC instant.' },
      rrule: { type: 'string', description: 'Single RFC 5545 RRULE line without DTSTART.' },
      time_zone: { type: 'string', description: 'IANA time zone for a recurring rule.' },
      start_at: { type: 'string', description: 'Recurring local wall clock DTSTART as YYYY-MM-DDTHH:mm:ss.' },
      notification_policy: { type: 'string', enum: ['failures', 'always', 'never'], description: 'Sidebar notification policy. Defaults to failures.' },
      pause_after_failures: { type: 'boolean', description: 'Pause future scheduling after 3 consecutive failed or timed-out runs.' },
      permission_preset: { type: 'string', required: true, enum: ['read-only', 'danger-full-access'], description: 'Confirmed permission for every run. Prefer read-only when no file changes are needed.' },
      creation_confirmed: { type: 'boolean', required: true, description: 'Must be true only after the user explicitly confirms the complete creation preview.' },
    },
    output: { schema: ACTION_SCHEMA, render },
    async execute(args, exec) {
      try {
        if (exec.agent !== agent) throw new Error('automation_create must run in its owning agent scope.')
        if (args.creation_confirmed !== true) throw new Error('Explicit user confirmation of the complete creation preview is required.')
        const cwd = agent.session.header.cwd
        if (cwd === undefined) throw new Error('The current session has no workspace directory.')
        const workspace = await rootCtx.workspaceRegistry.create(cwd)
        const task = await controller.create({
          name: args.name,
          prompt: args.prompt,
          schedule: createSchedule(args),
          execution: {
            workspaceId: workspace.id,
            cwd: workspace.path,
            ...(rootCtx.agentPresets.composedPreset(agent.ctx) === undefined
              ? {}
              : { agentPreset: rootCtx.agentPresets.composedPreset(agent.ctx)! }),
            ...(agent.options.provider === undefined ? {} : { provider: agent.options.provider }),
            ...(agent.options.model === undefined ? {} : { model: agent.options.model }),
          },
          createdBySessionId: agent.id,
          permissionPreset: args.permission_preset,
          ...(args.notification_policy === undefined ? {} : { notificationPolicy: args.notification_policy }),
          ...(args.pause_after_failures === undefined ? {} : { pauseAfterConsecutiveFailures: args.pause_after_failures }),
        })
        return {
          ok: true as const,
          id: task.id,
          status: task.status,
          message: `Created ${task.name}; next run ${task.nextRunAt}; permission ${task.security.permissionPreset}; notifications ${task.notificationPolicy}.`,
        }
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Create automation', kind: 'other', rawInput: args.name }),
  })))

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'automation_update',
    description: 'Update an existing automation. Omitted fields stay unchanged. To replace its schedule, supply either once_at, or all of rrule, time_zone, and start_at. Before changing permissions, show the new preset to the user and get explicit confirmation; set permission_confirmed only after they confirm.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact automation id.' },
      name: { type: 'string', description: 'Replacement task name.' },
      prompt: { type: 'string', description: 'Replacement self-contained prompt for future runs.' },
      once_at: { type: 'string', description: 'Replacement one-time canonical RFC 3339 UTC instant.' },
      rrule: { type: 'string', description: 'Replacement RFC 5545 RRULE line without DTSTART.' },
      time_zone: { type: 'string', description: 'Replacement IANA time zone.' },
      start_at: { type: 'string', description: 'Replacement local wall clock DTSTART as YYYY-MM-DDTHH:mm:ss.' },
      notification_policy: { type: 'string', enum: ['failures', 'always', 'never'], description: 'Replacement sidebar notification policy.' },
      pause_after_failures: { type: 'boolean', description: 'Whether to pause after 3 consecutive failed or timed-out runs.' },
      permission_preset: { type: 'string', enum: ['read-only', 'danger-full-access'], description: 'Replacement permission preset for future runs.' },
      permission_confirmed: { type: 'boolean', description: 'Required and true only after the user explicitly confirms a permission change.' },
    },
    output: { schema: ACTION_SCHEMA, render },
    async execute(args, exec) {
      try {
        if (exec.agent !== agent) throw new Error('automation_update must run in its owning agent scope.')
        const schedule = updateSchedule(args)
        if (args.permission_preset !== undefined && args.permission_confirmed !== true) {
          throw new Error('Explicit user confirmation is required to change permissions.')
        }
        if (args.name === undefined && args.prompt === undefined && schedule === undefined && args.notification_policy === undefined && args.pause_after_failures === undefined && args.permission_preset === undefined) {
          throw new Error('Supply at least one field to update.')
        }
        const task = await controller.update(args.id, {
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(schedule === undefined ? {} : { schedule }),
          ...(args.notification_policy === undefined ? {} : { notificationPolicy: args.notification_policy }),
          ...(args.pause_after_failures === undefined ? {} : { pauseAfterConsecutiveFailures: args.pause_after_failures }),
          ...(args.permission_preset === undefined ? {} : { permissionPreset: args.permission_preset }),
        })
        return { ok: true as const, id: task.id, status: task.status, message: `Updated ${task.id}; next run ${task.nextRunAt}; permission ${task.security.permissionPreset}.` }
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Update automation', kind: 'other', rawInput: args.id }),
  })))

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'automation_list',
    description: 'List durable automations and their current scheduling state.',
    parameters: {},
    output: { schema: LIST_SCHEMA, render },
    async execute(_args, exec) {
      try {
        if (exec.agent !== agent) throw new Error('automation_list must run in its owning agent scope.')
        return { ok: true as const, tasks: controller.list().map(summary) }
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List automations', kind: 'read' }),
  })))

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'automation_run',
    description: 'Queue one immediate manual run without changing the automation schedule.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact automation id.' },
    },
    output: { schema: ACTION_SCHEMA, render },
    async execute(args, exec) {
      try {
        if (exec.agent !== agent) throw new Error('automation_run must run in its owning agent scope.')
        const run = await controller.runNow(args.id)
        return { ok: true as const, id: run.id, status: run.status, message: `Queued manual run ${run.id} for ${args.id}.` }
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Run automation', kind: 'other', rawInput: args.id }),
  })))

  for (const definition of [
    {
      name: 'automation_delete',
      description: 'Delete one automation and cancel future scheduling. Existing run sessions remain.',
      verb: 'Deleted',
      execute: (id: string) => controller.delete(id),
    },
    {
      name: 'automation_pause',
      description: 'Pause one active automation. A run already started continues.',
      verb: 'Paused',
      execute: (id: string) => controller.pause(id),
    },
  ] as const) {
    disposers.push(toolCtx.tools.register(defineTool({
      name: definition.name,
      description: definition.description,
      parameters: { id: { type: 'string', required: true, description: 'Exact automation id.' } },
      output: { schema: ACTION_SCHEMA, render },
      async execute(args, exec) {
        try {
          if (exec.agent !== agent) throw new Error(`${definition.name} must run in its owning agent scope.`)
          const result = await definition.execute(args.id)
          if (typeof result === 'boolean' && !result) throw new Error(`Automation ${args.id} was not found.`)
          return { ok: true as const, id: args.id, status: definition.name === 'automation_delete' ? 'deleted' : 'paused', message: `${definition.verb} ${args.id}.` }
        } catch (error) {
          return failure(error)
        }
      },
      presentCall: (args) => ({ card: 'generic', title: definition.verb, kind: 'other', rawInput: args.id }),
    })))
  }

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'automation_resume',
    description: 'Resume one paused automation. Set run_now to run once immediately while preserving the future recurring schedule.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact automation id.' },
      run_now: { type: 'boolean', description: 'Also enqueue one immediate manual run.' },
    },
    output: { schema: ACTION_SCHEMA, render },
    async execute(args, exec) {
      try {
        if (exec.agent !== agent) throw new Error('automation_resume must run in its owning agent scope.')
        const task = await controller.resume(args.id, { runNow: args.run_now ?? false })
        return { ok: true as const, id: task.id, status: task.status, message: `Resumed ${task.id}; next run ${task.nextRunAt}.` }
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Resume automation', kind: 'other', rawInput: args.id }),
  })))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
