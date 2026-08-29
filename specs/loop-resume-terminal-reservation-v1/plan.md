# Plan

## Scope, and why it expands

Already authorized: `loop-fork/src/loop/run-state.ts`,
`loop-fork/src/loop/launch-reservation.ts` and their tests.

Harness write authority is exact and exhaustive: `loop-fork/.harness/tasks.json`
(only the task `loop-resume-terminal-reservation-v1`), the ephemeral
`loop-fork/.harness/current-task` (required absent at closure), and
`loop-fork/.harness/evidence/loop-resume-terminal-reservation-v1/**`. No
`current-run`, and no other `.harness` path, task, hook, config, debt, or
evidence subtree is writable.

Proposed bounded expansion, exactly two further paths:

- `loop-fork/src/loop/tmux-socket.ts`
- `loop-fork/tests/loop/tmux-socket.test.ts`

Justification, from the current source rather than from intent. The bound socket
of a `TmuxTarget` is held in the module-private `targetContents` WeakMap
(`src/loop/tmux-socket.ts:82`) and is readable only through module-private
`targetOf` (`src/loop/tmux-socket.ts:436`), which is deliberately not exported.
No exported symbol returns the bound socket string. `tmuxAttachCommand(target)`
(`src/loop/tmux-socket.ts:669`) emits a shell-escaped human hint; recovering a
socket by parsing that hint would launder provenance through a display
formatter and is rejected. Therefore an endpoint-state helper **cannot** be
written inside `launch-reservation.ts` without either breaking target opacity or
re-deriving the endpoint from the unbranded `manifest.tmuxSocket` string. It
must live beside `targetOf`, in `tmux-socket.ts`. That is the whole reason for
the expansion, and it is the minimum that preserves the opaque-target invariant.

## Sequence

1. Capture the exact Run 42 manifest bytes as a test fixture with the released,
   terminal, and legacy-target fields that triggered the conflict. Record source
   path, byte count, and SHA-256 as fixture provenance. Never edit Run 42.
2. Extend the typed manifest boundary to retain only a syntactically and
   semantically valid UTC workspace release timestamp, accepting the existing
   camel-case and legacy snake-case keys without inventing release state.
   Validation performs calendar component round-trip verification, because
   `Date.parse` accepts `2026-02-30T18:30:00Z` and rolls it to March 2. Both the
   seconds and millisecond forms are accepted and stored byte-for-byte.
3. Add a reservation-specific fail-closed read boundary in `run-state.ts`. Do not
   overload omission in `RunManifest` as validity. Contract an equivalent
   discriminated representation: `OwnershipField<T>` is `absent`, `valid(value)`,
   `invalid(reason)`, or `conflicting(reason)`; `ReservationManifestRead` is
   `valid(manifest + RunOwnershipEvidence)` or `refuse(manifestPath, optional
   manifestSha256/runId, readonly reasons)`; `RunOwnershipEvidence` separately
   preserves presence and validity for the mandatory run PID, the optional
   `launchAttemptPid`, `state`, `status`, and the `workspaceReleasedAt` aliases.
   Invalid-present or conflicting never normalizes to absent. An existing
   malformed-JSON, non-record, unreadable, or ownership-unestablishable manifest
   yields `refuse`, never `undefined`. PID parsing never uses prefix `parseInt`
   (`run-state.ts:327` today): accept only a positive safe JSON integer, or, only
   if legacy decimal strings remain supported, a full canonical lossless
   positive-decimal token; reject `9598junk`, fractional, zero or negative,
   overflow, whitespace, prefix or suffix, and alias disagreement.
   `launchAttemptPid` absent differs from present-invalid, and present-invalid or
   conflicting refuses. Present `state` must be enumerated and never falls back to
   `status` when invalid; absent `state` may be supplied only by an explicitly
   supported legacy `status` mapping; if both exist, each must be valid and
   semantically consistent or it refuses. Release aliases preserve
   absent/valid/invalid/conflicting, and invalid or disagreement refuses and
   cannot collapse to absence. `storedManifests` and reservation scanning consume
   `ReservationManifestRead` and retain a refusal sentinel for every existing
   unreadable or invalid-present manifest; `assertNoConflict` refuses before any
   counter increment or run allocation/write; never continue merely because
   canonical `readRunManifest` returns `undefined`. General non-reservation
   readers may keep existing DTO behavior.
