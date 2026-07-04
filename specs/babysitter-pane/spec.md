# Spec: Babysitter Pane (LLM loop watchdog)

## Problem

`loop --tmux` runs two agents (default Claude + Codex) side by side. When one agent
silently stalls — waiting on a prompt it never surfaces, hung on a tool, crashed, or
idling after finishing a slice — nobody notices until a human looks at the panes.
There is no in-session summary of what the pair is actually doing, and no automatic
recovery when the loop gets stuck.

## Goal

A third tmux pane, opt-in via `--babysit`, that continuously summarizes both agents'
progress from their hook events and auto-recovers an agent the loop has determined is
stuck — using the local Qwen mlx-lm server for judgment.

## Non-goals

- Not a replacement for the existing `loop dashboard` panel (that is cross-session; this
  is one pane inside one paired run).
- Not a general observability/metrics system. It reads hook events + pane text only.
- No cloud-LLM dependency. The babysitter's reasoning runs against a local, OpenAI-compatible
  endpoint (default Qwen `:8082`); if that endpoint is down, recovery is suppressed, not retried elsewhere.
- Single-agent modes (`--claude-only`, etc.) are out of scope for v1 (paired mode only).

## Background

- `loop-fork/src/loop/tmux.ts::startPairedSession` builds the two-pane session. It already
  captures pane text (`capturePane`), sends keys (`sendKeys`/`sendText`), and unblocks Claude
  startup prompts (`unblockClaudePane`). The babysitter reuses these primitives.
- Per-run state lives under `~/.loop/runs/<id>` via `run-state.ts`; Codex already gets a
  per-run `CODEX_HOME` (`codex-home.ts`), which is where its hooks config is injected.
- Claude Code supports `--settings <file>` (hooks live there). Codex supports hooks with
  `--dangerously-bypass-hook-trust`. Both are launch-time injections; no global user config is touched.
- The reasoning backend is the mlx-lm server stood up in the homelab (Qwen3.6-35B-A3B on
  `http://127.0.0.1:8082`, OpenAI-compatible). It is a *reasoning* model — verdict calls must
  budget tokens for its `reasoning` field.

## User journeys

1. **Happy path:** `loop --tmux --babysit "task"`. Top row = Claude | Codex; full-width bottom
   pane shows a live board: per-agent one-line progress summary + last hook activity. Agents
   work; the babysitter stays in observe mode and never acts.
2. **Stuck → recover:** Codex emits no hook events and its pane text is unchanged past the idle
   threshold. The deterministic detector marks it *suspect*; Qwen classifies it `stuck`; the
   escalation ladder answers a pending prompt → nudges → restarts the pane, one gated step at a
   time, logging each action. On the next observed hook event the ladder resets.
3. **Failure/edge:** Qwen endpoint is unreachable. The detector still runs and the board shows
   `LLM offline`, but no recovery action fires (fail-safe). An agent legitimately `waiting-human`
   is never auto-recovered.

## Acceptance criteria

These map directly to `verify.md`.

- [ ] `--babysit` (paired mode) adds a full-width bottom pane under the two agent panes; without
      the flag, layout and behavior are byte-for-byte unchanged.
- [ ] At launch, Claude is passed a generated `--settings` hooks file and Codex a per-run
      `config.toml`; both append normalized events to `runs/<id>/hooks/{claude,codex}.jsonl`.
- [ ] The deterministic detector marks an agent `suspect` only when `lastEventAge > idle` AND the
      pane hash is unchanged over the same window (unit-tested, no LLM).
- [ ] Qwen is called only for suspect agents and returns a structured verdict
      `{state, summary, confidence, suggestedAction}`; malformed responses are treated as `working`
      (no action).
- [ ] Recovery fires only on `state ∈ {stuck, crashed}` with `confidence ≥ threshold`, respects
      `--babysit-cooldown` and `--babysit-max-recoveries`, and follows the L1→L2→L3 ladder.
- [ ] `--babysit-dry-run` logs intended actions and executes none.
- [ ] Qwen unreachable ⇒ detector runs, recovery suppressed, board shows `LLM offline`.
- [ ] `waiting-human` / `waiting-peer` agents are never auto-recovered.
- [ ] Every decision and action is appended to `runs/<id>/babysitter.jsonl`.
- [ ] `main.ts` stays under 150 lines; `bun run check` and `bun test` pass.

## Out-of-scope risks

- Must not change the two-agent startup path when `--babysit` is absent (regression risk in
  `startPairedSession`).
- Hook injection must not break agent startup if the emitter or endpoint is missing — hooks are
  best-effort and must never block the agent.
- Auto-recovery must not poke a busy/healthy agent (false-positive risk) — mitigated by
  deterministic trigger + confidence gate + cooldown + cap.

## Open questions

- [ ] Exact Codex hooks config schema/event names in the installed Codex version — confirm against
      `codex` on this machine during T-02 and pin the emitted events.
- [ ] Default idle threshold and confidence gate values — start at `idle=120s`, `confidence=0.7`,
      tune during dry-run testing.
