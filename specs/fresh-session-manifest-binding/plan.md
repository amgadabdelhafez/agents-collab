# Plan

1. Add one small manifest-binding helper beside `updatePairedManifest` for the
   fields known before workspace creation.
2. Call it on the fresh path immediately after `sessionExists` returns false
   and before Governess-hook or persistent-agent initialization.
3. Extend paired tmux tests to capture the manifest at the first asynchronous
   boundary, then cover successful completion and failed startup retention.
4. Run focused tmux tests, the combined lifecycle regression band, and the full
   task verifier.
5. Record an eval and request an independent review bound to the exact commit.
