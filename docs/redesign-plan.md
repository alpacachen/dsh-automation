# Automation UI redesign plan

## Diagnosis

The review of `src/client/index.tsx` (1,258 lines) and `styles.css` (1,452 lines) identified five problems:

1. **Large single-column cards are hard to scan.** Each card stacks a title, status, next run, health strip, latest result, four action buttons and two disclosure sections. Three tasks fill a screen; ten require extensive scrolling.
2. **Details are buried in disclosures.** Native `<details>` elements lack persistent state and collapse after five-second polling updates. Workspace and permission details require repeated expansion.
3. **No search, filters or sorting.** Tasks follow the arbitrary order of server-side `Object.values`.
4. **Editing stacks dialogs.** Native selects and checkboxes do not match the host design.
5. **CSS duplicates host components.** Buttons, state dots, chips, modals and menus already exist in `@deepseek-ai/dsh-client-ui-primitives`, a module supplied directly by the host runtime without extra bundle size or module-table risk.

The host's `dsh-client-ui-schedule` uses only `primitives` and `react` at runtime, declares primitives in `dsh.client.inject`, and retains only Cordis as a peer.

## Target: two-column master-detail layout

Keep `shell.overlay`: `sidebar.right.pane.tab` is a session-scoped resource viewer, while automations are a global list. Change the panel contents.

```text
+-----------------------------------------------------------------------+
| Automations   12 tasks   Scheduler healthy       [New] [Refresh] [Close]|
+-----------------------+-----------------------------------------------+
| Search                | Daily release check                 Running   |
| All Active Paused Done| Next run: in 2 hours                          |
|                       | 2026-09-11 18:00 Asia/Shanghai                 |
| Daily release check   | Recent 12 run results                         |
|   in 2 hours          | [Run now] [Pause] [Edit] [...]                 |
| Dependency watch   !2 |                                               |
|   tomorrow 09:00      | Latest result                                 |
| Handoff summary       | Checked 14 packages; 2 need updates           |
|   completed           |                                               |
|                       | Overview                                      |
|                       | Schedule: daily, Asia/Shanghai                |
|                       | Workspace: automation; permission: read only  |
|                       | Execution: fresh session; notify: failures    |
|                       | Agent: defaults; no skills                    |
|                       | Task ID: a1b2c3... [Copy]                      |
|                       |                                               |
|                       | Run history (23)                              |
|                       | > Succeeded, scheduled, 1m12s, 09-11 08:00     |
|                       | > Failed, manual, 4s, 09-10 22:31              |
+-----------------------+-----------------------------------------------+
```

A compact, scannable task list sits on the left. The selected task's details are visible on the right by default. This addresses density, scanning and lost disclosure state together.

## Information placement

Preserve all existing functionality and information. The following tables map existing elements and identify newly exposed fields.

### Panel

| Existing element | Placement |
| --- | --- |
| Sidebar action and unread badge | Unchanged: `sidebar.footer.action` |
| Title and `taskCount` | Panel header |
| Error banner | Persistent banner below the header |
| Scheduler retrying/stopped banner | Persistent health dot plus a banner on failure; healthy state becomes visible too |
| Previously hidden scheduler fields | Health HoverCard: `consecutiveFailures`, `lastFailedAt`, `retryAt` |
| Loading | List skeleton and header `IconLoadingOutline16` |
| Empty state, three examples, `exampleDraftHint` | Preserve across the full panel width |
| New action | Header; disable when `workspaceId === undefined` and explain with a Tooltip |
| Refresh and close | Header |

### Compact task rows

Show a state dot, name, relative next-run time, consecutive-failure chip and a menu with run/pause/resume/edit/delete actions.

Sort running tasks first, then by ascending `nextRunAt`, with null values last. Search name and prompt, and filter through status Pills.

### Task details

