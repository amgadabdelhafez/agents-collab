# Phase 0A Verification

The slice passes only when all of the following are true:

1. One focused test proves a valid envelope round-trip and a cross-lane envelope
   is rejected with a stable machine-readable reason.
2. TypeScript typecheck passes for the affected source and test graph.
3. Formatting/static checks pass for changed files.
4. The loop binary builds successfully, proving the additive module does not
   break the existing package.
5. `git diff --check` passes and the changed-file list stays within the spec,
   contract module, one test file, documentation, and run evidence.
6. `runs/agent-operations-phase0-contracts/eval.json` records commands, results,
   hashes, reviewer verdict, and confirms no live service or installed binary
   was changed.
7. The governed loop produces one scoped commit and stops without merge,
   install, push, or runtime activation.
