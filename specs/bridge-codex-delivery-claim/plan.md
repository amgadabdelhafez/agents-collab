# Plan

1. Regression tests first (TDD), watched failing before any fix:
   app-server claim-during-inject, claim-released-on-failure,
   consumed-message abort, foreign-claim yield (bridge.test.ts); codex-pane
   claim + visible ack reason (bridge.test.ts); visible-path delegation
   without separate ack (codex-tmux-proxy.test.ts).
2. `deliverCodexBridgeMessage`: acquire the delivery claim after the existing
   status gates (no readiness wait exists on this path), re-check pending
   under the claim, inject, ack on success, release in a finally.
3. `deliverTmuxBridgeMessage`: optional ackReason parameter (default
   `sent to <target> tmux pane`) so the visible path keeps its ledger reason.
4. `deliverVisibleBridgeMessage`: delegate to `deliverTmuxBridgeMessage` with
   "submitted through visible codex tmux pane" so readiness is awaited before
   the claim and pending is re-checked under it; drop the unclaimed
   `submitTmuxBridgeMessage` call (remove the helper if no callers remain).
5. Update the existing visible-path proxy test to the delegation contract.
6. Deploy by rebuilding the live checkout binary and restarting only the
   dedicated `__bridge-worker`; if the live run uses the codex tmux proxy,
   leave the proxy process alone (it picks up the fix on its next natural
   restart) — never restart main agent panes.
