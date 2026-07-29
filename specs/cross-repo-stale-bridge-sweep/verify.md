# Verification

1. Exact bridge children for terminal manifests in multiple repository IDs are
   signaled after an unchanged second identity read.
2. An exact bridge child whose canonical run directory is absent is signaled.
3. Active/submitted, malformed, unreadable, identity-mismatched, and
   non-canonical run paths are preserved.
4. A live app-server or Claude process whose argv embeds `__bridge-mcp` is not
   even classified as a bridge candidate.
5. Extra arguments, unknown sources, executable mismatch, command changes, and
   PID reuse are preserved.
6. Process enumeration and per-PID inspection failures are contained and do
   not abort CLI startup.
7. `--version`, `--help`, and hidden helper subcommands bypass the sweep.
8. Focused cleanup and CLI tests pass through Harness.
9. `scripts/verify.sh cross-repo-stale-bridge-sweep
   cross-repo-stale-bridge-sweep` passes with an empty baseline list.
10. `runs/cross-repo-stale-bridge-sweep/eval.json` records verification and an
    exact-SHA independent review gate before deployment.
