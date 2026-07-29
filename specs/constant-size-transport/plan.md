# Plan

1. Persist each fully composed launch charter inside the run directory, bind it
   into the manifest by path, bytes, and SHA-256, and derive a sub-1-KiB
   verification bootstrap.
2. Replace launch-time full-prompt paste and large-paste marker handling with
   the bounded bootstrap, preserving explicit nonzero workspace failures.
3. Make Codex bridge delivery tmux-independent, add persisted-thread resume,
   and protect app-server acceptance with the bridge delivery claim.
4. Add unresolved notification events and throttled constant-size inbox nudges
   for interactive non-Codex panes; retain body delivery only on non-terminal
   provider-native paths.
5. Update agent guidance and add unit/integration regressions for realistic
   charters, manifest bindings, resume/failure behavior, delivery races, and
   notification throttling.
6. Run Harness checkpoint/verification, the root full verifier, a source-wide
   transport audit, and exact-SHA independent review. Hold deployment until the
   T4/census release is explicit.
