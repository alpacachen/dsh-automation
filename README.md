<div align="center">

# dsh-automation

### Tell your agent what should happen. Let it come back on time.

Durable one-time and recurring automations for DeepSeek Harness. Each run wakes a fresh Agent in a new, visible DSH session—ready to work without dragging yesterday's conversation along.

[![npm version](https://img.shields.io/npm/v/@alpacachen/dsh-automation?color=5b8def&label=npm)](https://www.npmjs.com/package/@alpacachen/dsh-automation)
![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
[![CI](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
![License](https://img.shields.io/badge/license-MIT-22c55e)

[简体中文](README.zh.md) · **English**

</div>

## ✨ Give future work to a future Agent

Some work should happen later: a release check tomorrow morning, a dependency review every Monday, or a daily summary before stand-up. dsh-automation lets you schedule that work in the same place you already describe it—your DSH conversation.

Tell an Agent what to do and when. The plugin remembers the task, waits in the DSH process, then opens a brand-new session when the time arrives. The complete conversation and tool history stay visible in the workspace tree.

| 💬 Schedule naturally | 🗓️ Keep real calendar time | 🔎 See every run |
| --- | --- | --- |
| Only Agents create tasks, so a plain-language request is enough. | RFC 5545 recurrence rules follow an IANA time zone across daylight-saving changes. | Every attempt has status, time, errors, and a link to its DSH session. |
| **🧼 Start fresh** | **🎛️ Stay in control** | **💾 Survive restarts** |
| Each run gets a new session with no previous chat history. | Run now, pause, resume, resume and run, inspect history, or delete from the UI. | Versioned JSON state and latest-only catch-up keep schedules durable and predictable. |

## 🚀 Get started in three moves

### 1. Install

```sh
dsh plugin --profile web add @alpacachen/dsh-automation
```

Restart `dsh web` so the plugin bundle is loaded. To inspect the mounted profile:

```sh
dsh --profile web --dump-config
```

### 2. Ask an Agent to schedule something

Try a one-time task:

> Tomorrow at 9:00 AM Shanghai time, review this workspace for release blockers and summarize them. Create a one-time automation.

Or a recurring routine:

> Every weekday at 6:00 PM in Asia/Shanghai, review today's changes and prepare a short handoff. Do not modify files.

The Agent calls `automation_create`, confirms the canonical schedule, and returns the task ID.

### 3. Open Automations

Choose **Automations** in the DSH sidebar. The management drawer shows what is active, what runs next, and what happened before.

From there you can:

- run a task immediately;
- pause or resume its calendar schedule;
- resume a paused task and run it once now;
- open the latest session or any recent run;
- delete future scheduling without deleting existing run sessions.

The UI follows the current DSH language, light/dark theme, typography, colors, and interaction patterns.

## ⏱️ How a run travels

```text
Schedule becomes due
        ↓
Run enters the global queue
        ↓
A fresh persisted DSH session is created
        ↓
The prompt runs with danger-full-access and no approval prompts
        ↓
Status and session link are recorded in Automations
```

Runs execute one at a time across the plugin. A slow task cannot overlap another automation run, and each completed session remains available in the workspace tree.

## 🗓️ Scheduling model

| Schedule | Required fields | Meaning |
| --- | --- | --- |
| **One time** | `once_at` | One canonical RFC 3339 UTC instant. |
| **Recurring** | `rrule`, `time_zone`, `start_at` | An RFC 5545 rule anchored to local wall-clock time in an IANA time zone. |

One-time input:

```json
{
  "name": "Release review",
  "prompt": "Review the current workspace release and report blockers.",
  "once_at": "2026-09-01T01:00:00.000Z"
}
```

Recurring input:

```json
{
  "name": "Weekday handoff",
  "prompt": "Review today's changes and prepare a concise handoff. Do not modify files.",
  "rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=0",
  "time_zone": "Asia/Shanghai",
  "start_at": "2026-09-01T18:00:00"
}
```

DSH must be running when work is due. After downtime, a recurring task runs only its latest missed occurrence instead of replaying a backlog. Paused occurrences are skipped. **Resume & run** performs one immediate run without moving the calendar anchor.

## 🧰 Agent tools

| Tool | What it does |
| --- | --- |
| `automation_create` | Create a one-time or recurring task for the current workspace. |
| `automation_list` | List tasks, schedules, next-run times, and recent history. |
| `automation_pause` | Stop future scheduling without deleting the task. |
| `automation_resume` | Resume scheduling, optionally with one immediate run. |
| `automation_delete` | Permanently remove the task and cancel future scheduling. |

Task creation is intentionally Agent-only. The UI focuses on safe day-to-day operation of tasks that already exist.

## 💡 Things to ask your Agent

> “At 10:00 tomorrow, run the full test suite and explain any failures.”

> “Every Monday at 9:30 AM, check our dependencies for important updates. Report only; do not edit files.”

> “Show me all automations in this workspace and pause the release reminder.”

> “Resume the weekly review and run it once right now.”

> “Delete the old stand-up automation. Keep its previous sessions.”

## 💾 Persistence and recovery

State lives at:

```text
$DSH_HOME/automation/state.json
```

The versioned JSON snapshot stores task definitions, schedule state, and the latest 20 run summaries. Writes are serialized and atomically replaced. Full conversations and tool history remain in DSH's normal session persistence.

The scheduler is entirely in-process: no cron, launchd, systemd, Windows Task Scheduler, database, or external worker is involved.

## ⚠️ Full-access automation

> [!WARNING]
> Every scheduled and manual run intentionally uses `danger-full-access` with approval disabled. A task prompt can execute commands and modify files with the current operating-system user's authority. It does not bypass OS permissions, sudo, OAuth, or missing credentials.

Write unattended prompts as carefully as you would write a shell script. When a task should only inspect data, say so explicitly.

## 🧑‍💻 Development

```sh
pnpm check
pnpm test
pnpm test:coverage
pnpm build
```

The suite covers persistence failures, RRULE and daylight-saving behavior, missed runs, pause/resume, immediate runs, global serialization, long timers, restart recovery, Agent session creation, tools, management API, localization, and DSH-aligned UI styling.

For local profile development:

```sh
pnpm build
cd "$DSH_HOME/profiles/web"
pnpm add '@alpacachen/dsh-automation@link:/absolute/path/to/automation'
```

## 📦 Releasing

CI validates every pull request and push to `main`. Bumping the stable SemVer in `package.json` triggers the release workflow: test, build, npm publish with provenance, Git tag, and GitHub Release—no npm token required.

## License

MIT
