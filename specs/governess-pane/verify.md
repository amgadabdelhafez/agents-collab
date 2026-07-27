# Verify: Governess Pane (LLM loop watchdog)
> This is the evaluator contract. The evaluator agent reads this file, not the spec.
> Every acceptance criterion in spec.md must appear here as a testable check.

## Automated checks

```bash
cd loop-fork
bun run check      # lint + types + style (biome)
bun test           # unit + integration
```

## Functional checks

| # | Check | Command / Assertion | Pass condition |
|---|---|---|---|
| F-01 | Non-governess layout unchanged | `bun test tests/loop/tmux.test.ts` | Existing 2-pane assertions unchanged; no `split-window -v -f` without `--governess` |
| F-02 | `--governess` adds full-width bottom pane | `bun test tests/loop/tmux.test.ts` | With flag, a `split-window -v -f -l <height>` running `__governess` is issued |
| F-03 | Hook injection wiring | `bun test tests/loop/*hook*` | Claude cmd gains `--settings <runDir>/hooks/claude-settings.json`; Codex gets per-run `config.toml` + bypass flag; only when `opts.governess` |
| F-04 | Emitter normalizes to JSONL | `bun test tests/loop/*emit*` | stdin JSON → one `{ts,agent,event,tool,detail,cwd}` line; exit 0 on bad input; unknown → `event:"raw"` |
| F-05 | Detector requires both signals | `bun test tests/loop/governess-detect.test.ts` | `suspect` only when stale events AND stable pane hash; active/changing never suspect |
| F-06 | LLM only for suspects; fallback safe | `bun test tests/loop/governess-llm.test.ts` | No call for non-suspect; malformed/empty/timeout → `{state:"working"}`; unreachable flagged distinctly |
| F-07 | Recovery gating | `bun test tests/loop/governess-recover.test.ts` | Action only on `{stuck,crashed}` & `confidence≥gate`; cooldown + `max-recoveries` enforced; `waiting-human/peer` never act |
| F-08 | Dry-run executes nothing | `bun test tests/loop/governess-recover.test.ts` | `--governess-dry-run` returns intended action; zero executor calls |
| F-09 | LLM offline suppresses recovery | `bun test tests/loop/governess.test.ts` | Endpoint unreachable ⇒ detector runs, board shows `LLM offline`, no action fired |
| F-10 | Decisions logged | `bun test tests/loop/governess.test.ts` | Each decision/action appended to `runs/<id>/governess.jsonl` |
| F-11 | main.ts size budget | `test $(grep -c "" loop-fork/src/loop/main.ts) -lt 150` | main.ts < 150 lines |

## UI checks

Not applicable — this is a terminal/tmux feature, no web UI. The pane's status board is asserted
via the control-loop render test (F-09/F-10), not screenshots.

## Performance thresholds

| Metric | Threshold | How to measure |
|---|---|---|
| Governess tick cost (no suspects) | 0 LLM calls | F-06 assertion (no call when not suspect) |
| Idle → first verdict | ≤ 1 tick after `idle` threshold | detector + loop test timing (mock clock) |

## Regression guards

These must NOT regress:

- [ ] Paired non-governess startup (`startPairedSession`) — existing `tmux.test.ts` golden assertions pass.
- [ ] `--claude-only` / `--codex-only` single-agent paths — unaffected (governess is paired-only).
- [ ] Claude/Codex launch commands with `--governess` absent — no `--settings` / `config.toml` added.
- [ ] Resume behavior (`--run-id` / `--session`) — governess pane re-attaches to the same run id.

## Rollback conditions

If any of the following are true after merge, revert immediately:

- Auto-recovery acts on a healthy agent in a real run (any confirmed false-positive restart).
- Enabling `--governess` changes agent behavior or breaks startup when the endpoint is down.
- `bun run check` or `bun test` fails on `main`.

## Eval output format

The evaluator writes `runs/<task-id>/eval.json`:

```json
{
  "task_id": "[task-id]",
  "feature": "governess-pane",
  "timestamp": "[ISO-8601]",
  "checks": {
    "functional": { "passed": 0, "failed": 0, "details": [] },
    "ui": { "passed": 0, "failed": 0, "screenshots": [] },
    "performance": { "passed": 0, "failed": 0, "details": [] },
    "regression": { "passed": 0, "failed": 0, "details": [] }
  },
  "verdict": "pass | fail",
  "notes": ""
}
```
