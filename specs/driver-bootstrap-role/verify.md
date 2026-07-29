# Verify: Driver bootstrap role activation

## Automated checks

1. Focused paired tmux tests pass.
2. Full sequential repository verification passes.
3. Defined source typecheck and compiled build pass.
4. Baseline-failure allowlist is empty.

## Functional checks

| # | Check | Pass condition |
|---|---|---|
| F-01 | Primary activation | Primary bootstrap says a concrete charter mission is assigned work and starts immediately without another task or role correction. |
| F-02 | Support restraint | Support bootstrap waits for a targeted request unless the charter explicitly assigns separate work. |
| F-03 | Interactive safety | Primary initiation is conditional on a concrete mission; no task is invented. |
| F-04 | Hash binding | Both variants retain path, expected SHA-256, byte verification, and fail-closed mismatch behavior. |
| F-05 | Constant size | Both variants stay below 1 KiB when the complete charter exceeds 8 KiB. |
| F-06 | Separation | Neither bootstrap contains the founder charter body. |

## Regression guards

- Complete primary and peer prompts remain unchanged.
- Persistent-session resume still avoids charter replay.
- Paired pane placement and manifest charter bindings remain unchanged.
- Harvto run 100 remains untouched.

## Release gate

The candidate needs a passing root eval and a different reviewer's exact-SHA
CONCUR before deployment.
