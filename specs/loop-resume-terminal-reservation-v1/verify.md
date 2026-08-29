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
  - `loop-fork/.harness/**` (task lifecycle contract and task-scoped evidence)
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

- Derives the socket only through module-private `targetOf`; no raw socket
  string appears in any return value or error message.
- `ENOENT` and `ENOTDIR` for the exact bound path, and only those, yield
  `absent`.
- Successful stat or probe yields `present`.
- `EACCES`, `EPERM`, timeout, unexpected I/O, and provenance error yield
  `unknown`.
- A non-provenanced object raises `TmuxTargetProvenanceError`.

## Release validator cases

- `2026-08-18T18:30:00Z` and `2026-08-18T18:30:00.000Z` both accepted and
  returned byte-for-byte as read.
- Rejected: missing, empty, non-string, malformed, non-UTC offset, impossible
  calendar date including `2026-02-30T18:30:00Z`, and disagreeing or
  mixed-validity camel/snake aliases in both orders.
- Read/write/reread round-trip retains a valid value and never invents one for
  an invalid value.

## Gates

Focused gates are two separate supported single-file commands. The repository
refuses direct multi-file `bun test` at `loop-fork/tests/setup.ts:5-7`, so a
literal multi-file command is not a runnable contract.

```bash
bun run test:file -- tests/loop/run-state.test.ts
bun run test:file -- tests/loop/launch-reservation.test.ts
bun run test:file -- tests/loop/tmux-socket.test.ts
bun run test:ci
bun run check
bun run build
git diff --check
```

Every gate must report an explicitly empty named failure set. Passing counts
alone are insufficient. No tolerated failure or baseline allowance.

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
