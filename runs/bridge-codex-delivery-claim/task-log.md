# bridge-codex-delivery-claim task log

- Adversarial review (2026-07-26) confirmed the single-owner delivery claim
  covered only `deliverTmuxBridgeMessage`: `deliverCodexBridgeMessage` injected
  into the codex app-server with no claim and no pending re-check (sender-side
  immediate path and the 250 ms `__bridge-worker` drain could double-deliver,
  and `receive_messages` could return the message a third time), and the codex
  tmux proxy's `deliverVisibleBridgeMessage` called the unclaimed
  `submitTmuxBridgeMessage`, leaving the message pollable during the
  multi-second pane injection.
- TDD: six regressions written and observed failing before the fix (app-server
  claim-held-during-inject, claim-released-on-failed-inject, consumed-message
  abort, foreign-claim yield, codex-pane visible-ack-reason claim
  choreography, proxy delegation without separate ack).
- Fix: `deliverCodexBridgeMessage` acquires the delivery claim after its
  status gates (no readiness wait exists on this path), re-checks pending
  under the claim, injects, acks on success, and releases in a finally.
  `deliverTmuxBridgeMessage` gained an optional ackReason; the proxy's
  `deliverVisibleBridgeMessage` now delegates to it with "submitted through
  visible codex tmux pane", so readiness is awaited before the claim and
  pending is re-checked under it. The unclaimed `submitTmuxBridgeMessage`
  helper was removed (no callers remained).
- Verification: bridge 80/80 + proxy 12/12; full suite 811 passed with the
  same four baseline Codex-launch failures; build, scoped biome check, and
  `git diff --check` clean. Independent evaluator subagent returned PASS with
  no blocking defects.
- Deployment: pending (rebuild live binary, restart only the dedicated
  bridge worker; no main agent pane restarts).
