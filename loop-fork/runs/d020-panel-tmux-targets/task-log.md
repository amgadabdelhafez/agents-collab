# Task d020-panel-tmux-targets

## Objective

Make dashboard tmux rows manifest-backed, server-scoped, and exactly attachable.

## Verification

- Rows are derived from every run manifest and only valid recorded sockets are
  queried, once per socket, with no ambient fallback.
- Live, dead, and unknown row states are retained and rendered distinctly;
  only live rows receive exact shell-safe attach commands.
- Same-named sessions on separate sockets remain separate, and a failed socket
  query affects only that socket.
- Display, query, and attach identity come from one provenance-checked target
  snapshot; a deterministic manifest rewrite regression proves coherence.
- Panel and tmux-socket suites: 68/68 pass.
- Exact four-file Ultracite check, build, and diff check pass.
- Independent zero-write review: PASS after the snapshot-race correction.
