# Automation — a quiet task inbox

Audience: DSH users delegating recurring workspace work. The single job is to understand what will happen next and inspect its result without reading runtime configuration.

## Direction

Use the host theme, not a separate branded dashboard. Reference palette (host tokens take precedence): paper #FFFFFF, mist #F6F7F9, ink #20242C, secondary #687080, rule #E8EBF0, focus blue #4168D4. Status colors remain host semantic colors. Typography (revised after user review): use the host sans family throughout. Panel text, controls, metadata, section labels and counts: 13px / 400. Panel/task/empty-state headings: 16px / 500. No Avenir override, display tracking, per-widget bold treatment, or tiny 11/12px labels. Technical IDs alone retain host monospace at 13px; sidebar navigation keeps the shell's 14px.

```
Automations                       New automation   ×
Tasks · count                            Scheduler
--------------------------------------------------
Search tasks       | Task name             Edit  …
All Active Paused  | status · workspace
                   | Next run — date + schedule
Task name          | Run now    Pause
status · next run  | Overview  Run history  Settings
Task name          | Instructions
                   | Latest result
```

Signature: a quiet next-run strip joins the human schedule and its next occurrence; this is a task inbox, not a metrics dashboard. Do not add decorative statistics, gradients, oversized icons, or nested cards.

## Critique before implementation

The prior master/detail structure is useful; a card grid would hide scan order and waste space. Keep the split view but remove the tinted sidebar, shadows on selected rows, repeated edit actions and always-visible fact grid. Use underline navigation instead of more pill containers. Keep full configuration available in a dedicated detail view. In the editor expose basics and schedule first, with advanced groups progressively disclosed. Unsaved changes must survive accidental navigation via confirmation. Small-screen layout must present one pane and retain a back action.

## Density refinement after user review

The user approved the quiet visual direction but found the modal too large for its contents. Preserve the palette, type roles, and next-run strip; tighten the container rather than shrinking body text or adding filler.

- Desktop canvas: 940 × 640 instead of 1120 × 800 (about 33% less area); list: 260 instead of 310px.
- Title and task count share a row; header padding drops from 24 to 14px vertically.
- Detail padding: 22px horizontally; sections: 14px vertically. Keep task instructions at 14px.
- Empty/loading/error panels use a separate 640px-wide, content-height layout, capped to the viewport.
- One-pane breakpoint moves to 760px so intermediate widths retain a compact modal rather than becoming an unnecessarily full-screen view.
- Browser regression adds exact panel dimensions, compact empty-state size, 820px intermediate layout and short-viewport overflow checks.
- At this follow-up, Automation is present in the live 3080 graph. After refreshing the existing GUI, confirmed the real panel measures 940 × 640 CSS pixels; no task execution was requested. Updated the isolated browser harness to replace an already-registered plugin factory safely.

## Typography refinement after user review

The density pass still mixed five sizes and four weight treatments. The user rejected that fragmentation. Keep the compact layout; remove type styling rather than adding another visual motif. Unify panel typography into the two roles above, including nested Host button/pill labels. Active tabs keep an underline instead of becoming bold; next-run values, section headings, task rows and result text use the same regular weight. Reading text shares a 1.6 line-height. Mobile uses the same scale, without its own title sizes.

Browser tests now inspect computed font family/size/weight for actual rendered text and controls across overview, configuration, history, editor, mobile, dark, empty and error screenshots. Host monospace for IDs is an explicit exception, not a third prose family.

## Verification

Typecheck, existing regression tests, build the real plugin bundle. Verify desktop, mobile, empty/loading/error, navigation, editor discard, and advanced sections. Never execute real scheduled work merely for a UI test. Current 3080 profile initially has no Automation installed; deployment verification must distinguish actual loaded code from fixture-only testing.

## Results

- Rebuilt `lib/client.js`; typecheck, all 83 regression tests and host-token audit pass. Live 3080 computed styles confirm one sans family and exactly 13px/400 plus 16px/500 in the overview.
- Added `scripts/test-ui-browser.mjs`: loads the actual local client bundle against the existing 3080 shell, React, primitives and theme sheets. Stops live shell boot and intercepts all API traffic; only fixture task/session callbacks execute.
- Browser coverage: overview/history/settings, keyboard row navigation, Escape/discard/keep editing, save, advanced disclosure, search/status filters, manual run/pause/resume/delete confirmation, new-task conversation handoff, empty/load-error/options-error and retries, 390px mobile, light/dark themes. Screenshots are review fixtures, not the user's task data.
- Installed the local plugin using the supported `plugin --profile web add link:/Users/chenxiang/Projects/dsh/automation` command after user confirmation. Verified dependency and bundle registration in the profile.
- Existing server was NOT restarted; no real scheduler was activated. The profile change takes effect after the existing DSH server restarts. Live scheduler/backend integration is not claimed by the fixture browser test.

### Re-run browser checks

Build first, then run `node scripts/test-ui-browser.mjs` with Playwright available. Optional environment variables: `PLAYWRIGHT_MODULE` (module path), `CHROME_PATH` (browser executable), `DSH_TEST_URL` (default existing 3080), `DSH_TEST_COOKIE` (local authenticated GUI cookie, supplied in the environment only), and `UI_SCREENSHOT_DIR` (defaults to `/tmp/automation-ui-review`). Do not commit authentication values. No replacement server is started.