| Existing element | Placement |
| --- | --- |
| Name, status and failure chip | Detail header |
| Relative/absolute `nextRunAt` and time zone | Prominent next-run block; show `—` for null |
| Twelve-segment health strip with native title | Preserve with Tooltip components for consistent timing and styling |
| Latest result summary | Separate section |
| Run/stop/pause/resume/resume-and-run | Primary action row |
| Open latest session/edit/delete | Action row and overflow menu |
| Inline deletion confirmation that shifts layout | Modal |
| Nine detail facts | Visible overview grid: schedule, workspace cwd, execution target, permission, agent execution, notifications, consecutive failures, pause policy, task ID and copy |
| Previously hidden task fields | `createdAt`, `createdBySessionId`, `pausedAt`, `pausedNextRunAt` |
| Recent runs | DisclosureRow per run: status, trigger, duration and time when collapsed; summary, error, enqueue/start/finish times, execution target and run ID when expanded |
| Per-run retry and open-session actions | Preserve inside expanded rows |

### Editor

Replace stacked dialogs with inline editing in the right pane. Keep the list visible so the selected task remains clear. Preserve every field:

- Basics: name and prompt.
- Schedule: once/recurring; `fireAt`; visual/advanced RRULE mode; frequency, interval, weekdays, monthDay, ends (never/count/until), count, until, timeZone, startAt and unsupported-rule hints.
- Agent execution: agentPreset with trust/description/broken/unavailable indicators; provider; model with `notInCatalog`; skills with description, `modelInvocable` and unavailable indicators; model failures and options loading/error states.
- Notifications: the three notification policies and pause-after-failures.
- Permissions: preset, description, sandbox, approval, the `approval === 'ask'` warning and explicit confirmation of changes.

Use primitives: a Menu-based Select shared by eight enum selectors; active Pills for weekdays; Switch for pause-after-failures; a searchable skill checklist with selected Tag chips; and Pills for rule modes.

Preserve the save condition: changed values, valid configuration and confirmed permission changes.

## Implementation notes

**Dependencies:** add `@deepseek-ai/dsh-client-ui-primitives` to `dsh.client.inject` and `^0.1.5-rc.2` to devDependencies for typechecking. Do not add it as a peer, following the official schedule plugin. The esbuild `@deepseek-ai/*` external rule leaves its require for the host runtime. Unlike the earlier discontinued `dsh-client-runtime` package, primitives is a host-supplied module.

**Icons:** replace more than twenty custom SVGs with verified primitives icons. Keep the shield, bell and calendar drawings where semantic equivalents are unavailable. Reduce `iconPaths` from eighteen entries to three.

**Polling:** replace separate five-second sidebar and panel requests with one shared store. Poll every five seconds while open and every thirty seconds while closed, keeping counts consistent.

**Responsive layout:** below approximately 880px, show one pane; details replace the list and include a back button.

**CSS:** retain layout and styles not covered by primitives, using only `--dsw-*` tokens. Target roughly 450 lines instead of 1,452.

**Accessibility:** preserve focus trapping, `aria-modal`, `aria-live` and Escape handling; add Up/Down keyboard navigation in the list.

## Unchanged scope

Do not change `controller.ts`, `scheduler.ts`, `runner.ts`, `api.ts` or `store.ts`. Keep REST behavior: there is no task-creation POST endpoint, so creation continues through a conversation draft that guides the agent. Reuse the 288 existing locale keys and add approximately fifteen for new fields, search and filters, keeping English and Chinese in sync.

## Implementation sequence

1. Add the primitives declaration and move the planned version to `0.3.20`.
2. Add English and Chinese locale entries.
3. Introduce shared client primitives: Select, icon aliases and status-to-tone/state mappings.
4. Split `index.tsx` into TaskList, TaskDetail, TaskEditor, AutomationPanel and SchedulerHealth.
5. Rewrite `styles.css`.
6. Build and typecheck; confirm the only added host-supplied require is primitives.
7. Hand off for manual testing.

## Decision to confirm

Prefer inline editing in the right pane, keeping the task list visible and avoiding stacked dialogs. A full-screen Modal offers more room for the large form and remains the alternative if preferred.
