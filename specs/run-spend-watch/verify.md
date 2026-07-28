# Verify — run-level spend watch

## Commands and observed results

| Check | Command | Baseline (main @ aa74ee7) | After |
|---|---|---|---|
| Tests | `bun test` | 890 pass / 4 fail | 926 pass / 4 fail |
| Failures | `bun test \| grep '(fail)'` | 4 Codex-launch expectations | same 4, unchanged |
| Lint | `biome check src tests` | 147 errors | 147 errors |
| Types | `tsc --noEmit` | 150 errors | 150 errors |
| Build | `bun run build` | 70 modules | 71 modules (new module bundled) |

The four failures before and after are identical:

```
(fail) preparePairedOptions creates a loop-scoped Codex home without global MCP config
(fail) runAgent launches Codex app-server with loop-scoped Codex home
(fail) buildCommand carries Codex bridge approval config for legacy exec
(fail) startPersistentAgentSession enables persistent Codex threads
```

`biome check src/loop/governess.ts` reports 47 errors both at HEAD and after
the change, so the 92 added lines introduce none. The `governess.ts` diff is
**purely additive** (92 insertions, 0 deletions).

## Safety properties asserted by test

- `observe` (the default) and `alert` return `enforced: false` for every input,
  including `$1,000,000` at `$100,000/hr`.
- `$30` cumulative at `$4/hr` — over `killUsd` — classifies `alert`, not
  `runaway`. A large legitimate job cannot be killed.
- `$6` at `$500/hr` — over the burn threshold — classifies `alert`, not
  `runaway`. A brief spike cannot be killed.
- `$100,000` of subscription (attributed) spend with zero billable spend never
  requests a kill.
- A single sample cannot produce a kill; the burn rate needs ≥ 60s of span.
- Notice and alert each escalate exactly once per run.
- Repeated usage events for one `jobId` are counted once (latest wins).
- Malformed JSONL lines, missing costs and negative costs are ignored.
- The journal contains no `secret`, `bearer`, or `token` substring.
- `appendSpendJournal` does not throw on an unwritable directory.

## Not verified

Nothing has run against a live loop. Observe mode exists precisely so the
founder can gather a week of `spend-watch.jsonl` before choosing real numbers;
the shipped defaults are placeholders, not measurements.
