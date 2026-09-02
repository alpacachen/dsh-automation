import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AutomationStateSchema, emptyAutomationState, type AutomationState } from './types.js'

export type AtomicWriter = (path: string, content: string) => Promise<void>

export async function writeJsonAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${path.split('/').at(-1) ?? 'state'}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export class AutomationStore {
  private state: AutomationState | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(
    readonly path: string,
    private readonly writer: AtomicWriter = writeJsonAtomic,
  ) {}

  async init(): Promise<void> {
    if (this.state !== undefined) return
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = emptyAutomationState()
      return
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Automation state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = AutomationStateSchema.safeParse(value)
    if (!parsed.success) throw new Error(`Automation state is invalid: ${parsed.error.message}`)
    this.state = normalizeState(parsed.data)
  }

  snapshot(): AutomationState {
    if (this.state === undefined) throw new Error('AutomationStore.init() must complete before use.')
    return structuredClone(this.state)
  }

  mutate<T>(operation: (draft: AutomationState) => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.state === undefined) throw new Error('AutomationStore.init() must complete before use.')
      const draft = structuredClone(this.state)
      const result = await operation(draft)
      draft.revision = this.state.revision + 1
      const validated = AutomationStateSchema.parse(draft)
      await this.writer(this.path, `${JSON.stringify(validated, null, 2)}\n`)
      this.state = validated
      return result
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

function normalizeState(state: AutomationState): AutomationState {
  for (const task of Object.values(state.tasks)) {
    task.execution.target ??= { mode: 'fresh' }
    for (const run of task.runs) run.executionTarget ??= { mode: 'fresh' }
  }
  return state
}
