# P0 Plan: Per-task Agent execution configuration

## Outcome

Allow every automation to persist and edit an optional DSH Agent preset, provider/model pair, ordered set of skills, and any permission preset currently advertised by the Host. Every run must compose a fresh Agent from that saved configuration. Existing state files must continue to load unchanged, permission changes must still require explicit confirmation, and unattended execution must never synthesize or auto-approve permissions.

This is an additive extension of the existing path:

`automation_create` / task editor -> `AutomationController` -> `AutomationDomain` -> `AutomationStore` -> `AutomationScheduler` -> `DshAutomationRunner` -> `ctx.agents.create(...)`

No second task/configuration store and no custom DSH composition format are needed.

## Current state and exact extension points

- `src/types.ts` already persists `execution.agentPreset`, `execution.provider`, and `execution.model`, but all are captured from the creating Agent and cannot be selected or updated. There is no `skills` field.
- `AutomationPermissionPresetSchema` is hard-coded to `read-only | danger-full-access`; `src/index.ts`, Agent tool schemas, UI labels, tests, and both READMEs repeat that closed set.
- `src/tools.ts` is the only creation surface. It requires a complete preview and `creation_confirmed: true`, captures the current workspace/preset/model, and requires `permission_confirmed: true` for updates containing a permission.
- `src/api.ts` only updates task fields. It enforces `confirmPermissionChange: true` before passing a permission change to the controller.
- `src/client/index.tsx` has no direct creation form; creation remains guided through a conversation. Its edit form only offers the two hard-coded permissions and does not expose Agent execution fields.
- `src/runner.ts` already composes the saved preset through `ctx.agentPresets.mount(agentCtx, task.execution.agentPreset)`, passes provider/model to `ctx.agents.create`, and applies the saved permission with `ctx.permissionPresets.set` before the first follow-up.
- `src/store.ts` parses state through Zod and writes atomically. Existing additive defaults in `AutomationTaskSchema` provide the precedent for backward-compatible lazy migration.

Use the installed/locked DSH `0.1.0-rc.8` APIs; do not invent a generic provider abstraction:

- `ctx.agentPresets.list(): Promise<AgentPreset[]>`, `defaultId`, `resolve(id?)`, `mount(agentCtx, id?)`, `standingKeyFor(id?)`, `serviceFor(agent, name)`, and exported `standingMountFor(agentCtx)`. `AgentPreset` exposes `id`, `trust`, optional `name`, `description`, `order`, and `broken`.
- `ctx.llm.listProviders(): LlmProviderInfo[]`, `listModels(provider)`, `resolveModelInfo(provider, model)`, and `resolveCallConfig({ provider, model })`. Model catalogs are advisory; `resolveCallConfig` is the request-validating boundary.
- `ctx.skills.list({ cwd, scope })`, `get(name, { cwd, scope })`, `isUserInvocable`, and `renderSkillContent` from `@deepseek-ai/dsh-skill`. `SkillSummary` supplies `name`, `description`, `whenToUse`, invocation policy, source, and provider.
- `ctx.permissionPresets.names`, `defaultPreset`, `resolve(name): PresetSpec`, `optionOf(name): PresetOption`, and `set(session, name)`. `PresetSpec` exposes the actual `sandbox` and `approval` (`ask | never`) values.
- `ctx.agents.create({ sessionId, meta, agentOptions, setup })` remains the only Agent factory. `AgentOptions` accepts optional `provider` and `model`.
- DSH's neighboring Host API builds model catalogs with `listProviders` + `listModels` + `resolveModelInfo`, lists presets without hiding broken rows, and resolves skill catalogs with a preset standing scope. Follow those behaviors, including partial per-provider model failures and treating catalog membership as advisory.

`@deepseek-ai/dsh-skill` must become an explicit peer/dev dependency at the same DSH range because production code will import its public types/helpers. No other new dependency is required; `standingMountFor` is already exported by the existing `dsh-agent-presets` dependency.

## Data model and compatibility decisions

### Persisted shape

Keep state `version: 1`; this change is additive and the existing schema-default migration mechanism is sufficient.

Change `AutomationExecutionSchema` to:

```ts
{
  workspaceId: string
  cwd: string
  agentPreset?: string
  provider?: string
  model?: string
  skills: string[] // Zod default([])
}
```

Change the permission value from a closed Zod enum to a trimmed, non-empty string. The Host registry, not this plugin, owns the permission vocabulary.

Compatibility behavior:

- Existing tasks with either old permission name remain valid.
- Existing tasks without `skills` parse as `skills: []`; the in-memory snapshot is normalized and the field is written only on the next ordinary mutation. Do not rewrite the state file during startup.
- Existing optional preset/provider/model values retain their current meaning and are never replaced during migration.
- Keep `security.source` and `security.grantedAt`. Only a real permission value change refreshes the confirmation audit timestamp.
- Do not tighten the persisted schema to require provider and model together: an older file may contain only one because the current create path captured them independently. Enforce paired values on new create/update requests, while allowing legacy records to load and retain their prior runner behavior until edited.

