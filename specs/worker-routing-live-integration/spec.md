# Spec: Worker Routing Live Integration

## Problem

Run 50 initially retained an older executable inode after the installed path
was replaced. The user then advanced to `harvto-loop-51`, whose governess and
worker pane did load the widened router. Its low job total was not a five-job
ceiling: useful Git metadata commands were still ineligible, and an eligible
134,990-byte read exceeded the broker's 128 KiB whole-file ceiling. The
unrestricted worker then churned on tools that could not satisfy the request,
occupying one of the default two pool slots.

## Goal

Ship one executable built from current `main` that preserves the three
governess usage-stability fixes and includes the already-verified widened,
fail-closed worker router. Close the two new run-51 bottlenecks: bounded reads
must work for files slightly larger than 128 KiB, and exact read-only Git
metadata commands must be representable by both the classifier and broker.
Replace only the live governess and worker-runtime panes needed to load the new
binary, without restarting Claude or Codex.

## In scope

- Port the source and regression tests from commits `0e92b3d`, `4f971ce`, and
  `d2c548f` onto current `main`.
- Preserve the delegation classifier and worker-runtime behavior already
  merged through `39e479b`.
- Add an exact `git_inspect` broker tool for bounded ref resolution, log,
  commit-stat, branch-list, and object-type queries.
- Route a single supported Git metadata command or an `&&` chain of up to four
  supported Git metadata commands; retain fixed-order `head`/`tail` evidence
  bounds and reject any mutation, network, shell, or mixed command.
- Give auto-routed exact reads/searches/Git operations a matching execution
  profile so the worker model sees only the broker tools capable of satisfying
  that request.
- Raise the bounded regular-file read ceiling from 128 KiB to 1 MiB; the
  selected result remains capped by the existing 64 KiB output budget.
- Run focused routing and governess tests, the full suite, static checks, and
  an executable build.
- Move the freshly built executable inode into the installed binary path,
  respawn only `harvto-loop-51:0.2` and `:0.3`, and capture live
  process/doctor evidence.

## Non-goals

- Routing final review decisions or mutation commands to the utility worker.
- Routing `git fetch`, `git checkout`, arbitrary shell chains, arbitrary Git
  options, or shell-expanded refs/pathspecs.
- Restarting the active Claude or Codex panes.
- Pushing or merging the branch.

## Acceptance criteria

- [x] Current-main routing tests remain green, including compound safe-read
      shapes and fail-closed negatives.
- [x] Run-51 shapes `git show --stat <hex> | head -N` and a safe
      `rev-parse && log && branch --list` chain route to a broker-satisfiable
      `git-inspect` request; fetch/checkout/mixed chains stay direct.
- [x] The broker runs every Git inspection as literal argv with no shell,
      bounded output, scrubbed environment, and protected-path exclusions
      wherever history can expose paths.
- [x] A 135 KiB file can be read with an explicit bounded line range, while
      selected output above 64 KiB still fails closed.
- [x] Exact auto-routed file reads expose only `read_file`; searches expose only
      `search_repo`; Git metadata exposes only `git_inspect`.
- [x] Codex transcript bindings refresh when the live session changes.
- [x] Transient tracker failures retain the last valid pricing and quota
      snapshot while permanent unavailability still renders as unavailable.
- [x] Full verification and an independent evaluator produce a passing
      `runs/worker-routing-live-integration/eval.json`.
- [x] The installed binary is byte-identical to the verified build. Claude and
      Codex PIDs remain unchanged; only governess/worker processes that must
      load the executable are replaced.
- [x] Live doctor passes and the worker counters are interpreted as eligibility
      counts, not a hard request cap.
