---
seq: 002
date: 2026-07-29T20:37:18Z
trigger: manual
topic: implemented fail-closed pane-death recovery and passed focused plus full verification
---

## Decided

- tmux `pane-died` is the direct signal; no polling daemon is added.
- Recovery requires active exact manifest/session/pane ownership twice.
- The rolling budget is three attempts per five minutes and is recorded before
  each respawn.
- Terminal/malformed/stale state fails closed and remains visibly stopped.

## Still open

- Exact-SHA independent review and deploy authorization.

## Where we are

- Focused and full verification pass.
- Isolated tmux active-recovery and stopped-run-suppression proof pass.
- Immediate hook reconciliation is a live-pane no-op and closes the
  split-to-hook exit race; the fourth rapid crash remains visibly stopped.
- Hook arming is ordered after complete control-pane creation and final stable
  manifest persistence, so startup-failure teardown cannot race recovery.
- Candidate is not deployed; Harvto run 100 remains untouched.
