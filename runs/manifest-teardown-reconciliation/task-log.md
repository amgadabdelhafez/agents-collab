# Manifest teardown reconciliation

- Positively verified loop 125 had no tmux session, no run-scoped processes,
  closed ports 4501 and 4601, and a proxy lifecycle ending in `SIGTERM` then
  `stopped`, while its manifest still declared the run active.
- Added an atomic dead-session reconciler guarded by active state and the
  unchanged tmux-session binding.
- Wired it to confirmed lifetime death and signal shutdown. Live and unknown
  liveness preserve state.
- Focused proxy suite on the cleared integration: 20 pass, 0 fail, including
  reconciliation-probe failure and retained shutdown-caller coverage.
- `bun run test:ci` passed every sequential test file with no failures.
- Source-lineage comparison: all four source-branch failures reproduce on
  untouched parent `f4eb698`; the cleared integration has an empty baseline.
- Next: finish the integrated commit and request exact-SHA review.
