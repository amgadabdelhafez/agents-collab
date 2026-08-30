# Spec: selective durable supervisor Attention

## Problem

The prototype Attention view selects by workflow action and reads an in-memory
board. That both loses restart durability and admits informational messages that
happen to require an action. The accepted contract requires Attention to contain
only questions, conflicts, failures, and authority decisions.

## Goal

Project a deterministic, body-free Attention list from a fresh authoritative
read of `JsonlSupervisorThreadStore`. Membership is determined only by the
immutable durable message category.

## Non-goals

- Store or infer message bodies, transcripts, credentials, local paths, or
  artifact content.
- Treat workflow phase or action as a substitute for message category.
- Mutate, acknowledge, claim, retry, or otherwise control a workflow.
- Add HTTP, UI, deployment, or external infrastructure.

## Acceptance criteria

- [x] The projector can read only the nominal durable thread-store class and
      malformed journal bytes fail before projection.
- [x] Exactly `question`, `conflict`, `failure`, and `authority-decision` are
      included; `informational` is excluded in every phase/action state.
- [x] A selected item remains visible after acknowledgement because category,
      not action state, defines Attention membership.
- [x] Lifecycle updates replace rather than duplicate a workflow item, while
      current phase/action and immutable category remain truthful.
- [x] Items sort by received time descending then workflow ID and restart plus
      repeated reads are byte-identical.
- [x] Output is defensive and contains no body, transcript, credential, local
      path, artifact content, manifest claim, or engine-specific type.
- [x] Focused/full/static/build/diff gates pass and an independent exact-SHA
      zero-write reviewer returns PASS.

## Exit condition

One exact committed candidate satisfies every criterion and receives literal
PASS from an independent zero-project-write reviewer.
