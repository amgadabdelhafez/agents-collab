# D-024 Smoke socket shim migration

## Problem

The tmux smoke harness still uses label-based `-L` routing and a product-facing
`LOOP_SMOKE_TMUX_SOCKET` shim. A smoke can therefore exercise a different
server-selection path from production and risks contacting a host server.

## Required behavior

- Every tmux smoke creates an absolute private socket pathname.
- The product receives that exact pathname through `LOOP_TMUX_SOCKET`.
- Smoke inspection and cleanup use real `tmux -S <exact-path>` commands.
- Each smoke asserts the manifest recorded the exact socket it created.
- Socket budget validation is byte-based, not shell character-count based.
- The old product-facing label shim is removed from the smoke path.

## Acceptance

- Shell syntax checks pass for every changed smoke.
- A repository sweep finds no product-facing `LOOP_SMOKE_TMUX_SOCKET` use.
- Focused smoke/static checks and an independent zero-write review pass.
- No smoke or test contacts an ambient tmux server during verification.
