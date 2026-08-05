# Exact-SHA review request: Governess handover ghost composer

## Trigger

In live `harvto-loop-131`, the founder confirmed the Governess `x`, then `h`
succession at 2026-08-05T02:38:25Z. Both controls remained `prepared` with
`notified:false`; no handover bundles or replacement session appeared.

Positive styled inspection found that the current unstyled probe collapsed
ghost styling into ordinary text in both panes:

- Codex was stopped at its dim idle suggestion, `Write tests for @filename`.
- Claude was stopped at its dim idle suggestion, `start T2 now: run C5 then
  C2`.

## Claim

Governess now captures styling only for the post-`Stop` handover composer
safety probe and reuses the already-shipped SGR-dim parser. Dim suggestion text
does not block a confirmed handover; non-dim draft text still blocks it. If a
test or adapter does not honor the optional styled flag, the old fail-closed
plain-text behavior remains.

## Changes

- Extend the existing `capturePane` dependency with an optional styled flag.
- Make the live dependency add `tmux capture-pane -e` only for that flag.
- Normalize the final ten handover probe lines through `stripDimSpans` before
  applying the unchanged non-empty-composer regex.
- Add producer-shaped positive and negative regressions.
- Add spec, plan, verification, run log, and empty-baseline eval artifacts.

## Verification

- Focused exit suite: `25 pass, 0 fail`.
- Complete sequential `bun run test:ci`: pass with no failures outside the
  sandbox; the first sandboxed local-port test failed to bind and passed when
  rerun with its required local loopback permission.
- Required `scripts/verify.sh governess-handover-composer-readiness
  governess-handover-composer-readiness`: pass, including lint, typecheck,
  compiled build, every sorted test file, and empty named baseline allowlist.
- `bun run check`, `bun run build`, and `git diff --check`: pass.

## Boundaries

- The live Claude ghost suggestion remains untouched; a producer-shaped
  non-dim draft regression independently proves real input still blocks.
- No handover authority, exit ordering, replacement readiness, or teardown
  condition changed.
- No live pane, process, composer, state file, binary, or run was mutated.
- This request is exact-SHA review only. It does not request deployment.
