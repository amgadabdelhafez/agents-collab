# Terminal released-run reservation

## Problem

Installed Loop v1.0.38 at integration commit
`62e8103d9181bad85012830f8170cca8e21fd0d6` correctly reconciles dead active
runs and starts headless paired runs, but an explicit `--tmux` launch is blocked
by legacy Run 42:

```text
launch conflict: run 42 (agents-collab-loop-42) still owns workspace /private/tmp/agents-collab-d001-handover-run1 on legacy-unknown
```

Run 42 is positively terminal and released: `status=stopped`,
`state=stopped`, `workspaceReleasedAt=2026-08-18T18:30:00.000Z`, PID 9598 is
absent, tmux session `agents-collab-loop-42` is absent, and its temporary
workspace is absent. The manifest reader drops the release marker, while the
reservation predicate treats the run as owning forever because tmux liveness for
its bound endpoint is `"unknown"`.

### Corrected artifact facts

The prior revision of this spec described the artifact from prose rather than
bytes and was wrong in two ways. Both are corrected here and are binding.

1. The release literal is `2026-08-18T18:30:00.000Z` (millisecond form), not
   `2026-08-18T18:30:00Z`. Validation must still accept both forms.
2. `launchAttemptPid` is **present** and equals the run PID: `9598`. It is
   positively dead. It is not absent.

Run 42's persisted `tmuxSocket` is
`/private/tmp/harness-d001-tmux/tmux-501/default`, which is a syntactically
valid socket, so its manifest handle yields a **defined, provenance-valid,
branded `TmuxTarget`**. The socket *file* is absent, which is why liveness
resolves to `"unknown"` rather than to a confirmed-missing session. Any design
predicated on `target === undefined` for Run 42 is refuted by the artifact.

## Requirements

1. Preserve and validate the existing camel-case and snake-case workspace
   release timestamp when reading a manifest. Invalid or ambiguous release
   values are not authority. Validation is strict UTC with calendar component
   round-trip verification: an instant such as `2026-02-30T18:30:00Z` must be
   rejected even though `Date.parse` silently rolls it over to March 2.
   Both `2026-08-18T18:30:00Z` and `2026-08-18T18:30:00.000Z` are accepted and
   are stored byte-for-byte as read.
2. Classify the **bound tmux endpoint** of a defined provenance-valid branded
   target as present, absent, or unknown, and exclude reservation ownership only
   when that endpoint is positively absent. Absence of a socket file is never
   inferred from an unbranded manifest string. The classifier
   `readTmuxEndpointState(target)` is total, non-throwing, and fail-closed: it
   derives the endpoint only through module-private `targetOf`, exposes no raw
   socket, and catches `TmuxTargetProvenanceError` and every provenance failure
   and returns unknown. A fake or unprovenanced input returns unknown and never
   releases.
3. Continue to fail closed for active or non-enumerated state, missing or
   invalid release proof, live tmux, an endpoint that is present, and an
   endpoint whose state is unknown. A live numeric run or launch-attempt PID
   blocks unless its independently observed process start time is strictly
   later than the valid workspace release timestamp, which positively proves
   PID reuse by an unrelated process. Missing, unreadable, equal, or
   pre-release process-start evidence remains ownership and blocks.
3a. Add a reservation-specific fail-closed **read boundary** so that ownership
   evidence is never destroyed before the reservation authority sees it.
   Omission in `RunManifest` must not be overloaded as validity. Presence and
   validity are preserved separately for the mandatory run PID, the optional
   `launchAttemptPid`, `state`, `status`, and the `workspaceReleasedAt` aliases;
   invalid-present or conflicting never normalizes to absent. PID parsing never
   uses prefix `parseInt`. An existing malformed, non-record, unreadable, or
   ownership-unestablishable manifest refuses rather than being dropped, and
   refusal happens before any counter increment or run allocation/write.
4. Add an exact Run 42 regression fixture and direct positive and negative
   predicate tests. Assert every required fixture exists before comparing or
   aggregating results; a missing fixture fails and never skips.
5. Scope product changes to manifest read/validation, the tmux endpoint-state
   seam, and the terminal reservation predicate. No lifecycle redesign, manifest
   mutation, Run 42 edit, dependency change, device work, Web UI work, or
   provider/model change.

## Acceptance

- The exact Run 42 fixture no longer blocks a fresh launch reservation.
- A terminal released Run 92-shaped fixture whose old numeric PID is now held
  by a process started strictly after release no longer blocks, without
  signaling that process or editing the old manifest.
- Every negative control remains a conflict, leaves its manifest bytes
  unchanged, and creates no new run.
- All seven named commands pass: the three focused single-file tests
  (`bun run test:file -- tests/loop/run-state.test.ts`,
  `bun run test:file -- tests/loop/launch-reservation.test.ts`,
  `bun run test:file -- tests/loop/tmux-socket.test.ts`), `bun run test:ci`,
  `bun run check`, `bun run build`, and `git diff --check`. Each one of these
  seven, with no exception for the non-test commands, reports its own explicit
  empty named failure set. Passing counts alone are insufficient, and omitting
  the failure set for any of the seven is a gate failure.
- One immutable candidate receives a separate literal zero-write exact-SHA
  review.
- Under contract, implementation, test, and review authority there is no merge,
  no rebase, no push, and no live tmux operation of any kind. Product
  implementation stops at a frozen, independently accepted exact SHA.
- Three separate, strictly sequential later authorities are **required and not
  yet held**, and this spec asserts none of them already exists: a literal
  `PASS` from an independent zero-write exact-SHA review; then **fresh
  exact-candidate installation authority obtained after `PASS`**, under which
  the successor binary hash is recorded; then a **separate, fresh, explicit tmux
  authority obtained after installation**, under which an explicit `--tmux`
  launch succeeds without editing Run 42. Installation authority never implies
  tmux launch authority, and there is no automatic flow from install to
  `--tmux`.

## Non-goals

- No cleanup of historical runs or tmux sessions.
- No automatic migration of preserved L4, Harvto, Agent Viz, or device lanes.
- No relaxation based only on terminal state, absent files, or unknown tmux.
