# Verification contract

## Identity and scope

- Base integration SHA is exactly
  `62e8103d9181bad85012830f8170cca8e21fd0d6`.
- Product/test allowlist:
  - `loop-fork/src/loop/run-state.ts`
  - `loop-fork/src/loop/launch-reservation.ts`
  - `loop-fork/src/loop/tmux-socket.ts`
  - `loop-fork/tests/fixtures/loop-resume-terminal-reservation-v1/**`
  - `loop-fork/tests/loop/run-state.test.ts`
  - `loop-fork/tests/loop/launch-reservation.test.ts`
  - `loop-fork/tests/loop/tmux-socket.test.ts`
  - `runs/loop-resume-terminal-reservation-v1/**`
  - `specs/loop-resume-terminal-reservation-v1/**`
  - `loop-fork/.harness/tasks.json` — lifecycle index, modifying **only** the
    task `loop-resume-terminal-reservation-v1`
  - `loop-fork/.harness/current-task` — ephemeral while the task is active, and
    **required absent at closure**
  - `loop-fork/.harness/evidence/loop-resume-terminal-reservation-v1/**`
- Harness write authority is exact and exhaustive. No `current-run`, and no other
  `.harness` path, task, hook, config, debt, or evidence subtree is writable.
  Explicitly not writable: `loop-fork/.harness/config.json`,
  `loop-fork/.harness/README.md`, `loop-fork/.harness/hooks/**`, any other task
  entry in `tasks.json`, and any other evidence subtree.
- `loop-fork/src/loop/tmux-socket.ts` and `loop-fork/tests/loop/tmux-socket.test.ts`
  are a bounded expansion, justified in `plan.md`: the bound socket is reachable
  only through module-private `targetOf` (`src/loop/tmux-socket.ts:436`), so the
  endpoint-state seam cannot live anywhere else without breaking target opacity.
- No lockfile, dependency, provider, model, Web UI, device, or installed-runtime
  path may change in the candidate.
- No dependency install. Any ignored read-only `node_modules` symlink used to
  make gates runnable requires repository-supported byte and lockfile
  compatibility proof, and must be removed at closure.

## Fixture provenance

