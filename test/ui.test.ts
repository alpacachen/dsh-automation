import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const clientDir = new URL('../src/client/', import.meta.url)
const cssUrl = new URL('styles.css', clientDir)

/** Every client module concatenated: the UI is split across modules, so these
 *  are contract checks on the client surface as a whole, not on one file. */
async function readClient(): Promise<string> {
  const names = (await readdir(clientDir)).filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
  const sources = await Promise.all(names.map((name) => readFile(new URL(name, clientDir), 'utf8')))
  return sources.join('\n')
}

test('stylesheet themes entirely through DSH tokens', async () => {
  const css = await readFile(cssUrl, 'utf8')

  // The redesign's core styling rule: no literal colors, so the plugin tracks
  // the host theme (including dark mode) instead of drifting from it.
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? []
  assert.deepEqual(literals, [], `stylesheet must use tokens, found literal colors: ${literals.join(', ')}`)

  // Undefined custom properties fail silently at computed-value time and take
  // the whole declaration with them, so names are verified against the host
  // theme by scripts/check-tokens.mjs. Here we only require tokens be used.
  assert.ok(/var\(--dsw-alias-/.test(css), 'expected DSH alias tokens')
  assert.ok(/var\(--dsw-font-/.test(css), 'expected DSH font tokens')

  // The panel needs an opaque surface of its own; a transparent one lets the
  // app show through behind it.
  assert.match(css, /\.am-panel\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-2\)/)

  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion/)
})

test('overlay is an accessible, dismissible dialog', async () => {
  const client = await readClient()

  assert.match(client, /aria-modal="true"/)
  assert.match(client, /role="dialog"/)
  assert.match(client, /'Escape'/)
  // Tab must cycle within the panel, but not fight portaled Modal/Menu focus.
  assert.match(client, /event\.key !== 'Tab'/)
  assert.doesNotMatch(client, /window\.confirm/)
  // Styling belongs in styles.css so tokens stay themeable.
  assert.doesNotMatch(client, /style=\{\{/)
})

test('mounts into the host slots it depends on', async () => {
  const client = await readClient()

  assert.match(client, /shell\.overlay/)
  assert.match(client, /sidebar\.footer\.action/)
  assert.match(client, /conversation\.input\.dock/)
  assert.match(client, /inputActions\.setDraft\(text\)/)
  assert.match(client, /ctx\.sessions\.open\(sessionId\)/)
  assert.match(client, /guidedCreationPrompt/)
})

test('surfaces task lifecycle controls and state', async () => {
  const client = await readClient()

  assert.match(client, /method: 'PATCH'/)
  assert.match(client, /\/stop`/)
  assert.match(client, /\/notifications\/read/)
  assert.match(client, /\/options\$\{query\}/)
  assert.match(client, /buildCommonRRule/)
  assert.match(client, /type="datetime-local"/)

  for (const status of ['statusTimedOut', 'statusOutcomeUnknown']) {
    assert.match(client, new RegExp(status))
  }
  assert.match(client, /t\('retry'\)/)
  assert.match(client, /health\.status === 'retrying'/)
  assert.match(client, /am-nav-badge/)
})

test('renders every field the task carries', async () => {
  const client = await readClient()

  // The prompt is the task's most important field and regressed once by being
  // editable but never displayed; assert it renders, not just that it is bound.
  assert.match(client, /className="am-prompt">\{task\.prompt\}/)

  for (const field of [
    'pauseAfterConsecutiveFailures',
    'confirmPermissionChange',
    'permissionConfirmed',
    'setPermissionConfirmed(false)',
    'agentPreset',
    'selectedSkills',
    'modelFailures',
    'approvalAskWarning',
    'hostDefault',
    'executionDestination',
    'executionFresh',
    'executionPinned',
    'formatRunDuration',
    'run.summary',
  ]) {
    assert.ok(client.includes(field), `missing ${field}`)
  }

  assert.doesNotMatch(client, /<b>Execution destination/)
})
