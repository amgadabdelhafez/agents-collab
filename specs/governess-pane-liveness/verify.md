# Verify: Governess pane liveness

## Automated checks

1. Focused helper and tmux tests pass with zero failures.
2. The repository sequential verification suite passes.
3. The compiled binary is produced successfully.
4. Baseline-failure allowlist is empty.

## Functional checks

| # | Check | Pass condition |
|---|---|---|
| F-01 | Active exact ownership | A dead pane with matching active manifest, session, and pane is respawned once and journaled. |
| F-02 | Terminal teardown | Completed, failed, and stopped manifests never respawn. |
| F-03 | Stale ownership | Session mismatch, pane mismatch, missing session, absent pane, and live pane never respawn. |
| F-04 | Malformed evidence | Missing/malformed manifest or invalid budget journal fails closed. |
| F-05 | Revalidation | Ownership or pane state changing between initial validation and action prevents respawn. |
| F-06 | Rolling budget | Attempts 1-3 inside five minutes are allowed, attempt 4 is suppressed, and an attempt after the window is allowed. |
| F-07 | Hook scope | Only the stable Governess pane receives a pane-scoped `pane-died` hook with canonical run/session/pane arguments, followed by one immediate reconciliation run. |
| F-08 | Hidden dispatch | The helper runs without startup GC, update checks, or agent transport teardown. |
| F-09 | Visible death | Dynamic border and retained-pane formats explicitly show stopped/dead state while live labels remain unchanged. |
| F-10 | Original command | Respawn uses `tmux respawn-pane -k -t <pane>` without a replacement command. |

## Isolated tmux proof

Use a dedicated tmux socket/session that is not `harvto-loop-100`. Start a
throwaway pane with `remain-on-exit`, kill only that pane's command, and verify
the configured format/hook behavior. Destroy only the isolated test server
after evidence is captured.

## Regression guards

- Existing paired tmux layout and manifest tests still pass.
- Live-session reattach does not add or replace hooks on an existing workspace.
- Normal stopped-run cleanup still tears down without respawning Governess.
- No tmux process is classified or killed from its command-line argv.
- Harvto run 100 remains untouched throughout verification.

## Release gate

`runs/governess-pane-liveness/eval.json` must record full verification and a
different reviewer's exact-SHA CONCUR. The deployed binary hash must match that
reviewed commit.
