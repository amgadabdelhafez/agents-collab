# Constant-size charter and bridge transport

## Problem

The harness still makes correctness depend on the size of two terminal-bound
payloads:

- paired launch composes the complete role guidance and founder charter, then
  pastes that body into each agent TUI; and
- bridge delivery can paste a complete inter-agent message into an interactive
  pane.

The first design already caused a prompt-size regression in which realistic
charters silently failed to create a workspace. The second leaves delivery
coupled to terminal readiness, tmux health, and arbitrary message length. In
run 99, a wedged tmux control plane blocked a safety-critical message even
though the Codex app-server was alive, and the evicted headless thread first
needed an explicit `thread/resume`.

## Requirements

1. Paired launch must materialize each complete, composed agent charter as a
   persistent run-owned file. The file must have an absolute path, byte count,
   and SHA-256 recorded in the run manifest.
2. The only launch text sent through a terminal is a bootstrap containing the
   agent role, charter path, expected SHA-256, and a fail-closed instruction to
   verify the hash before reading and proceeding. Every bootstrap must remain
   below 1 KiB regardless of founder-charter size.
3. Launch charter files must survive TUI or app-server recovery for the life of
   the run, be mode `0600`, and never be written beneath a shared temporary
   directory.
4. Large-paste readiness and marker handling must no longer participate in the
   paired launch path. A realistic charter of at least 8 KiB must exercise the
   same bounded bootstrap transport as a small charter.
5. A Codex bridge message must be injected directly through its app-server,
   independently of tmux liveness. If `thread/read` cannot find an otherwise
   persisted thread, delivery must call `thread/resume` before starting or
   steering a turn.
6. Codex delivery must use the existing bridge delivery claim and append a
   delivered resolution only after app-server acceptance. Resume or injection
   failure leaves the message pending and retryable without duplicate
   acceptance.
7. An interactive non-Codex TUI must receive only a constant-size notification
   that messages are waiting. Message identifiers, subjects, and bodies remain
   in the bridge ledger and are delivered only when the agent calls
   `receive_messages`.
8. A successful notification must be recorded without resolving the pending
   message. Notification retries must be throttled, while a newly queued
   message may trigger a new notification.
9. Headless provider-native delivery may retain its existing non-terminal
   payload transport. No message body may be introduced into an interactive
   terminal path.
10. Launch and bridge failures remain observable and nonzero or durably
    pending; no failure may be converted into success merely because a
    notification or bootstrap was submitted.
11. The live run 99 is read-only for this slice. Deployment requires focused
    and full verification, exact-SHA independent review, and release of the
    outstanding T4/census gate.

## Scope

- Paired tmux launch prompt materialization, bootstrap composition, manifest
  evidence, and realistic-size regressions.
- Codex app-server thread recovery and delivery claims.
- Bridge worker/runtime routing and interactive-TUI notification semantics.
- Agent bridge guidance, focused regressions, full repository verification,
  and exact-SHA review.

## Non-goals

- Restarting, repairing, or mutating run 99.
- Changing founder authority, task routing policy, or utility-worker roles.
- Replacing the bridge ledger or provider-native headless Claude delivery.
- Deploying before the independent measurement and review gates are released.
