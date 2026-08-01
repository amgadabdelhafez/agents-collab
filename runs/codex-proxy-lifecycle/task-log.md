# Task Log: codex-proxy-lifecycle

Feature: codex-proxy-lifecycle
Spec: `specs/codex-proxy-lifecycle/spec.md`
Worktree: `/private/tmp/agents-collab-proxy-lifecycle-hardening`
Started: 2026-08-01T20:00:00Z
Status: in-progress

---

## Understanding

Harvto runs 112 and 113 lost the port-4600 proxy while the port-4500 app-server
and underlying Codex work survived. The current detached process discards all
diagnostics and contains multiple recoverable paths that intentionally stop the
TUI relay. Done means those paths recover without dropping the TUI, valid
fragmented WebSocket messages work, and any future stop has durable evidence.

## Approach

Start from protocol and lifecycle regression tests. Preserve the proxy's
existing functional responsibilities, harden only its failure semantics, and
leave integration and deployment to the supervisor-owned release line.

---

## Progress entries

### 2026-08-01T20:00:00Z

Inspected deployed source and run-112/113 records. The two pane deaths are
proved, but the exact internal exit reason is unknowable because detached
stdout/stderr was configured as `ignore` and no lifecycle journal exists.
Confirmed fail-open code paths: one `dead` tmux probe stops the proxy, reconnect
attempt exhaustion stops it, and valid fragmented frames are rejected.

### 2026-08-01T20:18:00Z

Added protocol-level WebSocket tests that were red against the original client:
fragmented text with an interleaved ping closed the connection, and a first
frame coalesced with the HTTP upgrade was lost. Implemented binary-safe upgrade
buffering, deferred first-frame processing until the caller can attach its
handler, and continuation-frame reassembly. The two focused tests now pass.

### 2026-08-01T20:24:00Z

Hardened the proxy lifecycle. Tmux death now requires three confirmed `dead`
probes spanning at least five seconds; `unknown` resets cleanup evidence.
Lifecycle polling is separated from the 250 ms bridge-delivery poll and runs at
one second. Upstream reconnects continue at the bounded two-second backoff
plateau instead of terminating the proxy at attempt 40. A live integration test
held one TUI socket across 41 failed reconnects and subsequent recovery.

Added `codex-tmux-proxy-lifecycle.jsonl`, created mode 0600, with fixed-schema
records for start, disconnect, reconnect scheduling/failure/recovery, signals,
fatal start, and exact stop reason. The test proves the journal excludes the
thread id and request content.

### 2026-08-01T20:28:00Z

Verification on the candidate worktree: focused proxy/WebSocket integration
suite 16/16; tmux-control 2/2; broader app-server/tmux/bridge compatibility
157/157; scoped Ultracite check clean; build passed; `git diff --check` passed.
The all-at-once suite enumerated 893 pass / 4 fail. A separate clean detached
`origin/main` checkout reproduced the exact same four named failures in
`paired-options.test.ts` and `runner.test.ts`; no T12 file participates in
them. Sequential `npm run test:ci` correctly stopped on the first of those
baseline failures. Full repository Ultracite remains red on 209 pre-existing
format errors; the six T12 source/test files are clean. Release verification
therefore remains gated on the already-open corrected baseline/integration
line rather than tolerating either baseline by count.

---

## Blockers

Independent exact-SHA supervisor review and integration onto the release line
are pending. The current origin/main base also carries four named stale test
expectations and 209 pre-existing formatting diagnostics; both are held as
release blockers rather than allowlisted.

---

## Final summary

Pending.
