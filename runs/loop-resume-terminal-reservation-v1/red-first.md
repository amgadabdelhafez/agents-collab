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
