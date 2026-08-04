PURPOSE: Close the only survived mutation from your exact-SHA review of
`4a4d94f323b3f45848b83cc4427658855062bba6` before any world-model work resumes.

REQUESTED ACTION: Review the stamped candidate SHA and reply with exact-SHA
`CONCUR` or blocking findings. This is a content-review request only, not deploy
clearance.

SCOPE:

- Parent is the previously reviewed `4a4d94f323b3f45848b83cc4427658855062bba6`.
- Runtime behavior is unchanged.
- Added producer-backed tests around an unchanged copy of the governed sender.
- Added the bounded Harness task, eval, run evidence, and spec acceptance text.

MUTATION CLOSURE:

- A fake gate that exits zero with `status=PASS` but no
  `REVIEW_GATE_STAMP_V1` is refused with exit 1 and zero xchan calls.
- A fake gate that exits zero with `REVIEW_GATE_STAMP_V1` but no
  `status=PASS` is refused with exit 1 and zero xchan calls.

VERIFICATION:

- Focused review-request gate suite: 7 pass, 0 fail, 91 assertions.
- Full sequential `bun run test:ci`: pass.
- `bun run check`: pass across 761 files.
- `bun run build`: pass.
- Harness unit, focused, check, build, and full dimensions: pass.
- Harness preflight and stop-gate: pass.
- `./harness done`: post-task invariants pass, zero debt findings, regression
  harvested.

The separate world-model slice remains paused and is not part of this review.
