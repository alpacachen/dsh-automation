# Automation UI and interaction optimization plan

> Target files: `src/client/index.tsx`, `src/client/styles.css`, `src/client/locales.ts`.
> The plugin runs inside DSH Web and must use `--dsw-*` design tokens. Improve information architecture, spacing and meaningful components instead of adding colors or fonts.
>
> Historical implementation status: P0 (card restructuring and eight fixes) and P1 (run health strip and sectioned editor) landed with this PR. P2 (filters, search and empty-state guidance) remained pending; see section 5. Line references below describe that review snapshot.

## 1. Diagnosis

### Information overload

Each task card shows eight fact rows, the latest result, up to seven buttons and collapsible history (`index.tsx:851-1015`). The three primary questions—task name, next run and current status—are obscured by technical details.

| Existing display | Problem |
| --- | --- |
| `automation-<uuid>` at line 848 | Internal identifier dominates the overview |
| Full workspace cwd at line 861 | Filesystem detail crowds the main view |
| Combined provider/model/skills at line 876 | Difficult to scan; three facts share a shield icon |
| Always-visible consecutive failures at line 883 | Adds noise when zero |
| Shield icon for permission, execution and notifications | Conflicting semantics |

### Too many equal-weight actions

The actions row (lines 904-974) lists run, stop, pause, resume, resume-and-run, open latest session, edit and delete. Only Run now has primary styling. Destructive and infrequent actions compete with the main controls.

### Heavy inline editor

Editing expands around fifteen fields within a card in a 600px drawer (`EditTaskForm`, lines 290-636). Agent settings, multiple skills, visual RRULE editing and permission confirmation require a dedicated editing surface.

### Ambiguous states

Scheduling states (`active`, `paused`, `completed`) and run states (`running`, `succeeded`, `failed`, etc.) share pill styling (`statusClass`, line 257). The Chinese translation of `statusActive` at `locales.ts:272` incorrectly means running. An enabled but idle task therefore looks like an executing task. Translate active as enabled; reserve running for active execution.

### Polling flicker

Every refresh, including five-second background polling, sets loading to true (line 663) and marks the panel busy. List rerenders can reset scroll or flash empty/loading states.

### Icon semantics

The close icon also represents stopping runs and consecutive failures. Clock represents both navigation and upcoming runs; shield is reused for unrelated facts.

### Creation is not explained

New automation and three examples open a conversation and prefill an agent prompt instead of opening a creation form (`startExample`, line 726). The small `exampleDraftHint` does not adequately explain this transition.

### Accessibility and detail

- The dialog at line 756 has `aria-modal` but no focus trap or focus restoration.
- State and history dots rely on color without text alternatives.
- Frequent 11px/12px labels and 30px buttons are dense and small for touch input.

## 2. Design direction

### Purpose and audience

This is a scheduler for one-time and recurring agent work, aimed at developers checking task health from the sidebar. Make health and next-run timing immediately clear, with quick run, pause and edit actions.

### Host tokens and typography

Continue using host color and font tokens. Strengthen hierarchy with task names at 15–17px/600, metadata at 12–13px and auxiliary timestamps at 11px. The existing 15px name and 12px facts provide insufficient hierarchy.

Arrange cards as a name/status/next-run header, a health strip, a short summary and prioritized actions. Move technical details into a disclosure or editor.

### Run health strip

Summarize the last N results as colored segments: green for success, red for failure/timeout, gray for interrupted/unknown and blue for running. Hover reveals the summary, error and duration. Preserve full history behind a secondary disclosure, collapsed initially.

The strip makes persistent failures or a new failure after a successful streak easy to see. Pair it with prominent relative next-run time and smaller absolute time/time-zone details.

## 3. Component changes

### 3.1 Sidebar action

Preserve the icon and unread badge, showing its number only above zero. Consider the existing calendar icon to distinguish scheduled work from a generic clock.

### 3.2 Panel header

Preserve Automations and task count. Explain that New opens a guided conversation. Add a segmented All/Active/Paused/Completed filter and name search as the list grows.

### 3.3 Task card

```text
+-----------------------------------------------+
| Task name                         Status      |
|                                               |
| Next run: 2h 15m                              |
| Tomorrow 09:00, Asia/Shanghai                  |
|                                               |
| Recent run health strip                       |
| Latest result: one-sentence summary            |
|                                               |
| [Run now] [Pause]                 [...]        |
+-----------------------------------------------+
```

Remove raw task IDs, full cwd, combined provider/model/skills, always-zero failure counts and duplicate shield facts from the main surface. Preserve these details in an expandable area. Show the workspace name, concise permission description and a preset tag only when it differs from the default.

Distinguish scheduling state from execution: the pill represents enabled/paused/completed, while the health strip or pulse represents execution.

### 3.4 Actions

Use Run now as the primary action. Show one relevant contextual control: pause/resume or stop. Put edit, open latest session and delete in the overflow menu. Preserve deletion confirmation.

### 3.5 Sectioned editor

Open a full-width second view or a real modal instead of expanding within a card. Order sections by frequency and risk:

1. Name and prompt; give the prompt at least five rows.
2. Schedule: one-time/recurring, visual RRULE builder and collapsed advanced mode.
3. Execution: preset, provider, model and skills; collapsed initially unless overriding host defaults.
4. Notification and failure policies.
5. Permissions: prominent risk/approval warning and the existing confirmation checkbox.

Keep Save visible at the bottom. Include Cancel and protection against discarding changes.

### 3.6 Empty state and examples

Keep all three outcome-oriented examples. Add a chat cue explaining that clicking opens a conversation, the prompt is editable and nothing is sent automatically. Provide New automation as another primary entry point.

### 3.7 Loading and polling

Separate initial loading from silent refresh. Initial loading may show a skeleton and `aria-busy`; five-second background updates must not reset loading or scroll position.

### 3.8 Relative time and localization

Add relative time alongside `formatDate`'s absolute time (line 182). Correct the Chinese active label to mean enabled, keeping the running label for actual execution.

## 4. Required fixes

| # | Location | Problem | Fix |
| --- | --- | --- | --- |
| 1 | `locales.ts:272` | Active translation means running | Translate it as enabled |
| 2 | `index.tsx:663` | Polling sets loading every five seconds | Separate initial load and silent refresh |
| 3 | `index.tsx:876,871,878` | Three unrelated shield icons | Permission: shield; execution: robot/CPU; notifications: bell |
| 4 | `index.tsx:884` | Close icon means failure count | Remove or use a warning icon; hide at zero |
| 5 | `index.tsx:848` | Raw UUID in overview | Move to details with Copy ID |
| 6 | `index.tsx:756` | Missing focus trap/restore | Add both |
| 7 | `styles.css` | Small button targets | Main buttons at least 36px; icon buttons at least 34px |
| 8 | `index.tsx:467` | Four-row prompt textarea too small | Increase height and explain its role |

## 5. Implementation sequence

1. **P0:** restructure cards and actions (3.3/3.4); highest benefit, medium risk.
2. **P0:** the eight correctness/accessibility fixes; low risk.
3. **P1:** health strip and prominent relative time.
4. **P1:** independent sectioned editor.
5. **P2:** filtering and search.
6. **P2:** empty-state guidance.

Each phase can be reviewed and merged independently.

## 6. Decisions to confirm

1. Prefer a full-width second view within the panel, preserving the DSH drawer context, rather than a native browser modal.
2. Implement and review P0 first, then decide whether to continue with P1/P2.
