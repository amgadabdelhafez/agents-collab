# Verify: Claude Startup Readiness Timeout Preservation

## Deterministic checks

```bash
cd loop-fork
bun run test:file -- tests/loop/tmux.test.ts
bun run build
```

The readiness-timeout regression must prove all of the following before its
fixture is cleaned up:

- the launch promise rejects;
- no bootstrap buffer is loaded or pasted;
- the paired tmux session remains live;
- the manifest is `input-required` / `running` with exact session and pane
  targets;
- local persistent-session ownership is released once; and
- no `tmux kill-session` or persistent-session close occurs.

An unrelated fatal layout error must still terminalize the run as failed.

## Realistic-prompt smoke

```bash
evals/smoke/large-prompt-launch.sh
```

Run the smoke on an isolated tmux socket. Its never-ready fixture must exit
nonzero, preserve and inspect its tmux session plus recovery manifest, confirm
that neither agent received the charter, and then explicitly kill only that
fixture session. The smoke must finish with no fixture session or host-session
leak.

## Release gate

```bash
scripts/verify.sh
```

The exact candidate commit must receive an independent review, and any binary
deployment must be announced on the agent channel with commit and SHA-256.
