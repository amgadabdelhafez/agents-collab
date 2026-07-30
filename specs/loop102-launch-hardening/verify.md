# Verification

## Focused

```bash
cd loop-fork
bun run test:file -- tests/loop/tmux.test.ts
```

Required assertions:

- delayed Claude development-channel confirmation is accepted before bootstrap
  transport;
- stable startup warnings do not count as ready;
- timeout prevents bootstrap transport and fails launch;
- detached paired `new-session` receives `-x 220 -y 60`;
- valid attached-terminal dimensions are preserved.

## Repository

```bash
cd loop-fork
bun run check
bun run test:ci
bun run build
```

## Runtime smoke

Run `evals/smoke/large-prompt-launch.sh` against the exact candidate binary and
expected SHA-256. The smoke must not rebuild or mutate that binary. It must
positively assert autonomous bootstrap, named tmux session, agent panes,
manifest binding, detached geometry, and nonzero failure behavior.

## Release gate

- clean exact candidate commit;
- independent CONCUR bound to that commit and binary SHA-256;
- Harness preflight and stop-gate pass;
- channel PREDEPLOY and DEPLOYED messages include commit and SHA-256;
- canonical and global binaries match the announced hash afterward;
- `harvto-loop-102` remains live with its original process tree.
