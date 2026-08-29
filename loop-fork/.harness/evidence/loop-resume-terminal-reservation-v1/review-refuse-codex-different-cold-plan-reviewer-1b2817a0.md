# REFUSE — reviewer three, different cold plan reviewer, SHA 1b2817a0

## Identity

- Reviewer: `codex-different-cold-plan-reviewer`, at `/root/cold_third_review`.
- Reviewed SHA (exact): `1b2817a0f6c13b39fc88ca3aef9f708e05da0c85`.
- Parent SHA: `3b0e4f063b791a6d9f89746b2efba439af2b3fef`.
- Base integration SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`.
- Review kind: cold zero-write exact-SHA plan review. The reviewer read **only
  immutable commit, tree, and blob objects** for `1b2817a0`; it did not read a
  working tree.

## Verdict

Literal **`REFUSE`**. No `PASS` was returned and none is claimed anywhere, by
any party, for this SHA or for its successor.

## Zero-write attestation

The reviewer performed **zero writes**. It created, modified, and deleted no
file, no branch, no ref, and no Harness state. This record is a transcription of
that reviewer's verdict, not a re-derivation of it.

## Findings

1. **Verify authority still uses a specs glob.** `verify.md` grants
   `specs/loop-resume-terminal-reservation-v1/**` instead of exactly listing
   `specs/loop-resume-terminal-reservation-v1/spec.md`,
   `specs/loop-resume-terminal-reservation-v1/plan.md`, and
   `specs/loop-resume-terminal-reservation-v1/verify.md`. Citation: immutable
   blob `c75159c94c96ad950a39d067a82b55d8d1262dcb`, lines 15-16.
2. **"Applicable" narrows the empty named failure set requirement.** Empty named
   failure sets are required only for applicable test gates, which leaves
   `bun run check`, `bun run build`, and `git diff --check` outside the explicit
   requirement. The governing contract must require an explicitly empty named
   failure set for **each** of all seven named commands. Citations: immutable
   plan blob `d68fc50dbf22bb2ffe27498242cd87df97fbeea8`, lines 81-95, and
   immutable verify blob `c75159c94c96ad950a39d067a82b55d8d1262dcb`,
   lines 161-177.

The seven named commands, verbatim:

```bash
bun run test:file -- tests/loop/run-state.test.ts
bun run test:file -- tests/loop/launch-reservation.test.ts
bun run test:file -- tests/loop/tmux-socket.test.ts
bun run test:ci
bun run check
bun run build
git diff --check
```

## Recorder identity

Transcribed by the Run 130 Claude writer role, acting as
**recorder/transcriber of this verdict, not as its author and not as a
reviewer**. The Run 130 Claude role returned no verdict of its own and is the
sole Claude writer role for Run 130.
