---
paths:
  - "src/Loops/**"
  - "src/Plugin/Components/LoopsContainer.ts"
---

# Loops

Saved, repeatable, **headless** agent jobs: trigger → worker `AgentLoop` → optional independent verifier `AgentLoop` → run log + `STATE.md`. Gated by `featureSettings.loops` (default off).

**Layout**: `<rootVaultFolder>/Loops/<loop-id>/` holds `LOOP.md` (definition; body = per-run instructions), `STATE.md` (progress; runner-maintained), `runs/<ISO-ts>-run<N>.md` (one log per run; run number keeps same-second runs distinct), `drafts/` (the only writable place for `staging` loops). `plugin.loopsFolder` getter; `reinitLoopManager()` on `rootVaultFolder` change.

**LOOP.md frontmatter**: `name`, `description`, `enabled` (false = triggers skip it; Run now still works), `trigger` (`manual` | `on-startup` | `interval`), `interval` (`30m`/`6h`/`1d`, min 1m), `skill`, `worker` (assistant id; default `obsidian-agent` = `ObsidianAgent.buildSystemPrompt()`), `verifier` (assistant id; omit = no verification), `permission` (`read-only` | `staging` — nothing else is accepted), `max_tool_calls`, `max_tokens_per_run`, `model` (optional model id). Values follow YAML scalar rules: an unquoted ` #` starts a comment; quote the value to keep a literal `#`. Parse problems land in `LoopDefinition.warnings` (shown in the UI and run log). The UI enabled toggle rewrites the `enabled:` line — the file stays the source of truth.

**Key files**: `LoopManager.ts` (discovery/parsing/hot-reload, `isLoopFile()` matches only `<id>/LOOP.md` so runner writes never trigger reloads), `LoopRunner.ts` (serial queue + `runOnce()`), `LoopScheduler.ts` (triggers), `LoopPickerModal.ts` ("Run loop…"), `Plugin/Components/LoopsContainer.ts` (Settings → Loops list).

## Safety invariants — do not weaken

- **Never `ask`, `ask-everything`, or `auto-approve`.** The permission callback is `denyAll`. `read-only` loops use the existing mode; `staging` uses the `"staging"` `PermissionMode` (safe + write, never danger).
- **Writes are confined in code** by `LoopRunner.makeToolGuard(draftsFolder)`, passed via `AgentLoop`'s trailing `options.toolGuard`. The guard runs before `checkPermission`: write-tier tools need a `path` inside `drafts/` (rejects `..`, backslashes, look-alike prefixes); danger-tier, unknown, and `LOOP_BLOCKED_TOOLS` (`obsidian_open_note`, `obsidian_execute_command`, `run_shell_command`) are always denied. Blocked tools are also added to `disabledTools` so the model never sees them.
- **No dynamic tools** (`extraSetup` is `undefined`): no `invoke_assistant`, `list_skills`/`enable_skill`, `save_memory`. A loop can't change settings, memories, or personas. The verifier is a *separate* `AgentLoop` call in `read-only` mode — never route verification through `invoke_assistant`.
- One run at a time globally (serial queue). `enqueue()` skips a loop that is already running or queued.

## Run flow (`runOnce`)

1. `lastRunAt`/`runCount` saved **before** the run so the scheduler can't double-fire.
2. Fail fast (no tokens spent): unknown worker/verifier/skill, unknown `model:`, non-tool provider (only Claude/OpenAI/Mistral/Ollama/LM Studio), missing API key → status `error`.
3. Worker context order: `STATE.md` (+ previous verifier FAIL reasons) → worker prompt → skill body → LOOP.md body → run rules (headless, drafts path, end with `## Progress`). Tools: skill `allowed-tools` ∩ assistant `allowed-tools` (empty = all; a non-empty pair with no overlap is an error).
4. Model: `model:` → assistant `preferred-model` → `obsidianAgentSettings.defaultModel` (Obsidian Agent worker) → chat widget model. Verifier: its `preferred-model` → worker's model.
5. Budget: `onUsage` totals vs `max_tokens_per_run`; exceeded → per-pass controller aborts → status `budget-exceeded`. Verifier gets the *remaining* budget. Checked between model turns, so one turn can overshoot — but `AgentLoop` re-checks `signal.aborted` after each turn and never executes that turn's tool calls once aborted. OpenAI-compatible usage needs `AgentLoopOptions.requestUsage` (`stream_options.include_usage`; off for Mistral, which reports unprompted, and off in chat).
6. Verifier must end with `VERDICT: PASS|FAIL` + `REASONS:` bullets (`LoopRunner.parseVerdict`; unparseable → FAIL). Skipped unless worker status is `ok`.
7. Run log reuses `ChatHistory.renderToolCallBlock` (`> [!info]- N tool calls`). `STATE.md` has runner-owned marker blocks (`<!-- loop:progress:* -->` from the worker's `## Progress`, `<!-- loop:last-run:* -->`) plus `## Run history` (last 50 runner entries, matched as `- <ISO timestamp> …`). Other lines in that section and all later sections are preserved.
8. `loopSettings.loops[id]` (`LoopRuntimeState`: `lastRunAt`, `lastStatus`, `lastVerdict`, `lastFailReasons`, `runCount`) updated; `Notice` with the verdict. `lastFailReasons` is replaced only by a new verdict (PASS clears it) — error/aborted/over-budget runs keep outstanding feedback for the next worker. The running slot is released in a `finally`, so a failed settings save can't wedge the queue.

## Triggers

`LoopScheduler.start()` from `onLayoutReady`: `on-startup` loops + overdue (or never-run) `interval` loops run once 10s after layout-ready (single catch-up, not one per missed interval); then a 60s `registerInterval` tick. All inactive while the gate is off. Commands `run-loop` ("Run loop…") and `stop-loops` use `checkCallback` on the gate.

## Phase 2 hooks (not built)

Goal mode (`goal:` / `max_runs`, `/goal`) should loop over `runOnce()`; a drafts inbox can read `runs/` + `drafts/`; parallel runs would replace the single `currentController` with a per-loop map.
