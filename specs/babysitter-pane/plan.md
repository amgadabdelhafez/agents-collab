# Plan: Babysitter Pane (LLM loop watchdog)
> Derived from spec.md. Do not contradict spec.md or constitution.md.

## Approach

Add an opt-in `--babysit` mode to the existing paired tmux flow. A hidden `__babysit <runId>`
subcommand (same pattern as `codex-tmux-proxy`) runs inside a full-width bottom pane and executes
a fixed control loop: deterministic idle detection → Qwen verdict for suspect agents only →
gated escalation-ladder recovery → render + log. Hook capture is injected at agent launch
(Claude `--settings`, Codex per-run `config.toml`) so both agents write normalized JSONL the
babysitter tails. The LLM is never in the trigger path; it only confirms and summarizes.

## Sequence

1. **Flags + types + manifest** (`args.ts`, `types.ts`, `constants.ts`, `run-state.ts`): parse
   `--babysit*` flags; add babysitter manifest fields. Inert until wired.
2. **Hook injection** (`hooks/settings.ts`, `hooks/emit.ts`): generators for the Claude settings
   file and Codex `config.toml`; the `__hook-emit` subcommand that normalizes stdin → JSONL.
   Wire into `buildClaudeCommand` / Codex launch behind `opts.babysit`.
3. **Detector** (`babysitter-detect.ts`, pure): given hook tails + pane hashes + clock →
   per-agent `{lastEventAge, paneStable, suspect}`. Fully unit-tested.
4. **LLM client** (`babysitter-llm.ts`): OpenAI-compatible POST to the configured endpoint;
   parse/validate verdict; reasoning-model token budget; timeouts → `working` fallback.
5. **Recovery** (`babysitter-recover.ts`): pure ladder-decision (`decideAction(state, history)`)
   + effectful executors (answer-prompt / nudge / restart) via injected tmux deps; cooldown + cap.
6. **Control loop + render** (`babysitter.ts`): tie 1–5 together, status board, `babysitter.jsonl`.
7. **Third pane** (`tmux.ts::startPairedSession`): when `opts.babysit`, after the agent split,
   `split-window -v -f -l <height>` running `__babysit`. No change to the non-babysit path.
8. **Verify**: unit + dry-run integration tests; `bun run check`; write `eval.json`.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Trigger of recovery | Deterministic detector, not the LLM | Prevents hallucinated interventions on healthy agents |
| LLM role | Classify suspect + summarize only | Keeps auto-action gated behind objective signals |
| Babysitter process | Hidden `__babysit` subcommand in the same binary | Mirrors `codex-tmux-proxy`; one shipped artifact |
| Pane placement | Full-width bottom, `split-window -v -f` | User-requested; room for a status board |
| Hook transport | Launch-time injection to per-run paths | No global config mutation; auto-scoped to the run |
| LLM endpoint | Configurable, default local Qwen `:8082` | Free/private/unlimited polling; matches homelab setup |
| Endpoint down | Suppress recovery, keep detecting | Fail-safe; never guess an action blind |

## Affected subsystems

- **tmux launch** (`tmux.ts`) — new 3rd pane behind a flag; agent commands gain hook injection.
- **CLI args** (`args.ts`, `types.ts`, `constants.ts`) — new flags + defaults.
- **run-state** (`run-state.ts`) — manifest fields for babysitter pane/agent ids.
- **new: babysitter** (`babysitter*.ts`, `hooks/*`) — self-contained; imports tmux primitives only.

## Risks

- **False-positive recovery on a busy agent** → deterministic trigger + confidence gate + cooldown
  + `max-recoveries` cap + `waiting-human` exclusion + `--babysit-dry-run` for validation.
- **Hook injection breaks agent startup** → emitter is best-effort, never blocks; if the settings
  file/endpoint is absent the agent launches normally (regression test: non-babysit path unchanged).
- **Codex hook schema differs from assumption** → confirm against installed `codex` in T-02; keep the
  normalizer tolerant (unknown events pass through with `event:"raw"`).
- **Reasoning-model empty `content`** → verdict parser reads structured JSON with a token budget and
  falls back to `working` on malformed/empty output.

## Not doing

- Single-agent modes, non-paired runs, and multi-session dashboards — deferred.
- Semantic "is the work correct" judgment — the babysitter judges *liveness/progress*, not quality.
- Persisting summaries beyond `runs/<id>/` or shipping notifications beyond the pane (ntfy optional, later).
