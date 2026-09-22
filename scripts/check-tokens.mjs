/*
 * Assert every --dsw-* / --ds-* token the plugin references is actually defined
 * by the host theme. An undefined custom property makes its whole declaration
 * invalid-at-computed-value-time, which is how the panel ended up transparent.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

function findTheme() {
  if (process.env.DSH_THEME_FILE) return process.env.DSH_THEME_FILE
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-theme/client')
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  const cache = process.env.npm_config_cache ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache')
    : join(homedir(), '.npm'))
  const npx = join(cache, '_npx')
  if (existsSync(npx)) {
    for (const name of readdirSync(npx).sort()) {
      const candidate = join(npx, name, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js')
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('Host theme not found. Set DSH_THEME_FILE to its lib/client.js or CSS file.')
}

const theme = readFileSync(findTheme(), 'utf8')
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
