# Local release proof

## Source integration

- Canonical branch: `feat/babysitter-pane`
- Local merge commit: `4208c52` (`merge: release governed lower-agent runtime`)
- Remote push: none

## Recoverability and atomic installation

- Previous executable SHA-256:
  `d4a8f01751c1dc0964ce9bcb9aeebd8a5f7901caa1c038e4c057b28b7954af3c`
- Recoverable backup:
  `/Users/amgad/.loop/release-backups/loop.pre-lower-agent-integration.20260726T063059Z`
- Backup mode: 0700
- Canonical candidate was built as `loop.release-candidate` and renamed over
  `loop` only after a successful build and hash capture.
- Installed executable SHA-256:
  `8a82d58f7fb95ae522f97e0b4ed790c8005bdd9d4787bc4d0e7fd5e25bf51152`
- Installed mode: 0755

## Installed surface

`loop --help` advertises:

- utility model default `z-ai/glm-5.2`
- `OPENROUTER_API_KEY`
- external `LOOP_UTILITY_API_KEY_FILE`, defaulting to the mode-0600 key file
- default utility observer with `LOOP_UTILITY_PANE=0` opt-out
- configurable utility pane height and provider routing controls

A disposable installed-binary MCP probe returned:

- `route_task`
- `task_status`
- `get_task_result`
- `send_message`
- `bridge_status`
- `receive_messages`

The configured OpenRouter key remained outside the repository with mode 0600.

## Loop-40 non-interruption invariant

Immediately before and after the atomic executable rename:

| Pane | ID | PID | Command |
|---|---:|---:|---|
| Claude | `%0` | 35064 | `claude` |
| Codex | `%1` | 35066 | `codex-aarch64-a` |
| Governess | `%2` | 35520 | `loop` |
| Judge station | `%3` | 36990 | `node` |

No keys, bridge messages, signals, restarts, or persisted-state mutations were
sent to loop 40. The release affects future loop launches only.
