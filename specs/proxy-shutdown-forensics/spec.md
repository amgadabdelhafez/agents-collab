# Proxy shutdown forensics

## Problem

Run 119's Codex tmux proxy recorded only `stopped/requested`. The app-server and
tmux panes remained live, but the proxy disappeared and the recovered direct
Codex attach no longer received bridge idle-delivery wakes. The durable record
cannot identify which cleanup path requested shutdown, so the next recurrence
cannot distinguish an expected owner cleanup from an erroneous late cleanup.

## Goal

Bind every HTTP-requested proxy shutdown to a bounded declared callsite and
requester PID while independently recording the loopback peer socket observed
by the proxy. Preserve the existing shutdown behavior and keep all evidence
secret-free.

## Acceptance criteria

- [ ] The real HTTP shutdown producer sends a bounded caller label and PID.
- [ ] The proxy writes `shutdown-requested` before `stopped/requested`.
- [ ] The ledger distinguishes declared caller data from independently observed
      peer address, port, and family.
- [ ] Paired-start cleanup supplies an exact callsite label.
- [ ] A real proxy integration test proves the request creates the evidence.
- [ ] Focused tests, full verification, build, and diff checks pass.

## Non-goals

- Mutating or restarting run 119.
- Guessing which process made the already-recorded unattributed request.
- Treating a caller-declared PID as independently verified process identity.
- Deploying without exact-SHA supervisor review and fresh founder authority.
