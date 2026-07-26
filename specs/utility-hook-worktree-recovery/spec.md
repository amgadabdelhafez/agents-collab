# Utility hook worktree recovery

## Problem

Loop 47's explicit utility route can adopt a verified linked Git worktree, but
Claude's automatic `PreToolUse` classifier still anchors containment to the run
manifest root. Once Claude changes into the loop worktree, eligible mechanical
operations are rejected before a utility job exists. Ineligible and rejected
tool calls are also absent from routing statistics. Separately, Codex's bridge
MCP transport can close without reconnecting, preventing explicit delegation.
The live fallback behavior also led Codex to inject one verdict directly into
Claude and then send the same verdict through the bridge, duplicating visible
delivery.

## Requirements

- Resolve Claude's hook cwd to the canonical run root or a registered linked
  worktree of the same Git common directory before classifying tool scopes.
- Persist linked-worktree scopes as absolute request scopes so the existing
  utility workspace adoption boundary re-verifies and records the execution
  root before routing and detached execution.
- Fail open to the main agent for unverified workspaces, protected paths,
  unsupported tools, and unsafe commands.
- Journal every non-delegated `PreToolUse` candidate with a compact reason and
  include those records in governess considered/skipped totals.
- Preserve all existing worker authority, tool, cost, write, and secret
  boundaries.
- Diagnose and recover Codex's closed MCP transport without restarting Claude
  or Codex panes; add permanent recovery only if it can be done through the
  existing headless app-server/proxy boundary.
- Make the bridge the sole peer-delivery transport and remove obsolete periodic
  polling guidance now that paired tmux delivery is push-based.

## Acceptance

- A bounded read or focused check from a registered linked worktree creates a
  utility request for that worktree.
- An unrelated checkout and mixed/unsafe scope remain direct and observable.
- Edit and compound-shell exemptions appear in skipped-reason statistics.
- Focused tests, build, broad tests, and independent evaluation pass.
- Loop 47 produces a new real worker request from its active worktree while the
  Claude and Codex pane PIDs remain unchanged.
- Agent prompts prohibit direct tmux duplication and reserve status/receive
  calls for genuinely stuck delivery.
