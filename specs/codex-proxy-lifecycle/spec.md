# Spec: Codex Proxy Lifecycle Hardening

## Problem

In Harvto runs 112 and 113, the Codex TUI lost its relay on port 4600 while
the persistent app-server on port 4500 and the underlying review work remained
alive. The TUI exited with a WebSocket reset and the detached proxy left no
exit reason because its output was discarded. Current code can intentionally
stop the proxy after one `dead` tmux probe or after a bounded upstream
reconnect sequence. Its raw WebSocket client also rejects fragmented text
messages. Each path turns a recoverable diagnostic or transport condition into
a dead Codex pane.

## Goal

Keep the Codex TUI relay alive for the lifetime of an active loop, recover from
transient upstream and tmux-control failures without dropping the TUI socket,
support valid fragmented WebSocket text messages, and durably record proxy
lifecycle evidence so a future failure has an exact reason.

## Requirements

1. A single `dead` tmux liveness result must not stop a proxy that has already
   observed the session. Cleanup requires a bounded run of confirmed-dead
   probes; `unknown` remains fail-closed against cleanup authority.
2. Upstream reconnect exhaustion must not stop the TUI-facing proxy while the
   run manifest remains active and tmux is not durably dead. Retries continue
   at a bounded interval until recovery or authoritative shutdown.
3. The raw WebSocket client must reassemble valid fragmented text frames,
   including control frames interleaved between fragments, and deliver exactly
   one decoded message.
4. HTTP upgrade parsing must preserve any binary WebSocket bytes received in
   the same TCP read as the response headers.
5. The proxy must append secret-safe NDJSON lifecycle records in the run
   directory for start, upstream disconnect, reconnect attempt/failure/success,
   authoritative stop, signal, and fatal-start events. A stop record names the
   exact reason.
6. Proxy polling and reconnect timers remain bounded and do not busy-loop.
7. Existing thread-id persistence, delegation-candidate observation, MCP
   reload, and TUI request/response routing remain intact.
8. No live Harvto pane, proxy, manifest, or installed binary is changed by this
   task. Release remains behind supervisor review, integration, full
   verification, a changed-binary smoke, and the liaison section-4 QA gate.

## Acceptance criteria

- [x] A focused test proves one and two consecutive `dead` probes do not stop
      a previously live session, while the configured threshold does.
- [x] A focused integration test holds one TUI connection across more than the
      old reconnect-attempt limit and then proves successful upstream recovery.
- [x] Raw WebSocket tests prove fragmented text reassembly, interleaved ping,
      and same-read HTTP-upgrade plus first-frame preservation.
- [x] Lifecycle-log tests prove exact event names and stop reasons without
      prompt, tool payload, or provider-response content.
- [x] Existing proxy, app-server, tmux, bridge, and lifecycle tests pass.
- [ ] `bun run check`, `npm run test:ci`, `bun run build`, and
      `git diff --check` pass with no unnamed tolerated failures.
- [ ] `runs/codex-proxy-lifecycle/eval.json` records an independent exact-SHA
      verdict before any release integration.

## Non-goals

- Replacing the persistent Codex app-server.
- Changing bridge delivery ownership or injecting messages through app-server.
- Respawning or modifying the currently running Harvto loop.
- Deploying a binary from this branch.
