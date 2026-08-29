# Lifecycle note — loop-resume-terminal-reservation-v1

**SUPERSEDED PRE-GATE EVIDENCE ONLY.** Nothing in this note is proof of any
acceptance criterion. It records a reset, not a result.

Run: 130. Writer: Claude (same writer identity retained through recovery).
Contract/parent SHA at the time of the breach and of the reset:
`6f151163b712720dfc6464a8bd10c4cb07eded19`.
Base integration SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`.

## Sequencing breach

The supervisor interrupted the prior work turn. Product, test, and fixture
writes, an ignored dependency symlink, and a probe were made while durable hold
messages were unconsumed. That is a sequencing breach, not a code defect. On
recovery, `receive_messages` returned `[]`, so the hold bodies were no longer
retrievable from the queue; this is recorded as an unrecoverable evidence gap,
never as proof that no hold existed.

## Superseded delta inventory (read-only, before reset)

`git status --porcelain=v1`:

```
 M PLAN.md
 M loop-fork/src/loop/launch-reservation.ts
 M loop-fork/src/loop/run-state.ts
 M loop-fork/tests/loop/run-state.test.ts
 M status.md
?? loop-fork/tests/fixtures/loop-resume-terminal-reservation-v1/
```

| Path | working tree SHA-256 | HEAD SHA-256 |
|---|---|---|
| `loop-fork/src/loop/run-state.ts` | `491863e6b95bbe14b7fc665d1dc70f8a73a7cdc56c7e9597235fd37e8a50aae1` | `60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522` |
| `loop-fork/src/loop/launch-reservation.ts` | `b8e09e2ec38107972c91fbf044194ee0a3dbbf907036b8a8970b68c6cc4a4bba` | `1971ee32b6685a8a36736466559c366a4f7171f23ea77f60e82772c4e32ded40` |
| `loop-fork/tests/loop/run-state.test.ts` | `7e74b7cd80a5235c620a4bca4405ecc7d5bc2adfdb009ff0bdbc29e9a536bd8d` | `546ecf48b755e150b469df2d03db56a30c5ba8821cf70610d7001c3ac76087c3` |

Untracked fixture, a byte-exact copy of the real Run 42 manifest read from
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/42/manifest.json`
(Run 42 itself was never edited): 2814 bytes, SHA-256
`5e466b4ab2c8602bda8b7aefc1d8372356a2f1ae096c2e792769ccb947093b22`.

`git diff --numstat -- loop-fork`: `95 0` launch-reservation.ts, `43 0`
run-state.ts, `179 0` run-state.test.ts.

Superseded diff hash, `git diff -- loop-fork | shasum -a 256`:
`b6f85b9034fe384e0e578837551a8f9c192ae5b8243189f13a3da04950bc4525`.

Ignored dependency link created by this writer:
`loop-fork/node_modules -> /private/tmp/agents-collab-kickoff-base-bf2246/loop-fork/node_modules`,
ignored via `loop-fork/.gitignore:2:node_modules`. It was linked, never
installed, after observing that source tree's `bun.lock`
(`31d0bdb8a54bae9fd4dc29d287013e2a1821041072839b9859c6c9362273c321`) and
`package.json` (`c79cf0a69fb14de061c190c6bda5a93b8fdd5342d06e396d68c807cd6c302588`)
were byte-identical to this worktree's. It was removed at reset regardless.

## Probe (superseded)

Scratch file `loop-fork/probe42.ts`, created and deleted in the same turn.
`bun run ./probe42.ts` printed verbatim:

```
state stopped pid 9598 released 2026-08-18T18:30:00.000Z lap 9598 sess agents-collab-loop-42
handle? true
targetUndefined? false
```

## Gate observations (superseded, NOT carried forward)

- `bun run test:file -- tests/loop/launch-reservation.test.ts` — 18 pass / 0 fail.
- `bun run test:file -- tests/loop/run-state.test.ts` — 33 pass / 0 fail at
  baseline; 36 pass / 2 fail after the new cases. Both failures were the
  writer's own release validator accepting `2026-02-30T18:30:00Z`, because
  `Date.parse` rolls that instant over to March 2 rather than returning NaN.
  That fail-open is now a binding contract correction.

## Reset performed

Removed only this writer's own bytes, each named explicitly. No
`git checkout .`, no `git stash` (the stash stack is shared across worktrees),
no directory-scope `git clean`.

Post-reset evidence: `git status --porcelain=v1` shows only ` M PLAN.md` and
` M status.md`; `git diff --numstat -- loop-fork` is empty; the three reverted
paths hash exactly to their HEAD values above; `ls loop-fork/node_modules`
reports `No such file or directory`; `loop-fork/tests/fixtures/` contains only
the pre-existing `claude-code` and `utility` entries.
