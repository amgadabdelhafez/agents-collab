# babysitter-pane Research

## Research Question

What existing primitives (in-repo and on the host CLIs) already solve pane
watching, hook capture, and LLM judgment, so the babysitter reuses rather than
reinvents?

## Candidates Reviewed

- loop-fork `src/loop/tmux.ts` — `capturePane`, `sendKeys`, `sendText`,
  `split-window`, `unblockClaudePane`. Fit: high. Reused for pane capture, recovery
  keystrokes, and the third-pane split.
- loop-fork `src/loop/run-state.ts` + `codex-home.ts` — per-run manifest and per-run
  `CODEX_HOME`. Fit: high. Reused for run resolution and Codex hook placement.
- Claude Code `--settings` hooks — confirmed against the installed `claude` CLI. Reused
  as the Claude hook transport (per-tool + turn events).
- Codex hooks (`$CODEX_HOME/hooks.json`, `--dangerously-bypass-hook-trust`) — confirmed
  against installed `codex` and the existing `~/.codex/hooks.json`. Reused as the Codex
  hook transport (coarse turn events only).
- Local Qwen mlx-lm server (OpenAI-compatible `:8082`) — reused as the verdict backend
  via plain `fetch`; no SDK added.

## Open-Source Patterns

Supervisor/watchdog pattern: a deterministic liveness detector triggers, and the LLM
only classifies/summarizes a flagged suspect (never in the trigger path). Recovery uses
a bounded escalation ladder with cooldown + cap to avoid thrashing a healthy worker.

## Reuse Decision

BUILD-ON-REUSE, no new dependencies. All I/O comes from existing loop-fork modules;
both hook transports are native CLI features confirmed on this host; the LLM call is a
raw `fetch` to the already-running local server. New code is glue only: detector,
verdict client, recovery ladder, control loop, pane/hook wiring.

## Sources

- https://docs.claude.com/en/docs/claude-code/hooks — Claude Code hooks (event names,
  stdin payload, `--settings` registration) used for the Claude hook transport.
- https://github.com/ml-explore/mlx-lm — mlx-lm server (`mlx_lm.server`,
  OpenAI-compatible `/v1/chat/completions`) used as the local Qwen verdict backend.
- In-repo: `src/loop/tmux.ts`, `src/loop/run-state.ts`, `src/loop/codex-home.ts`
- Host CLIs: `claude --help` (--settings), `codex --help` + `~/.codex/hooks.json`
