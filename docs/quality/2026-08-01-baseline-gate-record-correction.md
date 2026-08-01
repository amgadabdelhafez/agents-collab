# Record correction — fix/baseline-gate-fail-closed commit 33a12952

**The commit message's pre-existing-diagnostics enumeration was WRONG.** It claimed the
parent's `bun run check` red was "20 format diagnostics" across five named `loop-fork/runs/`
directories. Independent measurement (supervisor, 2026-08-01, unsandboxed) and the exact-SHA
review both found **201 errors + 1 warning across SIX directories** — the five named plus
`runs/babysitter-pane/`. The substance is unchanged: the `loop-fork/runs` tree is
byte-identical between parent `cca7bef` and tip `33a12952` (tree `3248686a…`), so every
diagnostic is pre-existing and none was introduced or hidden by this branch. The defect was
the RECORD: an under-count stated as an exact enumeration. Banked class: verify the claim's
NUMBERS by running the instrument, not by summarising a partial scroll.
