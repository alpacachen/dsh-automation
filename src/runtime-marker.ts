import type { Agent } from '@deepseek-ai/dsh-agent'

export const unattendedAgents = new WeakSet<Agent>()
export const pendingUnattendedSessionIds = new Set<string>()
