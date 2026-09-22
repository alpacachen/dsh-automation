import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { standingMountFor } from '@deepseek-ai/dsh-agent-presets'
import { isUserInvocable, renderSkillContent, type SkillSummary } from '@deepseek-ai/dsh-skill'
import { assertProviderModelPair, validateReasoningExecution } from './validation.js'
import type { AgentConfigurationOptions, AutomationExecution, AutomationTask } from './types.js'

import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-permission-presets'
import '@deepseek-ai/dsh-skill'

export class AgentConfiguration {
  constructor(readonly ctx: Context) {}

  async options(cwd: string, agentPreset?: string, provider?: string, model?: string): Promise<AgentConfigurationOptions> {
    assertProviderModelPair(provider, model)
    let reasoning: AgentConfigurationOptions['reasoning']
    if (provider && model) {
      try {
        const info = await this.ctx.llm.resolveModelInfo(provider, model)
        reasoning = {
          provider, model,
          efforts: info.reasoning?.efforts.map(({ id, name, description }) => ({ id, name, ...(description === undefined ? {} : { description }) })) ?? [],
          ...(info.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
        }
      } catch (error) {
        reasoning = { provider, model, efforts: [], error: message(error) }
      }
    }
    const presets = await this.ctx.agentPresets.list()
    const providers = this.ctx.llm.listProviders()
    const modelResults = await Promise.all(providers.map(async (provider) => {
      try {
        const models = await this.ctx.llm.listModels(provider.id)
        return { provider, models }
      } catch (error) {
        return { provider, error: message(error) }
      }
    }))
    let skills: SkillSummary[] = []
    const candidatePreset = presets.find((preset) => preset.id === (agentPreset ?? this.ctx.agentPresets.defaultId))
    if (candidatePreset !== undefined && candidatePreset.broken === undefined) {
      const scope = await this.ctx.agentPresets.standingKeyFor(agentPreset)
      skills = (await this.ctx.skills.list({ cwd, scope })).filter(isUserInvocable)
    }
    return {
      ...(reasoning === undefined ? {} : { reasoning }),
      presets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name ?? preset.id,
        ...(preset.description === undefined ? {} : { description: preset.description }),
        trust: preset.trust,
        ...(preset.broken === undefined ? {} : { broken: preset.broken }),
        default: preset.id === this.ctx.agentPresets.defaultId,
      })),
      models: modelResults.flatMap((result) => result.models === undefined ? [] : [{
        provider: result.provider.id,
        name: result.provider.name,
        models: result.models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
        })),
      }]),
      modelFailures: modelResults.flatMap((result) => result.error === undefined ? [] : [{ provider: result.provider.id, error: result.error }]),
      permissions: this.ctx.permissionPresets.names.map((id) => {
        const option = this.ctx.permissionPresets.optionOf(id)
        const preset = this.ctx.permissionPresets.resolve(id)
        return {
          id,
          name: option.name,
          ...(option.description === undefined ? {} : { description: option.description }),
          sandbox: preset.sandbox,
          approval: preset.approval,
          default: id === this.ctx.permissionPresets.defaultPreset,
        }
      }),
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        modelInvocable: skill.invocation.modelInvocable,
        source: skill.source,
        provider: skill.provider,
      })),
    }
  }

  permissionName(permissionPreset: string): string | undefined {
    if (!this.ctx.permissionPresets.names.includes(permissionPreset)) return undefined
    return this.ctx.permissionPresets.optionOf(permissionPreset).name
  }

  async validate(
    execution: Omit<AutomationExecution, 'target'> & { target?: AutomationExecution['target'] },
    permissionPreset: string,
    options: { readonly allowLegacyPartialModel?: boolean } = {},
  ): Promise<void> {
    if (execution.target?.mode === 'pinned-session') {
      execution = { ...execution, agentPreset: undefined, provider: undefined, model: undefined, reasoningEffort: undefined, skills: [] }
    }
    const preset = await this.ctx.agentPresets.resolve(execution.agentPreset)
    if (preset.broken !== undefined) throw new Error(`Agent preset ${preset.id} is unavailable: ${preset.broken}`)
    assertProviderModelPair(execution.provider, execution.model, { allowLegacyPartialModel: options.allowLegacyPartialModel === true })
    validateReasoningExecution(execution)
    if (execution.provider !== undefined && execution.model !== undefined) {
      await this.ctx.llm.resolveCallConfig({
        provider: execution.provider, model: execution.model,
        ...(execution.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(execution.reasoningEffort) }),
      })
    }
    const scope = await this.ctx.agentPresets.standingKeyFor(execution.agentPreset)
    for (const name of execution.skills) {
      const skill = await this.ctx.skills.get(name, { cwd: execution.cwd, scope })
      if (skill === undefined) throw new Error(`Selected skill ${name} is unavailable.`)
      if (!isUserInvocable(skill)) throw new Error(`Selected skill ${name} is not user-invocable.`)
    }
    this.ctx.permissionPresets.resolve(permissionPreset)
  }

  async loadSelectedSkills(agent: Agent, task: AutomationTask): Promise<readonly { text: string; source: { kind: 'skill-invocation'; name: string; form: 'instructions' } }[]> {
    if (task.execution.skills.length === 0) return []
    const skills = this.ctx.agentPresets.serviceFor(agent, 'skills') ?? this.ctx.skills
    const scope = standingMountFor(agent.ctx)?.key
    const loaded = []
    for (const name of task.execution.skills) {
      const skill = await skills.get(name, { cwd: task.execution.cwd, scope })
      if (skill === undefined) throw new Error(`Selected skill ${name} is unavailable.`)
      if (!isUserInvocable(skill)) throw new Error(`Selected skill ${name} is not user-invocable.`)
      loaded.push({
        text: renderSkillContent(skill),
        source: { kind: 'skill-invocation' as const, name, form: 'instructions' as const },
      })
    }
    return loaded
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
