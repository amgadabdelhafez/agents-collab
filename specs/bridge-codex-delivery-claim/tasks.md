# Tasks

- [x] Baseline: full suite shows only the 4 known Codex-launch failures.
- [x] RED: four `deliverCodexBridgeMessage` concurrent-ownership regressions
      (claim held during inject, claim released on failed inject, consumed
      message aborts before inject, foreign claim yields) fail on current code.
- [x] RED: codex-pane `deliverTmuxBridgeMessage` visible-ack-reason regression
      fails on current code.
- [x] RED: `deliverVisibleBridgeMessage` delegation regression (routes through
      claimed delivery, no separate ack) fails on current code.
- [x] GREEN: claim + pending re-check in `deliverCodexBridgeMessage`.
- [x] GREEN: ackReason parameter on `deliverTmuxBridgeMessage`.
- [x] GREEN: `deliverVisibleBridgeMessage` delegates to
      `deliverTmuxBridgeMessage`; unclaimed submit path retired.
- [x] Existing visible-path proxy test updated to the delegation contract.
- [x] Full suite, build, biome check, `git diff --check` clean (baseline-only
      failures).
- [x] Independent evaluation against verify.md; `eval.json` + `task-log.md` in
      `runs/bridge-codex-delivery-claim/`.
- [ ] Deploy: merge, rebuild live binary, restart only the bridge worker.
