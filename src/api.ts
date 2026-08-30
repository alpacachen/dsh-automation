import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AutomationController } from './controller.js'
import { AutomationScheduleSchema, type UpdateAutomationRequest } from './types.js'

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

function parseUpdate(body: Record<string, unknown>): UpdateAutomationRequest {
  if (Object.keys(body).some((key) => key !== 'name' && key !== 'prompt' && key !== 'schedule')) {
    throw new Error('Update body contains an unknown field.')
  }
  if (body.name !== undefined && typeof body.name !== 'string') throw new Error('name must be a string.')
  if (body.prompt !== undefined && typeof body.prompt !== 'string') throw new Error('prompt must be a string.')
  const schedule = body.schedule === undefined ? undefined : AutomationScheduleSchema.parse(body.schedule)
  return {
    ...(body.name === undefined ? {} : { name: body.name as string }),
    ...(body.prompt === undefined ? {} : { prompt: body.prompt as string }),
    ...(schedule === undefined ? {} : { schedule }),
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
        if (req.method === 'GET' && (suffix === '' || suffix === '/tasks')) {
          send(res, 200, { tasks: controller.list() })
          return
        }
        const match = /^\/tasks\/([^/]+)(?:\/(run|pause|resume))?$/.exec(suffix)
        if (match === null) {
          send(res, 404, { error: 'Automation API route not found.' })
          return
        }
        const id = decodeURIComponent(match[1]!)
        const action = match[2]
        if (req.method === 'PATCH' && action === undefined) {
          send(res, 200, { task: await controller.update(id, parseUpdate(await readJson(req))) })
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
