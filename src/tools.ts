import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { AutomationController } from './controller.js'
import type { AutomationSchedule, AutomationTaskView } from './types.js'
import { AgentConfiguration } from './agent-configuration.js'

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
    agentPreset: { type: 'string', required: true },
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    skills: { type: 'array', required: true, items: { type: 'string' } },
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
    agentPreset: task.execution.agentPreset ?? 'Host default',
    provider: task.execution.provider ?? 'Host default',
    model: task.execution.model ?? 'Host default',
    skills: task.execution.skills,
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
  agentConfiguration = new AgentConfiguration(rootCtx),
): () => void {
  const disposers: Array<() => void> = []

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'automation_options',
    description: 'List the Host agent presets, provider/models, user-invocable skills, and permission presets available for automation configuration. Call this before selecting configuration ids. With an id, options use that task workspace and saved preset; agent_preset previews skills for a candidate preset. An empty agent_preset means the Host default.',
    parameters: {
      id: { type: 'string', description: 'Existing automation id. Omit to use this Agent workspace.' },
      agent_preset: { type: 'string', description: 'Candidate preset id for skill discovery; empty means Host default.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              options: { type: 'object', required: true, additionalProperties: true },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render,
    },
    async execute(args, exec) {
      try {
        if (exec.agent !== agent) throw new Error('automation_options must run in its owning agent scope.')
        const candidate = args.agent_preset === undefined
          ? undefined
          : args.agent_preset || undefined
        const options = args.id === undefined
          ? await agentConfiguration.options(agent.session.header.cwd ?? (() => { throw new Error('The current session has no workspace directory.') })(), args.agent_preset === undefined ? rootCtx.agentPresets.composedPreset(agent.ctx) : candidate)
          : await controller.options(args.id, args.agent_preset === undefined ? undefined : candidate ?? null)
        return { ok: true as const, options: options as unknown as Record<string, JsonValue> }
      } catch (error) {
        return failure(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Automation options', kind: 'read' }),
  })))

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'automation_create',
    description: 'Create one durable unattended automation. Call automation_options before selecting Host ids. Before calling, show one concise preview with name, schedule/time zone, workspace, Agent preset, provider/model, ordered selected skills, exact Host permission label/id (including approval warning), notification policy, and failure-pause policy; wait for explicit user confirmation, then set creation_confirmed to true. Every run starts a fresh visible session. Presets with approval ask may wait until timeout because unattended runs never auto-approve. Supply either once_at, or rrule + time_zone + start_at.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short task name.' },
      prompt: { type: 'string', required: true, description: 'Self-contained prompt for every fresh run session.' },
      once_at: { type: 'string', description: 'One-time canonical RFC 3339 UTC instant.' },
      rrule: { type: 'string', description: 'Single RFC 5545 RRULE line without DTSTART.' },
      time_zone: { type: 'string', description: 'IANA time zone for a recurring rule.' },
      start_at: { type: 'string', description: 'Recurring local wall clock DTSTART as YYYY-MM-DDTHH:mm:ss.' },
      notification_policy: { type: 'string', enum: ['failures', 'always', 'never'], description: 'Sidebar notification policy. Defaults to failures.' },
      pause_after_failures: { type: 'boolean', description: 'Pause future scheduling after 3 consecutive failed or timed-out runs.' },
      agent_preset: { type: 'string', description: 'Host Agent preset id. Omit to capture the creating Agent preset.' },
      provider: { type: 'string', description: 'Provider override; must be supplied with model.' },
      model: { type: 'string', description: 'Model override; must be supplied with provider.' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Ordered user-invocable skill names to preload. Defaults to none.' },
      permission_preset: { type: 'string', required: true, description: 'Confirmed Host permission preset id for every run.' },
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
        if ((args.provider === undefined) !== (args.model === undefined)) throw new Error('provider and model must be supplied together.')
        const capturedProvider = args.provider ?? agent.options.provider
        const capturedModel = args.model ?? agent.options.model
        const task = await controller.create({
          name: args.name,
          prompt: args.prompt,
          schedule: createSchedule(args),
          execution: {
            workspaceId: workspace.id,
            cwd: workspace.path,
            ...((args.agent_preset ?? rootCtx.agentPresets.composedPreset(agent.ctx)) === undefined
              ? {}
              : { agentPreset: args.agent_preset ?? rootCtx.agentPresets.composedPreset(agent.ctx)! }),
            ...(capturedProvider === undefined || capturedModel === undefined ? {} : { provider: capturedProvider, model: capturedModel }),
            skills: args.skills ?? [],
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
    description: 'Update an existing automation. Call automation_options before selecting Host ids. Omitted fields stay unchanged; null clears an Agent preset or provider/model override, and skills replaces the ordered selection. Provider/model must be set or cleared together. Before an actual permission change, show the exact Host preset and get explicit confirmation; set permission_confirmed only after they confirm.',
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
      agent_preset: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Replacement Host Agent preset id, or null for Host default.' },
      provider: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Replacement provider, or null with model to use Host default.' },
      model: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Replacement model, or null with provider to use Host default.' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Replacement ordered selected skills; [] clears.' },
      permission_preset: { type: 'string', description: 'Replacement Host permission preset id for future runs.' },
      permission_confirmed: { type: 'boolean', description: 'Required and true only after the user explicitly confirms a permission change.' },
    },
    output: { schema: ACTION_SCHEMA, render },
    async execute(args, exec) {
      try {
        if (exec.agent !== agent) throw new Error('automation_update must run in its owning agent scope.')
        const schedule = updateSchedule(args)
        const current = controller.get(args.id)
        if (args.permission_preset !== undefined && args.permission_preset !== current.security.permissionPreset && args.permission_confirmed !== true) {
          throw new Error('Explicit user confirmation is required to change permissions.')
        }
        if (args.name === undefined && args.prompt === undefined && schedule === undefined && args.notification_policy === undefined && args.pause_after_failures === undefined && args.permission_preset === undefined && args.agent_preset === undefined && args.provider === undefined && args.model === undefined && args.skills === undefined) {
          throw new Error('Supply at least one field to update.')
        }
        const task = await controller.update(args.id, {
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(schedule === undefined ? {} : { schedule }),
          ...(args.notification_policy === undefined ? {} : { notificationPolicy: args.notification_policy }),
          ...(args.pause_after_failures === undefined ? {} : { pauseAfterConsecutiveFailures: args.pause_after_failures }),
          ...(args.permission_preset === undefined ? {} : { permissionPreset: args.permission_preset }),
          ...(args.permission_preset === undefined || args.permission_confirmed !== true ? {} : { permissionChangeConfirmed: true as const }),
          ...((args.agent_preset === undefined && args.provider === undefined && args.model === undefined && args.skills === undefined) ? {} : {
            execution: {
              ...(args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset }),
              ...(args.provider === undefined ? {} : { provider: args.provider }),
              ...(args.model === undefined ? {} : { model: args.model }),
              ...(args.skills === undefined ? {} : { skills: args.skills }),
            },
          }),
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
