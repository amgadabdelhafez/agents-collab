# ra1: outbound resumable inbox stream (`loop connect`)

Status: implemented on `claude/ra1-inbox-stream` (base
`claude/fix-integration-r9b-2026-10-11` at `dca155ba`). Not deployed. Owner
decisions of 2026-10-11 (tailnet-only reach, server in k3s, phone alerts)
are out of scope here: this is the transport only.

## Problem

Every r9 endpoint kind is local to the orchestration server: a run dir, a
Claude session dir, a loopback Codex app-server. A session behind NAT, or on
another device, has no inbound port the server could deliver to. Mailbox
files only reach sessions on the server's own disk.

## Shape

| piece | where |
|---|---|
| `inbox-stream` endpoint kind, locator `{kind, agent: claude\|codex, sessionId}` (ids only; sessionRef must be `session:<sessionId>`) | `supervisor-endpoint-lease.ts` |
| `GET {routePath}/sessions/<slug>/inbox`, SSE | `a2a-v2-routes-contract.ts`, `supervisor-inbox-stream.ts` |
| durable inbox `loop_supervisor_inbox_v1` (ledger database) | `supervisor-inbox-stream.ts` (`PostgresSupervisorInboxStore`) |
| kind adapter: deliver = durable append + wake; probe = holder presence | `supervisor-message-v2-endpoint-delivery.ts` |
| wiring (hub shared by adapter and route; inbox opened after the ledger, closed after the host) | `supervisor-a2a-v2-service.ts`, `loop-orchestration-server.ts` |
| resumable client | `inbox-stream-client.ts` |
| `loop connect` MCP server (stdio) | `connect-command.ts` |

Routing is unchanged (`decideSupervisorEndpointRoute`): a live inbox-stream
lease routes to the endpoint and never falls through to the mailbox; a
released or absent lease uses the mailbox when the supervisor has one. So
mailbox files remain the fallback for sessions on the server's own disk
(laptop sessions) only.

## Semantics

- **Event id = ledger sequence.** `seq BIGSERIAL`; appends for one
  (tenant, recipient) are serialized by `pg_advisory_xact_lock`, so their
  sequence numbers commit in order and a reader that saw N saw every smaller
  one. `Last-Event-ID` resumes strictly after it.
- **Durable, replayable, bounded.** One row per message workflow (a retried
  attempt appends nothing). The stream carries only messages whose workflow is
  not terminal (the V2 ledger's start intent): an acknowledged message is not
  replayed. Terminal rows are pruned on append after `terminalRetentionMs`;
  unacknowledged rows per recipient are capped (`maxPending`, default 1000),
  past which delivery is a transient failure the message workflow retries
  within its own attempt bound.
- **Wakeups, no polling.** The delivery activity that appended wakes that
  recipient's streams in process (the workflow delivery path). A claim or
  release on the session routes wakes them too, so a takeover fences the old
  stream promptly. The heartbeat (5 s, under Bun.serve's 10 s idle timeout)
  writes a comment and re-checks the lease fence; it reads no messages. Bun's
  SQL client has no LISTEN, so a second server process would not be woken:
  the server is a single writer today (see Limits).
- **Slow consumer bounded.** At most `maxBufferedBytes` (256 KiB) plus one
  frame is queued per connection; a consumer that does not drain within
  `stallMs` (30 s) gets an `overflow` event and is disconnected, then resumes
  from its own Last-Event-ID. The client reads the stream only between
  deliveries, so a slow local delivery is what applies the backpressure.
- **ACK is not completion.** Reading the stream is not the ACK. The session
  acknowledges on the existing recipient route (`inbox_ack` tool, or
  `loop a2a ack`), which is the delivery/read ACK; completion stays a
  published result.

## Security

- Bearer identity must be the path's supervisor and bound to its configured
  principal (`identity-mismatch` otherwise); the token cannot stream another
  seat's inbox.
- The request presents the fence of that supervisor's unreleased
  inbox-stream lease (`x-loop-lease-epoch`, `x-loop-lease-holder`): one holder
  at a time. Any other kind, another principal, a released row or a stale
  fence is 409 `lease-fenced`. An expired but unreleased lease is still its
  holder's (expiry alone never fences); the sweep renews it once the holder is
  present again.
- Locators carry ids only; the server derives no path or URL for this kind.
- `loop connect` fixes identity before reading stdin (`--as`, its tokenEnv,
  the fence it claimed with holderRef `connect:<uuid>`); tool input cannot
  name an identity or a server. A fenced stream ends for good; only an
  explicit claim (`--takeover`) takes a lease back (owner decision 9).
- The lease is kept alive by the server's existing lease sweep observing the
  holder's presence (a stream open now, or closed within a 60 s grace); there
  is no client renew loop.

## `loop connect`

```
loop connect --as supervisor:x --deliver claude --session <claude-session-id>
loop connect --as supervisor:x --deliver codex  --thread <id> --codex-remote ws://127.0.0.1:<port>
loop connect --as supervisor:x --deliver seat   --run <run-id> --seat claude|codex
             [--takeover] [--ttl-ms <ms>] [--allow-multi-token-env]
```

Delivery by kind reuses existing paths: the bridge's
`notifications/claude/channel` shape (`claudeChannelNotification`, sent only
after `notifications/initialized`), `injectCodexMessage` on a loopback thread,
and the run's bridge queue through `SupervisorMessageV2BridgeDeliveryPort`
(deduplicated per message). Tools: `inbox_ack`, `inbox_status`.

## Limits and open items

- The client resolves the server from the orchestration config, which the
  r9 client accepts only on loopback. Reaching `https://loop.home.lab` over
  the tailnet needs the tokens/identity group to extend
  `resolveA2AClientEndpoint` to an https origin; not done here.
- Wakeups are in-process. A multi-replica server needs LISTEN/NOTIFY (a
  client that supports it) or one writer per tenant; the hub's `wake` is the
  seam.
- The client cursor lives in memory: a restarted `loop connect` replays the
  unacknowledged messages once (at-least-once until ACK). Codex injection has
  no dedupe of its own across such a restart.
