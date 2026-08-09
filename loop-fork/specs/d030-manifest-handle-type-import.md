# D-030 Manifest handle type import

## Problem

The documented TypeScript gate fails because `governess-pane-liveness.ts`
imports `ManifestHandle` from `run-state.ts`. That module uses the type
internally but does not export it; the authority-owning declaration is in
`tmux-socket.ts`.

## Required behavior

- Import the type from its authoritative declaration module.
- Do not widen runtime authority or add a value import.
- Preserve the sole `createManifestHandle` producer boundary.

## Acceptance

- The documented TypeScript command passes.
- The tmux migration checker passes.
- Governess pane-liveness owning tests pass.
- Static checks and independent review pass.
