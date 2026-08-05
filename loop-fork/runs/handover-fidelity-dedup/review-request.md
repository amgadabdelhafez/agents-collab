# Exact-SHA review request: handover effort fidelity and restart reconciliation

## Authority and lineage

- Supervisor ruling: `71fdfec7-0aaa-4a86-b364-892dbecceb20`.
- Required cleared harness tip: `67e622d0aee4ef331acec3cebc58e34f7f2ec292`.
- This is the first approved slice. Context-pressure restacking remains second.
- Retired candidate `1e04e5fb7e83366079cba4260d3ed8362ffce738`
  remains unreviewed and was recorded in the debt register with its rationale.

## Claim

Teardown-first handover now preserves the exact driver and reviewer efforts and
binds the durable continuation plus both context bundles into the validated
handover manifest. Replacement argv is derived only from those validated
manifest values. A Governess restart also clears stale viewport and scrollback
content exactly once before rendering the first live frame, so predecessor rows
cannot remain visually duplicated while steady-state rendering stays
changed-line-only.

## Consumer trace

The duplicate-row symptom was display-only terminal residue, not duplicate
state or accounting:

- Persisted Governess state contains no agent-row or helper-row arrays.
- Runtime configuration constructs exactly one monitored agent for each
  manifest left/right pane.
- Each tick produces one current row per configured agent and at most one
  current row for each helper tier.
- Cost, statistics, role balance, pressure, quota display, and enforcement all
  consume those current rows before rendering.
- Therefore stale predecessor rows could remain on screen after a restart, but
  they could not double-count spend, pressure, quota, or enforcement decisions.

The fix is consequently confined to the initial terminal frame: it emits
scrollback clear, viewport clear, and cursor home once. Later frames continue
through the existing delta renderer.

## Verification

- Producer-backed terminal regression starts with stale predecessor rows and
  ends with exactly one live Codex row and one live au-pair row; the next frame
  contains no clear sequence.
- Handover regressions verify exact driver/reviewer effort argv and fail closed
  for invalid effort, continuation tampering, and bundle tampering.
- Focused suites: `116 pass, 0 fail`.
- `bun run check`: pass.
- Governed TypeScript command: pass.
- `bun run build`: pass.
- `git diff --check`: pass.
- Full uninterrupted `bun run test:ci`: pass outside the sandbox, with no
  tolerated failures. The prior sandbox attempt stopped only on localhost bind
  denial; the exact integration test passed outside the sandbox before the full
  rerun.
- Official `scripts/verify.sh handover-fidelity-dedup
  handover-fidelity-dedup`: pass through lint, typecheck, build, the complete
  sorted test set, and an empty baseline allowlist.

## Boundaries

- No live run, process, tmux pane, channel data, installed binary, or release
  state was mutated.
- This request is review only. No merge, push, installation, or deployment is
  requested or authorized by it.
- T4 remains gated on reviewer HIGH.

Please review the stamped exact candidate and reply with CONCUR or concrete
blocking findings against that exact SHA.
