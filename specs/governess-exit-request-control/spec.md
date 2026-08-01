# Governess Exit-Request Control

## Incident

During Harvto run 109, the Governess board continued to render advancing
timestamps while its `x` and `e` keyboard controls stopped responding across
four attempts over roughly ten minutes. Manual tmux teardown left run-owned
bridge and Codex app-server children that required explicit PID cleanup. The
manifest later reconciled to failed but retained a stale tmux session name.

The evidence proves that rendering remained live while the interactive input
path was ineffective. It does not prove which terminal, stream, promise, or
long-idle transition caused the input failure.

## Outcome

Provide a public, bounded `loop stop --run-id <id>` command that sends a durable
teardown request to the live Governess. Governess remains the sole teardown
owner and executes its existing fenced manifest, registered-process, and tmux
cleanup transaction. The command never kills processes or tmux directly.

## Required behavior

1. The CLI resolves the requested run in the current repository and rejects a
   missing, terminal, non-Governess, or mismatched run before writing anything.
2. The CLI reads the current positive Governess epoch and appends one request to
   `governess-exit-requests.jsonl` containing a unique id, timestamp, run id,
   epoch, and `teardown` action.
3. A pending request for the same run, epoch, and action is reused instead of
   appending duplicate teardown work.
4. Every live Governess tick checks the append-only request ledger after its
   epoch fence and before expensive observations or local-model work.
5. Governess rejects malformed, wrong-run, or stale-epoch requests durably and
   performs no teardown for them.
6. Governess durably accepts a valid request, runs the canonical Governess-owned
   teardown transaction, records completion after manifest/process cleanup and
   before killing its tmux session, then exits.
7. The CLI returns success only after observing the matching completion receipt
   and terminal manifest state within a bounded timeout.
8. On timeout, rejection, lost epoch, or unavailable Governess, the CLI returns
   nonzero with the request id and exact reason. It does not fall back to direct
   process signaling or tmux deletion.
9. Ordinary keyboard `x`/`e` teardown continues to use the same canonical
   transaction and remains supported.
10. Startup and doctor surfaces report accepted-but-incomplete requests as
    interrupted teardown evidence rather than silently discarding them.

## Safety invariants

- Governess is the only teardown owner.
- A stale epoch can never stop a newer run or Governess instance.
- Silence is not completion; only a matching durable receipt plus terminal
  manifest state lets the CLI return zero.
- A request cannot target another repository merely by reusing its run id.
- Request processing cannot depend on stdin, pane focus, or a healthy tmux
  client attachment.
- Cleanup must use the modern registered-process path. The `origin/main`
  implementation that only marks the run and kills tmux is not an acceptable
  base for this feature.

## Prerequisites

- Integrate on a descendant that already contains Governess-owned registered
  bridge/app-server cleanup and stale-manifest reconciliation.
- Reconcile the current named baseline-failure fix before release verification.
- Do not deploy into an active run; activation is next-loop only after exact-SHA
  independent review.

## Non-goals

- Guessing or claiming the root cause of run 109's stdin failure.
- A second external process killer.
- Automatic handover or replacement-loop launch.
- Retrying teardown after an epoch change without a new explicit CLI request.
- Mutating the historical run-109 ledger.
