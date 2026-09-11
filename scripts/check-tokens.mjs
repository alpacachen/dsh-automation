/*
 * Assert every --dsw-* / --ds-* token the plugin references is actually defined
 * by the host theme. An undefined custom property makes its whole declaration
 * invalid-at-computed-value-time, which is how the panel ended up transparent.
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const THEME = execSync(
  'ls ~/.npm/_npx/*/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
  { shell: '/bin/zsh' },
).toString().trim().split('\n')[0]

const theme = readFileSync(THEME, 'utf8')
const defined = new Set(theme.match(/--[a-z0-9-]+(?=\s*:)/g) ?? [])

const css = readFileSync('src/client/styles.css', 'utf8')
// Only names used via var(), ignoring any fallback text.
const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]))

const missing = [...used].filter((name) => !defined.has(name)).sort()
console.log(`theme defines ${defined.size} custom properties`)
console.log(`stylesheet references ${used.size}`)
if (missing.length === 0) {
  console.log('OK — every referenced token is defined by the host theme')
} else {
  console.log('MISSING:')
  for (const name of missing) console.log('  ' + name)
  process.exitCode = 1
}
