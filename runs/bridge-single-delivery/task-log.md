# Bridge single-delivery task log

- Confirmed loop 48 had one ledger message for bridge ID
  `72d1512b-0163-4511-bbfc-5b33affa9e18` but three visible Claude copies.
- Narrowly stopped the bridge worker and resolved the already-seen pending ID;
  Claude and Codex pane processes were not touched.
- Added delivery-claim filtering to `receive_messages`.
- Added hook-backed active-turn exclusion for Claude tmux delivery.
- Focused bridge tests: 71 passed, 0 failed.
- Build and `git diff --check`: passed.
- Full suite: 800 passed; 4 pre-existing Codex-launch expectation failures.
