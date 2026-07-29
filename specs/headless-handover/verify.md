# Verification

1. Pure probe tests distinguish `0:<agent-command>`, `1:<command>`, a
   successful tmux command whose target is missing, malformed output, and tmux
   control unavailability.
2. A headless-agent handover fixture contains two validated bundles, reports
   one missing pane and one live pane, sends `/exit` only to the live pane, and
   launches the replacement exactly once.
3. The transaction remains non-destructive until the replacement is alive,
   ready, and has accepted the handover manifest.
4. After acceptance, the old run records stopped state, cleans only run-owned
   processes, and kills its tmux session in the existing order.
5. Unknown pane evidence does not launch a replacement and does not invoke
   teardown.
6. `scripts/verify.sh headless-handover headless-handover` passes with an empty
   baseline allowlist.
7. The exact committed SHA receives independent review before deployment.

