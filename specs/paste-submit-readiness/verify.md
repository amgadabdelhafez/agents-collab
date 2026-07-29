# Verification

1. A realistic 22 KB Codex prompt does not receive Enter until its
   `[Pasted Content ...]` marker is captured.
2. A realistic 22 KB Claude prompt does not receive Enter until its fragmented
   `[Pasted text #N]` marker is captured.
3. Missing render evidence terminates at the configured poll bound.
4. The two pane waits begin before either pane is submitted.
5. `scripts/verify.sh paste-submit-readiness paste-submit-readiness` passes.
6. `runs/paste-submit-readiness/eval.json` records a separate-agent verdict.