### Update semantics

Add an execution patch to `UpdateAutomationRequest` with explicit tri-state behavior:

- omitted property: preserve the saved value;
- string: select that Host id;
- `null`: clear the saved override and follow the Host default on future runs;
- `skills: []`: clear forced skill invocation.

Provider and model must be set together or cleared together. Agent preset can be cleared independently. Normalize skill names by trimming, rejecting empty values, and preserving first occurrence order while rejecting or removing duplicates consistently at the request boundary.

### Meaning of optional values

- No saved Agent preset means `agentPresets.mount(agentCtx, undefined)` chooses the Host default at run time.
- No saved provider/model pair means `agents.create` receives neither and the Host Agent factory supplies its default.
- No saved skills means the Agent receives its ordinary preset skill catalog, but no skill is forced into the run.
- Saved skill names mean explicitly preload those current skill definitions for every run. Persist names, not skill bodies or paths; local skill edits therefore take effect on the next run.

## Host-backed configuration service

Add one small host-side module, `src/agent-configuration.ts`, shared by API, Agent tools, controller validation, and runner execution. It should hold `Context` and expose only the operations actually needed:

1. `options(cwd, agentPreset?)`
   - Presets: call `agentPresets.list()`, mark `defaultId`, include display metadata/trust/broken reason, and disable rather than hide broken presets.
   - Models: call `llm.listProviders()` and load each provider with `Promise.all`; return successful groups and provider-local failures. Include provider/model ids and display metadata. Do not reject empty/advisory catalogs.
   - Permissions: map `permissionPresets.names` through `optionOf` and `resolve`, including the Host label/description plus sandbox and approval policy; mark `defaultPreset`.
   - Skills: resolve the candidate preset's scope with `agentPresets.standingKeyFor(agentPreset)`, then call `skills.list({ cwd, scope })` and retain user-invocable entries. Return model-invocable state for UI explanation.
2. `validate(execution, permissionPreset)`
   - Reject an unknown/broken Agent preset.
   - Require a provider/model pair for new values and validate it with `llm.resolveCallConfig`; do not reject solely because a model is absent from the advisory list.
   - Resolve every selected skill against the selected/default preset scope and task cwd; reject missing or non-user-invocable skills.
   - Validate permission by `permissionPresets.resolve(name)`.
3. `loadSelectedSkills(agent, task)`
   - After preset composition, use `agentPresets.serviceFor(agent, 'skills') ?? ctx.skills`, with `standingMountFor(agent.ctx)?.key` as the view scope, and load each saved name again.
   - Fail before the task prompt if a configured skill disappeared, became non-user-invocable, or cannot load. Return canonical `renderSkillContent(...)` text and `skill-invocation` source metadata.

Import `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-skill`, and the existing preset/permission packages for their Context augmentation. Add `llm` and `skills` to the plugin's `inject` list. Startup should no longer resolve two literal permissions; instead, fail startup only if the Host exposes no permission presets or its declared default cannot resolve.

This shared module is the single validation boundary. UI affordances and tool descriptions are not authorization checks.

## Implementation phases

### 1. Domain and persistence

Files: `src/types.ts`, `src/domain.ts`, `src/store.ts`, `test/helpers.ts`, `test/domain.test.ts`, `test/store.test.ts`.

- Add `skills` with `default([])` and broaden permission ids as described above.
- Add the nested execution patch types used by API/tools/UI.
- In `AutomationDomain.update`, include execution changes in the “at least one field” check and merge only supplied keys. Delete optional overrides when a patch value is `null`; replace skills atomically when supplied.
- Keep trimming/name/prompt/schedule behavior and permission audit updates unchanged.
- Add a legacy state fixture with no skills and both old permission ids; prove it parses without startup rewrite and receives `skills: []` in memory.
- Add domain tests for set, clear, unchanged, paired provider/model, skills replacement, and preservation of unrelated paused/scheduling state.

### 2. Host discovery and validation

Files: new `src/agent-configuration.ts`, `src/index.ts`, `package.json`, `test/index.test.ts`, and a focused new or existing test file for the resolver.

- Implement the Host calls above with plain data projections suitable for JSON and Agent tool results.
- Preserve model provider failures beside successful groups, matching DSH's Host API pattern.
- Validate ids at create/update and again immediately before execution. Saved tasks may outlive removed Host options; they should remain listable/editable, but a run must fail closed with an actionable error instead of silently substituting another preset/model/skill/permission.
- Tests should fake the real service method shapes and cover unknown/broken preset, unregistered provider, advisory-unlisted-but-resolvable model, missing skill, non-user-invocable skill, arbitrary Host permission names, and partial model catalog failure.

