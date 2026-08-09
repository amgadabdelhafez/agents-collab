# Task d021-governess-pane-target

## Objective

Remove bare-session/bare-pane tmux authority from Governess pane recovery.

## Verification

- Pane inspection and respawn use only manifest-derived `OwnedPaneTarget`
  composers with exact socket and pane identity.
- Missing, invalid, conflicting, and drifting manifest targets produce no tmux
  observation or effect.
- Active ownership is read coherently by bracketing the manifest with matching
  handle hashes, and is revalidated after the durable attempt record and
  immediately before respawn.
- Existing durable restart budget and journal ordering remain intact.
- Governess pane liveness and tmux suites: 142/142 pass.
- Exact two-file Ultracite check, build, and diff check pass.
- Independent zero-write review: PASS after both snapshot races were fixed.
