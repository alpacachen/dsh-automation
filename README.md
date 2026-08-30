# DSH Automation

Durable, agent-created scheduled tasks for DeepSeek Harness. Every run starts a fresh, visible DSH session in the task's workspace.

## Features

- One-time UTC schedules and recurring RFC 5545 RRULE schedules with IANA time zones
- Agent-only task creation (`automation_create`)
- Agent and UI management: list, pause, resume, run now, and delete
- Fresh DSH session per run, retained in the workspace session tree
- `danger-full-access` with no approval prompts for every unattended run
- Process-local single-timer scheduler; no cron, launchd, systemd, or scheduler framework
- Versioned JSON persistence with serialized atomic writes
- Latest-only missed-run recovery and globally serial execution

DSH must be running when local work is due. After downtime, a recurring task runs only its latest missed occurrence. Paused recurring occurrences are skipped; `Resume & run` performs one immediate run without moving the calendar anchor.

## Agent tools

- `automation_create`
- `automation_list`
- `automation_pause`
- `automation_resume`
- `automation_delete`

Example one-time input:

```json
{
  "name": "Release review",
  "prompt": "Review the current workspace release and report blockers.",
  "once_at": "2026-09-01T01:00:00.000Z"
}
```

Example recurring input:

```json
{
  "name": "Daily dependency review",
  "prompt": "Review dependency changes and report security concerns. Do not modify files.",
  "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  "time_zone": "Asia/Shanghai",
  "start_at": "2026-09-01T09:00:00"
}
```

## Persistence

The default state file is:

```text
$DSH_HOME/automation/state.json
```

It stores task definitions, scheduling state, and the latest 20 run summaries. Full conversations and tool history remain in DSH's normal session persistence.

## DSH profile installation

Install the npm package:

```bash
dsh plugin --profile web add @alpacachen/dsh-automation
```

The package supplies its own Cordis patch. Restart DSH after installation; the Client bundle contributes an **Automations** sidebar action and management drawer.

For local development, build and link the checkout instead:

```bash
pnpm build
cd "$DSH_HOME/profiles/web"
pnpm add '@alpacachen/dsh-automation@link:/absolute/path/to/automation'
```

## Development

```bash
pnpm check
pnpm test
pnpm test:coverage
pnpm build
```

The suite covers persistence failures, RRULE and DST behavior, missed runs, pause/resume, run-now, overlap serialization, long timers, restart recovery, Agent session creation, tools, and the HTTP management API.

## Releasing

CI validates every pull request and push to `main`. To release, bump the stable SemVer in `package.json` and push to `main`; `.github/workflows/release.yml` tests, builds, publishes with npm provenance, creates `v<version>`, and opens a GitHub Release.

npm requires a one-time bootstrap publish before Trusted Publishing can be configured for a new package. After `@alpacachen/dsh-automation` exists, configure its npm Trusted Publisher for GitHub repository `alpacachen/dsh-automation` and workflow `release.yml`; subsequent releases need no npm token.

## Security

All runs intentionally use `danger-full-access`. Automation prompts can execute commands and modify files with the current operating-system user's authority. This does not bypass OS permissions, sudo, OAuth, or missing credentials.
