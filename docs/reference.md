# Automation reference

[Back to overview](../README.md) · [简体中文](reference.zh.md)

## A few things to know before running tasks

- DSH must be running to execute tasks. After a restart, each eligible task catches up with only its latest missed occurrence; paused occurrences are skipped.
- Each plugin instance runs one automation at a time. Runs have a 1-hour limit by default, configurable through `maxRunDurationMs`.
- Pausing affects future scheduling; a started run continues. Stopping the current run, running now, or choosing Resume & run leaves the original schedule unchanged.
- Interactive approvals are never granted automatically. Unattended runs may wait until timeout.
- Pinned sessions keep their context and Agent/model configuration, apply task permissions, and do not reload skills. Changing the binding after creation requires the UI. A busy or unavailable target fails the run without creating a replacement session.
- Failed runs can be retried manually. Optional auto-pause counts failures and timeouts; success resets the count. A run whose outcome was not recorded before an unexpected restart becomes outcome unknown and is not automatically rerun.
- Message delivery has its own status. Failed sends never rerun tasks or automatically resend; an interrupted send becomes unknown. Manual cancellation and Host shutdown interruptions do not trigger reports. Platform acceptance does not guarantee receipt on the recipient's device.

## Agent tools and schedule parameter reference

| Tool                 | Purpose                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `automation_options` | Query current Host Agent, model, skill, and permission options.              |
| `automation_create`  | Create a task after the user confirms its complete configuration.            |
| `automation_update`  | Update task and execution settings; permission changes require confirmation. |
| `automation_list`    | List tasks and run state.                                                    |
| `automation_run`     | Queue one immediate run without changing the schedule.                       |
| `automation_pause`   | Pause future scheduling.                                                     |
| `automation_resume`  | Resume, optionally with one immediate run.                                   |
| `automation_delete`  | Delete the task and future scheduling, preserving existing sessions.         |

Create and update support `agent_preset`, `provider` / `model`, and ordered `skills`; updates can clear execution overrides or replace the skill list. Creation also accepts `execution_mode: pinned-session`, `target_session_id`, and `session_target_confirmed: true` after user confirmation. Changing the target after creation and configuring message delivery require the UI.

| Type      | Parameter   | Format / example                                                           |
| --------- | ----------- | -------------------------------------------------------------------------- |
| One-time  | `once_at`   | RFC 3339 UTC instant, such as `2027-01-04T01:00:00.000Z`.                  |
| Recurring | `rrule`     | One RFC 5545 rule without `DTSTART`, such as `FREQ=WEEKLY;BYDAY=MO,WE,FR`. |
| Recurring | `time_zone` | IANA zone, such as `Asia/Shanghai`.                                        |
| Recurring | `start_at`  | Local wall-clock time in `YYYY-MM-DDTHH:mm:ss` format.                     |

Recurring schedules require `rrule`, `time_zone`, and `start_at` together.
