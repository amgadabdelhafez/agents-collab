# Verification

1. A realistic 22 KB Codex prompt does not receive Enter until its
   `[Pasted Content ...]` marker is captured.
2. A realistic 22 KB Claude prompt does not receive Enter until its fragmented
   `[Pasted text #N]` marker is captured.
3. Missing render evidence terminates at the configured poll bound.
4. The two pane waits begin before either pane is submitted.
5. `scripts/verify.sh paste-submit-readiness paste-submit-readiness` passes.
6. `runs/paste-submit-readiness/eval.json` records a separate-agent verdict.
7. A 9,279-byte runtime bridge body is read through `tmux load-buffer`, pasted
   with `paste-buffer -p`, and never appears in `send-keys` arguments.
8. Runtime Enter occurs only after a delayed `[Pasted text #N]` marker and the
   private payload file is removed immediately after buffer loading.
