# D-007: Mid-run delivery accountability

## Status

Shipped in loop v1.0.38 at local main commit
`bf2246f38658356bd62cd569e1abf48614cada63`. The bounded implementation commit
was `e5bb70b54555d0d5266b63fd758ff6f5b420edba`; native review passed as
`cd81ba6b-4b67-40b8-b643-248802a137ef`. Continue to monitor live UAT and reopen
only with new producer evidence.

## Confirmed failure

Run 14 persisted Codex thread ID
`019fdefe-8a55-7d72-a345-74b2e8584901`, while the live TUI rollout was
`019fdefe-8bbb-7c23-bf30-947a300f9201`. Request
`af0aa210-074e-4ab5-a172-6d46730ca7d0` remained pending until runtime ownership
was corrected. Harvto run 164 later produced three authority races while the
Claude-seat bridge was unavailable and a courier added roughly 90 seconds of
latency, including an 18-second prohibition-versus-review authorization race.

## Required behavior

- Persist the live TUI thread or session identity mechanically after every
  rollout and reject stale manifest routing.
- Within 60 seconds, every idle-seat message must be durably submitted or gain
  a durable exact failure reason tied to its message ID and target identity.
- Classify apparent Claude composer text with the one-character probe before
  deciding whether the seat is busy: replacement is ghost typeahead; append is
  a real draft. Remove the probe character after classification.
- Preserve causal ordering for authority messages so delayed delivery cannot
  silently authorize work after a newer prohibition.

## Regression evidence required

- Producer-backed stale-manifest versus live-rollout fixture.
- Idle-seat delivery success and exact-failure paths both bounded to 60 seconds.
- Out-of-order authority messages cannot execute a superseded action.
- Ghost-typeahead and real-draft composer cases both exercised.
