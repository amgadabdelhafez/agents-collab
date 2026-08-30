# Spec: durable knowledge artifact read model

## Problem

The accepted message-board and artifact-reference views now read the durable
thread journal, but the earlier knowledge artifact projector still accepts an
in-memory board value. The final knowledge view must share the authoritative
durable source and must not copy message bodies, transcripts, or local paths.

## Goal

Expose a knowledge artifact read model that can only fresh-read
`JsonlSupervisorThreadStore`, reuses the accepted durable artifact projection,
and emits deterministic content-addressed references with safe backlinks.

## Non-goals

- Copy, dereference, summarize, or infer artifact content.
- Promote a message or artifact into canonical knowledge.
- Store body, transcript, credential, local path, or engine-specific state.
- Mutate messages, workflows, artifacts, or external systems.

## Acceptance criteria

- [x] The final knowledge reader accepts only the nominal durable store and a
      malformed journal fails before any knowledge projection.
- [x] It reuses the accepted durable artifact-reference projection rather than
      parsing or validating a second message-board representation.
- [x] Lifecycle updates replace rather than duplicate backlinks; restart and
      repeated reads are byte-identical and deterministically ordered.
- [x] Output contains only content-addressed artifact refs, counts, and safe
      message/thread/workflow/category/lifecycle backlinks.
- [x] Output contains no body, transcript, credential, local path, artifact
      content, knowledge-promotion claim, manifest claim, or engine type.
- [x] The earlier in-memory projector remains compatibility-only and is not the
      authoritative final read path.
- [x] Focused/full/static/build/diff gates pass and an independent exact-SHA
      zero-write reviewer returns PASS.

## Exit condition

One exact committed candidate satisfies every criterion and receives literal
PASS from an independent zero-project-write reviewer.
