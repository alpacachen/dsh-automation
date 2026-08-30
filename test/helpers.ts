import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationExecution, AutomationSchedule, CreateAutomationRequest } from '../src/types.js'

export async function temporaryDirectory(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-automation-test-'))
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}

export const execution: AutomationExecution = {
  workspaceId: 'workspace-test',
  cwd: '/tmp/test-workspace',
  agentPreset: 'standard',
  provider: 'test-provider',
  model: 'test-model',
}

export function createRequest(schedule: AutomationSchedule, name = 'Test automation'): CreateAutomationRequest {
  return {
    name,
    prompt: 'Perform the test task and report the result.',
    schedule,
    execution,
    createdBySessionId: 'session-creator',
  }
}

export async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}
