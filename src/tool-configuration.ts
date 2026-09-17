import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { AutomationError } from './errors.js'
import { assertProviderModelPair } from './validation.js'
import type { AutomationController } from './controller.js'
import type { AutomationExecutionTarget, AutomationSchedule } from './types.js'
import type { AgentConfiguration } from './agent-configuration.js'
import { ACTION_SCHEMA, ERROR_SCHEMA, executeTool, render, workspaceDirectory } from './tool-support.js'

import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-persistence'

function latestSessionModel(agent: Agent): { provider: string; model: string } | undefined {
  const events = agent.session.snapshotEvents()
  const event = [...events].reverse().find((entry) => entry.type === 'request/header')
  if (event?.type !== 'request/header') return undefined
  const config = event.data.header.config
  if (typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined
  return { provider: config.provider, model: config.model }
}

function createSchedule(args: {
  once_at?: number | string
  rrule?: string
  time_zone?: string
  start_at?: string
}): AutomationSchedule {
  const { once_at, rrule, time_zone, start_at } = args
  const hasRecurring = rrule !== undefined || time_zone !== undefined || start_at !== undefined
  if (once_at !== undefined && !hasRecurring) {
    if (typeof once_at !== 'string') throw new Error('once_at must be an RFC 3339 UTC string.')
    return { kind: 'once', fireAt: once_at }
  }
  if (once_at === undefined && rrule !== undefined && time_zone !== undefined && start_at !== undefined) {
    return { kind: 'recurring', rrule, timeZone: time_zone, startAt: start_at }
  }
  throw new Error('Supply either once_at, or all of rrule, time_zone, and start_at.')
}

function updateSchedule(args: Parameters<typeof createSchedule>[0]): AutomationSchedule | undefined {
  if (args.once_at === undefined && args.rrule === undefined && args.time_zone === undefined && args.start_at === undefined) {
    return undefined
  }
  return createSchedule(args)
}

export function registerConfigurationTools(
  rootCtx: Context,
  toolCtx: Context,
  agent: Agent,
  controller: AutomationController,
  agentConfiguration: AgentConfiguration,
): Array<() => void> {
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
    execute(args, exec) {
      return executeTool('automation_options', agent, exec.agent, async () => {
        const candidate = args.agent_preset === undefined ? undefined : args.agent_preset || undefined
        const options = args.id === undefined
          ? await agentConfiguration.options(workspaceDirectory(agent), args.agent_preset === undefined ? rootCtx.agentPresets.composedPreset(agent.ctx) : candidate)
          : await controller.options(args.id, args.agent_preset === undefined ? undefined : candidate ?? null)
        return { ok: true as const, options: options as unknown as Record<string, JsonValue> }
      })
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
      execution_mode: { type: 'string', enum: ['fresh', 'pinned-session'], description: 'Execution destination; defaults to fresh.' },
      target_session_id: { type: 'string', description: 'Persisted target session id for pinned-session mode.' },
      session_target_confirmed: { type: 'boolean', description: 'Must be true after the target session preview is confirmed.' },
      creation_confirmed: { type: 'boolean', required: true, description: 'Must be true only after the user explicitly confirms the complete creation preview.' },
    },
    output: { schema: ACTION_SCHEMA, render },
    execute(args, exec) {
      return executeTool('automation_create', agent, exec.agent, async () => {
        if (args.creation_confirmed !== true) throw new Error('Explicit user confirmation of the complete creation preview is required.')
        const cwd = workspaceDirectory(agent)
        const workspace = await rootCtx.workspaceRegistry.create(cwd)
        assertProviderModelPair(args.provider, args.model)
        const currentModel = latestSessionModel(agent)
        const capturedProvider = args.provider ?? currentModel?.provider ?? agent.options.provider
        const capturedModel = args.model ?? currentModel?.model ?? agent.options.model
        let target: AutomationExecutionTarget = { mode: 'fresh' }
        if (args.execution_mode === 'pinned-session') {
          const targetSessionId = args.target_session_id
          if (targetSessionId === undefined) throw new Error('target_session_id is required for pinned-session mode.')
          if (args.session_target_confirmed !== true) throw new Error('Explicit user confirmation is required for a pinned session target.')
          const persistence = rootCtx.get('sessionPersistence')
          if (persistence === undefined) throw new AutomationError('target_session_unavailable', 'persisted session inspection is unavailable.')
          const snapshot = await persistence.stat(SessionId(targetSessionId))
          if (snapshot === undefined || snapshot.header.id !== SessionId(targetSessionId)) throw new AutomationError('target_session_not_found', 'pinned session could not be resolved.')
          if (snapshot.header.cwd !== cwd) throw new AutomationError('target_workspace_mismatch', 'pinned session cwd does not match.')
          target = { mode: 'pinned-session', sessionId: targetSessionId, workspaceId: workspace.id, cwd: workspace.path, fallback: 'fail' }
        }
        const agentPreset = args.agent_preset ?? rootCtx.agentPresets.composedPreset(agent.ctx)
        const task = await controller.create({
          name: args.name,
          prompt: args.prompt,
          schedule: createSchedule(args),
          execution: {
            workspaceId: workspace.id,
            cwd: workspace.path,
            ...(agentPreset === undefined ? {} : { agentPreset }),
            ...(capturedProvider === undefined || capturedModel === undefined ? {} : { provider: capturedProvider, model: capturedModel }),
            skills: args.skills ?? [],
            target,
          },
          createdBySessionId: agent.id,
          permissionPreset: args.permission_preset,
          ...(target.mode === 'pinned-session' ? { sessionTargetConfirmed: true as const } : {}),
          ...(args.notification_policy === undefined ? {} : { notificationPolicy: args.notification_policy }),
          ...(args.pause_after_failures === undefined ? {} : { pauseAfterConsecutiveFailures: args.pause_after_failures }),
        })
        return {
          ok: true as const,
          id: task.id,
          status: task.status,
          message: `Created ${task.name}; next run ${task.nextRunAt}; permission ${task.security.permissionPreset}; notifications ${task.notificationPolicy}.`,
        }
      })
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
    execute(args, exec) {
      return executeTool('automation_update', agent, exec.agent, async () => {
        const schedule = updateSchedule(args)
        const current = controller.get(args.id)
        if (['delivery', 'confirmDeliveryChange', 'deliveryChangeConfirmed'].some((key) => Object.hasOwn(args, key))) {
          throw new Error('Message delivery changes are manual-only in Automation settings.')
        }
        if (['execution_mode', 'target_session_id', 'session_target_confirmed', 'execution', 'target', 'confirmSessionTargetChange'].some((key) => Object.hasOwn(args, key))) {
          throw new Error('Session target changes are unsupported by automation_update; change the target manually in Automation settings.')
        }
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
      })
    },
    presentCall: (args) => ({ card: 'generic', title: 'Update automation', kind: 'other', rawInput: args.id }),
  })))

  return disposers
}
