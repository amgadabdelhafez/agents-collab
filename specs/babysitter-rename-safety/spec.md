# Spec: Babysitter Rename Safety

## Problem

The babysitter periodically derives new task labels and injects `/rename` into
Claude and Codex. An agent can appear idle while its composer contains a human
or peer draft, so the injected command can remain in the message box or combine
with later input. Label-history deduplication cannot prevent this when the local
model produces distinct labels for the same task.

## Goal

Keep the non-invasive tmux pane-border labels, but stop sending keystrokes into
agent TUIs by default. Retain agent-session rename only as an explicit opt-in.

## Acceptance criteria

- [ ] A normal babysitter run never injects `/rename` into Claude or Codex.
- [ ] Pane-border task labels continue to update.
- [ ] `LOOP_BABYSIT_AGENT_RENAME=1` restores the legacy `/rename` behavior.
- [ ] Dry-run and busy-state protections still apply when rename is opted in.
- [ ] Focused tests, the full test suite, and the build pass.
- [ ] The live run is restarted by replacing only its babysitter pane, and its
      state tick advances afterward without a new rename being recorded.

## Non-goals

- Detecting whether an agent composer contains a draft.
- Renaming tmux windows or changing the pane-border format.
