# Plan: Worker Routing Live Integration

1. Record the live run-51 baseline: installed binary hash/inodes, pane PIDs,
   routing counters, ineligibility reasons, and worker tool failures.
2. Port only the governess usage-stability source and tests from the three
   earlier commits onto current `main`; do not modify the delegation grammar.
3. Add red-first tests for the 135 KiB bounded-read failure, request-specific
   tool exposure, literal bounded Git metadata execution, safe Git command
   chains, and fail-closed mixed/mutating chains; implement the smallest broker
   and classifier changes that make them pass.
4. Run focused governess and routing suites, full `bun test`, `bun run check`,
   `bun run build`, and `git diff --check` through Harness where applicable.
5. Obtain an independent evaluation against `verify.md` and write a passing
   run-owned `eval.json`.
6. Install the freshly built executable by inode move. Keep Claude/Codex alive;
   respawn only the governess and worker-display panes so both load the new
   executable.
   Verify PIDs, binary hash, doctor output, stable usage display, completed
   worker jobs, and live routing telemetry.
