# Live deployment record

Date: 2026-07-27T17:47:14Z  
Commit: `4a6c758e3f9d7217564ecfc627a692a9a842d61b`

## Installed binary

- Candidate SHA-256: `912b17ef79dcf780594e9a7540ac3437c845e4ba8573b3efeb3e94c793cd447e`
- Canonical SHA-256: `912b17ef79dcf780594e9a7540ac3437c845e4ba8573b3efeb3e94c793cd447e`
- Global SHA-256: `912b17ef79dcf780594e9a7540ac3437c845e4ba8573b3efeb3e94c793cd447e`
- `/Users/amgad/.local/bin/loop` remains a symlink to the canonical binary.
- Installation used a same-directory temporary executable, verified its hash,
  and atomically renamed it over the canonical target.

Installed strings confirm the four-slot default, configurable one-to-eight
slot bound, per-stage structured read-plan broker, actionable/retained/unsafe
telemetry, three consecutive broker-rejection breaker, and pre-third identical
tool-call breaker.

## Loop 53 state

The loop-53 tmux server disappeared before deployment. `tmux list-sessions`
returns `no server running`, so there is no governess pane to restart and no
current pane PID/layout that can be preserved or verified.

The installed binary can still read the persisted run-53 state. `loop
governess doctor 53` reports the manifest, epoch, journal, state, handoff,
replacement, and transport checks healthy, but the session, adapter, and lease
checks are false; aggregate `ok` is false because the live tmux session is
absent.

No loop or agent session was recreated implicitly. Live restart/layout/board
acceptance remains pending until loop 53 (or its intended replacement) is
running again.
