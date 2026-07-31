# Plan

1. Reproduce the startup sequence in a disposable tmux server using an isolated
   Claude config directory and the same strict MCP/development-channel flags as
   Loop.
2. Capture the rendered producer output, inspect it for secrets or personal
   data, and write adjacent provenance metadata with hashes.
3. Replay the captured fixture in the existing tmux startup test. If production
   rejects a captured empty composer, bind pane text, cursor, activity, client,
   and pipe state in one tmux command queue. Probe the ambiguous suggestion with
   ordered `End,C-l` only after an activity-second boundary, require an observed
   redraw, and restore a detected draft with acknowledged `Home,C-l`.
4. Keep synthetic wrapping variants explicitly labeled as unit-only.
5. Preserve executable red-before evidence, run focused and full verification,
   obtain exact-commit independent review, then deploy the exact reviewed bytes
   and run the bound pre-launch smoke.
