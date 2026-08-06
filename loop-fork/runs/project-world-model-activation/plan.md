# Project World Model activation plan

## 1. Contract

- Default World Model preparation on new and dead-session-resume paired tmux
  launches.
- Preserve already-live sessions without manifest, pane, or composer mutation.
- Bind run-scoped artifacts and their hashes into the manifest.
- Preserve the Phase-0 non-authoritative boundary.

## 2. Implementation

- Materialize committed Git state into a run-scoped SQLite database.
- Derive bounded task seeds, with deterministic entry-document fallback.
- Write a bounded bootstrap context and update the manifest before handoff.
- Add verified artifact guidance to both fresh charters and pane environment.

## 3. Verification

- Producer-backed temporary Git fixture.
- Manifest whole-binding validation and run-directory confinement.
- Promptless and task-bound launch ordering plus fail-closed cancellation.
- No mutation on already-live reattachment.
- Charter and environment assertions.
- Exact-binary launch smoke from disposable repositories with a real committed
  `HEAD`, so the release gate exercises World Model provenance.
- Static check, complete certified suite, build, binary smoke, preflight, and
  stop-gate.

## Non-goals

- No routing or release authority for the World Model.
- No live pane restart, composer injection, or deployment in this change.