### 3. Controller and HTTP API

Files: `src/controller.ts`, `src/api.ts`, `test/controller.test.ts`, `test/api.test.ts`.

- Inject the shared configuration resolver into `AutomationController`.
- Validate the fully materialized prospective configuration before domain create/update. For a partial update, merge it with the current task first, then validate the resulting execution and permission together.
- Add `GET /api/automation/v1/tasks/:id/options?agentPreset=<candidate>` for the editor. Resolve cwd from the stored task; do not accept an arbitrary client filesystem path. The optional query value previews skills for a candidate preset, with an explicit empty value meaning Host default.
- Extend PATCH parsing with a strict `execution` object and nullable override fields. Reject unknown nested keys, partial provider/model mutations, malformed skills, and bodies that contain no effective update.
- Keep same-origin checks, `x-dsh-automation` mutation header, body limit, and current error handling. The options endpoint is read-only GET.
- Continue requiring `confirmPermissionChange: true` whenever PATCH supplies a different permission. Do not let an execution patch bypass or reset `security` audit fields.

### 4. Agent tools

Files: `src/tools.ts`, `test/tools.test.ts`.

- Add a read-only `automation_options` tool. With no task id it uses the owning Agent's current cwd/preset; with a task id it uses that task's saved cwd/config. An optional candidate `agent_preset` refreshes the skill list for preview.
- Extend `automation_create` with optional `agent_preset`, `provider`, `model`, and `skills`. If omitted, preserve current behavior by capturing the creator's composed preset and complete provider/model pair; default skills to `[]`.
- Extend `automation_update` with nullable execution overrides/skill replacement, using the same paired provider/model rule as HTTP.
- Update `automation_create` guidance so the confirmation preview includes Agent preset, provider/model, selected skills, the exact Host permission label/id, notifications, and failure pause policy. `creation_confirmed` remains mandatory.
- Update `automation_update` guidance to call `automation_options` before selecting ids and to obtain explicit permission confirmation only for an actual permission change. `permission_confirmed` remains mandatory whenever the tool supplies a changed permission.
- Expand list summaries/output schemas with saved preset, provider/model, and skills. Display `Host default` for absent overrides instead of guessing the current Host default.
- Runtime validation must reject stale/arbitrary strings even if a model skipped `automation_options`.

### 5. Runner composition

Files: `src/runner.ts`, `test/runner.test.ts`.

Keep the existing order and insert skills without changing Agent ownership:

1. Revalidate saved configuration against the current Host.
2. Create the fresh session/Agent with saved `meta.agentPreset`, `agentOptions.provider/model`, and `setup: agentPresets.mount(...)`.
3. Apply the exact saved permission with `permissionPresets.set(session, name)`.
4. Resolve selected skills from the composed Agent scope. For each selected skill, call `agent.inject(createUserMessage(...))` with canonical `renderSkillContent` text and source `{ kind: 'skill-invocation', name, form: 'instructions' }`.
5. Rename/flush/attach as today, then `followup` the unattended task prompt and wait for idle.

The ordering guarantees selected skills are available to the first model step and permission is pinned before any work wakes the Agent. Do not prefix the task prompt with `/skill`, invent a skill loader, copy skill Markdown into state, or register per-task tools.

If configuration or skill loading fails, do not fall back to defaults. Dispose an unpublished/non-retained Agent handle as the current `finally` already does, record the run as failed, and keep future scheduling behavior unchanged.

Permission behavior remains fail-closed:

- Apply the Host preset exactly; never translate a custom Host id to one of the old two names.
- Never auto-answer approval requests. A Host preset with `approval: ask` remains selectable after confirmation, but an unattended operation requiring approval can wait and ultimately hit the existing run timeout; the options UI and preview must state that risk.
- Keep the prompt's unattended warning and saved permission id, and continue excluding automation-management tools from automation-created Agents through the existing `automation-` id guard.

### 6. Client UI and locales

Files: `src/client/index.tsx`, `src/client/styles.css`, `src/client/locales.ts`, `test/ui.test.ts`, `test/locales.test.ts`.

- When an edit form opens, fetch task options. Refetch skills when Agent preset changes; retain the current saved stale value visibly with an “unavailable” warning so the user can repair rather than lose it silently.
- Add an “Agent execution” section using native controls:
  - Agent preset select with Host default plus non-broken Host presets and descriptions/trust markers.
  - Provider then model selects grouped by provider; Host default clears both. Show provider-local catalog failures without disabling unrelated providers.
  - Multi-select/checklist for user-invocable skills, showing description and whether the model could otherwise invoke it.
  - Dynamic permission select from Host options, showing label, description, sandbox/approval summary, and the current saved unavailable id when necessary.
