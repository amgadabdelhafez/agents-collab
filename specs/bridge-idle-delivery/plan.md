# Plan

1. Regression tests first (TDD): dim type-ahead readiness unit test, ghost
   delivery end-to-end, no-claim-during-wait, consumed-mid-wait abort.
2. `claudeComposerText` strips SGR-dim spans (then residual ANSI) before the
   `❯` prompt parse; Claude readiness/confirmation captures use
   `tmux capture-pane -e`.
3. Delivery-claim scope: `deliverTmuxBridgeMessage` waits for pane readiness
   BEFORE `acquireDeliveryClaim`, then re-checks pending and re-checks
   readiness with a single attempt under the claim before injecting.
4. Update capture choreography in the four existing tests affected by the
   extra in-claim readiness capture.
5. Deploy by rebuilding the live checkout binary and restarting only the
   dedicated `__bridge-worker`; governess respawns it. No pane restarts.
