import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AutomationStore } from './store.js'
import { AutomationDomain } from './domain.js'
import { AutomationScheduler, DEFAULT_MAX_RUN_DURATION_MS, MAX_TIMER_DELAY_MS } from './scheduler.js'
import { DshAutomationRunner } from './runner.js'
import { AutomationController } from './controller.js'
import { registerAutomationTools } from './tools.js'
import { registerAutomationApi } from './api.js'
import { AgentConfiguration } from './agent-configuration.js'
import { unattendedAgents, pendingUnattendedSessionIds } from './runtime-marker.js'

import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-host-webserver'
import '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-permission-presets'
import '@deepseek-ai/dsh-session-title'
import '@deepseek-ai/dsh-workspace'
import '@deepseek-ai/dsh-skill'

export * from './types.js'
export * from './recurrence.js'
export * from './store.js'
export * from './domain.js'
export * from './scheduler.js'
export * from './controller.js'

export const name = 'automation'
export const inject = [
  'agents',
  'sessions',
  'tools',
  'agentPresets',
  'llm',
  'skills',
  'permissionPresets',
  'workspaceRegistry',
  'sessionTitle',
  'webServer',
]

export interface Config {
  readonly root?: string
  readonly maxRunHistory?: number
  readonly maxRunDurationMs?: number
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const root = resolve(config.root ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'automation'))
  const maxRunDurationMs = config.maxRunDurationMs ?? DEFAULT_MAX_RUN_DURATION_MS
  if (!Number.isSafeInteger(maxRunDurationMs) || maxRunDurationMs <= 0 || maxRunDurationMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`maxRunDurationMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`)
  }
  if (ctx.permissionPresets.names.length === 0) throw new Error('The Host exposes no permission presets.')
  ctx.permissionPresets.resolve(ctx.permissionPresets.defaultPreset)

  const store = new AutomationStore(join(root, 'state.json'))
  const domain = new AutomationDomain(store, config.maxRunHistory ?? 20)
  await domain.init(Date.now())
  const agentConfiguration = new AgentConfiguration(ctx)
  const runner = new DshAutomationRunner(ctx, agentConfiguration)
  const scheduler = new AutomationScheduler(domain, runner, undefined, (error) => {
    ctx.logger.error(`automation scheduler failed and will retry: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }, maxRunDurationMs)
  const controller = new AutomationController(domain, scheduler, undefined, agentConfiguration)
  const toolCleanups = new Map<Agent, () => void>()

  const installTools = (agent: Agent) => {
    if (agent.id.startsWith('automation-') || pendingUnattendedSessionIds.has(agent.id) || unattendedAgents.has(agent) || toolCleanups.has(agent)) return
    const dispose = registerAutomationTools(ctx, agent.ctx, agent, controller)
    toolCleanups.set(agent, dispose)
  }

  for (const agent of ctx.agents.roots()) installTools(agent)
  const stopCreated = ctx.on('agent/created', ({ agent }) => installTools(agent))
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
    toolCleanups.get(agent)?.()
    toolCleanups.delete(agent)
  })
  const stopApi = registerAutomationApi(ctx, controller)
  scheduler.start()

  ctx.effect(() => async () => {
    stopApi()
    stopCreated()
    stopDisposed()
    for (const dispose of toolCleanups.values()) dispose()
    toolCleanups.clear()
    await scheduler.stop()
  }, 'automation.lifecycle()')
}
