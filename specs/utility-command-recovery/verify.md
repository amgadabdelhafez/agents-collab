# Verification

1. Replaying an unprofiled focused-check request creates no utility job and
   returns actionable exact metadata guidance.
2. An exact focused check targeting a registered linked worktree persists a
   normalized root, cwd, scopes, and argv and runs only there.
3. A 600-line dynamic read returns lines 1-500 with `truncated=true`,
   `requestedEndLine=600`, and `nextStartLine=501`; a second bounded read can
   complete the evidence.
4. An oversized exact classified range remains rejected.
5. The repeat and rejection breakers retain their existing tests.
6. `scripts/verify.sh utility-command-recovery utility-command-recovery`
   passes with an empty baseline list.
7. `runs/utility-command-recovery/eval.json` records a separate-agent verdict.
