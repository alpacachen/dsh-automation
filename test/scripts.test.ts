import test from 'node:test'
import assert from 'node:assert/strict'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const browserScript = fileURLToPath(new URL('../scripts/test-ui-browser.mjs', import.meta.url))
const tokenScript = fileURLToPath(new URL('../scripts/check-tokens.mjs', import.meta.url))

test('browser script imports external paths and file URLs before launching', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-scripts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const name = 'playwright 空 格 #% stub.mjs'
  const module = join(dir, name)
  // Stop at the browser boundary: no GUI, server, or built bundle is used.
  writeFileSync(module, 'export const chromium = { launch() { console.log("fixture launch"); process.exit(0) } }')
  for (const specifier of [module, pathToFileURL(module).href, `./${name}`]) {
    const result = spawnSync(process.execPath, [browserScript], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PLAYWRIGHT_MODULE: specifier, UI_SCREENSHOT_DIR: '', TMPDIR: dir, TMP: dir, TEMP: dir },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /fixture launch/)
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_MODULE: module, TMPDIR: dir, TMP: dir, TEMP: dir }
  delete env.UI_SCREENSHOT_DIR
  const result = spawnSync(process.execPath, [browserScript], { cwd: dir, encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(dir, 'automation-ui-review')), true)
})

test('token audit honors the explicit theme path and reports missing tokens/files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-tokens-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'src/client'), { recursive: true })
  writeFileSync(join(dir, 'src/client/styles.css'), '.test { color: var(--dsw-test) }')
  const theme = join(dir, 'theme 空 格 #%.css')
  const run = (path: string) => spawnSync(process.execPath, [tokenScript], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, DSH_THEME_FILE: path, npm_config_cache: join(dir, 'missing-cache') },
  })
  writeFileSync(theme, ':root { --dsw-test: red }')
  for (const path of [theme, './theme 空 格 #%.css']) {
    const result = run(path)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /OK — every referenced token/)
  }
  writeFileSync(theme, ':root { --dsw-other: red }')
  assert.equal(run(theme).status, 1)
  assert.match(run(theme).stdout, /MISSING:\s+--dsw-test/)
  assert.notEqual(run(join(dir, 'missing.css')).status, 0)
})

test('build cleanup removes only lib and tolerates an absent directory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-clean-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'lib/nested'), { recursive: true })
  writeFileSync(join(dir, 'lib/nested/stale.js'), 'stale')
  writeFileSync(join(dir, 'keep.txt'), 'keep')
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // Execute the actual cleanup stage only; never build or delete the repository lib.
  const cleanup = scripts.build.split(' && ')[0]
  execSync(cleanup, { cwd: dir })
  assert.equal(existsSync(join(dir, 'lib')), false)
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'keep')
  execSync(cleanup, { cwd: dir })
})
