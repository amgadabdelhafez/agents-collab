# Verification

1. A founder charter of at least 8 KiB creates persistent per-agent charter
   files whose manifest path, byte count, and SHA-256 match the bytes on disk.
2. Each terminal-bound launch bootstrap is below 1 KiB, contains no founder
   charter body, and tells the agent to fail closed on a hash mismatch.
3. Small and realistic-size charters use the same launch path; no large-paste
   marker or readiness poll is required. Workspace creation failure remains
   nonzero and rolls back partial run ownership.
4. Codex messages reach the app-server without invoking a tmux liveness probe.
   An evicted thread is resumed before turn start/steer.
5. An injection/resume error leaves exactly one unresolved bridge message and
   no delivered resolution. A successful retry appends exactly one delivered
   resolution under a delivery claim.
6. Interactive TUI notification text has a fixed upper bound and contains no
   message body, subject, or identifier. Notification evidence does not remove
   messages from `receive_messages`.
7. A notified inbox is throttled, while adding a new message permits one fresh
   notification. Draining the inbox appends the authoritative delivered
   resolutions exactly once.
8. Provider-native headless delivery remains functional and does not fall back
   to terminal body injection.
9. `evals/smoke/constant-size-transport.sh`, focused tests, and
   `scripts/verify.sh constant-size-transport constant-size-transport` pass
   with an empty baseline allowlist. The committed smoke must exercise a live
   hash-verifying fake agent, controlled hash mismatch, current pane mapping,
   ledger-only 9,279-byte bridge body, bounded nudge, and full inbox pull.
10. The committed exact SHA receives independent review, and deployment stays
    held until the T4/census gate is explicitly released.
