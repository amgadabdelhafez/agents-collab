# Idle Codex doorbell and bridge-worker backoff

## Problem

In a paired loop with a configured Codex app-server, a bridge message can remain
pending after direct app-server delivery refuses it while Codex is busy. The
detached bridge worker excludes that Codex message from tmux delivery whenever
the remote endpoint exists, so no terminal doorbell wakes Codex after it becomes
idle. The same worker rereads the growing bridge ledger every 250 ms while the
message remains pending, consuming a sustained share of one CPU core.

Live producer evidence from loop 122 measured a 12 minute 24 second post-idle
stall and 10-15% CPU in the bridge worker.

## Required behavior

1. Direct app-server delivery remains the first Codex delivery path.
2. When that direct attempt fails and a Codex message remains pending, the same
   worker cycle attempts the existing bounded tmux inbox notification path.
3. A tmux notification is not delivery: the message remains pending until
   `receive_messages` records the authoritative delivery acknowledgement.
4. An idle worker uses bounded exponential backoff from 250 ms to 5 seconds;
   successful work resets the delay to 100 ms.
5. Other bridge targets, delivery claims, notification retry limits, and live
   loop processes remain unchanged.

## Out of scope

- Replacing the append-only bridge journal or its hot index.
- Restarting or mutating loop 122.
- Changing agent prompts, routing policy, or utility concurrency.
