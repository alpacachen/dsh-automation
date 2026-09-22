import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { AgentConfiguration } from '../src/agent-configuration.js'
import { execution } from './helpers.js'

function context() {
  const skills = {
    report: { name: 'report', description: 'Write a report.', invocation: { userInvocable: true, modelInvocable: true }, source: 'project-dsh', provider: 'files', content: 'Report.' },
    hidden: { name: 'hidden', description: 'Hidden.', invocation: { userInvocable: false, modelInvocable: true }, source: 'runtime', provider: 'runtime', content: 'Hidden.' },
  } as const
  return {
    agentPresets: {
      defaultId: 'standard',
      async list() { return [{ id: 'standard', name: 'Standard', trust: 'system', path: '/standard' }, { id: 'broken', trust: 'user', path: '/broken', broken: 'bad yaml' }] },
      async resolve(id = 'standard') {
        const preset = (await this.list()).find((entry) => entry.id === id)
        if (preset === undefined) throw new Error(`Unknown preset ${id}`)
        return preset
      },
      async standingKeyFor(id = 'standard') {
        const preset = await this.resolve(id)
        if (preset.broken !== undefined) throw new Error(preset.broken)
        return { id }
      },
      serviceFor() { return undefined },
    },
    llm: {
      listProviders: () => [{ id: 'good', name: 'Good' }, { id: 'down', name: 'Down' }],
      async listModels(provider: string) {
        if (provider === 'down') throw new Error('catalog offline')
        return [{ provider, id: 'listed', name: 'Listed' }]
      },
      async resolveModelInfo(provider: string, model: string) { return { provider, model } },
      async resolveCallConfig(config: { provider: string; model: string }) {
        if (config.provider !== 'good') throw new Error(`Unknown provider ${config.provider}`)
        return config
      },
    },
    permissionPresets: {
      names: ['workspace-safe', 'trusted'],
      defaultPreset: 'workspace-safe',
      optionOf: (id: string) => ({ value: id, name: id === 'trusted' ? 'Trusted' : 'Workspace safe' }),
      resolve(id: string) {
        if (!this.names.includes(id)) throw new Error(`Unknown permission ${id}`)
        return id === 'trusted'
          ? { sandbox: 'danger-full-access', approval: 'never' }
          : { sandbox: 'workspace-write', approval: 'ask' }
      },
    },
    skills: {
      async list() { return Object.values(skills) },
      async get(name: string) { return skills[name as keyof typeof skills] },
    },
  } as unknown as Context
}

test('reasoning discovery resolves only the candidate route and preserves opaque Host metadata', async () => {
  const ctx = context()
  const calls: string[][] = []
  ctx.llm.resolveModelInfo = async (provider, model) => {
    calls.push([provider, model])
    if (model === 'broken') throw new Error('metadata offline')
    return {
      provider, id: model, name: model,
      ...(model === 'plain' ? {} : { reasoning: { efforts: [{ id: 'vendor: auto' as any, name: 'Adaptive', description: 'Vendor controlled' }, { id: 'disabled' as any, name: 'Disabled' }], defaultEffort: 'vendor: auto' as any } }),
    }
  }
  const config = new AgentConfiguration(ctx)
  assert.equal((await config.options('/w')).reasoning, undefined)
  assert.equal((await config.options('/w', undefined, '', '')).reasoning, undefined)
  assert.deepEqual(calls, [])
  assert.deepEqual((await config.options('/w', undefined, 'good', 'unlisted')).reasoning, {
    provider: 'good', model: 'unlisted', efforts: [{ id: 'vendor: auto', name: 'Adaptive', description: 'Vendor controlled' }, { id: 'disabled', name: 'Disabled' }], defaultEffort: 'vendor: auto',
  })
  assert.deepEqual((await config.options('/w', undefined, 'good', 'plain')).reasoning, { provider: 'good', model: 'plain', efforts: [] })
  assert.deepEqual((await config.options('/w', undefined, 'good', 'broken')).reasoning, { provider: 'good', model: 'broken', efforts: [], error: 'metadata offline' })
  assert.deepEqual(calls, [['good', 'unlisted'], ['good', 'plain'], ['good', 'broken']])
  await assert.rejects(config.options('/w', undefined, 'good'), /set together/)
})

