# REFUSE — reviewer four, cold successor reviewer, SHA 3df5b236

## Identity

- Reviewer: `codex-cold-successor-reviewer`, at `/root/cold_successor_review`.
- Reviewed SHA (exact): `3df5b2369620e2b45220671f51e0a247227cde48`.
- Parent SHA: `1b2817a0f6c13b39fc88ca3aef9f708e05da0c85`.
- Integration base SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`.
- Review kind: cold zero-write exact-SHA plan review. The reviewer inspected
  **immutable Git objects only**, with `GIT_OPTIONAL_LOCKS=0`.

## Verdict

Literal **`REFUSE`**. No `PASS` was returned and none is claimed anywhere, by
any party, for this SHA or for its successor.

## Zero-write attestation

The reviewer made **no filesystem, index, ref, Harness, process, runtime, or
verdict-artifact writes**. This record is a transcription of that reviewer's
verdict, not a re-derivation of it.

## Finding — R4-1, authority boundary incomplete

Three parts:

1. **Change and install prohibitions do not cover integration or live tmux.**
   `verify.md` immutable blob `72a36ebab368bcd9c8115dcf4e69c0b980622a47`,
   lines 33-37, forbids some change and install classes ("No lockfile,
   dependency, provider, model, Web UI, device, or installed-runtime path may
   change in the candidate." and "No dependency install. …") but **does not
   prohibit live tmux operations, merge, rebase, or push**.
2. **Install authority flows directly into a live tmux launch.** `verify.md`
   blob `72a36ebab368bcd9c8115dcf4e69c0b980622a47`, lines 203-208, moves from
   "Before installation, remeasure the built committed blob and obtain fresh
   install authority." straight to "After installation, record `shasum -a 256
   …`, then rerun the exact explicit `--tmux` launch that Run 42 blocked.",
   with **no separate tmux authority** between them.
3. **The plan repeats the same defect.** `plan.md` immutable blob
   `6a76e8dfbe60c03ef148238bc79bd95305f4c159`, lines 100-103: "9. Only after
   PASS and fresh install authority, build and install locally, record the
   installed SHA-256, and retry the explicit `--tmux` certification."

**None of the three governing blobs prohibits merge, rebase, or push.**

## Required boundary

- Under contract, implementation, test, and review authority: no merge, no
  rebase, no push, and no live tmux operation of any kind.
- Product implementation stops at a frozen, independently accepted exact SHA.
- Installation requires fresh exact-candidate installation authority obtained
  after `PASS`.
- Live tmux lifecycle certification requires a separate, fresh, explicit tmux
  authority obtained after installation. Installation authority never implies
  tmux launch authority. There is no automatic flow from install to `--tmux`.
- These later authorities are required and **not yet held**. The contract must
  not claim any of them already exists.

## Recorder identity

Transcribed by the Run 130 Claude writer role, acting as
**recorder/transcriber of this verdict, not as its author and not as a
reviewer**. The Run 130 Claude role returned no verdict of its own and is the
sole Claude writer role for Run 130.
