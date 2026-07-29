# Large-paste submission readiness

## Problem

The prompt-size transport fix delivers a 22 KB composed charter to both real
agent TUIs, but immediately sends `Enter` from a separate tmux command. Codex
and Claude can still be ingesting the paste when that key arrives, leaving the
full charter visible and unsubmitted until a human presses Enter.

Loop-62 reproduced this independently in both panes. The fake launch smoke did
not expose it because its fake agents consume stdin immediately.

## Requirements

1. Paired startup must use terminal bracketed-paste framing when the target TUI
   requests it.
2. For large Codex and Claude startup prompts, the launcher must wait boundedly
   for visible paste-ingestion evidence before sending Enter.
3. The wait must run concurrently for the two panes so one slow TUI does not
   serialize the other pane's startup.
4. If visible evidence never arrives, startup must remain bounded and submit
   once rather than hang forever.
5. Automated coverage must simulate delayed real-TUI paste rendering and prove
   Enter is not sent before the paste marker appears.
6. Existing small-prompt, promptless, resume, and non-Codex/Claude startup
   behavior must remain intact.

## Scope

- Paired tmux prompt paste and submission ordering.
- Focused and full regression tests.
- No changes to routing, Governess policy, or the live loop-62 panes.
