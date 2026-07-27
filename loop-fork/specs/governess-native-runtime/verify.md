# Verification

- Unit tests prove lifecycle sequences remain monotonic across restart.
- Unit tests prove dispatched controls are reconciled but never resent.
- Unit tests prove acknowledgements require post-dispatch target evidence.
- Unit tests prove a replacement accepts only the exact handover manifest.
- Replay tests detect changed decisions and explain phase/evidence history.
- Rendering tests cover one and multiple judges under a 20-row viewport.
- `bun run check`, full `bun test`, and `bun run build` pass or any unrelated
  pre-existing failures are identified with exact evidence.
- A focused live tmux replacement verifies composer safety and governess
  refresh without changing agent PIDs; isolated tests exercise the destructive
  handover acknowledgement path without tearing down productive agents.
