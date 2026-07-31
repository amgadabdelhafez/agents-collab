# Verification

## Functional checks

| Check | Pass condition |
|---|---|
| Producer identity | `claude --version` and executable path are recorded |
| Isolation | Capture uses dedicated `CLAUDE_CONFIG_DIR` and disposable tmux socket/session |
| Configuration | Development-channel server name exactly matches a valid strict MCP config entry |
| No spend | No prompt is submitted and capture stops at startup UI |
| Raw evidence | Captured bytes are retained with SHA-256 and reviewed for secrets/personal data |
| Replay | Focused test consumes the captured fixture and confirms startup handling |
| Bound state | Pane bytes, cursor, activity, client count, and pipe state come from one tmux command queue |
| Empty composer | Detached/unpiped ready frame requires a quiet second boundary, acknowledged `End,C-l`, and cursor x=2 |
| Human draft | Matching unsent text moves to End, is restored to Home with acknowledged redraw, and remains blocked |
| Synthetic boundary | Hand-authored variants are labeled unit-only and do not certify producer shape |
| Regression | `bun run test:file -- tests/loop/tmux.test.ts` passes |
| Release | `scripts/verify.sh claude-warning-producer-fixture claude-warning-producer-fixture` passes with empty baseline |

## Rollback

Revert if the fixture contains sensitive data, its provenance cannot reproduce
the producer conditions, replay no longer exercises the captured output, the
redraw acknowledgment can be satisfied without observed activity, or a
non-placeholder draft can be overwritten or left with a changed cursor.
