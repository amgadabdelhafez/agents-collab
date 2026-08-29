# Review index — reviewed SHA 1b2817a0

Reviewed SHA (exact): `1b2817a0f6c13b39fc88ca3aef9f708e05da0c85`.
Parent SHA: `3b0e4f063b791a6d9f89746b2efba439af2b3fef`.
Base integration SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`.

## Verdicts

| Reviewer | Location / identifier | Writes | Verdict |
|---|---|---|---|
| `codex-different-cold-plan-reviewer` | `/root/cold_third_review` | zero | `REFUSE` |

The verdict is literal `REFUSE`. **No `PASS` is claimed anywhere, by any party,
for this SHA or for its successor.** A successor commit closing these findings is
not an acceptance; it must receive a fresh, different cold zero-write exact-SHA
plan review.

Full record:
- `review-refuse-codex-different-cold-plan-reviewer-1b2817a0.md`

The earlier index `review-index-3b0e4f06.md` and its two `REFUSE` records cover a
different reviewed SHA and are unchanged.

## Role of Run 130 Claude

The Run 130 Claude writer role is the **recorder/transcriber** of this verdict.
It is **not a reviewer**, it authored no verdict, and it returned no verdict of
its own. It is the sole Claude writer role for Run 130; no concurrent writer
exists.

## Finding-to-closure mapping

| # | Finding | Closure in the successor |
|---|---|---|
| R3-1 | `verify.md` authority uses the glob `specs/loop-resume-terminal-reservation-v1/**` (blob `c75159c94c96ad950a39d067a82b55d8d1262dcb` lines 15-16) | The glob is replaced by exactly three listed paths: `specs/loop-resume-terminal-reservation-v1/spec.md`, `specs/loop-resume-terminal-reservation-v1/plan.md`, `specs/loop-resume-terminal-reservation-v1/verify.md`. No other allowlist entry changes; `runs/loop-resume-terminal-reservation-v1/**` and the exact Harness write authority block stay byte-identical. |
| R3-2 | Empty named failure sets required only for "applicable" test gates, leaving `bun run check`, `bun run build`, and `git diff --check` outside the explicit requirement (plan blob `d68fc50dbf22bb2ffe27498242cd87df97fbeea8` lines 81-95; verify blob `c75159c94c96ad950a39d067a82b55d8d1262dcb` lines 161-177) | `spec.md`, `plan.md`, and `verify.md` each now state that **every one** of the seven named commands has its own explicit empty named failure set, enumerated by name, with `bun run check`, `bun run build`, and `git diff --check` on identical terms with the four test commands. The word "applicable" is removed from all three specs. Omission or "not applicable" for any of the seven is a gate failure. Passing counts alone remain insufficient and no tolerated failure or baseline allowance is permitted. |

The seven named commands, verbatim and in contract order:

```bash
bun run test:file -- tests/loop/run-state.test.ts
bun run test:file -- tests/loop/launch-reservation.test.ts
bun run test:file -- tests/loop/tmux-socket.test.ts
bun run test:ci
bun run check
bun run build
git diff --check
```

## Preserved, not weakened

The four already accepted corrections C1-C4 recorded in `review-index-3b0e4f06.md`;
the exact Run 42 literals; the reservation evidence boundary; the endpoint seam
and `targetOf` target opacity; the fail-closed refusal matrix; the strict date
and PID rules; and the exact Harness write authority (`loop-fork/.harness/tasks.json`
limited to task `loop-resume-terminal-reservation-v1`, ephemeral
`loop-fork/.harness/current-task` required absent at closure, and
`loop-fork/.harness/evidence/loop-resume-terminal-reservation-v1/**` only, with no
`current-run`).

## Successor commit character

The successor is **contract-only**. It changes zero product, test, fixture, and
dependency bytes; installs nothing; runs no gates, probes, tmux, device, or Web
UI work; and performs no merge, rebase, or push. It stops before source for a
different cold zero-write exact-SHA plan review.
