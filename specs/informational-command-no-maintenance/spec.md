# Informational commands must not run maintenance

## Problem

The run-101 Codex pane executed `loop collab --help` from an older worktree.
Because the CLI only recognized help and version when they were the first
argument, it ran global startup garbage collection before parsing the nested
help request. That maintenance falsely classified the still-live run as
abandoned, rewrote its manifest to `failed`, and signaled registered transport
processes.

Top-level `loop --help` and `loop --version` already bypass maintenance. The
same safety property must hold when a syntactically active help or version flag
follows a positional subcommand or command name.

## Requirements

1. A syntactically active `-h`, `--help`, `-v`, or `--version` request must be
   recognized before every startup maintenance, update, transport, or launcher
   action, even when it follows a positional token such as `collab`.
2. Recognition must share the normal argument parser's token-consumption
   semantics. A flag consumed as another option's value, or appearing after
   the `--` positional delimiter, is not an informational request.
3. Malformed arguments encountered before an informational flag retain the
   normal parser outcome; the preflight must not create an alternative parser
   grammar.
4. Informational requests print through the shared information renderer,
   independent of ambient model/config values, and return without garbage
   collection, staged updates, manual-update handling, agent cleanup, task
   resolution, or tmux launch.
5. Unit coverage must include nested positional aliases, all four information
   flags, option-value and `--` negatives, and zero calls to every startup
   maintenance dependency.
6. The realistic launch smoke must isolate both `HOME` and every explicit
   config/storage selector, and seed its isolated update-check cache, so
   automation cannot bind the user's real loop or Claude registries or depend
   on network timing. It must prove the run record exists only below the
   disposable home.
7. The current Harvto run-101 manifest, panes, processes, hooks, and bridge
   files remain read-only throughout implementation and verification.
8. A paired workspace confirmed dead before handoff must exit nonzero and
   terminalize only its exact active manifest as `failed`. Unknown tmux
   liveness must not grant terminalization or kill authority, and transport
   ownership inherited from an older launcher must remain recorded for exact
   cleanup.
9. The realistic smoke must prove that each generated launch charter contains
   the complete source prompt bytes, with a source payload of at least 8 KiB,
   rather than accepting a leading sentinel alone.
10. During the initial pre-resource probe, a cold tmux control socket must be
    treated as absent when tmux reports its platform-specific
    `No such file or directory` error. The same diagnostic after resource
    creation and all other control errors remain unknown, and the isolated
    smoke must keep every Darwin tmux socket pathname within the 103-byte
    pathname budget.
11. Release QA must be able to smoke an exact prebuilt binary without invoking
    the build or rewriting the installed path. Exact-binary mode requires an
    explicit expected SHA-256 and proves that hash before launch and again
    during cleanup, including failed smoke paths.

## Scope

- CLI argument preflight and its tests.
- Paired pre-handoff failure accounting and its focused regressions.
- Realistic launch-smoke environment isolation and assertions.
- No routing, pane layout, teardown, or live-run repair changes.

## Acceptance criteria

- [ ] `loop collab --help` and equivalent nested information requests exit
      before all startup maintenance.
- [ ] `loop --prompt --help` and `loop collab -- --help` are not
      misclassified as information requests.
- [ ] Confirmed missing workspaces fail nonzero with `failed/failed` manifests;
      tmux timeout/unknown cases preserve active ownership.
- [ ] The isolated smoke verifies complete source prompt bytes at realistic
      size without live network or real-home state.
- [ ] A cold isolated tmux server starts normally on macOS without widening
      cleanup authority for permission or overlong-path failures.
- [ ] Exact-binary smoke mode never rebuilds or mutates its target and fails
      closed on a missing or mismatched expected SHA-256.
- [ ] Focused tests and the full sequential verifier pass with zero failures.
- [ ] A different agent issues an exact-SHA verdict before any deployment.
- [ ] No live launcher smoke or binary activation occurs until run-101 has
      completed its governed teardown and the supervisor clears the hold.
