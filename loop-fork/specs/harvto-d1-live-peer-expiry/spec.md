# D1 Live Peer Expiry

## Goal

Keep an accepted durable bridge message recoverable while its intended target is positively live
or target liveness is unknown. TTL and queue depth create pressure; neither is authoritative
non-liveness.

## Scope

- `src/loop/bridge-store.ts` TTL, queue admission, journal reconstruction, and liveness seam.
- `src/loop/tmux-control.ts` bounded peer-pane liveness probe.
- `src/loop/bridge-dispatch.ts` typed backpressure result reporting.
- `src/loop/governess.ts` backpressure handling before `BridgeSendStatus` narrowing.
- Focused bridge-store tests in `tests/loop/governess-p0-runtime.test.ts` and existing bridge
  controls affected by result formatting or liveness integration.
- D1 Harness evidence only.

No Harvto edits, D2-D14 work, dependency changes, UI changes, merge, rebase, push, deploy, or
release.

## Invariant

1. After acceptance and durable journaling, one message identity stays pending until one terminal
   resolution: delivered acknowledgement, explicit supersession, or expiry/dead-letter backed by
   current authoritative `dead` target evidence.
2. TTL or queue depth alone never terminalizes a `live` or `unknown` target message. Unknown and
   missing evidence fail closed by retaining already accepted messages.
3. Target liveness is peer-scoped. Positive tmux evidence requires exact manifest target-to-pane
   mapping and a bounded pane probe. Session existence, notification, heartbeat, and pane prose are
   not target liveness or delivery proof. Codex app-server evidence requires the manifest PID and a
   current process probe.
4. Repeated reads, journal reconstruction, worker reconciliation, and recovery append at most one
   terminal resolution and produce at most one effective delivery for an identity.

## State transitions

- Pending + TTL elapsed + `dead`: append one `expired`; identity becomes terminal.
- Pending + TTL elapsed + `live|unknown`: remain pending; append no resolution.
- Net-new enqueue at `maxOutstanding` + `dead`: preserve existing behavior by journaling the new
  identity and one `dead-letter` resolution.
- Net-new enqueue at `maxOutstanding` + `live|unknown`: accept one pressure-slot identity with an
  optional `retainedReason: "queue-pressure"` message field; remain pending.
- Net-new enqueue at `maxRetained` + `live|unknown`: return typed `backpressure` before message or
  transcript journal acceptance. Backpressure appends no bridge or transcript journal event.
- Pressure-slot identity + later `dead`: append one `expired` if its TTL elapsed, otherwise one
  `dead-letter`.
- Duplicate without supersession: return existing identity; no new journal event.
- Duplicate with explicit supersession: append one `superseded` for old identity, then admit the
  replacement using net pending count.
- Consume/delivery acknowledgement: append one `delivered`; later reads and consumes do not return
  identity.

## Authoritative liveness evidence

- Tmux target: `RunManifest.tmuxSession`, exact `tmuxPaneLeft|Right`, and matching
  `tmuxPaneLeftAgent|RightAgent`, followed by bounded `display-message` evidence for `pane_dead`.
  Pane absence is dead only when an independent session probe is live in the same resolution.
  Session dead/unknown, nonzero pane-probe exit, probe timeout/throw, or unparseable pane output is
  unknown; this prevents a tmux restart or transient probe failure from terminalizing a target
  queue. Only successful exact output with `pane_dead=1` proves pane death.
- Codex app server: configured remote transport, manifest `codexAppServerPid`, and tri-state
  `process.kill(pid, 0)` evidence. Success is live, `ESRCH` is dead, other errors are unknown.
- Multiple configured target routes: any live evidence means live; all present evidence dead means
  dead; incomplete, missing, malformed, timed-out, or conflicting evidence means unknown.
- `supervisor` has no local authoritative liveness source and is unknown.

## Retention bound and consequence

`maxRetained` bounds the pending set per target, not append-only journal bytes. Default
`DEFAULT_BRIDGE_MAX_RETAINED` is 33 when `DEFAULT_BRIDGE_MAX_OUTSTANDING` is 32. A custom
`maxOutstanding` derives `maxRetained = maxOutstanding + 1` unless explicitly overridden.

A permanently unknown or live non-draining target has no time bound: accepted identities retain up
to `maxRetained`, then net-new sends receive backpressure before durable acceptance. This prevents
pending-set growth but can reject a later higher-priority send behind older work. Dropping old work would violate
D1, so this priority inversion under a wedged queue is accepted and must remain observable through
the typed result and durable pending data.
`backpressure` is deliberately not a `BridgeResolution`; using existing resolution name `blocked`
would terminalize a pending identity.

## Journal compatibility

No new event kind is required. `retainedReason` is optional on the existing message shape. Pre-fix
journals omit it and continue to parse. Older readers reconstruct known message fields and ignore the
optional field without rewriting the append-only message line. Unknown event kinds remain ignored.
Queue pressure does not add a `BridgeQueueHealth` field; existing status schema and terminal counts
remain compatible.

Utility-runtime bridge sends remain redundant notifications after authoritative utility-job state
transitions. Backpressure can miss a nudge there, but cannot erase or falsely complete the durable
route/result state; moving notification ahead of that transition is outside D1 and would weaken the
durable-state guarantee.
