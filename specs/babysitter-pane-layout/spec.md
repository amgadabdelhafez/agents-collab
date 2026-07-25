# Spec: Babysitter Pane Layout Cleanup

## Problem

The structured Project summary is truncated at half the available width, and
the agent table is wider than the live tmux pane. Tmux therefore wraps the
header and each agent row at arbitrary boundaries, making activity values look
like unlabeled extra rows.

## Goal

Use the full summary width for Project and render runtime/usage versus activity
as two intentional, aligned tables that fit the live pane without changing the
information shown.

## Acceptance criteria

- [ ] A representative Project summary longer than 180 characters wraps across
      two lines without truncation.
- [ ] Runtime/usage and activity each have their own header and agent rows.
- [ ] Neither table exceeds the 180-character content width.
- [ ] Existing values, colors, bridge activity, LLM footer, and summary height
      cap remain available.
- [ ] Focused tests and build pass.
- [ ] Only the live babysitter pane is restarted for deployment.
