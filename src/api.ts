import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AutomationController } from './controller.js'
import { AutomationPermissionPresetSchema, AutomationScheduleSchema, NotificationPolicySchema, NotificationTargetSchema, type AutomationExecutionTarget, type UpdateAutomationRequest } from './types.js'

import '@deepseek-ai/dsh-host-webserver'

const API_ROOT = '/api/automation/v1'
const MAX_BODY_BYTES = 16 * 1024

function send(res: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Request body must be a JSON object.')
  return value as Record<string, unknown>
}

function parseUpdate(body: Record<string, unknown>, currentPermission: string): UpdateAutomationRequest {
  if (Object.keys(body).some((key) => !['name', 'prompt', 'schedule', 'notificationPolicy', 'notificationTarget', 'pauseAfterConsecutiveFailures', 'permissionPreset', 'confirmPermissionChange', 'execution', 'confirmSessionTargetChange'].includes(key))) {
    throw new Error('Update body contains an unknown field.')
  }
  if (body.name !== undefined && typeof body.name !== 'string') throw new Error('name must be a string.')
  if (body.prompt !== undefined && typeof body.prompt !== 'string') throw new Error('prompt must be a string.')
  if (body.pauseAfterConsecutiveFailures !== undefined && typeof body.pauseAfterConsecutiveFailures !== 'boolean') {
    throw new Error('pauseAfterConsecutiveFailures must be boolean.')
  }
  const schedule = body.schedule === undefined ? undefined : AutomationScheduleSchema.parse(body.schedule)
  const notificationPolicy = body.notificationPolicy === undefined ? undefined : NotificationPolicySchema.parse(body.notificationPolicy)
  const notificationTarget = body.notificationTarget === null ? null : body.notificationTarget === undefined ? undefined : NotificationTargetSchema.parse(body.notificationTarget)
  const permissionPreset = body.permissionPreset === undefined ? undefined : AutomationPermissionPresetSchema.parse(body.permissionPreset)
  if (permissionPreset !== undefined && permissionPreset !== currentPermission && body.confirmPermissionChange !== true) {
    throw new Error('confirmPermissionChange must be true when changing permissions.')
  }
  const execution = parseExecutionPatch(body.execution)
  if (execution?.target !== undefined) throw new Error('Pinned session target changes are unsupported via REST in MVP.')
  return {
    ...(body.name === undefined ? {} : { name: body.name as string }),
    ...(body.prompt === undefined ? {} : { prompt: body.prompt as string }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(notificationPolicy === undefined ? {} : { notificationPolicy }),
    ...(notificationTarget === undefined ? {} : { notificationTarget }),
    ...(body.pauseAfterConsecutiveFailures === undefined ? {} : { pauseAfterConsecutiveFailures: body.pauseAfterConsecutiveFailures as boolean }),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    ...(permissionPreset === undefined || body.confirmPermissionChange !== true ? {} : { permissionChangeConfirmed: true as const }),
    ...(execution === undefined ? {} : { execution }),
  }
}

function parseExecutionPatch(value: unknown): UpdateAutomationRequest['execution'] {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('execution must be an object.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length === 0) throw new Error('execution must contain at least one field.')
  if (Object.keys(input).some((key) => !['agentPreset', 'provider', 'model', 'skills', 'target'].includes(key))) {
    throw new Error('execution contains an unknown field.')
  }
  const nullableString = (key: 'agentPreset' | 'provider' | 'model') => {
    const entry = input[key]
    if (entry !== undefined && entry !== null && typeof entry !== 'string') throw new Error(`execution.${key} must be a string or null.`)
    if (typeof entry === 'string' && !entry.trim()) throw new Error(`execution.${key} must not be empty.`)
    return entry as string | null | undefined
  }
  const agentPreset = nullableString('agentPreset')
  const provider = nullableString('provider')
  const model = nullableString('model')
  if ((provider === undefined) !== (model === undefined) || (provider !== undefined && ((provider === null) !== (model === null)))) {
    throw new Error('execution.provider and execution.model must be set or cleared together.')
  }
  if (input.skills !== undefined && (!Array.isArray(input.skills) || input.skills.some((name) => typeof name !== 'string'))) {
    throw new Error('execution.skills must be an array of strings.')
  }
  const skills = input.skills as string[] | undefined
  let target: AutomationExecutionTarget | undefined
  if (input.target !== undefined) {
    if (typeof input.target !== 'object' || input.target === null || Array.isArray(input.target)) throw new Error('execution.target must be an object.')
    const value = input.target as Record<string, unknown>
    if (value.mode === 'fresh') target = { mode: 'fresh' as const }
    else if (value.mode === 'pinned-session' && typeof value.sessionId === 'string' && typeof value.workspaceId === 'string' && typeof value.cwd === 'string' && value.fallback === 'fail') target = { mode: 'pinned-session' as const, sessionId: value.sessionId, workspaceId: value.workspaceId, cwd: value.cwd, fallback: 'fail' as const }
    else throw new Error('execution.target is invalid.')
  }
  return {
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(skills === undefined ? {} : { skills }),
    ...(target === undefined ? {} : { target, sessionTargetConfirmed: true as const }),
  }
}

export function registerAutomationApi(ctx: Context, controller: AutomationController): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: API_ROOT,
    async handler(req, res) {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'Cross-origin requests are not allowed.' })
        return
      }
      if (req.method !== 'GET' && req.headers['x-dsh-automation'] !== '1') {
        send(res, 403, { error: 'Missing Automation request header.' })
        return
      }
      const url = new URL(req.url ?? API_ROOT, 'http://localhost')
      const suffix = url.pathname.slice(API_ROOT.length)
      try {
        if (req.method === 'POST' && suffix === '/notifications/read') {
          await controller.markNotificationsRead()
          send(res, 200, { read: true })
          return
        }
        if (req.method === 'GET' && (suffix === '' || suffix === '/tasks')) {
          send(res, 200, { tasks: controller.list(), scheduler: controller.schedulerHealth() })
          return
        }
        if (req.method === 'GET' && suffix === '/notification-options') {
          send(res, 200, await controller.notificationOptions())
          return
        }
        const match = /^\/tasks\/([^/]+)(?:\/(run|pause|resume|stop|options))?$/.exec(suffix)
        if (match === null) {
          send(res, 404, { error: 'Automation API route not found.' })
          return
        }
        const id = decodeURIComponent(match[1]!)
        const action = match[2]
        if (req.method === 'GET' && action === 'options') {
          const candidate = url.searchParams.has('agentPreset') ? url.searchParams.get('agentPreset') || null : undefined
          send(res, 200, { options: await controller.options(id, candidate) })
          return
        }
        if (req.method === 'PATCH' && action === undefined) {
          send(res, 200, { task: await controller.update(id, parseUpdate(await readJson(req), controller.get(id).security.permissionPreset)) })
          return
        }
        if (req.method === 'DELETE' && action === undefined) {
          const deleted = await controller.delete(id)
          send(res, deleted ? 200 : 404, { deleted })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: 'Method not allowed.' })
          return
        }
        if (action === 'run') {
          send(res, 202, { run: await controller.runNow(id) })
          return
        }
        if (action === 'stop') {
          send(res, 202, await controller.stop(id))
          return
        }
        if (action === 'pause') {
          send(res, 200, { task: await controller.pause(id) })
          return
        }
        if (action === 'resume') {
          const body = await readJson(req)
          if (body.runNow !== undefined && typeof body.runNow !== 'boolean') throw new Error('runNow must be boolean.')
          send(res, 200, { task: await controller.resume(id, { runNow: body.runNow === true }) })
          return
        }
        send(res, 404, { error: 'Automation API route not found.' })
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
