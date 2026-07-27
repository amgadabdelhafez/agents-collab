# Live proof: run 51

Captured 2026-07-26 PDT against tmux session `harvto-loop-51`.

## Deployment identity and pane preservation

- Previous installed SHA-256: `e9d35f5411ff3040f67c759d35fde624ec3e62a4c921a90e53087c7af40f9ea0`
- Verified/installed SHA-256: `e04e60191aec2c63e200fc06f0a19693dcf65277b123b36eda5fe6e404e3474a`
- Installed executable inode changed from `54411913` to `54758940`.
- Claude pane `%0` remained PID `22530`.
- Codex pane `%1` remained PID `22532`.
- Only governess pane `%2` and worker-display pane `%3` were respawned, to
  PIDs `89736` and `89735` respectively.

`loop governess doctor 51` returned `ok: true`; adapter, epoch, handoff,
journal, lease, manifest, replacement, runDir, session, state, and transport
were all true, with no journal issues.

## Usage stability

Four samples across 15 seconds kept the Codex row populated with
`gpt-5.6-sol`, weekly quota `W10`, and cost `$1.15`; total estimated cost stayed
nonzero (`$15.61` then `$15.76`). A later sample showed Codex cost `$1.83` and
total `$19.07`, confirming refresh continued rather than freezing the values.

## Routing and broker satisfiability

Git-inspection canary `51d366d6-181b-4c60-8095-402dab19b1ba`:

- Automatic request profile: `git-inspect`.
- Exact bounded queries: resolve `origin/main`, one-line log of `origin/main`,
  and branch list `*loop51*`.
- State: `pending-route -> routed-utility -> claimed -> running -> completed`.
- Broker activity: three `git_inspect` calls, three successes, zero failures,
  no other tool type.

Large-read canary `3ba668cf-53ab-440c-9f3a-e7fd9e6fff04`:

- Automatic request profile: `file-read`.
- Target: the 134,990-byte loop-48 README, lines 1-300.
- State: `pending-route -> routed-utility -> claimed -> running -> completed`.
- Broker activity: one `read_file` call, one success, zero failures, no other
  tool type.

After both canaries the board reported `considered 129`, `routed worker 6`,
`pending 0`, and worker `6j` / `5ok` / `1fail`. The sole failure was job
`a0492888-a684-44f2-963b-bb7932015ca5`, claimed by the old governess seconds
before deployment and deliberately fenced as a stale epoch during the scoped
restart; its one `git_status` broker call had succeeded. It is deployment
fencing evidence, not a worker execution failure.
