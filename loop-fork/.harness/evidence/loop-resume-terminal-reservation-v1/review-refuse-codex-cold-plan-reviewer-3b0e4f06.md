# REFUSE — reviewer one, cold plan reviewer, SHA 3b0e4f06

## Identity

- Reviewer: `codex-cold-plan-reviewer`, at `/root/cold_current_review`.
- Reviewed SHA (exact): `3b0e4f063b791a6d9f89746b2efba439af2b3fef`.
- Base integration SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`.
- Review kind: cold zero-write exact-SHA plan review of the contract bundle
  `specs/loop-resume-terminal-reservation-v1/{spec,plan,verify}.md`.

## Verdict

Literal **`REFUSE`**. No `PASS` was returned and none is claimed anywhere.

## Zero-write attestation

The reviewer performed **zero writes**. It created, modified, and deleted no
file, no branch, no ref, and no Harness state. This record is a transcription of
that reviewer's verdict, not a re-derivation of it.

## Findings

1. **Contradictory provenance outcome.** The endpoint-state helper has no single
   defined outcome for a provenance failure: the contract both requires a raise
   of `TmuxTargetProvenanceError` and classifies "provenance error" as endpoint
   state `unknown`. One condition maps to two outcomes.
2. **Two-versus-three focused gates.** The contract states the focused gates are
   "two separate supported single-file commands" while the fenced command block
   lists three. Cardinality contradicts the list.
3. **Overbroad Harness glob.** The allowlist entry `loop-fork/.harness/**`
   authorizes every unrelated Harness task, hook, config, and other tasks'
   evidence subtrees.

## Recorder identity

Transcribed by the Run 130 Claude writer role, acting as
**recorder/transcriber of this verdict, not as its author and not as a
reviewer**. The Run 130 Claude role returned no verdict of its own.
