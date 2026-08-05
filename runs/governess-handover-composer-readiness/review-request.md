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

After the reviewed first correction was deployed, resumed handover completed
the Codex side but left Claude unnotified. Live hook bytes show Claude's parent
turn ended with `Stop` sequence 1336 followed by `SubagentStop` sequence 1337.
The raw-last-event check therefore remained false even though styled tmux bytes
showed only an empty composer plus dim suggestion.

After exact SHA `ab495bc` passed review, the live transaction progressed without
deploying it: Claude was notified and persisted its ready bundle. The next
consumer still stalled because the hook tail was `Stop` sequence 1350,
`SubagentStop` sequence 1351, then the exact producer generic idle
`Notification` sequence 1352 with detail `Claude is waiting for your input`.
That later notification blocked Governess's post-bundle governed `/exit` even
though the composer contained only a dim suggestion.

## Changes

- Extend the existing `capturePane` dependency with an optional styled flag.
- Make the live dependency add `tmux capture-pane -e` only for that flag.
- Normalize the final ten handover probe lines through `stripDimSpans` before
  applying the unchanged non-empty-composer regex.
- Add producer-shaped positive and negative regressions.
- Make styled capture causal in the positive fake: styled returns captured dim
  SGR bytes, while unstyled returns ordinary non-dim composer text.
- Treat trailing `SubagentStop` and only Claude's exact producer generic idle
  notification as transparent when locating the latest parent `Stop`.
- Keep every other notification, including a permission request, fail-closed.
- Add a producer-shaped post-bundle governed-exit regression.
- Add spec, plan, verification, run log, and empty-baseline eval artifacts.

## Verification

- Focused exit suite: `27 pass, 0 fail`.
- Reviewer M1, removing the `true` styled-capture argument, is killed: focused
  suite becomes `24 pass, 1 fail`, with `styledCaptures` receiving `[false]`
  instead of `[true]`. The implementation was restored before broader checks.
- M2, restoring the raw `events.at(-1)` check, is killed: focused suite becomes
  `25 pass, 1 fail` because Claude remains unnotified after `Stop`,
  `SubagentStop`. The restored suite is `26 pass, 0 fail`.
- M3, leaving the exact generic idle notification blocking, is killed: focused
  suite becomes `26 pass, 1 fail` because no governed `/exit` is sent. The
  permission-notification negative regression remains green. Restored suite:
  `27 pass, 0 fail`.
- Complete sequential `bun run test:ci`: pass with no failures outside the
  sandbox; the first sandboxed local-port test failed to bind and passed when
  rerun with its required local loopback permission.
- Required `scripts/verify.sh governess-handover-composer-readiness
  governess-handover-composer-readiness`: pass, including lint, typecheck,
  compiled build, every sorted test file, and empty named baseline allowlist.
- `bun run check`, `bun run build`, and `git diff --check`: pass.

## Live continuation after an authorized deployment

Do **not** re-trigger `x`, `h`. The live state still persists
`exitControl.mode=handover`, the founder's original `requestedAt`, Codex's ready
bundle, and Codex's completed exit. Re-triggering would call `beginHandover` and
clear the intact in-flight transaction.

After exact-SHA approval and fresh deployment authority, the bounded sequence
is:

1. Install the approved immutable binary through the estate atomic-backup
   protocol and independently verify its commit and SHA-256.
2. Restart only the Governess pane with `tmux respawn-pane -k -t %2`. Tmux
   reuses its recorded `/Users/amgad/.local/bin/loop __governess 131` command;
   the agent, helper, proxy, and application panes remain untouched.
3. Positively verify `%2` is alive on the new binary, the persisted Governess
   epoch increased, the existing Codex bundle/exit survived, both bundle files
   still exist, and Claude receives exactly one governed `/exit`.
4. Let the existing handover transaction proceed. Do not send `x` or `h` again
   and do not force teardown unless the normal replacement acceptance gate
   fails and separate authority is given.

## Boundaries

- The live Claude ghost suggestion remains untouched; a producer-shaped
  non-dim draft regression independently proves real input still blocks.
- No handover authority, exit ordering, replacement readiness, or teardown
  condition changed.
- Exact producer string equality prevents permission or arbitrary input
  notifications from inheriting the idle exception.
- The first reviewed fix was deployed and only Governess was restarted under
  authorization; Codex then completed its normal governed handover exit. This
  follow-up has not touched Claude, re-triggered the handover, or mutated the
  persisted transaction.
- This request is exact-SHA review only. It does not request deployment.
