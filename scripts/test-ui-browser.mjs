/**
 * Actual built plugin + existing DSH shell/primitives, with isolated fixture APIs.
 * Never activates the scheduler or sends task/session writes to the real server.
 * Build first. Requires Playwright; use PLAYWRIGHT_MODULE for an external install.
 * DSH_TEST_COOKIE accepts the existing local GUI auth cookie (name=value) in env.
 * DSH_TEST_URL defaults to the current GUI. Screenshots go to UI_SCREENSHOT_DIR.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? 'playwright'
const { chromium } = await import(isAbsolute(playwrightModule) || playwrightModule.startsWith('.')
  ? pathToFileURL(resolve(playwrightModule)).href : playwrightModule)
const base = process.env.DSH_TEST_URL ?? 'http://127.0.0.1:3080'
const output = resolve(process.env.UI_SCREENSHOT_DIR ?? resolve(tmpdir(), 'automation-ui-review'))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
const errors = []
const writes = []
const now = Date.now()
const instant = (offset) => new Date(now + offset).toISOString()
const common = {
  prompt: 'Inspect workspace dependency manifests and lockfiles for security risks and compatibility changes.\n\nDo not modify files. List actionable issues first and give concrete recommendations.',
  createdAt: instant(-86400000 * 8), createdBySessionId: 'fixture-creator', status: 'active', running: false,
  schedule: { kind: 'recurring', rrule: 'FREQ=WEEKLY;BYDAY=MO', startAt: '2026-09-01T09:30:00', timeZone: 'Asia/Shanghai' },
  nextRunAt: instant(3600000 * 20), notificationPolicy: 'failures', pauseAfterConsecutiveFailures: true,
  consecutiveFailures: 0, unreadNotifications: 0,
  execution: { workspaceId: 'fixture-workspace', cwd: '/preview/project', skills: [], target: { mode: 'fresh' } },
  security: { permissionPreset: 'read-only', source: 'user-confirmed', grantedAt: instant(-86400000) },
  runs: [{ id: 'fixture-run', trigger: 'scheduled', enqueuedAt: instant(-86400000), startedAt: instant(-86400000), finishedAt: instant(-86340000), status: 'succeeded', sessionId: 'fixture-result', summary: 'Check complete: no blockers found.\nReview compatibility notes for two dependencies before the next upgrade.' }],
}
let tasks = [
  { ...structuredClone(common), id: 'dependencies', name: 'Weekly dependency watch' },
  { ...structuredClone(common), id: 'handoff', name: 'Weekday handoff', nextRunAt: instant(86400000), schedule: { ...common.schedule, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startAt: '2026-09-01T18:00:00' } },
  { ...structuredClone(common), id: 'release', name: 'Release readiness check', status: 'paused', nextRunAt: null, consecutiveFailures: 2, runs: [{ ...common.runs[0], status: 'failed', error: 'Test service unavailable. Check the connection and retry.' }] },
  { ...structuredClone(common), id: 'archive', name: 'Archive weekly changes', status: 'completed', nextRunAt: null, runs: [] },
]
tasks[0].runs[0].delivery = { botId: 'bot-alpha', targetId: 'report', status: 'failed', attemptedAt: instant(-86339000), finishedAt: instant(-86338000), error: 'Fixture bot offline' }
let listError = false
let optionError = false
let deliveryError = false
let deliveryAvailable = true
const deliveryReads = []
const deliveryGates = new Map()
const deliveryBots = [{ botId: 'bot-alpha', channel: 'feishu' }, { botId: 'bot-beta', channel: 'telegram' }]
const deliveryTargets = {
  'bot-alpha': [{ targetId: 'report', name: 'Report chat', kind: 'user' }, { targetId: 'daily', name: 'Daily chat', kind: 'user' }],
  'bot-beta': [{ targetId: 'phone', name: 'Phone chat', kind: 'chat' }],
}
const options = { presets: [], models: [], modelFailures: [], skills: [], permissions: [
  { id: 'read-only', name: 'Read only', sandbox: 'read-only', approval: 'never', default: true },
  { id: 'danger-full-access', name: 'Full access', sandbox: 'danger-full-access', approval: 'never', default: false },
] }

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
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
    if (method === 'GET' && path === '/delivery-options') {
      const botId = url.searchParams.get('botId') ?? ''
      deliveryReads.push(botId)
      const response = deliveryError ? { error: 'Fixture delivery options unavailable' } : {
        options: { available: deliveryAvailable, bots: deliveryAvailable ? deliveryBots : [], targets: deliveryAvailable ? deliveryTargets[botId] ?? [] : [] },
      }
      const status = deliveryError ? 503 : 200
      await deliveryGates.get(botId)
      return route.fulfill({ status, json: response })
    }
    if (method === 'GET' && path.endsWith('/options')) return route.fulfill({ status: optionError ? 503 : 200, json: optionError ? { error: 'Fixture options unavailable' } : { options } })
    if (method === 'GET' && path === '/tasks') return route.fulfill({ status: listError ? 503 : 200, json: listError ? { error: 'Fixture connection unavailable' } : { tasks, scheduler: { status: 'healthy', consecutiveFailures: 0 } } })
    writes.push({ path, method, body: route.request().postDataJSON() })
    const task = tasks.find((item) => path.split('/')[2] === item.id)
    if (method === 'PATCH' && task) {
      const { execution, confirmSessionTargetChange, delivery, confirmDeliveryChange, ...patch } = route.request().postDataJSON()
      Object.assign(task, patch)
      if (delivery === null) delete task.delivery
      else if (delivery !== undefined) {
        assert.equal(confirmDeliveryChange, true)
        task.delivery = delivery
      }
      if (execution) {
        if (execution.target) assert.equal(confirmSessionTargetChange, true)
        task.execution = { ...task.execution, ...execution,
          ...(execution.target?.mode === 'pinned-session' ? { target: { ...execution.target, workspaceId: task.execution.workspaceId, cwd: task.execution.cwd, fallback: 'fail' } } : {}),
        }
      }
    }
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
    // Start the isolated fixture in light mode regardless of the Host boot preference.
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
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
      const snapshot = { active: 'en' }
      let sessionSnapshot
      const sessionListeners = new Set()
      const setSessionPhase = (phase) => {
        sessionSnapshot = { ...sessionSnapshot, phase,
          ids: phase === 'ready' ? sessionRows.map((row) => row.id) : [],
          byId: phase === 'ready' ? Object.fromEntries(sessionRows.map((row) => [row.id, row])) : {},
        }
        for (const listener of sessionListeners) listener()
      }
      window.__automationSetSessionPhase = setSessionPhase
      const ctx = {
        locale: {
          register(_namespace, values) { dictionaries = values; return () => {} },
          bind() { return (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionaries.en[key]) },
          subscribe() { return () => {} }, getSnapshot() { return snapshot },
        },
        slots: {
          inject(_name, install) { return install() },
          register(meta, Component) { components[meta.id] = Component; return () => {} },
        },
        sessions: { open(id) { window.__automationOpenedSession = id }, async refresh() {
          if (window.__automationSessionRefreshError) throw new Error('Fixture sessions unavailable')
          // Host remote failures resolve without making the first baseline ready.
          if (!window.__automationSessionRefreshPending) queueMicrotask(() => setSessionPhase('ready'))
        } },
        uiWorkspace: { async connectWorkspace() { return 'fixture-new-session' } },
      }
      mod.apply(ctx)
      document.body.replaceChildren()
      const root = document.createElement('div')
      document.body.append(root)
      const sessionRows = [
        { id: 'fixture-current', displayTitle: 'Current workspace conversation', cwd: '/preview/project', running: false },
        { id: 'fixture-target', displayTitle: 'Release planning', cwd: '/preview/project', running: false },
        { id: 'fixture-fork', displayTitle: 'Forked planning', cwd: '/preview/project', parentId: 'fixture-current', running: false },
        { id: 'fixture-busy', displayTitle: 'Busy conversation', cwd: '/preview/project', running: true },
        { id: 'fixture-other', displayTitle: 'Other workspace conversation', cwd: '/other/project', running: false },
        { id: 'fixture-child', displayTitle: 'Child conversation', cwd: '/preview/project', parentId: 'fixture-current', origin: 'subagent', running: false },
        { id: 'fixture-detached', displayTitle: 'Detached conversation', cwd: '/preview/project', running: false },
        { id: 'fixture-archived', displayTitle: 'Archived conversation', cwd: '/preview/project', running: false },
      ].map((row) => ({ ...row, blank: false, updatedAt: Date.now() }))
      sessionSnapshot = { current: 'fixture-current', phase: 'ready', ids: sessionRows.map((row) => row.id), byId: Object.fromEntries(sessionRows.map((row) => [row.id, row])) }
      const subscribeSessions = (listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener) }
      const getSessions = () => sessionSnapshot
      function SidebarFixture() {
        const [wide, setWide] = React.useState(true)
        window.__automationSetSidebarWide = setWide
        return React.createElement('div', { id: 'fixture-sidebar', style: { width: wide ? 228 : 36 } },
          React.createElement(components.automation, { wide }))
      }
      ReactDOM.createRoot(root).render(React.createElement(React.Fragment, null,
        React.createElement(SidebarFixture),
        React.createElement(components['automation-panel'], {
          useSessions: (select) => select(React.useSyncExternalStore(subscribeSessions, getSessions, getSessions)),
          useWorkspaces: (select) => select({ archivedSessionIds: ['fixture-archived'], items: [{ workspaceId: 'fixture-workspace', sessionIds: ['fixture-current', 'fixture-target', 'fixture-fork', 'fixture-busy', 'fixture-child', 'fixture-archived'] }] }),
        }),
      ))
    })
    await page.locator('.am-nav').waitFor()
    await assertSidebar()
    await page.getByRole('button', { name: 'Open Automations', exact: true }).click()
    await page.locator('.am-panel').waitFor()
  }
  const assertCustomFocus = async (locator) => {
    await page.keyboard.press('Tab')
    await locator.focus()
    const focus = await locator.evaluate((el) => {
      const css = getComputedStyle(el)
      return { visible: el.matches(':focus-visible'), style: css.outlineStyle, width: css.outlineWidth }
    })
    assert.deepEqual(focus, { visible: true, style: 'solid', width: '2px' }, 'Custom controls retain visible keyboard focus')
  }
  const assertSidebar = async () => {
    for (const wide of [true, false]) {
      await page.evaluate((wide) => window.__automationSetSidebarWide(wide), wide)
      const nav = page.locator(`.am-nav.${wide ? 'is-wide' : 'is-rail'}`)
      await nav.waitFor()
      const geometry = await nav.evaluate((el) => {
        const css = getComputedStyle(el)
        const box = el.getBoundingClientRect()
        const parent = el.parentElement.getBoundingClientRect()
        const icon = el.querySelector('.am-nav-icon').getBoundingClientRect()
        const svg = el.querySelector('svg').getBoundingClientRect()
        const probe = document.createElement('span')
        probe.style.color = 'var(--dsw-alias-label-primary)'
        el.append(probe)
        const primary = getComputedStyle(probe).color
        probe.remove()
        return { width: box.width, height: box.height, x: box.x - parent.x, parentWidth: parent.width,
          radius: css.borderRadius, margin: css.margin, color: css.color, primary,
          icon: [icon.width, icon.height], svg: [svg.width, svg.height],
          centered: Math.abs(svg.x + svg.width / 2 - icon.x - icon.width / 2) < 0.5 &&
            Math.abs(svg.y + svg.height / 2 - icon.y - icon.height / 2) < 0.5 }
      })
      assert.equal(geometry.height, wide ? 42 : 36)
      assert.equal(geometry.width, wide ? geometry.parentWidth : 36)
      assert.equal(geometry.x, 0)
      assert.equal(geometry.radius, wide ? '12px' : '50%')
      assert.equal(geometry.margin, wide ? '0px' : '8px 0px 10px')
      assert.equal(geometry.color, geometry.primary)
      assert.deepEqual(geometry.icon, wide ? [16, 16] : [18, 18])
      assert.deepEqual(geometry.svg, wide ? [16, 16] : [18, 18])
      assert.equal(geometry.centered, true, 'Host clock matches the Settings icon size without extra scaling')
      assert.equal(await nav.locator('.am-nav-label').count(), wide ? 1 : 0)
      await assertCustomFocus(nav)
      await nav.screenshot({ path: `${output}/sidebar-${wide ? 'wide' : 'rail'}.png` })
    }
    await page.evaluate(() => window.__automationSetSidebarWide(true))
    await page.locator('.am-nav.is-wide').waitFor()
  }
  const assertHeaderActions = async () => {
    const edit = await page.getByRole('button', { name: 'Edit', exact: true }).boundingBox()
    const more = page.getByRole('button', { name: 'More actions', exact: true })
    const box = await more.boundingBox()
    assert.equal(edit.height, 28)
    assert.equal(box.height, 28)
    assert.ok(Math.abs(edit.y + edit.height / 2 - box.y - box.height / 2) < 0.5, 'Edit and More action centers align')
    assert.equal(await more.evaluate((el) => getComputedStyle(el).borderRadius), '8px')
  }
  const assertTypography = async () => {
    const violations = await page.locator('.am-panel').evaluate((panel) => {
      const family = getComputedStyle(panel).fontFamily
      const probe = document.createElement('code')
      probe.style.fontFamily = 'var(--ds-font-family-code)'
      document.body.append(probe)
      const codeFamily = getComputedStyle(probe).fontFamily
      probe.remove()
      const violations = []
      const check = (el, expected) => {
        const css = getComputedStyle(el)
        const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, css[key]]))
        if (Object.keys(expected).some((key) => actual[key] !== expected[key])) {
          violations.push({ text: el.textContent.trim().slice(0, 40), tag: el.tagName, class: el.className, expected, actual })
        }
      }
      const visible = (el) => el instanceof HTMLElement && el.getClientRects().length
      const text = (el) => [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
      for (const el of panel.querySelectorAll('*')) {
        if (visible(el) && (text(el) || el.matches('input,textarea'))) {
          check(el, { fontFamily: el.closest('code') ? codeFamily : family })
        }
      }
      // Assert actual component baselines, not a permissive list of font sizes.
      check(panel, { fontSize: '13px', lineHeight: '20px', fontWeight: '400' })
      for (const [selector, fontSize, lineHeight, fontWeight = '400'] of [
        ['h2,h3', '16px', '24px', '500'],
        ['.am-row-name,.am-row-meta,.am-field-label,.am-fact-label,.am-fact-value,.am-form-section-title,.am-interval > span:not(.am-input)', '13px', '20px'],
        ['input,textarea,.am-select,.am-select-value', '14px', '22px'],
        ['.am-tab', '13px', '20px', '500'],
        ['code', '13px', '20px'],
      ]) {
        for (const el of panel.querySelectorAll(selector)) {
          if (visible(el)) check(el, { fontSize, lineHeight, fontWeight })
        }
      }
      // Real Host Button(sm) and Pill labels (including nested spans) must keep
      // 12/18. Exclude custom controls and icon-only DisclosureRow/Switch buttons.
      for (const button of panel.querySelectorAll('button:not([class*="am-"]):not([role="switch"])')) {
        if (!visible(button) || !button.textContent.trim()) continue
        for (const el of [button, ...button.querySelectorAll('span,strong,b,small')]) {
          if (visible(el)) check(el, { fontSize: '12px', lineHeight: '18px', fontWeight: '400' })
        }
      }
      // Host menus are portaled outside the panel; check them when opened too.
      for (const item of document.querySelectorAll('[role="menuitem"]')) {
        for (const el of [item, ...item.querySelectorAll('span')]) {
          if (visible(el)) check(el, { fontSize: '14px', lineHeight: '22px', fontWeight: '400', fontFamily: family })
        }
      }
      return violations
    })
    assert.deepEqual(violations, [], 'Custom type roles and real Host primitive baselines must remain intact')
  }
  await mount()
  await page.locator('.am-row').first().waitFor()
  assert.equal(await page.locator('.am-row').count(), 4)
  const search = page.getByRole('textbox', { name: 'Search automations' })
  await page.keyboard.press('Tab')
  await search.focus()
  assert.deepEqual(await search.evaluate((el) => {
    const css = getComputedStyle(el)
    const probe = document.createElement('span')
    probe.style.color = 'var(--dsw-alias-brand-primary)'
    el.parentElement.append(probe)
    const focusedBorder = getComputedStyle(el.parentElement).borderColor === getComputedStyle(probe).color
    probe.remove()
    return { visible: el.matches(':focus-visible'), outline: css.outlineStyle, shadow: css.boxShadow, focusedBorder }
  }), { visible: true, outline: 'none', shadow: 'none', focusedBorder: true }, 'Official Input uses its wrapper border, never an extra inner ring')
  await assertHeaderActions()
  await assertCustomFocus(page.locator('.am-row').first())
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.locator('.am-row.is-selected .am-row-name').innerText(), 'Weekday handoff')
  await page.keyboard.press('ArrowUp')
  assert.equal(await page.locator('.am-row.is-selected .am-row-name').innerText(), 'Weekly dependency watch')
  const lightBackground = await page.locator('.am-panel').evaluate((el) => getComputedStyle(el).backgroundColor)
  assert.notEqual(lightBackground, 'rgba(0, 0, 0, 0)', 'Host theme must be installed, not an unstyled false-positive')
  const panelBox = await page.locator('.am-panel').boundingBox()
  assert.equal(panelBox.width, 940)
  assert.equal(panelBox.height, 640)
  // Keyboard navigation is tested above; overview artwork shows resting state.
  await page.locator('.am-panel').focus()
  await assertTypography()
  await page.screenshot({ path: `${output}/overview.png` })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  assert.equal(await page.locator('.am-facts').count(), 1)
  assert.ok(await page.locator('.am-facts code').count() > 0, 'Settings must exercise Host code typography')
  await assertTypography()
  await page.getByRole('button', { name: /Run history/ }).click()
  await page.locator('.am-run').click()
  await page.getByText('Run ID', { exact: true }).waitFor()
  await page.getByText('Message delivery: Fixture bot offline', { exact: true }).waitFor()
  assert.match(await page.locator('.am-run').innerText(), /succeeded/)
  assert.equal(await page.locator('.am-run').getByRole('button', { name: 'Retry', exact: true }).count(), 0, 'Delivery failure never offers rerunning a succeeded task')
  await assertTypography()
  await page.screenshot({ path: `${output}/history.png` })
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  assert.equal(await page.locator('.am-editor-disclosure').count(), 4)
  assert.equal(await page.locator('.am-editor-disclosure[open]').count(), 0)
  assert.equal(await page.locator('.am-editor .am-pill-group button').count() > 0, true, 'Editor must exercise real Host Pills')
  assert.equal(await page.locator('.am-editor-disclosure > summary > svg.am-disclosure-chevron').count(), 4)
  const disclosure = page.locator('.am-editor-disclosure summary').first()
  assert.equal(await disclosure.evaluate((el) => getComputedStyle(el).listStyleType), 'none', 'Only the explicit Host chevron is shown')
  await assertCustomFocus(disclosure)
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('.am-editor-disclosure[open]').count(), 1, 'Native details retains keyboard activation')
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('.am-editor-disclosure[open]').count(), 0)
  await assertCustomFocus(page.locator('.am-select').first())
  assert.deepEqual(await page.locator('.am-select').first().evaluate((el) => {
    const css = getComputedStyle(el)
    return [el.getBoundingClientRect().height, css.borderRadius]
  }), [32, '8px'])
  await page.locator('textarea').first().focus()
  assert.deepEqual(await page.locator('textarea').first().evaluate((el) => {
    const css = getComputedStyle(el)
    return { visible: el.matches(':focus-visible'), outline: css.outlineStyle, focusedBorder: css.borderColor === css.color }
  }), { visible: true, outline: 'none', focusedBorder: true }, 'Textarea uses a focused border without an extra ring')
  await assertTypography()
  assert.equal(deliveryReads.length, 0, 'Disabled delivery does not fetch bot metadata')
  await page.getByRole('button', { name: 'Save changes', exact: true }).waitFor()
  await page.locator('#am-name').fill('Weekly dependency watch · Edited')
  await page.getByText('Unsaved changes', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await page.locator('.am-row').nth(1).click()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  assert.equal(await page.locator('#am-name').inputValue(), 'Weekly dependency watch · Edited')
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  assert.equal(await page.locator('.am-editor').count(), 0)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('#am-name').fill('Weekly dependency watch · Saved')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.getByRole('heading', { name: 'Weekly dependency watch · Saved', exact: true }).waitFor()
  assert.ok(writes.some((write) => write.method === 'PATCH' && write.body.name.endsWith('Saved')))
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await assertTypography()
  await page.screenshot({ path: `${output}/editor.png` })
  await page.locator('.am-editor-disclosure summary').first().click()
  assert.equal(await page.locator('.am-editor-disclosure[open]').count(), 1)
  await page.locator('.am-editor-disclosure[open]').scrollIntoViewIfNeeded()
  await assertTypography()
  await page.screenshot({ path: `${output}/editor-advanced.png` })
  // Manual-only session targeting: selecting does not commit until Save.
  const beforeTargetSave = writes.length
  await page.getByRole('button', { name: 'Session mode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Use an existing session', exact: true }).waitFor()
  await assertTypography()
  await page.getByRole('menuitem', { name: 'Use an existing session', exact: true }).click()
  assert.equal(await page.locator('.am-editor-disclosure').count(), 3, 'Pinned sessions do not expose ignored fresh-agent controls')
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: 'Target session', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: /Other workspace|Child conversation|Detached conversation|Archived conversation/ }).count(), 0)
  await page.getByRole('menuitem', { name: /Forked planning/ }).click()
  assert.equal(await page.getByRole('switch', { name: /^I confirm future runs/ }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), false)
  await page.getByRole('button', { name: 'Target session', exact: true }).click()
  await page.getByRole('menuitem', { name: /Release planning/ }).click()
  await page.getByRole('textbox', { name: 'Search session title or ID' }).fill('no-such-title')
  await page.getByRole('button', { name: 'Target session', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: /Current workspace conversation/ }).count(), 0)
  await page.getByRole('menuitem', { name: /Release planning/ }).click()
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), false)
  await page.getByRole('textbox', { name: 'Search session title or ID' }).fill('')
  await page.getByRole('button', { name: 'Session mode', exact: true }).scrollIntoViewIfNeeded()
  await assertTypography()
  await page.screenshot({ path: `${output}/session-target.png` })
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await assertTypography()
  await page.screenshot({ path: `${output}/session-target-dark.png` })
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.am-row.is-selected').click()
  await page.getByRole('button', { name: 'Target session', exact: true }).scrollIntoViewIfNeeded()
  assert.equal(await page.getByRole('button', { name: 'Target session', exact: true }).isVisible(), true)
  assert.equal(await page.locator('.am-editor').evaluate((el) => el.scrollWidth > el.clientWidth), false)
  assert.equal(await page.locator('.am-panel').evaluate((el) => el.scrollWidth > el.clientWidth), false)
  await assertTypography()
  await page.screenshot({ path: `${output}/session-target-mobile.png` })
  await page.setViewportSize({ width: 1440, height: 1000 })
  assert.equal(writes.length, beforeTargetSave, 'Session selection must not save implicitly')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.locator('.am-editor').waitFor({ state: 'hidden' })
  const targetWrite = writes.filter((write) => write.method === 'PATCH').at(-1).body
  assert.deepEqual(targetWrite, { confirmSessionTargetChange: true, execution: { target: { mode: 'pinned-session', sessionId: 'fixture-target' } } })
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Target session', exact: true }).waitFor()
  assert.match(await page.getByRole('button', { name: 'Target session', exact: true }).innerText(), /Release planning/)
  await page.getByRole('button', { name: 'Session mode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New session for every run', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), false)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.locator('.am-editor').waitFor({ state: 'hidden' })
  assert.deepEqual(writes.filter((write) => write.method === 'PATCH').at(-1).body.execution.target, { mode: 'fresh' })
  // Failure/retry is local, with no target writes until explicitly confirmed.
  await page.evaluate(() => { window.__automationSessionRefreshError = true })
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Session mode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Use an existing session', exact: true }).click()
  await page.getByText(/Fixture sessions unavailable/).waitFor()
  await page.evaluate(() => { window.__automationSessionRefreshError = false })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.getByText(/Fixture sessions unavailable/).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  // Match Host's actual first-baseline failure: refresh resolves, phase stays
  // pending. Retrying publishes readiness separately via the observable store.
  await page.evaluate(() => {
    window.__automationSessionRefreshPending = true
    window.__automationSetSessionPhase('pending')
  })
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Session mode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Use an existing session', exact: true }).click()
  await page.getByText(/No session list was received/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Target session', exact: true }).isDisabled(), true)
  assert.equal(await page.getByText('Loading sessions…', { exact: true }).count(), 0)
  // A ready snapshot arriving after promise settlement must clear a provisional
  // readiness error without remounting or resetting the user's dirty form.
  await page.evaluate(() => window.__automationSetSessionPhase('ready'))
  await page.getByText(/No session list was received/).waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: 'Target session', exact: true }).isDisabled(), false)
  await page.evaluate(() => window.__automationSetSessionPhase('pending'))
  await page.getByText(/No session list was received/).waitFor()
  await page.evaluate(() => { window.__automationSessionRefreshPending = false })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.getByText(/No session list was received/).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Target session', exact: true }).click()
  await page.getByRole('menuitem', { name: /Forked planning/ }).click()
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), false, 'Selecting a valid destination permits explicit Save without another switch')
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  // Queued/running tasks lock the destination without blocking ordinary edits.
  const firstTask = tasks.find((task) => task.id === 'dependencies')
  firstTask.runs.push({ id: 'fixture-queued', trigger: 'manual', status: 'queued', enqueuedAt: instant(0) })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Session mode', exact: true }).isDisabled(), true)
  await page.getByText('Wait until queued or running work finishes before changing the session.').waitFor()
  await page.locator('.am-editor-disclosure summary').filter({ hasText: /^Message delivery/ }).click()
  assert.equal(await page.getByRole('switch', { name: 'Send via dsh-im', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  firstTask.runs.pop()
  // A missing saved target remains visible and can be repaired by switching fresh.
  firstTask.execution.target = { mode: 'pinned-session', sessionId: 'missing-session', workspaceId: 'fixture-workspace', cwd: '/preview/project', fallback: 'fail' }
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByText('The saved session is unavailable in this workspace. Select another session or use a new session.').waitFor()
  assert.match(await page.getByRole('button', { name: 'Target session', exact: true }).innerText(), /missing-session/)
  await page.getByRole('button', { name: 'Session mode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New session for every run', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.locator('.am-editor').waitFor({ state: 'hidden' })
  // Delivery help is discoverable before enabling, by hover, keyboard, or tap.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const deliveryHelp = page.getByRole('button', { name: 'About message delivery', exact: true })
  assert.equal(await deliveryHelp.locator('svg').count(), 1, 'Help uses the Host question icon, not a text glyph')
  assert.equal((await deliveryHelp.innerText()).trim(), '')
  const helpText = page.getByText('Send Automation results and failure reports through dsh-im installed on the same Host. Configure a bot and save a target in dsh-im first. No pinned Session or two-way sync is required.', { exact: true })
  await deliveryHelp.hover()
  await helpText.waitFor()
  await page.screenshot({ path: `${output}/message-delivery-help.png`, animations: 'disabled' })
  assert.equal(await helpText.evaluate((el) => getComputedStyle(el).opacity), '1')
  await page.mouse.move(0, 0)
  await deliveryHelp.focus()
  await helpText.waitFor()
  await deliveryHelp.click()
  assert.equal(await deliveryHelp.evaluate((el) => el.closest('details').open), false, 'Help must not toggle the section')
  await helpText.waitFor()
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  // Optional direct delivery is independent of fresh/pinned execution and sidebar notifications.
  const openDelivery = async () => {
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.locator('.am-editor-disclosure summary').filter({ hasText: /^Message delivery/ }).click()
  }
  const saveDelivery = async () => {
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.locator('.am-editor').waitFor({ state: 'hidden' })
    return writes.filter((write) => write.method === 'PATCH').at(-1).body
  }
  const confirmation = () => page.getByRole('switch', { name: /^I allow task results and failure reports/ })
  await openDelivery()
  const beforeDeliverySave = writes.length
  await page.getByRole('switch', { name: 'Send via dsh-im', exact: true }).click()
  await page.getByRole('button', { name: 'Bot', exact: true }).click()
  await page.getByRole('menuitem', { name: /feishu · bot-alpha/ }).click()
  await page.getByRole('button', { name: 'Saved target', exact: true }).click()
  await page.getByRole('menuitem', { name: /Report chat · report/ }).click()
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), false)
  assert.equal(await confirmation().count(), 0)
  await page.getByRole('button', { name: 'Saved target', exact: true }).click()
  await page.getByRole('menuitem', { name: /Daily chat · daily/ }).click()
  assert.equal(await confirmation().count(), 0, 'Saving the selected destination is the only confirmation')
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), false)
  await assertTypography()
  await page.screenshot({ path: `${output}/message-delivery.png` })
  assert.equal(writes.length, beforeDeliverySave, 'Delivery selection must not save implicitly')
  assert.deepEqual(await saveDelivery(), { delivery: { botId: 'bot-alpha', targetId: 'daily' }, confirmDeliveryChange: true })
  assert.equal(firstTask.execution.target.mode, 'fresh')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('bot-alpha / daily', { exact: true }).waitFor()

  // Slow responses from a previous bot must not populate the currently selected bot's targets.
  await openDelivery()
  await page.getByRole('button', { name: 'Saved target', exact: true }).click()
  await page.getByRole('menuitem', { name: /Daily chat · daily/ }).click()
  let releaseOldDelivery
  deliveryGates.set('bot-beta', new Promise((resolve) => { releaseOldDelivery = resolve }))
  const oldDeliveryRequest = page.waitForRequest((request) => request.url().includes('/delivery-options?botId=bot-beta'))
  await page.getByRole('button', { name: 'Bot', exact: true }).click()
  await page.getByRole('menuitem', { name: /telegram · bot-beta/ }).click()
  await oldDeliveryRequest
  assert.match(await page.getByRole('button', { name: 'Saved target', exact: true }).innerText(), /Select a saved target/)
  assert.equal(await confirmation().count(), 0)
  await page.getByRole('button', { name: 'Bot', exact: true }).click()
  await page.getByRole('menuitem', { name: /feishu · bot-alpha/ }).click()
  releaseOldDelivery()
  deliveryGates.delete('bot-beta')
  await page.getByRole('button', { name: 'Saved target', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: /Phone chat/ }).count(), 0)
  await page.getByRole('menuitem', { name: /Report chat · report/ }).click()
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), false)
  assert.equal(await confirmation().count(), 0)
  assert.deepEqual(await saveDelivery(), { delivery: { botId: 'bot-alpha', targetId: 'report' }, confirmDeliveryChange: true })

  // A failed discovery request does not block unrelated edits or invent a destination patch.
  deliveryError = true
  await openDelivery()
  await page.getByText(/Fixture delivery options unavailable/).waitFor()
  await page.locator('#am-name').fill('Weekly dependency watch · Delivery')
  assert.deepEqual(await saveDelivery(), { name: 'Weekly dependency watch · Delivery' })
  await openDelivery()
  await page.getByText(/Fixture delivery options unavailable/).waitFor()
  deliveryError = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.getByText(/Fixture delivery options unavailable/).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()

  // Missing saved destinations remain visible; preserving or disabling does not need rediscovery/consent.
  firstTask.delivery = { botId: 'bot-removed', targetId: 'target-removed' }
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await openDelivery()
  await page.getByText(/The saved bot or target is unavailable/).waitFor()
  assert.match(await page.getByRole('button', { name: 'Bot', exact: true }).innerText(), /bot-removed/)
  await page.locator('#am-name').fill('Weekly dependency watch · Saved')
  assert.deepEqual(await saveDelivery(), { name: 'Weekly dependency watch · Saved' })
  await openDelivery()
  await page.getByText(/The saved bot or target is unavailable/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Bot', exact: true }).isDisabled(), false)
  await page.getByRole('button', { name: 'Bot', exact: true }).click()
  await page.getByRole('menuitem', { name: /feishu · bot-alpha/ }).click()
  await page.getByRole('button', { name: 'Saved target', exact: true }).click()
  await page.getByRole('menuitem', { name: /Report chat · report/ }).click()
  assert.deepEqual(await saveDelivery(), { delivery: { botId: 'bot-alpha', targetId: 'report' }, confirmDeliveryChange: true })
  deliveryAvailable = false
  await openDelivery()
  await page.getByText(/dsh-im delivery is unavailable/).waitFor()
  await page.getByRole('switch', { name: 'Send via dsh-im', exact: true }).click()
  assert.equal(await confirmation().count(), 0)
  assert.deepEqual(await saveDelivery(), { delivery: null })
  assert.equal(firstTask.delivery, undefined)
  deliveryAvailable = true
  await page.getByRole('textbox', { name: 'Search automations' }).fill('no matching task')
  await page.getByText('No automation matches “no matching task”.').waitFor()
  await page.getByRole('button', { name: 'Show all tasks' }).click()
  assert.equal(await page.locator('.am-row').count(), 4)
  await page.locator('.am-list-tools').getByRole('button', { name: 'Paused', exact: true }).click()
  assert.equal(await page.locator('.am-row').count(), 1)
  await page.locator('.am-list-tools').getByRole('button', { name: 'All', exact: true }).click()
  await page.setViewportSize({ width: 820, height: 680 })
  assert.equal(await page.locator('.am-detail-pane').isVisible(), true)
  assert.equal(await page.locator('.am-panel').evaluate((el) => el.scrollWidth > el.clientWidth), false)
  await assertTypography()
  await page.screenshot({ path: `${output}/tablet.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  if (await page.getByRole('button', { name: 'Back to list', exact: true }).isVisible()) await page.getByRole('button', { name: 'Back to list', exact: true }).click()
  await page.locator('.am-row').first().click()
  await assertTypography()
  assert.equal(await page.locator('.am-header > button').evaluateAll((buttons) => buttons.every((button) =>
    button.scrollHeight <= button.clientHeight && button.scrollWidth <= button.clientWidth)), true, 'Header actions must not wrap or clip on mobile')
  await page.screenshot({ path: `${output}/mobile-detail.png` })
  assert.equal(await page.locator('.am-panel').evaluate((el) => el.scrollWidth > el.clientWidth), false)
  await page.getByRole('button', { name: 'Back to list', exact: true }).click()
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
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByText(/Fixture options unavailable/).waitFor()
  optionError = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.getByText(/Fixture options unavailable/).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  // Lifecycle controls are exercised only against local fixture responses.
  await page.getByRole('button', { name: 'Run now', exact: true }).click()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(tasks.length, 4)
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete task', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.am-row').length === 3)
  assert.ok(writes.some((write) => write.method === 'DELETE'))
  tasks = []
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('heading', { name: 'Start with an idea' }).waitFor()
  const emptyBox = await page.locator('.am-panel').boundingBox()
  assert.equal(await page.locator('.am-example > svg').count(), await page.locator('.am-example').count(), 'Each example has an explicit Host launch icon')
  assert.equal(await page.locator('.am-example').first().evaluate((el) => getComputedStyle(el, '::after').content), 'none', 'No font-dependent arrow pseudo-element remains')
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
  await page.getByRole('heading', { name: 'Could not load tasks' }).waitFor()
  await assertTypography()
  await page.screenshot({ path: `${output}/error.png` })
  listError = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.getByRole('heading', { name: 'Start with an idea' }).waitFor()
  await page.getByRole('button', { name: 'New automation', exact: true }).click()
  await page.waitForFunction(() => window.__automationOpenedSession === 'fixture-new-session')
  assert.equal(await page.locator('.am-panel').count(), 0)
  assert.deepEqual(errors.filter((message) => !message.includes('AUTOMATION_TEST_BOOT_STOP')), [])
  console.log(`PASS: actual bundle against ${base}; overview/history/settings, editor save/discard, filters, mobile, dark, empty, error/retry. All writes intercepted (${writes.length}). Screenshots: ${output}`)
} finally {
  await browser.close()
}
