import type { Context } from '@deepseek-ai/cordis'
import type { AutomationDelivery, AutomationDeliveryOptions, AutomationRun, AutomationTask } from './types.js'
import type { RunOutcome } from './domain.js'

// Public dsh-im Host API. It is optional: Automation still works without dsh-im.
// Only public identifiers are projected; platform routes and credentials never
// cross the Automation API boundary.
interface DshImService {
  listBots(): Promise<readonly { botId: string; channel: string }[]>
  listTargets(botId: string): Promise<readonly { targetId: string; name?: string; kind: string }[]>
  send(
    botId: string,
    targetId: string,
    text: string,
    options?: { signal?: AbortSignal; format?: 'plain' | 'markdown' },
  ): Promise<{ sent: boolean }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshIm: DshImService
  }
}

function service(ctx: Context): DshImService | undefined {
  const value = ctx.get('dshIm')
  return value !== undefined &&
    typeof value.listBots === 'function' &&
    typeof value.listTargets === 'function' &&
    typeof value.send === 'function'
    ? value
    : undefined
}

export async function deliveryOptions(ctx: Context, botId?: string): Promise<AutomationDeliveryOptions> {
  const im = service(ctx)
  if (im === undefined) return { available: false, bots: [], targets: [] }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const bots = (await im.listBots()).map(({ botId, channel }) => ({ botId, channel }))
        // Keep other bots selectable when a previously saved bot was removed.
        const targets =
          botId === undefined || !bots.some((bot) => bot.botId === botId)
            ? []
            : (await im.listTargets(botId)).map(({ targetId, name, kind }) => ({
                targetId,
                kind,
                ...(name === undefined ? {} : { name }),
              }))
        return { available: true, bots, targets }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('dsh-im target discovery timed out. Try again.')), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function validateDelivery(ctx: Context, delivery: AutomationDelivery): Promise<void> {
  const options = await deliveryOptions(ctx, delivery.botId)
  if (!options.available) throw new Error('dsh-im direct delivery is unavailable on this Host.')
  if (!options.bots.some((bot) => bot.botId === delivery.botId))
    throw new Error('The selected dsh-im bot is no longer available.')
  if (!options.targets.some((target) => target.targetId === delivery.targetId))
    throw new Error('Select a saved target belonging to the selected dsh-im bot.')
}

export async function sendAutomationResult(
  ctx: Context,
  task: AutomationTask,
  _run: AutomationRun,
  outcome: RunOutcome,
  signal: AbortSignal,
): Promise<void> {
  const im = service(ctx)
  if (im === undefined) throw new Error('dsh-im direct delivery is unavailable on this Host.')
  if (task.delivery === undefined) throw new Error('No message delivery destination was configured.')
  signal.throwIfAborted()
  const text = [
    `[Automation] ${task.name}`,
    `Status: ${outcome.status}`,
    '',
    outcome.output?.trim() ||
      outcome.summary?.trim() ||
      (outcome.status === 'succeeded' ? 'Task completed without a text reply.' : ''),
    ...(outcome.error === undefined ? [] : [`Error: ${outcome.error}`]),
  ]
    .filter((line, index) => line !== '' || index === 2)
    .join('\n')
  const result = await im.send(task.delivery.botId, task.delivery.targetId, text, { signal, format: 'markdown' })
  if (result.sent !== true)
    throw new Error('dsh-im did not confirm platform acceptance. Delivery will not be retried automatically.')
}
