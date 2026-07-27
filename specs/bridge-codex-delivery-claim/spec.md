# Bridge codex-side delivery claims

## Problem

The single-owner delivery claim (bridge-single-delivery, hardened by
bridge-idle-delivery) covers `deliverTmuxBridgeMessage` only. Adversarial
review on 2026-07-26 confirmed the two codex-side automatic delivery paths
bypass it:

1. `deliverCodexBridgeMessage` (src/loop/bridge-runtime.ts) performs the
   app-server injection with no claim and no pending re-check. The sender-side
   immediate path (bridge.ts `immediateBridgeDelivery`, governess.ts
   `sendGovernessBridgeMessage`) and the persistent `__bridge-worker`
   `drainCodexAppServerMessages` loop (250 ms cadence) can both deliver the
   same message, and `receive_messages` can return it a third time because no
   claim file ever exists.
2. `deliverVisibleBridgeMessage` (src/loop/codex-tmux-proxy.ts) calls
   `submitTmuxBridgeMessage` directly with no claim; during the multi-second
   pane injection the message stays pending and unclaimed, so a codex
   `receive_messages` poll consumes it while the injection also completes.

## Requirements

- Both codex-side automatic delivery paths follow the
  `deliverTmuxBridgeMessage` claim choreography: wait for readiness BEFORE
  acquiring the claim, re-check pending under the claim before injecting,
  acknowledge before releasing.
- `deliverCodexBridgeMessage` has no readiness wait (the app-server call is
  the injection itself), so it claims immediately after its status gates,
  re-checks pending under the claim, injects, acks on success, and releases
  the claim on every path including errors.
- The visible codex tmux path delivers through the claimed tmux choreography;
  its readiness wait (which can poll for seconds) must never hold a claim.
- The visible path keeps its distinct ledger reason
  ("submitted through visible codex tmux pane").
- A message consumed by polling before injection is never injected.
- A fresh foreign claim makes both paths yield without injecting.
- No main agent pane is restarted during deployment.

## Acceptance

- Regressions prove the app-server path holds the claim during injection,
  releases it on success and on failure, skips already-consumed messages, and
  yields to a foreign claim. All existing `deliverCodexBridgeMessage` tests
  were single-caller; these are the first concurrent-ownership regressions.
- A regression proves codex pane delivery holds the claim during injection and
  records the visible ack reason when asked to.
- A regression proves the visible proxy path routes through the claimed tmux
  delivery and no longer acknowledges separately.
- Existing bridge delivery, retry, queue, dedup, and single-owner tests pass;
  the full suite matches the 4 known Codex-launch baseline failures.
- Live: only the dedicated bridge worker restarts on the new binary; Claude,
  Codex, governess, and utility pane PIDs unchanged.
