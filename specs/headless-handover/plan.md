# Plan

1. Add a pure pane-probe result normalizer that distinguishes a confirmed
   missing tmux target from unavailable/unknown control.
2. Use that normalizer in the default Governess pane probe without weakening
   the existing bounded tmux timeout behavior.
3. Add focused regressions for missing, live, dead, malformed, and unknown
   probes plus a complete headless handover transaction.
4. Prove the headless transaction skips terminal input, launches once, waits
   for replacement acceptance, and then invokes existing mark-cleanup-kill
   ownership in order.
5. Run focused tests, full repository verification, reproducible builds, and
   exact-SHA independent review before any deploy.

