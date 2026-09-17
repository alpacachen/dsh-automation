import type { AutomationExecution, AutomationExecutionPatch } from './types.js'

/**
 * Single source of truth for Automation validation rules.
 *
 * Every entry point that accepts automation configuration — the Agent tools
 * (`tools.ts`), the HTTP API (`api.ts`), the domain (`domain.ts`), and the
 * runtime validator (`agent-configuration.ts`) — delegates the shared rules
 * here so a rule change needs exactly one edit.
 */

/** Trim, reject empties, and reject duplicates among skill names. */
export function normalizeSkills(skills: readonly string[]): string[] {
  const normalized = skills.map((name) => name.trim())
  if (normalized.some((name) => !name)) throw new Error('Skill names must not be empty.')
  if (new Set(normalized).size !== normalized.length) throw new Error('Skill names must be unique.')
  return normalized
}

/**
 * provider and model must be supplied together, cleared together, and never
 * partially nulled. `allowLegacyPartialModel` tolerates a pre-existing
 * half-set pair when neither field is being touched by the caller.
 */
export function assertProviderModelPair(
  provider: string | null | undefined,
  model: string | null | undefined,
  options: { readonly allowLegacyPartialModel?: boolean } = {},
): void {
  const providerSupplied = provider !== undefined
  const modelSupplied = model !== undefined
  if (providerSupplied !== modelSupplied) {
    if (options.allowLegacyPartialModel === true) return
    throw new Error('provider and model must be set together.')
  }
  if (providerSupplied && (provider === null) !== (model === null)) {
    throw new Error('provider and model must be set or cleared together.')
  }
}

/** Execution override ids (agentPreset/provider/model) must not be empty strings. */
export function assertOverrideId(value: string | null | undefined, label: string): void {
  if (typeof value === 'string' && !value.trim()) throw new Error(`${label} must not be empty.`)
}

/** Validate an execution patch without mutating anything. */
export function validateExecutionPatch(patch: AutomationExecutionPatch): void {
  assertProviderModelPair(patch.provider, patch.model)
  for (const value of [patch.agentPreset, patch.provider, patch.model]) {
    if (typeof value === 'string' && !value.trim()) throw new Error('Execution override ids must not be empty.')
  }
  if (patch.skills !== undefined) normalizeSkills(patch.skills)
}

/** Merge an execution patch onto the current execution, preserving trim/null semantics. */
export function applyExecutionPatch(
  current: AutomationExecution,
  patch: AutomationExecutionPatch | undefined,
): AutomationExecution {
  if (patch === undefined) return current
  const next: AutomationExecution = {
    ...current,
    ...(patch.target === undefined ? {} : { target: patch.target }),
    ...(patch.skills === undefined ? {} : { skills: normalizeSkills(patch.skills) }),
  }
  for (const key of ['agentPreset', 'provider', 'model'] as const) {
    if (patch[key] === undefined) continue
    if (patch[key] === null) delete next[key]
    else next[key] = patch[key].trim()
  }
  return next
}

/** A pinned session target requires explicit confirmation and a matching workspace/cwd. */
export function validateTarget(execution: AutomationExecution, confirmed: boolean): void {
  const target = execution.target ?? { mode: 'fresh' as const }
  if (target.mode !== 'pinned-session') return
  if (!confirmed) throw new Error('Explicit user confirmation is required for a pinned session target.')
  if (target.workspaceId !== execution.workspaceId || target.cwd !== execution.cwd) {
    throw new Error('Pinned session target workspace and cwd must match execution settings.')
  }
}
