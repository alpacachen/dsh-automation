import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { unattendedAgents } from './runtime-marker.js'

export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: false },
    error: { type: 'string', required: true },
  },
} as const

export const ACTION_SCHEMA = {
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

export function render(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

export function workspaceDirectory(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('The current session has no workspace directory.')
  return cwd
}

/** Guard borrowed live Agents too: their installed tools must stay unavailable during unattended runs. */
export async function executeTool<T>(name: string, owner: Agent, caller: Agent | undefined, action: () => T | Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    if (unattendedAgents.has(owner)) throw new Error('Automation tools are unavailable during an unattended run.')
    if (caller !== owner) throw new Error(`${name} must run in its owning agent scope.`)
    return await action()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
