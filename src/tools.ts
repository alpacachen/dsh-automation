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
    description: 'Create one durable unattended automation. Every run starts a fresh visible session with danger-full-access. Supply either once_at, or rrule + time_zone + start_at.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short task name.' },
      prompt: { type: 'string', required: true, description: 'Self-contained prompt for every fresh run session.' },
      once_at: { type: 'string', description: 'One-time canonical RFC 3339 UTC instant.' },
      rrule: { type: 'string', description: 'Single RFC 5545 RRULE line without DTSTART.' },
      time_zone: { type: 'string', description: 'IANA time zone for a recurring rule.' },
      start_at: { type: 'string', description: 'Recurring local wall clock DTSTART as YYYY-MM-DDTHH:mm:ss.' },
    },
    output: { schema: ACTION_SCHEMA, render },
    async execute(args, exec) {
      try {
        if (exec.agent !== agent) throw new Error('automation_create must run in its owning agent scope.')
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
        })
        return {
          ok: true as const,
          id: task.id,
          status: task.status,
          message: `Created ${task.name}; next run ${task.nextRunAt}. All runs use danger-full-access without approval prompts.`,
        }
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Create automation', kind: 'other', rawInput: args.name }),
  })))

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'automation_update',
    description: 'Update an existing automation. Omitted fields stay unchanged. To replace its schedule, supply either once_at, or all of rrule, time_zone, and start_at.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact automation id.' },
      name: { type: 'string', description: 'Replacement task name.' },
      prompt: { type: 'string', description: 'Replacement self-contained prompt for future runs.' },
      once_at: { type: 'string', description: 'Replacement one-time canonical RFC 3339 UTC instant.' },
      rrule: { type: 'string', description: 'Replacement RFC 5545 RRULE line without DTSTART.' },
      time_zone: { type: 'string', description: 'Replacement IANA time zone.' },
      start_at: { type: 'string', description: 'Replacement local wall clock DTSTART as YYYY-MM-DDTHH:mm:ss.' },
    },
    output: { schema: ACTION_SCHEMA, render },
    async execute(args, exec) {
      try {
        if (exec.agent !== agent) throw new Error('automation_update must run in its owning agent scope.')
        const schedule = updateSchedule(args)
        if (args.name === undefined && args.prompt === undefined && schedule === undefined) {
          throw new Error('Supply at least one field to update.')
        }
        const task = await controller.update(args.id, {
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(schedule === undefined ? {} : { schedule }),
        })
        return { ok: true as const, id: task.id, status: task.status, message: `Updated ${task.id}; next run ${task.nextRunAt}.` }
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
