# Plan

1. Expose bridge delivery-claim ownership to the MCP receive path.
2. Filter claimed messages from `receive_messages` without resolving them.
3. Add hook-backed Claude busy detection to tmux readiness.
4. Add focused regressions, run the full verification suite, and build.
5. Deploy only the bridge worker for loop 48 and verify pane PIDs are unchanged.
