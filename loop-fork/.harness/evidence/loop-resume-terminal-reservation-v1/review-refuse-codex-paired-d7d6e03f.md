# Paired Codex review of implementation candidate d7d6e03f — literal REFUSE

Recorded by the Run 130 Claude writer acting as **recorder/transcriber, not
author and not reviewer**.

- Reviewer: paired Codex reviewer.
- Recorded in transcript at `2026-08-29T20:01:07.645Z`.
- Reviewed SHA (exact): `d7d6e03f252fbf3efe35519495a80ffbcf78a726`.
- Parent SHA: `b0b113394c52bd27d1db7261e16e7c3a9e6a1203`.
- Verdict: literal **`REFUSE`**. That candidate is unfrozen.

## Blocking finding — evidence-backed legacy bypass

`manifestCanStillOwnWorkspace` in `loop-fork/src/loop/launch-reservation.ts`
consulted `terminalReleaseGranted` and, when the conjunction was **false**, still
executed the legacy body (`tmux !== "dead"` implies owned, otherwise
`isActiveRunState(manifest.state)`). A terminal manifest with no `tmuxSession`
and no recorded `workspaceReleasedAt` therefore released the workspace through
the legacy route even though the fail-closed conjunction had already declined to
release it. The strict predicate was additive rather than governing, so an
evidence-backed scan could still release on the older, weaker rule.

## Closure

The predicate now returns exactly `!terminalReleaseGranted(...)` whenever
`RunOwnershipEvidence` is supplied. There is no fall-through in either
direction. Callers that pass no evidence keep the prior verdict, which is what
`loop-fork/tests/loop/governess-exit.test.ts:1313` exercises. Invalid or
unreadable ownership never reaches the predicate at all: `storedManifests`
retains a refusal sentinel and `assertNoConflict` throws before
`reserveRunStorage`.

Two direct regression tests were added to
`loop-fork/tests/loop/launch-reservation.test.ts`, each asserting unchanged
manifest bytes and an unchanged run-directory listing (hence no counter step):

1. evidence-backed terminal manifest with no `tmuxSession` and absent
   `workspaceReleasedAt` blocks;
2. evidence-backed terminal manifest with `"dead"` liveness blocks, because
   conjunct 3 requires `"unknown"`.

Both failed against `d7d6e03f` before the repair and pass after it. One existing
in-allowlist test,
`same branch or same root conflicts while terminal dead ownership permits`,
asserted the removed legacy release; it was rewritten to assert the new contract
and renamed to
`same branch or same root conflicts, and terminal dead ownership alone no longer releases`.