- Keep the existing permission confirmation checkbox. Reset it whenever the selected permission changes; disable Save until it is checked for a real change. No `window.confirm`.
- Disable only configuration controls while their options load/save; preserve typed name/prompt/schedule edits across an option refresh.
- Task cards should show saved preset, provider/model, and skills, using “Host default” for absent overrides. Permission display must use Host metadata when available and fall back to the raw saved id.
- Update English and Chinese dictionaries in lockstep, including loading/failure/unavailable/default/approval-warning copy. Keep current accessibility patterns: associated labels, keyboard-reachable controls, `aria-live`/`role=alert` for option failures, and visible focus states.
- CSS changes should reuse existing DSH tokens and editor grid patterns; no component library or new icons are needed.

Creation remains conversation-guided in P0. Do not add a second client-side create form; the enhanced Agent tools and preview already cover creation.

### 7. Documentation

Files: `README.md`, `README.zh.md`.

- Replace “read-only or full-access” language with Host-exposed permission presets.
- Document optional Agent preset, provider/model, and skill selection; distinguish saved override from Host default.
- Document that selected skill names load their current definitions on each run and a removed/broken option fails the run rather than falling back.
- Document confirmation behavior and the unattended consequence of `approval: ask` presets.
- Add `automation_options` and the expanded create/update arguments to the Agent tools table/examples.
- State that existing tasks migrate in memory and retain their saved execution/permission settings.

## Test and verification matrix

Run after implementation:

```sh
pnpm check
pnpm test
pnpm test:coverage
pnpm build
git diff --check
```

Required cases:

- Persistence: pre-change state loads; no eager rewrite; next mutation writes normalized skills; unsupported state versions/corrupt JSON still fail without overwrite.
- Domain: execution set/clear/partial merge, skill ordering, provider/model pairing, permission audit timestamp, paused schedule preservation.
- Host resolver: dynamic permission names, broken presets, Host default, model catalog partial failure, `resolveCallConfig` validation, preset-scoped skill lookup, stale skill rejection.
- API: options route, strict nested body, nullable clears, CSRF/same-origin behavior, missing confirmation rejection, unknown Host ids.
- Agent tools: options discovery, current-Agent defaults, explicit selection, clear semantics, complete preview requirement, permission confirmation, stale value errors, summary output.
- Runner: exact create options, preset mounted before publication, permission set before skill injection/follow-up, ordered multiple skill injections with canonical sources, no skills path, disappeared skill fail-closed, custom Host permission, cancellation and cleanup regressions.
- UI/locales: dynamic options, default/unavailable states, provider/model coupling, skill selection, permission checkbox reset/disable behavior, approval warning, balanced EN/ZH placeholders, existing accessibility/token assertions.
- Full scheduler/controller regression suite: configuration failures become ordinary failed runs and do not create overlap, alter recurrence, or bypass timeout/cancellation handling.

## Risks and mitigations

- **Host catalogs change after save.** Revalidate at every run and fail with the missing id; never substitute a new default.
- **Model lists are incomplete/advisory.** Use them for presentation only; validate the exact pair with `llm.resolveCallConfig`.
- **Preset-scoped skills differ by workspace/preset.** Always resolve with task cwd and the candidate/composed preset scope; refetch when preset changes.
- **Skill content changes between runs.** This is intentional P0 behavior. Persist names only and document it; add immutable skill snapshots/hashes only if reproducible historical execution becomes a requirement.
- **`approval: ask` in an unattended session.** Expose the policy and warn, but do not weaken it or auto-approve. Existing run timeout bounds the wait.
- **Removed options make the editor impossible to save.** Preserve stale saved values as explicit unavailable rows and allow the user to replace/clear them; unchanged legacy tasks remain readable.
- **Capability enumeration cost.** Fetch on editor open and preset change only. Do not add a cache until measurements show Host catalog calls need one.
- **Preset composition can be broken.** List broken presets for diagnosis but reject selection and execution with the Host's `broken` reason.

## P0 decisions and deferred work

- Keep one global execution queue and fresh-session-per-run behavior.
- Keep guided conversational creation; only task editing gets direct configuration controls.
- Keep state version 1 with additive defaults; no standalone migration command or backup file.
- Persist stable Host ids and skill names, not copied metadata, paths, credentials, model capabilities, preset compositions, or skill bodies.
- Do not add reasoning-effort, max-token, per-run overrides, per-task concurrency, custom sandbox knobs, arbitrary plugin composition, or credential editing in P0. Those require separate product/security decisions.
- Do not reuse the Host API-proxy client in this plugin's browser bundle; the automation options endpoint is task-addressed, avoids exposing arbitrary cwd paths, and keeps this plugin on its existing HTTP boundary.
