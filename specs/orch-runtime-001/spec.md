# Spec: Supervisor orchestration runtime

## Objective

Compose the accepted Temporal `WorkflowPort`, governed supervisor-message
service, existing bridge delivery adapter, durable supervisor-thread journal,
and durable board, Attention, and knowledge read models behind one embeddable
runtime seam.

## Requirements

- Every receive, claim, acknowledge, tick, and cancel is authorized before the
  workflow mutation and durably projected before success returns.
- Replayed workflow commands and durable projection appends are idempotent.
- Message category is immutable for one workflow and is recovered from the
  durable journal after restart.
- Board, Attention, and knowledge reads fresh-read the authoritative journal;
  they never expose message bodies, transcripts, credentials, or local paths.
- The Temporal host owns exactly one worker lifecycle for a caller-supplied
  namespace, task queue, connection, build identity, and workflow path.
- Worker startup failure leaves no advertised runtime; close is idempotent and
  awaits worker shutdown.
- Canonical workflow and read-model modules remain engine-neutral.

## Non-goals

- Provisioning Temporal infrastructure, credentials, DNS, or production
  namespaces.
- Adding a public HTTP API or UI before the shared authentication boundary is
  integrated.
- Replacing the existing bridge dispatcher, authority port, or journal schema.

