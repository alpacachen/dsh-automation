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

## Reasoning effort

For fresh sessions, open **Edit → Agent execution**, choose a provider, then use the combined model menu to select **Model** or **Reasoning effort**. This uses the Host Menu primitive without changing the chat session's model selection. Choices come from that model's Host metadata, not a fixed low/medium/high list. **Default (no override)** preserves the normal Agent/model default; it does not turn reasoning off. Existing tasks keep their prior behavior. Switching models in the editor resets this choice to default.

For Agent tools, query `automation_options` with the candidate `provider` and `model` (or an existing task `id`) before using `reasoning_effort`. An explicit level requires a concrete provider/model pair and is validated by the Host before saving and running. Omit it on creation for the default, omit it on update to preserve the saved value, or pass `null` on update to clear it. HTTP updates use `execution.reasoningEffort`. When changing models through tools/API, also clear or replace an incompatible level. Pinned sessions always use their own reasoning configuration; task-level overrides apply only to fresh sessions.

## Manually delete run records

Expand a record in **Run history**, choose **Delete record**, and confirm. This removes only that record and its summary, error, and delivery status. It does not delete the session, recall messages, or change the task schedule, consecutive failure count, or paused state. Deletion cannot be undone.

Queued or running records and records whose messages are still sending cannot be deleted. Other finished records remain deletable while the task is running. Deleting the latest record makes the overview show the latest remaining result; deleting every record shows **No run records**.

## State storage

Run history is retained without a count limit by default. An explicit plugin `maxRunHistory` setting still limits retention. Previously pruned records cannot be restored by changing this setting.

State is written to a temporary file in the same directory, flushed, and atomically renamed over the previous file. Windows skips directory fsync; other platforms attempt it after the rename. If that post-commit step fails, the Host logs `AUTOMATION_DIRECTORY_SYNC_FAILED`: the operation is already committed and memory follows the new file, but persistence across a system crash or power loss is not guaranteed. Investigate the filesystem warning rather than retrying the operation. Failures before the rename still reject the operation and leave the previous state unchanged.

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

Create and update support `agent_preset`, `provider` / `model`, `reasoning_effort`, and ordered `skills`; updates can clear execution overrides or replace the skill list. Creation also accepts `execution_mode: pinned-session`, `target_session_id`, and `session_target_confirmed: true` after user confirmation. Changing the target after creation and configuring message delivery require the UI.

| Type      | Parameter   | Format / example                                                           |
| --------- | ----------- | -------------------------------------------------------------------------- |
| One-time  | `once_at`   | RFC 3339 UTC instant, such as `2027-01-04T01:00:00.000Z`.                  |
| Recurring | `rrule`     | One RFC 5545 rule without `DTSTART`, such as `FREQ=WEEKLY;BYDAY=MO,WE,FR`. |
| Recurring | `time_zone` | IANA zone, such as `Asia/Shanghai`.                                        |
| Recurring | `start_at`  | Local wall-clock time in `YYYY-MM-DDTHH:mm:ss` format.                     |

Recurring schedules require `rrule`, `time_zone`, and `start_at` together.
