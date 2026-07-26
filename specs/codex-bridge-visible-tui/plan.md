# Plan: Bridge activity visible in the agent TUIs

## Approach

Route every incoming Codex bridge request through the existing guarded
tmux-pane injector. The proxy acknowledges it only after pane submission
succeeds and never originates app-server `turn/start` or `turn/steer` requests
for bridge delivery. Codex's TUI remains the sole owner of visible turns and
decides whether input submitted during work steers or queues.

## Sequence

1. Add failing proxy tests for idle visible delivery and failed submission.
2. Expose an acknowledgement-free guarded pane injector from bridge runtime.
3. Make proxy draining asynchronous and single-flight for visible delivery.
4. Remove proxy-originated bridge turns/steers and verify reconnect behavior.
5. Build, run focused/full tests, install the new loop binary, restart only the
   live run's proxy transport if it can be done without restarting Codex, and
   run a visible bridge canary.
6. Route Claude inbound traffic through its tmux pane when one is live, while
   retaining MCP channel notifications for headless runs.
7. Keep non-Codex tmux draining active while the Codex proxy owns Codex
   delivery, add regression tests, and deploy only bridge support processes.
8. Run a visible Claude canary without restarting either main-agent pane.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| All delivery | Codex TUI pane | Makes request, activity, and transcript visible |
| Active input policy | Codex TUI decides | Keeps turn/queue semantics owned and rendered by the UI |
| Failure | Keep durable request pending | Prevents false delivery and duplicate recovery |
| Acknowledgement owner | Proxy after successful injection | Guarantees one durable acknowledgement |
| Claude live delivery | Claude TUI pane | Avoids unacknowledged channel writes and keeps activity visible |
| Claude headless delivery | MCP channel | Preserves the only available headless route |

## Affected subsystems

- `codex-tmux-proxy` — submits bridge input only through the visible pane.
- `bridge-runtime` — exposes guarded pane injection without acknowledgement.
- Claude live delivery — bypasses MCP channel flush when the target pane exists.
- Bridge/proxy tests — assert transport and durable delivery semantics.

## Risks

- Concurrent drain ticks could duplicate pane input → single-flight guard.
- Tmux pane not ready → leave queued and retry; never fall back headlessly.
- Live deployment could disturb active agents → do not restart Claude/Codex;
  replace only the proxy process after verification.
- Old Claude MCP child can continue consuming messages → restart only that
  support process after its current tool call completes; preserve the pane.

## Not doing

No protocol spoofing or synthetic TUI event stream. The TUI itself submits all
bridge input, which is the reliable way to make it first-class visible work
with the current app-server protocol.
