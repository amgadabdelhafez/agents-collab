# Manifest teardown reconciliation

- Positively verified loop 125 had no tmux session, no run-scoped processes,
  closed ports 4501 and 4601, and a proxy lifecycle ending in `SIGTERM` then
  `stopped`, while its manifest still declared the run active.
- Added an atomic dead-session reconciler guarded by active state and the
  unchanged tmux-session binding.
- Wired it to confirmed lifetime death and signal shutdown. Live and unknown
  liveness preserve state.
- Focused proxy suite: 19 pass, 0 fail, including reconciliation-probe failure.
- Full source-lineage suite: 900 pass, four named failures. All four reproduce
  unchanged on parent `f4eb698`; this branch is not release-cleared.
- Next: commit the source fix, restack it on the cleared integrated lineage,
  rerun mandatory suites, and request exact-SHA review there.
