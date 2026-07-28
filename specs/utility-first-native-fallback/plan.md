# Plan: Utility-first native fallback

1. Add a fail-closed native-fallback mode and append-only request/lease journal
   with one run-wide slot, epoch fencing, terminal utility evidence, expiry,
   atomic consumption, child binding, and lifecycle telemetry.
2. Add bridge request/status tools and process pending requests from the
   Governess loop after ordinary utility routing.
3. Register current Codex/Claude tool and subagent hooks. Gate native spawn
   calls, enforce the one approved read-only profile, and deny unsafe child
   tools and descendants.
4. Generate loop-scoped provider controls: Codex one-slot or strict-off config,
   a read-only Codex profile, and Claude's read-only CLI profile or strict deny
   flags.
5. Update the shared delegation guidance and Governess board with compact mode,
   lease, block, and reason telemetry.
6. Add store, bridge, hook, config, prompt, tmux, Governess, concurrency, expiry,
   and negative-boundary regressions.
7. Run focused checks, repository checks, the full fail-closed verifier, and an
   independent exact-commit review. Do not touch the live agent panes.
