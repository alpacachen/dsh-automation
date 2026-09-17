import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AutomationController } from './controller.js'
import type { AutomationTaskView } from './types.js'
import { AgentConfiguration } from './agent-configuration.js'
import { registerConfigurationTools } from './tool-configuration.js'
import { ACTION_SCHEMA, ERROR_SCHEMA, executeTool, render } from './tool-support.js'

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

export function registerAutomationTools(
  rootCtx: Context,
  toolCtx: Context,
  agent: Agent,
  controller: AutomationController,
  agentConfiguration = new AgentConfiguration(rootCtx),
): () => void {
  const disposers = registerConfigurationTools(rootCtx, toolCtx, agent, controller, agentConfiguration)

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'automation_list',
    description: 'List durable automations and their current scheduling state.',
    parameters: {},
    output: { schema: LIST_SCHEMA, render },
    execute(_args, exec) {
      return executeTool('automation_list', agent, exec.agent, () => ({ ok: true as const, tasks: controller.list().map(summary) }))
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
    execute(args, exec) {
      return executeTool('automation_run', agent, exec.agent, async () => {
        const run = await controller.runNow(args.id)
        return { ok: true as const, id: run.id, status: run.status, message: `Queued manual run ${run.id} for ${args.id}.` }
      })
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
      execute(args, exec) {
        return executeTool(definition.name, agent, exec.agent, async () => {
          const result = await definition.execute(args.id)
          if (typeof result === 'boolean' && !result) throw new Error(`Automation ${args.id} was not found.`)
          return { ok: true as const, id: args.id, status: definition.name === 'automation_delete' ? 'deleted' : 'paused', message: `${definition.verb} ${args.id}.` }
        })
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
    execute(args, exec) {
      return executeTool('automation_resume', agent, exec.agent, async () => {
        const task = await controller.resume(args.id, { runNow: args.run_now ?? false })
        return { ok: true as const, id: task.id, status: task.status, message: `Resumed ${task.id}; next run ${task.nextRunAt}.` }
      })
    },
    presentCall: (args) => ({ card: 'generic', title: 'Resume automation', kind: 'other', rawInput: args.id }),
  })))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
