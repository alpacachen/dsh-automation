import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const cssUrl = new URL('../src/client/styles.css', import.meta.url)
const clientUrl = new URL('../src/client/index.tsx', import.meta.url)

test('Automation UI uses DSH tokens and accessible interaction states', async () => {
  const [css, client] = await Promise.all([
    readFile(cssUrl, 'utf8'),
    readFile(clientUrl, 'utf8'),
  ])

  for (const token of [
    '--dsw-font-family',
    '--dsw-alias-bg-base',
    '--dsw-alias-label-primary',
    '--dsw-alias-border-l2',
    '--dsw-shadow-lv3',
  ]) {
    assert.ok(css.includes(`var(${token})`), `missing DSH token ${token}`)
  }

  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion/)
  assert.match(client, /aria-modal="true"/)
  assert.match(client, /event\.key === 'Escape'/)
  assert.match(client, /automation-delete-confirm/)
  assert.match(client, /conversation\.input\.dock/)
  assert.match(client, /inputActions\.setDraft\(text\)/)
  assert.match(client, /ctx\.sessions\.open\(sessionId\)/)
  assert.doesNotMatch(client, /automation-access-note/)
  assert.doesNotMatch(client, /window\.confirm/)
  assert.doesNotMatch(client, /style=\{\{/)
})
