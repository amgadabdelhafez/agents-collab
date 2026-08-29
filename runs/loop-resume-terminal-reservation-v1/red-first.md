# RED-first record

Tests were written and executed before any source existed. Each failed for the
reason a missing implementation produces, not for an incidental error.

1. `bun run test:file -- tests/loop/tmux-socket.test.ts`
   → `SyntaxError: Export named 'readTmuxEndpointState' not found in module
   '.../loop-fork/src/loop/tmux-socket.ts'` — `0 pass, 1 fail, 1 error`.
2. `bun run test:file -- tests/loop/run-state.test.ts`
   → `0 pass, 1 fail, 1 error` (`readReservationManifest` not exported).
3. `bun run test:file -- tests/loop/launch-reservation.test.ts`
   → `0 pass, 1 fail, 1 error` (`readReservationManifest` not exported).

Source was then written and each file re-run to green (48 / 30 / 51 pass, 0
fail). One authored test case was withdrawn during the green cycle and the
withdrawal is recorded rather than hidden: the sub-case that deleted
`tmuxSession` from the Run 42 fixture asserted a refusal, but a manifest that
claims no tmux session at all is released by the pre-existing legacy path that
`tests/loop/governess-exit.test.ts:1313` depends on, and that file is outside
this candidate's write allowlist. The contract's "target undefined, or unusable
without a branded endpoint" case remains covered by the two sub-cases that keep
`tmuxSession` present: a relative (unusable) `tmuxSocket`, and an absent
`tmuxSocket`. Both yield an undefined target and refuse.

## Corrected successor — RED first again

Both regression tests for the paired-Codex finding were written and run before
the source repair:

- `evidence-backed terminal manifest without tmuxSession and without a release marker blocks`
- `evidence-backed terminal manifest with dead liveness blocks when the conjunction fails`

Against `d7d6e03f252fbf3efe35519495a80ffbcf78a726` the file reported
`30 pass, 2 fail`, with both named tests in the failure set — each failing
because `reservePairedLaunch` **resolved** instead of rejecting, which is the
legacy fall-through the finding names. After the predicate repair the file
reports `32 pass, 0 fail`.

One pre-existing in-allowlist test encoded the removed behavior and was rewritten
rather than deleted:
`same branch or same root conflicts while terminal dead ownership permits`
became
`same branch or same root conflicts, and terminal dead ownership alone no longer releases`.
Its third phase previously asserted that a terminal manifest with a matching
binding, no `tmuxSession`, and no release marker produced run `2`; it now asserts
the launch conflict, unchanged manifest bytes, and a run-directory listing still
exactly `["1"]`. Under the evidence-backed predicate that manifest can never
release: with no `tmuxSession` there is no branded target, so conjunct 1 fails,
and with no recorded handback conjunct 5 fails.

`tests/loop.test.ts` and `tests/loop/governess-exit.test.ts` — both outside the
allowlist and both callers of the affected paths — were checked directly and are
unaffected (`41 pass, 0 fail` and `34 pass, 0 fail`). The three-argument legacy
call at `governess-exit.test.ts:1313` still receives the prior verdict because
it supplies no ownership evidence.
