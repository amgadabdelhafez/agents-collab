# Spec: Claude Pane Delivery Confirmation

## Problem

Loop 47 repeatedly journaled codex-to-Claude bridge messages as delivered after
`tmux send-keys` returned success, even when the text remained unsubmitted in
Claude's composer. The bridge treated keystroke acceptance as delivery proof.

## Goal

For visible Claude-pane delivery, acknowledge the ledger only after pane state
and Claude's session transcript prove that the injected message was submitted.

## Requirements

1. Capture the Claude transcript version before injection.
2. After Enter, require both a cleared composer and a newer transcript version.
3. If the text remains in the composer, retry once by appending one literal
   space and pressing Enter.
4. If confirmation still fails, return false and keep the ledger message
   pending for the bridge worker's next attempt.
5. Preserve non-empty human drafts: injection still begins only at an empty
   Claude prompt.
6. Do not apply Claude-specific confirmation to other agent panes.
7. Add deterministic success, fallback, and unconfirmed-delivery regressions.
8. Refresh only the bridge/governess control path in loop 47; do not restart or
   inject into Claude or Codex while either is active.
