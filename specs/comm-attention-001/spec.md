# Spec: SupervisorMessage board and Attention projections

## Problem

`SupervisorMessage` now has durable, governed delivery, but operators still
need to inspect individual workflow state and manually relay status. There is
no canonical body-free board or Attention projection over that state, and no
end-to-end proof that one supervisor can send, claim, and acknowledge a message
without the founder acting as courier.

## Goal

Add one deterministic read-model boundary that consumes only canonical
`SupervisorMessageProjection` values. It exposes a communication-board view of
all known messages and an Attention view of messages requiring an action. Prove
the full cross-supervisor path using the accepted workflow, governed service,
and existing bridge queue.

## Non-goals

- Store or display message bodies, transcripts, credentials, or local paths.
- Introduce a second workflow state machine, message queue, or claim authority.
- Add UI, HTTP, device, deployment, or production Temporal infrastructure.
- Allow a read-model consumer to claim, acknowledge, route, or mutate workflow
  state.

## Acceptance criteria

- [ ] Board items are derived only from the canonical body-free workflow
      projection plus the stable workflow ID.
- [ ] Board state upserts by workflow ID, rejects malformed projections, and
      orders deterministically without duplicating a message.
- [ ] Attention state contains exactly board items whose canonical
      `actionRequired` is not `none`; it does not invent priority or authority.
- [ ] Both projections preserve only stable identities, lifecycle timestamps,
      action, phase, delivery attempt count, and content-addressed artifact
      references. They contain no body, transcript, credential, or local path.
- [ ] Read-model reads return defensive snapshots and cannot mutate canonical
      workflow state or subsequent projections.
- [ ] One cross-supervisor proof uses the governed service and existing bridge
      queue to receive, deliver, claim, and acknowledge a message. It proves one
      pending bridge row, exact destination, deterministic board transitions,
      Attention removal after acknowledgement, and no human relay operation.
- [ ] Focused, full, static, build, and diff gates pass with empty named failure
      sets, followed by independent exact-SHA zero-write review.

## Exit condition

One exact committed candidate satisfies the criteria and receives literal PASS
from an independent zero-project-write reviewer.
