<div align="center">

# dsh-automation

### Schedule future Agent work in DSH with one sentence.

Run one-time or recurring tasks. Every run opens a fresh, visible DSH session.

[![npm version](https://img.shields.io/npm/v/@alpacachen/dsh-automation?color=5b8def&label=npm)](https://www.npmjs.com/package/@alpacachen/dsh-automation)
![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-22c55e)

[简体中文](README.zh.md) · **English**

</div>

## ✨ Highlights

- 🗣️ **Create naturally** — tell an Agent what to do and when.
- 🗓️ **Schedule precisely** — one-time instants, RFC 5545 recurrence, and IANA time zones.
- 🧼 **Start fresh** — every run uses a new session with no previous chat history.
- 👀 **Stay informed** — see status, errors, history, and session links in one place.
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

## 🎛️ Manage and edit

Each task card lets you:

- change the name, prompt, or schedule;
- run now, pause, resume, or resume and run;
- open the latest session or any recent run;
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
Schedule due → Global queue → Fresh session → Agent runs → Result and session link recorded
```

- Automations run globally one at a time and never overlap.
- Runs time out after one hour by default; set `maxRunDurationMs` in plugin config to change the limit.
- Queued or running work can be stopped without moving its future schedule.
- DSH must be running when work is due; after restart, only the latest missed occurrence runs.
- Transient scheduler failures retry automatically with bounded exponential backoff.
- Paused occurrences are skipped; **Resume & run** does not move the original schedule.

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
| `automation_create` | Create a one-time or recurring task |
| `automation_update` | Change its name, prompt, or schedule |
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

## License

MIT
