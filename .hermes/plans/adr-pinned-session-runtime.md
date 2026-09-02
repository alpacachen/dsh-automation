# ADR: pinned-session runtime uses DSH persisted resume

Status: accepted for MVP
Date: 2026-09-02

## Decision

Use the DSH Host's public `ctx.agents.resume({ resumeSessionId, agentOptions?, setup?, signal? })` contract for pinned-session runs. The automation plugin must resolve the exact configured session ID, validate its persisted header before execution, resume a temporary owned `AgentHandle`, append one follow-up, await `agent.whenIdle()`, flush through `ctx.sessions.flush()`, and dispose only the temporary runtime handle. It must never emulate resume by retaining a live `Agent` across process restarts and must never fall back to `ctx.agents.create()` when pinned resolution/resume fails.

Fresh runs continue using `ctx.agents.create()` and their existing `automation-*` session allocation.

## Evidence inspected

- Installed `@deepseek-ai/dsh-agent@0.1.0-rc.8` declarations expose:
  - `AgentRegistry.resume({ resumeSessionId: SessionId, agentOptions?, setup?, signal? }): Promise<AgentHandle>`.
  - `AgentRegistry.create({ sessionId, meta?, agentOptions?, setup?, signal? }): Promise<AgentHandle>`.
  - `AgentHandle.dispose(): Promise<void>`.
  - `Agent.status` (`idle`/`running`) and `Agent.whenIdle(): Promise<void>`.
  - `Agent.followup()`, `Agent.cancel()`, and the explicit `AgentHandle` ownership boundary.
- Installed `@deepseek-ai/dsh-session@0.1.0-rc.8` declarations expose live `Session.header`, `Session.events`, `SessionStore.get/list`, and `SessionStore.flush()`.
- Installed `@deepseek-ai/dsh-session-persistence@0.1.0-rc.8` declarations expose `SessionPersistence.inspect()`, `prepare()`, `load()`, `list()`, and `listSnapshots()`. `inspect()` is non-mutating and returns validated header/events; `prepare()` is the Host-owned unpublished preparation used by resume; `load()` may commit cold recovery and must not be used as a preflight check.
- The DSH agent contract documents that resume loads persisted state, reconstructs history, publishes only after setup, and rejects when persistence is unavailable or the session cannot be resumed. The handle disposer tears down the runtime and session registration; it is not a plugin-level persisted-session delete operation.
- Current plugin dependencies are pinned to `@deepseek-ai/dsh-agent@0.1.0-rc.8` and `@deepseek-ai/dsh-session@0.1.0-rc.8`, matching the inspected declarations.
- No local `dsh-sentinel` source or installed `@deepseek-ai/dsh-sentinel` package was found in `/Users/chenxiang/Projects`; therefore no sentinel-specific resume path is assumed. The public Host contracts above are sufficient.

## Lifecycle and safety guarantees relied upon

1. `resume()` loads the durable session by exact ID and creates a fresh runtime; no live Agent object is required for restart recovery.
2. Setup runs before publication. The resumed runtime is therefore not visible as a partially composed Agent.
3. `AgentHandle` is the caller-owned teardown capability. Pinned execution must retain that handle only for the occurrence and dispose it in `finally`.
4. `Agent.whenIdle()` is the Host's whole-agent quiescence wait. The runner must check `agent.status` before sending and must not inject into a running target.
5. `Session.header.cwd` and `Session.header.id` are available for workspace/cwd validation; persistence inspection can resolve metadata without publishing a runtime.
6. `Session.events.length` is a process-local baseline after resume publication; events after that index are the occurrence's output.

## Failure modes

- Missing persistence backend or missing artifact: map to an explicit target-not-found/unavailable failure.
- Archived/deleted/unresumable or incompatible session: surface a target-specific failure from the Host; do not create a replacement session.
- A live Agent already owns the ID: `resume()` rejects rather than crash-repairing a live turn; map to `target_session_busy`.
- Header cwd/workspace mismatch: reject before follow-up.
- Cancellation before/during resume: abort the occurrence and dispose only the temporary handle; never delete the persisted target.
- A Host API/version without these contracts is a hard compatibility blocker, not a reason to retain live Agents or implement a plugin-side persistence workaround.

## Non-mutating spike verification

The installed declarations and the isolated tests added with the MVP model the call sequence without opening a real session: inspect/resolve exact ID -> resume -> status/baseline -> follow-up -> whenIdle -> flush -> handle dispose. No real DSH workspace or session is touched by the test fixture.

## Consequences

Pinned execution can survive DSH/plugin restart because the target identity is persisted and the runtime is reconstructed per occurrence. Runtime configuration must inherit the resumed session's composition in v1; selected skills must not be reinjected. The plugin still needs explicit target validation, global serialization, unattended-source tool gating, and stable target failure mapping in later implementation tasks.
