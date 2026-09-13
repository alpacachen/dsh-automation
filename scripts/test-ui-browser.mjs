/**
 * Actual built plugin + existing DSH shell/primitives, with isolated fixture APIs.
 * Never activates the scheduler or sends task/session writes to the real server.
 * Build first. Requires Playwright; use PLAYWRIGHT_MODULE for an external install.
 * DSH_TEST_COOKIE accepts the existing local GUI auth cookie (name=value) in env.
 * DSH_TEST_URL defaults to the current GUI. Screenshots go to UI_SCREENSHOT_DIR.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const base = process.env.DSH_TEST_URL ?? 'http://127.0.0.1:3080'
const output = resolve(process.env.UI_SCREENSHOT_DIR ?? '/tmp/automation-ui-review')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
const errors = []
const writes = []
const now = Date.now()
const instant = (offset) => new Date(now + offset).toISOString()
const common = {
  prompt: '检查当前工作区的依赖清单和锁文件，关注安全风险与兼容性变化。\n\n不要修改文件。优先列出需要处理的问题，并给出具体建议。',
  createdAt: instant(-86400000 * 8), createdBySessionId: 'fixture-creator', status: 'active', running: false,
  schedule: { kind: 'recurring', rrule: 'FREQ=WEEKLY;BYDAY=MO', startAt: '2026-09-01T09:30:00', timeZone: 'Asia/Shanghai' },
  nextRunAt: instant(3600000 * 20), notificationPolicy: 'failures', pauseAfterConsecutiveFailures: true,
  consecutiveFailures: 0, unreadNotifications: 0,
  execution: { workspaceId: 'fixture-workspace', cwd: '/preview/project', skills: [], target: { mode: 'fresh' } },
  security: { permissionPreset: 'read-only', source: 'user-confirmed', grantedAt: instant(-86400000) },
  runs: [{ id: 'fixture-run', trigger: 'scheduled', enqueuedAt: instant(-86400000), startedAt: instant(-86400000), finishedAt: instant(-86340000), status: 'succeeded', sessionId: 'fixture-result', summary: '检查完成：未发现阻塞问题。\n建议在下次升级前复核两项依赖的兼容性说明。' }],
}
let tasks = [
  { ...structuredClone(common), id: 'dependencies', name: '每周依赖巡检' },
  { ...structuredClone(common), id: 'handoff', name: '工作日交接', nextRunAt: instant(86400000), schedule: { ...common.schedule, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startAt: '2026-09-01T18:00:00' } },
  { ...structuredClone(common), id: 'release', name: '发布准备检查', status: 'paused', nextRunAt: null, consecutiveFailures: 2, runs: [{ ...common.runs[0], status: 'failed', error: '测试服务暂时不可用，请检查连接后重试。' }] },
  { ...structuredClone(common), id: 'archive', name: '归档本周变更', status: 'completed', nextRunAt: null, runs: [] },
]
let listError = false
let optionError = false
const options = { presets: [], models: [], modelFailures: [], skills: [], permissions: [
  { id: 'read-only', name: '只读', sandbox: 'read-only', approval: 'never', default: true },
  { id: 'danger-full-access', name: '完全访问', sandbox: 'danger-full-access', approval: 'never', default: false },
] }

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (error) => errors.push(error.message))
  if (process.env.DSH_TEST_COOKIE) {
    const [name, ...value] = process.env.DSH_TEST_COOKIE.split('=')
    await page.context().addCookies([{ name, value: value.join('='), url: base }])
  }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.startsWith('/api/automation/v1/')) return route.fulfill({ status: 503, json: { error: 'Non-fixture APIs are disabled in this test.' } })
    const path = url.pathname.replace('/api/automation/v1', '')
    const method = route.request().method()
    if (method === 'GET' && path.endsWith('/options')) return route.fulfill({ status: optionError ? 503 : 200, json: optionError ? { error: 'Fixture options unavailable' } : { options } })
    if (method === 'GET' && path === '/tasks') return route.fulfill({ status: listError ? 503 : 200, json: listError ? { error: 'Fixture connection unavailable' } : { tasks, scheduler: { status: 'healthy', consecutiveFailures: 0 } } })
    writes.push({ path, method, body: route.request().postDataJSON() })
    const task = tasks.find((item) => path.split('/')[2] === item.id)
    if (method === 'PATCH' && task) Object.assign(task, route.request().postDataJSON())
    if (method === 'DELETE') tasks = tasks.filter((item) => item !== task)
    if (method === 'POST' && task && path.endsWith('/pause')) { task.status = 'paused'; task.nextRunAt = null }
    if (method === 'POST' && task && path.endsWith('/resume')) { task.status = 'active'; task.nextRunAt = instant(3600000) }
    return route.fulfill({ json: { ok: true } })
  })
  // Capture the real module system, but stop before any live shell plugin applies.
  await page.addInitScript(() => {
    let loader
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true, get: () => loader,
      set(value) {
        loader = value
        const create = value.create
        value.create = function (options) {
          window.__automationTestModules = create.call(this, options)
          window.__automationTestSeeds = options.staticModules
          throw new Error('AUTOMATION_TEST_BOOT_STOP')
        }
      },
    })
  })
  const mount = async () => {
    await page.goto(base)
    if ((await page.locator('body').innerText()).includes('authentication required')) throw new Error('Supply the current local GUI cookie via DSH_TEST_COOKIE; no auth bypass is attempted.')
    await page.waitForFunction(() => window.__automationTestModules)
    await page.evaluate(async () => {
      for (const id of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar']) await window.__automationTestModules.import(id)
    })
    // Shell boot was intentionally stopped, so install its exact built theme
    // sheets without applying the live settings service.
    const themeUrl = await page.evaluate(() => window.__automationTestModules.manifest.modules.find((row) => row.id === '@deepseek-ai/dsh-client-ui-theme').initialUrl)
    const themeSource = await (await page.request.get(new URL(themeUrl, base).href)).text()
    const sheets = [...themeSource.matchAll(/var (\w+_css_default) = ("(?:[^"\\]|\\.)*");/g)].map((match) => JSON.parse(match[2]))
    assert.ok(sheets.length >= 6, 'Expected the actual host theme sheets')
    await page.addStyleTag({ content: sheets.join('\n') })
    // If Automation is now installed, a host combo batch can already contain
    // its factory. Finish that transport before replacing it with this build.
    await page.evaluate(async () => {
      const modules = window.__automationTestModules
      const id = '@alpacachen/dsh-automation'
      if (modules.manifest.modules.some((row) => row.id === id)) await modules.prefetch(id)
      modules.invalidate(id)
    })
    await page.addScriptTag({ path: fileURLToPath(new URL('../lib/client.js', import.meta.url)) })
    await page.evaluate(async () => {
      const mod = await window.__automationTestModules.import('@alpacachen/dsh-automation')
      const React = window.__automationTestSeeds.react
      const ReactDOM = window.__automationTestSeeds['react-dom/client']
      const components = {}
      let dictionaries
      const snapshot = { active: 'zh' }
      const ctx = {
        locale: {
          register(_namespace, values) { dictionaries = values; return () => {} },
          bind() { return (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionaries.zh[key]) },
          subscribe() { return () => {} }, getSnapshot() { return snapshot },
        },
        slots: {
          inject(_name, install) { return install() },
          register(meta, Component) { components[meta.id] = Component; return () => {} },
        },
        sessions: { open(id) { window.__automationOpenedSession = id } },
        uiWorkspace: { async connectWorkspace() { return 'fixture-new-session' } },
      }
      mod.apply(ctx)
      document.body.replaceChildren()
      const root = document.createElement('div')
      document.body.append(root)
      ReactDOM.createRoot(root).render(React.createElement(React.Fragment, null,
        React.createElement(components.automation, { wide: true }),
        React.createElement(components['automation-panel'], {
          useSessions: (select) => select({ current: 'fixture-current' }),
          useWorkspaces: (select) => select({ items: [{ workspaceId: 'fixture-workspace', sessionIds: ['fixture-current'] }] }),
        }),
      ))
    })
    await page.getByRole('button', { name: '打开自动化任务', exact: true }).click()
    await page.locator('.am-panel').waitFor()
  }
  const assertTypography = async () => {
    const violations = await page.locator('.am-panel').evaluate((panel) => {
      const family = getComputedStyle(panel).fontFamily
      return [...panel.querySelectorAll('*')].filter((el) => el instanceof HTMLElement && el.getClientRects().length &&
        ([...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) || el.matches('input,textarea')))
        .flatMap((el) => {
          const css = getComputedStyle(el)
          const heading = el.matches('h2,h3')
          const expectedSize = heading ? '16px' : '13px'
          const expectedWeight = heading ? '500' : '400'
          return css.fontSize !== expectedSize || css.fontWeight !== expectedWeight || (!el.matches('code') && css.fontFamily !== family)
            ? [{ text: el.textContent.trim().slice(0,30), tag: el.tagName, class: el.className, size: css.fontSize, weight: css.fontWeight, family: css.fontFamily }] : []
        })
    })
    assert.deepEqual(violations, [], 'Typography must stay on the two-role host type system')
  }
  await mount()
  await page.locator('.am-row').first().waitFor()
  assert.equal(await page.locator('.am-row').count(), 4)
  await page.locator('.am-row').first().focus()
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.locator('.am-row.is-selected .am-row-name').innerText(), '工作日交接')
  await page.keyboard.press('ArrowUp')
  assert.equal(await page.locator('.am-row.is-selected .am-row-name').innerText(), '每周依赖巡检')
  const lightBackground = await page.locator('.am-panel').evaluate((el) => getComputedStyle(el).backgroundColor)
  assert.notEqual(lightBackground, 'rgba(0, 0, 0, 0)', 'Host theme must be installed, not an unstyled false-positive')
  const panelBox = await page.locator('.am-panel').boundingBox()
  assert.equal(panelBox.width, 940)
  assert.equal(panelBox.height, 640)
  // Keyboard navigation is tested above; overview artwork shows resting state.
  await page.locator('.am-panel').focus()
  await assertTypography()
  await page.screenshot({ path: `${output}/overview.png` })
  await page.getByRole('button', { name: '配置', exact: true }).click()
  assert.equal(await page.locator('.am-facts').count(), 1)
  await assertTypography()
  await page.getByRole('button', { name: /运行历史/ }).click()
  await page.locator('.am-run').click()
  await page.getByText('运行 ID', { exact: true }).waitFor()
  await assertTypography()
  await page.screenshot({ path: `${output}/history.png` })
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  assert.equal(await page.locator('.am-editor-disclosure').count(), 3)
  assert.equal(await page.locator('.am-editor-disclosure[open]').count(), 0)
  await page.getByRole('button', { name: '保存修改', exact: true }).waitFor()
  await page.locator('#am-name').fill('每周依赖巡检 · 已编辑')
  await page.getByText('有未保存的修改', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await page.locator('.am-row').nth(1).click()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(await page.locator('#am-name').inputValue(), '每周依赖巡检 · 已编辑')
  await page.getByRole('button', { name: '取消', exact: true }).last().click()
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  assert.equal(await page.locator('.am-editor').count(), 0)
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('#am-name').fill('每周依赖巡检 · 已保存')
  await page.getByRole('button', { name: '保存修改', exact: true }).click()
  await page.getByRole('heading', { name: '每周依赖巡检 · 已保存', exact: true }).waitFor()
  assert.ok(writes.some((write) => write.method === 'PATCH' && write.body.name.endsWith('已保存')))
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await assertTypography()
  await page.screenshot({ path: `${output}/editor.png` })
  await page.locator('.am-editor-disclosure summary').first().click()
  assert.equal(await page.locator('.am-editor-disclosure[open]').count(), 1)
  await page.locator('.am-editor-disclosure[open]').scrollIntoViewIfNeeded()
  await assertTypography()
  await page.screenshot({ path: `${output}/editor-advanced.png` })
  await page.getByRole('button', { name: '取消', exact: true }).last().click()
  await page.getByRole('textbox', { name: '搜索自动化' }).fill('no matching task')
  await page.getByText('没有匹配“no matching task”的自动化。').waitFor()
  await page.getByRole('button', { name: '查看全部任务' }).click()
  assert.equal(await page.locator('.am-row').count(), 4)
  await page.locator('.am-list-tools').getByRole('button', { name: '已暂停', exact: true }).click()
  assert.equal(await page.locator('.am-row').count(), 1)
  await page.locator('.am-list-tools').getByRole('button', { name: '全部', exact: true }).click()
  await page.setViewportSize({ width: 820, height: 680 })
  assert.equal(await page.locator('.am-detail-pane').isVisible(), true)
  assert.equal(await page.locator('.am-panel').evaluate((el) => el.scrollWidth > el.clientWidth), false)
  await assertTypography()
  await page.screenshot({ path: `${output}/tablet.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.am-row').first().click()
  await assertTypography()
  await page.screenshot({ path: `${output}/mobile-detail.png` })
  assert.equal(await page.locator('.am-panel').evaluate((el) => el.scrollWidth > el.clientWidth), false)
  await page.getByRole('button', { name: '返回列表', exact: true }).click()
  await assertTypography()
  await page.screenshot({ path: `${output}/mobile-list.png` })
  assert.equal(await page.locator('.am-detail-pane').isVisible(), false)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  assert.notEqual(await page.locator('.am-panel').evaluate((el) => getComputedStyle(el).backgroundColor), lightBackground)
  await assertTypography()
  await page.screenshot({ path: `${output}/dark.png` })
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  optionError = true
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByText(/Fixture options unavailable/).waitFor()
  optionError = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByText(/Fixture options unavailable/).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '取消', exact: true }).last().click()
  // Lifecycle controls are exercised only against local fixture responses.
  await page.getByRole('button', { name: '立即运行', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '恢复', exact: true }).click()
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(tasks.length, 4)
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.am-row').length === 3)
  assert.ok(writes.some((write) => write.method === 'DELETE'))
  tasks = []
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('heading', { name: '从一个想法开始' }).waitFor()
  const emptyBox = await page.locator('.am-panel').boundingBox()
  assert.equal(emptyBox.width, 640)
  assert.ok(emptyBox.height < panelBox.height, 'Empty state should fit its content, not reserve a full workspace')
  await assertTypography()
  await page.screenshot({ path: `${output}/empty.png` })
  await page.setViewportSize({ width: 1024, height: 500 })
  assert.ok((await page.locator('.am-panel').boundingBox()).height <= 436)
  await page.locator('.am-example').last().scrollIntoViewIfNeeded()
  await page.setViewportSize({ width: 1440, height: 1000 })
  listError = true
  await mount()
  await page.getByRole('heading', { name: '暂时无法加载任务' }).waitFor()
  await assertTypography()
  await page.screenshot({ path: `${output}/error.png` })
  listError = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByRole('heading', { name: '从一个想法开始' }).waitFor()
  await page.getByRole('button', { name: '新建自动化', exact: true }).click()
  await page.waitForFunction(() => window.__automationOpenedSession === 'fixture-new-session')
  assert.equal(await page.locator('.am-panel').count(), 0)
  assert.deepEqual(errors.filter((message) => !message.includes('AUTOMATION_TEST_BOOT_STOP')), [])
  console.log(`PASS: actual bundle against ${base}; overview/history/settings, editor save/discard, filters, mobile, dark, empty, error/retry. All writes intercepted (${writes.length}). Screenshots: ${output}`)
} finally {
  await browser.close()
}
