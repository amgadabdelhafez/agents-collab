# Verify: informational commands without maintenance

## Automated checks

1. Parser tests prove all four information flags are recognized when active,
   but not when consumed as a value or placed after `--`.
2. CLI tests prove nested information requests call none of the three startup
   garbage collectors, staged-update handling, manual update handling, agent
   cleanup, task resolution, or tmux launch.
3. Paired tmux tests prove every confirmed-dead pre-handoff path terminalizes
   only its exact active manifest, while completed, unknown-liveness, and
   external-transport ownership cases retain their distinct semantics.
4. The realistic large-prompt smoke uses a clean allowlisted environment,
   fresh isolated update throttle, and proves full source prompt bytes and
   manifest/config state below the disposable home only.
5. The cold-server case exercises macOS's exact missing-socket diagnostic only
   at initial preflight; post-resource probes retain unknown semantics, and the
   smoke rejects socket pathnames beyond Darwin's 103-byte budget.
6. `scripts/verify.sh` passes with zero baseline failures.

## Required cases

| Case | Expected result |
|---|---|
| `collab --help` | information response; zero maintenance |
| `collab -h` | information response; zero maintenance |
| `collab --version` | information response; zero maintenance |
| `collab -v` | information response; zero maintenance |
| unknown positional + information flag | information response; zero maintenance |
| `--prompt --help` | `--help` remains the prompt value |
| `collab -- --help` | `--help` remains positional data |
| malformed consuming option before help | normal parse error semantics |
| paired workspace absent before attach | nonzero; exact manifest `failed/failed` |
| tmux control timeout | no failure transition or transport clearing |
| cold macOS tmux socket at initial preflight | treated as absent; paired launch proceeds |
| missing macOS tmux socket after resource creation | unknown; no cleanup authority |
| permission or overlong tmux socket error | unknown; no cleanup authority |
| completed run ends during attach | completion preserved |
| realistic prompt charter | complete source buffer present; source >=8 KiB |

## Release gate

The candidate needs a passing eval and a different agent's exact-SHA verdict.
Live smoke and deployment stay blocked while Harvto run-101 is alive.
