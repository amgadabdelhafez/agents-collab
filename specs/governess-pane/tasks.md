# Tasks: Governess Pane (LLM loop watchdog)
> Each task must be independently implementable in one worktree.
> Tasks must not reference chat context.

## Checklist

- [ ] **T-01** Flags, types, manifest — parse `--governess*`, add defaults + manifest fields (inert).
- [ ] **T-02** Hook injection — Claude settings + Codex config.toml generators + `__hook-emit` normalizer.
- [ ] **T-03** Deterministic detector — pure idle/suspect logic, unit-tested.
- [ ] **T-04** Qwen verdict client — OpenAI-compatible call + verdict schema + fallbacks.
- [ ] **T-05** Recovery ladder — pure `decideAction` + effectful executors, cooldown/cap.
- [ ] **T-06** Control loop + render + `governess.jsonl` — the `__governess` subcommand body.
- [ ] **T-07** Third pane wiring — full-width bottom pane in `startPairedSession` behind `opts.governess`.
- [ ] **T-08** Verify — unit + dry-run integration tests, `bun run check`, `eval.json`.

---

## Task detail

### T-01 — Flags, types, manifest
**Goal:** CLI accepts `--governess`, `--governess-idle`, `--governess-cooldown`, `--governess-max-recoveries`,
`--governess-dry-run`, `--governess-url`, `--governess-model`, `--governess-height`; `Options` + manifest carry them.
**Files:** `src/loop/args.ts`, `src/loop/types.ts`, `src/loop/constants.ts`, `src/loop/run-state.ts`
**Inputs:** spec "Config knobs"; existing flag-parsing patterns in `args.ts`.
**Output:** parsed options with documented defaults (`idle=120s`, `cooldown=300s`, `max=3`,
`confidence=0.7`, url=`http://127.0.0.1:8082`, model=`mlx-community/Qwen3.6-35B-A3B-4bit`).
**Done when:**
- [ ] Flags parse with defaults; unknown-value errors match existing `parseToken` behavior.
- [ ] Manifest gains `tmuxPaneGovernessAgent` + governess pane id fields.
- [ ] Tests pass for touched code.

### T-02 — Hook injection
**Goal:** At launch (when `opts.governess`), Claude gets `--settings <runDir>/hooks/claude-settings.json`
and Codex gets `<CODEX_HOME>/config.toml` + `--dangerously-bypass-hook-trust`; both append normalized
events to `runs/<id>/hooks/{claude,codex}.jsonl` via `loop __hook-emit <agent> <path>`.
**Files:** `src/loop/hooks/settings.ts`, `src/loop/hooks/emit.ts`, `src/loop/tmux.ts` (buildClaudeCommand +
Codex launch), `src/loop/cli.ts` (register `__hook-emit`).
**Inputs:** `claude --help` (`--settings`), installed `codex` hooks schema (confirm here), `codex-home.ts`.
**Output:** hook JSONL files under `runs/<id>/hooks/`; normalized schema `{ts,agent,event,tool,detail,cwd}`.
**Done when:**
- [ ] Non-governess launch is unchanged (no `--settings`, no config.toml written).
- [ ] Emitter reads stdin JSON, writes one normalized line, never exits non-zero.
- [ ] Unknown Codex events pass through as `event:"raw"`.

### T-03 — Deterministic detector
**Goal:** Pure `detect(state, now) -> perAgent{lastEventAge, paneStable, suspect}` with no I/O.
**Files:** `src/loop/governess-detect.ts`, `tests/loop/governess-detect.test.ts`
**Inputs:** hook tails, pane-capture hashes, prior tick state, clock; thresholds from options.
**Output:** suspect flags used by the control loop.
**Done when:**
- [ ] `suspect` requires BOTH stale events AND stable pane hash over the window.
- [ ] Fixture tests cover: active, idle-but-changing, stuck, recovered-resets.

### T-04 — Qwen verdict client
**Goal:** `judge(agentContext) -> {state, summary, confidence, suggestedAction}` via OpenAI-compatible POST.
**Files:** `src/loop/governess-llm.ts`, `tests/loop/governess-llm.test.ts`
**Inputs:** endpoint/model from options; hook tail + pane text; reasoning-model token budget.
**Output:** validated verdict object.
**Done when:**
- [ ] Malformed/empty/timeout response → `{state:"working"}` fallback (no action).
- [ ] Endpoint-unreachable is surfaced distinctly (drives `LLM offline` + recovery suppression).
- [ ] `mock.module` used to stub fetch; no live network in tests.

### T-05 — Recovery ladder
**Goal:** Pure `decideAction(verdict, history, opts) -> null | L1 | L2 | L3` + executors that perform
answer-prompt / nudge / restart via injected tmux deps.
**Files:** `src/loop/governess-recover.ts`, `tests/loop/governess-recover.test.ts`
**Inputs:** verdict, per-agent action history, cooldown/cap/confidence from options.
**Output:** action taken (or none) + updated history; each execution appends to `governess.jsonl`.
**Done when:**
- [ ] No action unless `state ∈ {stuck,crashed}` and `confidence ≥ gate`.
- [ ] Cooldown + `max-recoveries` enforced; ladder resets on progress.
- [ ] `dry-run` returns the intended action without invoking executors.
- [ ] `waiting-human`/`waiting-peer` never produce an action.

### T-06 — Control loop + render + log
**Goal:** The `__governess <runId>` subcommand: tick every interval → detect → judge suspects → recover →
render status board → append decisions to `runs/<id>/governess.jsonl`.
**Files:** `src/loop/governess.ts`, `src/loop/cli.ts` (register `__governess`), `tests/loop/governess.test.ts`
**Inputs:** T-03..T-05 modules; run-state; tmux primitives.
**Output:** live pane board + `governess.jsonl`.
**Done when:**
- [ ] One dry-run tick over fixtures yields the correct intended actions with zero side effects.
- [ ] Board shows per-agent state/summary/last-action and `LLM offline` when endpoint down.

### T-07 — Third pane wiring
**Goal:** When `opts.governess`, add a full-width bottom pane running `__governess` after the agent split.
**Files:** `src/loop/tmux.ts`, `tests/loop/tmux.test.ts`
**Inputs:** `startPairedSession`; `split-window -v -f -l <height>`.
**Output:** 3-pane session; manifest records the governess pane.
**Done when:**
- [ ] Without `--governess`, `startPairedSession` behavior is byte-for-byte unchanged (asserted).
- [ ] With `--governess`, bottom pane spans full width under both agents.

### T-08 — Verify
**Goal:** Feature-level verification per `verify.md`.
**Files:** `tests/**`, `runs/<task-id>/eval.json`
**Inputs:** `verify.md` checks.
**Output:** `eval.json` (verdict pass), green `bun run check` + `bun test`.
**Done when:**
- [ ] All F-checks pass; `main.ts` < 150 lines confirmed.
- [ ] `eval.json` written to `runs/<task-id>/`.
