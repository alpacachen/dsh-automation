import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { deliveryOptions, sendAutomationResult, validateDelivery } from '../src/im-delivery.js'
import type { AutomationRun, AutomationTask } from '../src/types.js'

const destination = { botId: 'bot-test', targetId: 'daily-report' }
const task = { name: 'Daily report', delivery: destination } as AutomationTask
const run = { id: 'run-test' } as AutomationRun

function service() {
  const sends: unknown[][] = []
  return {
    sends,
    async listBots() { return [{ botId: destination.botId, channel: 'telegram', token: 'must-not-leak' }] },
    async listTargets() { return [{ targetId: destination.targetId, name: 'My phone', kind: 'chat', route: { privateId: 'must-not-leak' } }] },
    async send(...args: unknown[]) { sends.push(args); return { sent: true } },
  }
}

test('optional Cordis delivery service discovers only public bot/target labels', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  assert.deepEqual(await deliveryOptions(ctx), { available: false, bots: [], targets: [] })
  await assert.rejects(validateDelivery(ctx, destination), /unavailable/)
  const im = service()
  ctx.provide('dshIm', im)
  assert.deepEqual(await deliveryOptions(ctx), { available: true, bots: [{ botId: 'bot-test', channel: 'telegram' }], targets: [] })
  assert.deepEqual((await deliveryOptions(ctx, destination.botId)).targets, [{ targetId: 'daily-report', name: 'My phone', kind: 'chat' }])
  await validateDelivery(ctx, destination)
  await assert.rejects(validateDelivery(ctx, { ...destination, botId: 'different-bot' }), /bot.*available/)
  await assert.rejects(validateDelivery(ctx, { ...destination, targetId: 'unknown' }), /saved target/)
  assert.equal(im.sends.length, 0, 'Discovery and validation never send a test message')
})

test('a deleted saved bot leaves other bots discoverable while saving it still fails', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const im = service()
  let targetReads = 0
  const listTargets = im.listTargets
  im.listTargets = async () => { targetReads++; return listTargets() }
  ctx.provide('dshIm', im)
  assert.deepEqual(await deliveryOptions(ctx, 'deleted-bot'), {
    available: true, bots: [{ botId: 'bot-test', channel: 'telegram' }], targets: [],
  })
  await assert.rejects(validateDelivery(ctx, { ...destination, botId: 'deleted-bot' }), /bot.*available/)
  assert.equal(targetReads, 0, 'Do not ask dsh-im for targets of a removed bot')
  assert.equal((await deliveryOptions(ctx, destination.botId)).targets[0]?.targetId, destination.targetId)
  await validateDelivery(ctx, destination)
  assert.equal(im.sends.length, 0)
})

test('direct send uses configured IDs and full output without requiring a Session or sync', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const im = service()
  ctx.provide('dshIm', im)
  const signal = new AbortController().signal
  const output = `first line\n${'full reply '.repeat(120)}`
  await sendAutomationResult(ctx, task, run, { status: 'succeeded', output, summary: 'short summary' }, signal)
  assert.deepEqual(im.sends[0]?.slice(0, 2), ['bot-test', 'daily-report'])
  assert.equal(im.sends[0]?.[2], `[Automation] Daily report\nStatus: succeeded\n\n${output.trim()}`)
  assert.deepEqual(im.sends[0]?.[3], { signal })
  await sendAutomationResult(ctx, task, run, { status: 'failed', error: 'Model unavailable' }, signal)
  assert.match(String(im.sends[1]?.[2]), /Status: failed\n\nError: Model unavailable/)
})

test('missing/offline/rejected/canceled service calls surface without hidden retry', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const outcome = { status: 'succeeded' as const }
  const signal = new AbortController().signal
  await assert.rejects(sendAutomationResult(ctx, task, run, outcome, signal), /unavailable/)
  const im = service()
  ctx.provide('dshIm', im)
  im.send = async () => { throw new Error('bot-not-connected') }
  await assert.rejects(sendAutomationResult(ctx, task, run, outcome, signal), /bot-not-connected/)
  im.send = async () => ({ sent: false })
  await assert.rejects(sendAutomationResult(ctx, task, run, outcome, signal), /platform acceptance/)
  await assert.rejects(sendAutomationResult(ctx, { ...task, delivery: undefined }, run, outcome, signal), /No message delivery/)
  const canceled = new AbortController()
  canceled.abort(new Error('Stop delivery'))
  await assert.rejects(sendAutomationResult(ctx, task, run, outcome, canceled.signal), /Stop delivery/)
  im.listBots = async () => { throw new Error('Discovery unavailable') }
  await assert.rejects(deliveryOptions(ctx), /Discovery unavailable/)
})