4. Add a provenance-safe endpoint-state seam in `tmux-socket.ts`. It is total and
   non-throwing, derives the socket only through module-private
   `targetOf(target)`, exposes no raw socket string in its result or messages,
   catches every provenance failure and returns `unknown`, and classifies the
   exact bound endpoint as `present`, `absent`, or `unknown`.
5. Add the terminal-release predicate beside launch reservation. It consumes the
   endpoint state; it never touches `manifest.tmuxSocket` directly and never
   calls `existsSync` on a manifest string.
6. Add direct negative controls for every refusal in the matrix below. Assert
   manifest byte preservation and no new run directory on every refused case.
7. Run the focused gates as exactly **three** separate supported single-file
   commands, then the full suite, static check, build, and diff check:

   ```bash
   bun run test:file -- tests/loop/run-state.test.ts
   bun run test:file -- tests/loop/launch-reservation.test.ts
   bun run test:file -- tests/loop/tmux-socket.test.ts
   bun run test:ci
   bun run check
   bun run build
   git diff --check
   ```

   Record exact command, exit status, and an explicit empty named failure set for
   each applicable test gate, under `runs/loop-resume-terminal-reservation-v1/`.
8. Commit one frozen candidate. A different agent performs a zero-write review
   against that exact SHA and the parent integration SHA.
9. Only after PASS and fresh install authority, build and install locally,
   record the installed SHA-256, and retry the explicit `--tmux` certification.

## Endpoint-state seam

Signature lives in `loop-fork/src/loop/tmux-socket.ts`.

`readTmuxEndpointState(target)` is a **total, non-throwing, fail-closed**
classifier for the reservation consumer. It never throws for any input.

- Input is nominally a branded `TmuxTarget`. Every provenance failure,
  `TmuxTargetProvenanceError` included, is caught internally and classified
  `unknown`. A fake or unprovenanced input returns `unknown` and never releases.
- The socket is obtained only from module-private `targetOf(target)`.
- It exposes no raw socket: no raw socket string is returned or embedded in any
  message.
- Classification of the exact bound path:
  - `absent` — only on positive `ENOENT` or `ENOTDIR` for that exact path.
  - `present` — successful stat or probe.
  - `unknown` — `EACCES`, `EPERM`, timeout, unexpected I/O, or any provenance
    failure.

Unknown is never absence. This is the same invariant `tmux-control.ts` already
states for liveness: an unaddressable target is `"unknown"`, never `"dead"`,
because a positive verdict grants cleanup authority.

## Release predicate

Release the reservation only when **all** hold:

1. defined provenance-valid branded target;
2. endpoint positively `absent`;
3. tmux liveness `"unknown"`;
4. state exactly `completed`, `failed`, or `stopped` (enumerated allowlist, not
   `!isActiveRunState(...)`);
5. `workspaceReleasedAt` valid and unambiguous;
6. the reservation read returned `valid(...)`, not `refuse(...)`; and
7. manifest run PID and any present `launchAttemptPid` are canonical positive
   integers and positively dead.

## Refusal matrix

Every one of these owns or refuses:

- target undefined, or unusable without a branded endpoint;
- endpoint `present`;
- endpoint `present` combined with unknown liveness;
- endpoint `unknown`;
- live tmux;
- active or non-enumerated state;
- release marker absent, invalid, or conflicting across key spellings;
- run PID or `launchAttemptPid` malformed or alive;
- run PID string `9598junk`, or any non-canonical PID token;
- malformed-present `launchAttemptPid`;
- present-invalid `state` accompanied by a terminal-looking `status`;
- `state` and `status` semantic disagreement;
- release alias conflict;
- existing malformed or unreadable manifest.

Exact Run 42 is the sole positive legacy fixture. Every refusal proves manifest
bytes unchanged and no new run created.

## Ownership

- One headless paired Loop is the sole source writer.
- The reviewer makes zero writes.
- The supervisor may inspect, relay, and run lifecycle controls but does not
  edit product source after the writer is launched.
