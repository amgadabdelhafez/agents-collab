# webui-control-plane-spec Research

## Research Question

Which existing Loop contracts and current Web platform tools should be reused to
build an interactive local control surface without duplicating runtime authority
or turning tmux into a hidden browser dependency?

## Candidates Reviewed

- **Existing Loop readers and ledgers.** Reuse `run-state.ts`, normalized hook
  events, `governess-state.json`, `governess-control.jsonl`, `bridge.jsonl`,
  `readUtilityObservability`, and native transcript usage readers. These already
  encode identity, provenance, redaction, idempotency, and one-owner worker
  semantics. The current `panel.ts` is useful discovery code but is not an
  authority because it heuristically joins processes, lsof, default-tmux state,
  and manifests.
- **Bun HTTP server and Server-Sent Events.** Bun is already the runtime. Its
  native router, static responses, and long-lived SSE support avoid a second
  backend framework. SSE fits the one-way live projection; typed mutations can
  remain ordinary HTTP requests with explicit receipts.
- **React 19 + TypeScript, built with Vite.** The target has resizable regions,
  dense cards, filters, timelines, drawers, drafts, and configuration. A
  component model is justified. Vite officially supports Bun and React/TypeScript
  templates. No additional state library or UI kit is needed for the first
  release.
- **Prior Agent Operations Control Plane design.** Its projection lesson,
  deterministic-control boundary, provenance, and adapter model are reusable.
  Temporal, Restate, NATS, and PostgreSQL remain shadow architecture and are not
  prerequisites for this local Web UI.

## Open-Source Patterns

- Build a read model from authoritative events and label adapter probes as
  diagnostics. A status projection must expose source and freshness and must be
  rebuildable after missed updates.
- Use a snapshot request for initial state and an ordered event stream for live
  updates. SSE supplies event IDs and browser reconnection; the server must also
  support an explicit full resync when the cursor is unavailable.
- Keep commands separate from events. A future browser action carries a stable
  request ID and expected run/epoch/state, then returns a durable receipt. The
  UI never writes JSONL or sends terminal keystrokes directly.
- Bind locally by default, exchange a one-time launch token for a strict cookie,
  deny cross-origin requests, disable caching, and redact terminal/provider
  content before it crosses the HTTP boundary.
- Follow Fetch semantics for Origin: safe same-origin GET/HEAD/SSE may omit the
  header, so validate exact Host and reject a present mismatch; require exact
  Origin for bootstrap and future non-safe requests.
- Use semantic HTML, keyboard-operable controls, and restrained live regions;
  frequent telemetry updates must not continuously interrupt assistive
  technology.

## Reuse Decision

Adapt the existing Loop runtime instead of introducing a separate control-plane
service. The approved implementation direction is:

1. Bun serves a versioned local API, static assets, and SSE.
2. A new typed projection layer wraps existing readers and emits canonical
   fleet/run views with source references, freshness, confidence, and conflicts.
3. React + TypeScript renders the browser client; Vite produces fixed-name
   assets embedded in the compiled Loop executable.
4. Release 1 is read-only. React state remains a small reducer/external store;
   do not add Redux, a CSS framework, a component kit, or WebSockets without an
   evidenced need.
5. Later mutations use Governess policy, epoch fencing, idempotency, and the
   control journal. They never call tmux directly.

This reuses the system's hard-won safety contracts while replacing only the
presentation and operator-interaction layer.

## Sources

- https://bun.sh/docs/runtime/http/routing
- https://bun.sh/docs/runtime/http/server
- https://bun.sh/docs/bundler/executables
- https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- https://react.dev/learn/typescript
- https://react.dev/versions
- https://vite.dev/guide/
- https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA22
- https://fetch.spec.whatwg.org/#origin-header
- `loop-fork/src/loop/run-state.ts`
- `loop-fork/src/loop/governess-journal.ts`
- `loop-fork/src/loop/bridge-store.ts`
- `loop-fork/src/loop/utility-observability.ts`
- `loop-fork/src/loop/panel.ts`
- historical branch `github/codex/agent-operations-redesign`, documentation
  only; not installed authority