The Run 42 fixture must be a byte-exact copy of
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/42/manifest.json`:
2814 bytes, SHA-256
`5e466b4ab2c8602bda8b7aefc1d8372356a2f1ae096c2e792769ccb947093b22`.
Byte count and hash are asserted before any other fixture-derived claim. A
missing fixture fails; `.skip`, conditional pass, and empty aggregation are
forbidden, because a skip here is a fail-open. Run 42 is never edited.

## Required cases

1. **Exact Run 42.** Terminal, valid release marker
   `2026-08-18T18:30:00.000Z`, run PID `9598` dead, `launchAttemptPid` **9598
   present, equal to the run PID, and positively dead**, defined
   provenance-valid branded target whose bound endpoint is positively absent,
   tmux liveness `"unknown"`. Fresh reservation succeeds.
2. Active state plus release marker: refuses.
3. Terminal without release marker: refuses.
4. Terminal with invalid release marker: refuses. Includes
   `2026-02-30T18:30:00Z`, which `Date.parse` rolls over to March 2 and which
   strict calendar component round-trip validation must reject.
5. Terminal released with live run PID: refuses.
6. Terminal released with live launch-attempt PID: refuses.
7. Terminal released with live tmux: refuses.
8. Terminal released, endpoint **present**, liveness unknown: refuses.
9. Terminal released, endpoint **unknown** (`EACCES`, `EPERM`, timeout,
   unexpected I/O, or provenance error): refuses. Unknown is never absence.
10. Target undefined, or unusable without a branded endpoint: refuses.
11. Non-enumerated state: refuses. The terminal set is exactly `completed`,
    `failed`, `stopped`.
12. Release marker conflicting across `workspaceReleasedAt` and
    `workspace_released_at`: refuses.
13. Every refused case preserves manifest bytes exactly and creates no new run
    directory. Asserted per case, not once in aggregate.

## Endpoint-state cases

`readTmuxEndpointState(target)` is a **total, non-throwing, fail-closed**
classifier for the reservation consumer. It has exactly one outcome per input.

- Derives the socket only through module-private `targetOf`; no raw socket
  string appears in any return value or message. It exposes no raw socket.
- `ENOENT` and `ENOTDIR` for the exact bound path, and only those, yield
  `absent`.
- Successful stat or probe yields `present`.
- `EACCES`, `EPERM`, timeout, and unexpected I/O yield `unknown`.
- Every provenance failure, `TmuxTargetProvenanceError` included, is caught
  internally and yields `unknown`. The classifier never throws for any input.
- Direct case: a fake or unprovenanced input returns `unknown` and never
  releases the reservation.

Unknown is never absence.

## Reservation manifest read boundary cases

The reservation consumer must not treat omission in `RunManifest` as validity.
An equivalent discriminated representation is required in
`loop-fork/src/loop/run-state.ts`:

- `OwnershipField<T>` is `absent`, `valid(value)`, `invalid(reason)`, or
  `conflicting(reason)`.
- `ReservationManifestRead` is `valid(manifest + RunOwnershipEvidence)` or
  `refuse(manifestPath, optional manifestSha256/runId, readonly reasons)`.
- `RunOwnershipEvidence` separately preserves presence **and** validity for the
  mandatory run PID, the optional `launchAttemptPid`, `state`, `status`, and the
  `workspaceReleasedAt` aliases. Invalid-present or conflicting never normalizes
  to absent.
- An existing malformed-JSON, non-record, unreadable, or ownership-unestablishable
  manifest yields `refuse`, never `undefined`.

Strict ownership evidence rules:

- PID parsing never uses prefix `parseInt`. Accept only a positive safe JSON
  integer, or — only if legacy decimal strings remain supported — a full
  canonical lossless positive-decimal token. Reject `9598junk`, fractional,
  zero or negative, overflow, whitespace, prefix or suffix, and alias
  disagreement.
- `launchAttemptPid` absent differs from present-invalid. Present-invalid or
  conflicting refuses.
- Present `state` must be enumerated and never falls back to `status` when
  invalid. If `state` is absent, only an explicitly supported legacy `status`
  mapping may supply it. If both exist, each must be valid and semantically
  consistent, or it refuses.
- Release aliases preserve absent, valid, invalid, and conflicting. Invalid or
  disagreement refuses and cannot collapse to absence.

Consumption:

- `storedManifests` and reservation scanning consume `ReservationManifestRead`
  and retain a refusal sentinel for every existing unreadable or invalid-present
  manifest.
- `assertNoConflict` refuses **before** any counter increment or run
  allocation/write.
- Never continue merely because canonical `readRunManifest` returns `undefined`.
- General non-reservation readers may keep existing DTO behavior.

Direct contract cases, inside the already authorized
`loop-fork/tests/loop/run-state.test.ts` and
`loop-fork/tests/loop/launch-reservation.test.ts`:

1. Run PID string `9598junk`.
2. Malformed-present `launchAttemptPid`.
3. Present-invalid `state` plus a terminal-looking `status`.
4. `state` and `status` semantic disagreement.
5. Release alias conflict.
6. Existing malformed or unreadable manifest.

Each of the six refuses, preserves exact manifest bytes, and creates no run
directory and no counter change. The raw valid Run 42 positive fixture and every
refusal case in **Required cases** above are retained alongside these.

## Release validator cases

- `2026-08-18T18:30:00Z` and `2026-08-18T18:30:00.000Z` both accepted and
  returned byte-for-byte as read.
- Rejected: missing, empty, non-string, malformed, non-UTC offset, impossible
  calendar date including `2026-02-30T18:30:00Z`, and disagreeing or
  mixed-validity camel/snake aliases in both orders.
- Read/write/reread round-trip retains a valid value and never invents one for
  an invalid value.

## Gates

Focused gates are exactly **three** separate supported single-file commands. The
repository refuses direct multi-file `bun test` at `loop-fork/tests/setup.ts:5-7`,
so a literal multi-file command is not a runnable contract.

```bash
bun run test:file -- tests/loop/run-state.test.ts
bun run test:file -- tests/loop/launch-reservation.test.ts
bun run test:file -- tests/loop/tmux-socket.test.ts
bun run test:ci
bun run check
bun run build
git diff --check
```

Every applicable test gate must report an **explicit empty named failure set**.
Passing counts alone are insufficient. No tolerated failure or baseline
allowance.

## Review and runtime certification

- Freeze and report exact candidate and parent SHAs.
- A separate reviewer returns literal `PASS` or `REFUSE` for the exact SHA and
  performs zero writes.
- Before installation, remeasure the built committed blob and obtain fresh
  install authority.
- After installation, record `shasum -a 256 /Users/amgad/.local/bin/loop` and
  `loop --version`, then rerun the exact explicit `--tmux` launch that Run 42
  blocked. Success requires tmux session existence, both agent identities,
  initial hook progression, and bridge liveness.