test('reasoning validation delegates exact ids to Host and ignores pinned overrides', async () => {
  const ctx = context()
  const calls: unknown[] = []
  ctx.llm.resolveCallConfig = async (config) => {
    calls.push(config)
    if (config.reasoningEffort !== undefined && config.reasoningEffort !== 'vendor: auto') throw new Error('UNSUPPORTED_REASONING_EFFORT')
    return config
  }
  const config = new AgentConfiguration(ctx)
  const chosen = { ...execution, provider: 'good', model: 'unlisted', reasoningEffort: 'vendor: auto' }
  await config.validate(chosen, 'workspace-safe')
  assert.deepEqual(calls, [{ provider: 'good', model: 'unlisted', reasoningEffort: 'vendor: auto' }])
  await assert.rejects(config.validate({ ...chosen, reasoningEffort: 'auto' }, 'workspace-safe'), /UNSUPPORTED_REASONING_EFFORT/)
  await assert.rejects(config.validate({ ...chosen, provider: undefined, model: undefined }, 'workspace-safe'), /requires an explicit provider and model/)
  await assert.rejects(config.validate({ ...chosen, model: undefined }, 'workspace-safe', { allowLegacyPartialModel: true }), /requires an explicit provider and model/)
  await assert.rejects(config.validate({ ...chosen, reasoningEffort: '' }, 'workspace-safe'), /non-empty/)
  const before = calls.length
  await config.validate({ ...chosen, agentPreset: 'missing', reasoningEffort: 'unsupported', skills: ['missing'], target: { mode: 'pinned-session', sessionId: 's', workspaceId: chosen.workspaceId, cwd: chosen.cwd, fallback: 'fail' } }, 'workspace-safe')
  assert.equal(calls.length, before)
})

test('Host options preserve partial model failures and dynamic permission metadata', async () => {
  const options = await new AgentConfiguration(context()).options('/tmp/workspace')
  assert.deepEqual(options.models.map((entry) => entry.provider), ['good'])
  assert.deepEqual(options.modelFailures, [{ provider: 'down', error: 'catalog offline' }])
  assert.deepEqual(options.permissions.map((entry) => [entry.id, entry.sandbox, entry.approval]), [
    ['workspace-safe', 'workspace-write', 'ask'],
    ['trusted', 'danger-full-access', 'never'],
  ])
  assert.deepEqual(options.skills.map((entry) => entry.name), ['report'])
  assert.equal(options.presets.find((entry) => entry.id === 'broken')?.broken, 'bad yaml')
})

test('validation is fail-closed but accepts advisory-unlisted resolvable models and Host permission ids', async () => {
  const configuration = new AgentConfiguration(context())
  await configuration.validate({ ...execution, provider: 'good', model: 'unlisted', skills: ['report'] }, 'workspace-safe')
  await assert.rejects(() => configuration.validate({ ...execution, model: undefined }, 'workspace-safe'), /set together/)
  await configuration.validate({ ...execution, model: undefined }, 'workspace-safe', { allowLegacyPartialModel: true })
  await assert.rejects(() => configuration.validate({ ...execution, agentPreset: 'missing' }, 'workspace-safe'), /Unknown preset/)
  await assert.rejects(() => configuration.validate({ ...execution, agentPreset: 'broken' }, 'workspace-safe'), /bad yaml/)
  await assert.rejects(() => configuration.validate({ ...execution, provider: 'missing', model: 'model' }, 'workspace-safe'), /Unknown provider/)
  await assert.rejects(() => configuration.validate({ ...execution, provider: 'good', model: 'model', skills: ['missing'] }, 'workspace-safe'), /unavailable/)
  await assert.rejects(() => configuration.validate({ ...execution, provider: 'good', model: 'model', skills: ['hidden'] }, 'workspace-safe'), /not user-invocable/)
  await assert.rejects(() => configuration.validate({ ...execution, provider: 'good', model: 'model' }, 'missing'), /Unknown permission/)
})

test('selected skill loading returns canonical content and invocation metadata', async () => {
  const loaded = await new AgentConfiguration(context()).loadSelectedSkills(
    { ctx: {} } as any,
    { execution: { cwd: '/tmp/workspace', skills: ['report'] } } as any,
  )
  assert.match(loaded[0]!.text, /<skill_content[^>]+name="report"/)
  assert.deepEqual(loaded[0]!.source, { kind: 'skill-invocation', name: 'report', form: 'instructions' })
})
