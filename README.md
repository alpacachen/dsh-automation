<div align="center">

# dsh-automation

### Schedule future Agent work in DSH with one sentence.

Run one-time or recurring tasks. Runs use a fresh visible session by default, or a confirmed pinned persisted session with no fresh fallback.

[![npm version](https://img.shields.io/npm/v/@alpacachen/dsh-automation?color=5b8def&label=npm)](https://www.npmjs.com/package/@alpacachen/dsh-automation)
![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-22c55e)

[Simplified Chinese](README.zh.md) · **English**

</div>

## ✨ Highlights

- 🗣️ **Create naturally** — tell an Agent what to do and when.
- 🗓️ **Schedule precisely** — one-time instants, RFC 5545 recurrence, and IANA time zones.
- 🧼 **Start fresh by default** — each run starts a new session unless an existing session is selected.
- 👀 **Stay informed** — see result summaries, duration, errors, history, and session links in one place.
- 🛡️ **Limit access** — choose any permission preset advertised by the DSH Host for each task.
- 🤖 **Choose execution** — optionally pin an Agent preset, provider/model pair, and ordered skills.
- 📌 **Manually select an existing Session** — bind a task to a conversation in the same workspace so future runs continue there instead of creating new sessions.
- 🧭 **Start with guidance** — use outcome-focused templates or a guided creation conversation.
- 🎛️ **Stay in control** — edit, run, pause, resume, or delete tasks from the UI.

## 🚀 Quick start

### 1. Install

```sh
dsh plugin --profile web add @alpacachen/dsh-automation
```

### 2. Restart DSH

Restart `dsh web` so the plugin can load.

### 3. Ask an Agent

> Tomorrow at 9:00 AM in Asia/Shanghai, review this workspace for release blockers and create a one-time automation.

Or:

> Every weekday at 6:00 PM, summarize today's changes and open work. Report only; do not modify files.

After creation, open **Automations** in the sidebar to manage the task.

Use **New automation** at any time for a guided setup, or choose a result-focused template in the empty state. Before creation, the Agent previews the name, schedule and time zone, workspace, Agent preset, provider/model, selected skills, exact Host permission, notifications, and failure-pause policy, then waits for confirmation.

## 📌 Manually select an existing Session

Runs create fresh sessions by default. In **Edit → Execution destination**, you can manually select and confirm an existing Session in the same workspace. Future runs retain its context and Agent/model configuration while applying the task's permissions. Agents cannot change this setting; a busy or unavailable target fails without creating a replacement.

### 📱 Pair with dsh-im

One use for an existing Session is pairing with [dsh-im](https://github.com/xmanrui/dsh-im) to deliver water reminders, daily briefings, and other scheduled results to your phone:

- Enable **session two-way sync** on the corresponding dsh-im private-chat target (off by default).
- Select **the same Session currently bound to the IM chat** as the automation destination, and keep DSH and the bot connection running.
- Use **Run now** once to verify phone delivery; recheck the task binding after switching IM sessions.

> Compatibility: dsh-im must also support Automation-origin plugin turns. Versions that mirror only user-origin turns skip these replies even with two-way sync enabled. See the [dsh-im guide](https://github.com/xmanrui/dsh-im/blob/main/PROACTIVE_DELIVERY.en.md) for configuration details.

## 🎛️ Manage and edit

Each task card lets you:

- change the name, prompt, or schedule;
- run now, pause, resume, or resume and run;
- open the latest session or any recent run;
- choose failure-only, every-completion, or no sidebar notifications;
- choose a saved Agent preset, provider/model pair, and ordered skills, or follow Host defaults;
- see or change any Host permission preset for future runs; actual permission changes require confirmation;
- retry failed runs and optionally pause after three consecutive failures;
- delete future scheduling while keeping existing sessions.

![Automation task list, run state, and quick actions](docs/screenshots/automation-list.png)

### Visual recurrence editor

Common schedules do not require writing RRULE by hand:

| Settings | Meaning |
| --- | --- |
| Daily · every `1` day | Run every day |
| Weekly · every `3` weeks · Monday–Friday | Every third week, run Monday through Friday |
| Monthly · every `2` months · day 15 | Run on day 15 every two months |

You can also stop after a number of runs or on a date. Use **Advanced RRULE** for uncommon rules.

![Visual recurrence editor](docs/screenshots/schedule-editor.png)

## ⏱️ How runs work

```text
Schedule due → Global queue → Fresh or pinned persisted session → Agent runs → Result and session link recorded
```

- Automations run globally one at a time and never overlap.
- Runs time out after one hour by default; set `maxRunDurationMs` in plugin config to change the limit.
- Queued or running work can be stopped without moving its future schedule.
- A run active during an unexpected restart is marked **outcome unknown** instead of being reported as failed or retried.
- Notification-worthy results add a persistent unread badge to the Automations sidebar action.
- Successful runs clear the consecutive-failure count; tasks can optionally auto-pause after three failures or timeouts.
- DSH must be running when work is due; after restart, only the latest missed occurrence runs.
- Transient scheduler failures retry automatically with bounded exponential backoff.
- Paused occurrences are skipped; **Resume & run** does not move the original schedule.
- Fresh-session runs load the current definitions of selected skills; pinned-session runs keep the target's existing configuration without reinjecting them. Required execution settings that are unavailable fail the run instead of falling back.
- Permission presets with `approval: ask` remain interactive: unattended runs never auto-approve and may wait until the run timeout.
- Existing state stays at version 1. Older tasks are normalized in memory without a startup rewrite and retain their saved execution and permission settings.

## 🗓️ Schedule formats

| Type | Parameters | Example |
| --- | --- | --- |
| One-time | `once_at` | `2026-09-01T01:00:00.000Z` |
| Recurring | `rrule` + `time_zone` + `start_at` | `FREQ=WEEKLY;BYDAY=MO,WE,FR` |

- `once_at` is an RFC 3339 UTC instant.
- `rrule` is one RFC 5545 rule without `DTSTART`.
- `time_zone` is an IANA zone such as `Asia/Shanghai`.
- `start_at` is local wall-clock time in `YYYY-MM-DDTHH:mm:ss` form.

## 🧰 Agent tools

| Tool | Purpose |
| --- | --- |
| `automation_options` | List current Host Agent, model, skill, and permission options |
| `automation_create` | Create after confirming optional `agent_preset`, `provider`/`model`, ordered `skills`, permission, and policies |
| `automation_update` | Set or clear execution overrides and replace skills; permission changes require confirmation |
| `automation_list` | List tasks and current run state |
| `automation_run` | Queue one immediate run without changing the schedule |
| `automation_pause` | Pause future scheduling |
| `automation_resume` | Resume, optionally with one immediate run |
| `automation_delete` | Delete the task and cancel future scheduling |

## 💡 Example requests

> “Every Monday at 9:30 AM, check dependencies for important updates.”

> “Move the release check to Friday at 4:00 PM.”

> “Resume the daily handoff and run it once now.”

> “List all automations and pause the dependency check.”

The built-in release readiness, dependency watch, and daily handoff templates remain editable drafts; selecting one never sends it automatically.

## License

MIT
