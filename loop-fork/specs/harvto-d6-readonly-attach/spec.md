# D6 Read-only tmux Viewer Recovery

## Problem

At exact base `ee1e7736d876d4b387f13580ec25ddf1c606e873`, Claude launch recovery uses a
pane snapshot whose `window_active_clients` count does not distinguish writable clients from tmux
clients attached with `read-only`. `matchesClaudeSuggestionSnapshot` rejects every snapshot with an
active client, so a stale read-only viewer can keep an exact suggested-composer recovery
indeterminate even though tmux guarantees that viewer cannot send pane input.

The post-send changed-suggestion branch separately tests `observed.activeClients === 0`. If only the
shared matcher changes, a stable read-only viewer can still turn a benign changed suggestion into
`ClaudePostProbeIndeterminateError` after the bounded probe was sent. Both consumers are one D6
classification boundary.

The source incident is D6: a stale read-only viewer wedged targeted recovery for about two hours in
run 186. The incident statement is evidence authority, not permission to access or mutate Harvto.

## Required behavior

1. Recovery classifies clients viewing the exact target pane's window by current tmux client mode.
   A positively identified `client_readonly=1` viewer is non-writing and does not by itself block
   recovery of the otherwise exact, stable Claude suggested composer.
2. Window membership is proved by exact client identity from pane-bound
   `window_active_clients_list`. Those identities are intersected with per-client
   `client_readonly` records from `list-clients` bound to the exact target session. The
   `window_active_clients` count is only an additional fail-closed cardinality cross-check; equal
   counts never prove membership.
3. Any writable target-window identity, missing intersection member, duplicate or unparseable
   record, failed or timed-out query, target mismatch, count mismatch, or client identity/mode
   change makes recovery indeterminate before any key is sent.
4. Pane snapshot parsing keeps the existing fixed-arity cursor/activity/count/pipe marker intact.
   Variable-length active-client identities use a separate unambiguous field or record line;
   missing delimiters, extra fixed-marker arity, duplicates, or malformed identities fail closed.
5. Both the initial shared matcher and the post-send changed-suggestion classifier use the same
   positively read-only rule. With stable read-only viewers and a newly valid suggested composer,
   the post-send branch returns `candidate-changed`; unknown or unsafe post-send evidence still
   throws `ClaudePostProbeIndeterminateError`.
6. The pane remains independently bound by styled text, cursor, window activity, pane-pipe state,
   and exact suggested-composer text. A pipe, foreign draft, cursor change, activity race, or
   genuinely unclassifiable post-send state retains the existing fail-closed behavior.
7. Client evidence is sampled around the mutation boundary. Recovery may send the existing bounded
   probe only when the same exact target-client set remains read-only and the pane evidence remains
   stable; otherwise it sends zero keys.
8. Empty-set semantics are explicit: `activeClients === 0`, an empty pane-bound identity set, and an
   empty matched mode set are jointly safe. A positive count with an absent or empty identity/mode
   set is unsafe. The synthetic capture shim supplies the explicit three-way zero/empty/empty state;
   no predicate relies on vacuous `every()` over missing evidence.
9. A successful recovery is idempotent: after the composer is acknowledged empty, replay performs
   no second probe or submission. It never acknowledges, discards, or duplicates a bridge message.

## Compatibility and boundaries

- Writable attached clients and unknown client state remain blockers; D6 does not weaken protection
  for human drafts or concurrent pane writers.
- Piped panes remain blocked even when every attached client is read-only.
- D6 changes only tmux client classification for the existing Claude suggested-composer launch
  recovery. The Governess recovery ladder's direct `answer-prompt` and `nudge` transport is D11 and
  is not changed here.
- No bridge routing, message body delivery, lifecycle, provider/model, dependency, UI, Harvto,
  remote, deployment, or release behavior changes.
- Deterministic injected-output tests can prove parser and policy behavior plus the exact default
  query construction, but cannot prove a deployed tmux server's runtime output. Unsupported or
  changed live output remains contained by the required fail-closed branch; tmux 3.7b local manual
  entries for `list-clients`, `client_readonly`, and `window_active_clients_list` are the documented
  compatibility bound.
- Production scope is `src/loop/tmux.ts`; regression scope is `tests/loop/tmux.test.ts`. Planning,
  evidence, eval, matrix, Harness, `PLAN.md`, and `status.md` are bookkeeping scope only.

## Acceptance

- The named exact-base regression fails because one positively read-only target-window client is
  still represented only as `activeClients: 1` and blocks the existing probe.
- Positive read-only, read-only changed-suggestion, writable negative, malformed/extra-arity or
  unknown fail-closed, changing-client race, other-window isolation, explicit empty-set/synthetic
  shim, piped-pane, draft-preservation, and replay controls pass.
- Focused tmux tests and every mandatory repository/Harness gate pass with empty baseline failures.
- One explicit implementation commit receives Claude literal zero-write `PASS` for its exact SHA;
  Harness closes exactly once, followed by a separate bookkeeping commit.
