# Loop-58 runtime corrections

## Problem

The first live Loop-58 audit exposed four integration failures in the checkout
that actually launched the run:

1. the verified Claude config isolation/startup-GC change exists on another
   branch, so Loop-58 registered its bridge in the real `~/.claude.json`;
2. the reviewer prompt says both "delegate immediately" and "wait for Codex",
   causing Claude to perform costly context gathering before a review request;
3. a bounded five-file line-count request routed to Au Pair but failed with
   `command_denied` because the broker has no native line-count operation;
4. the control/helper processes must be refreshed without losing Claude or Codex work or silently
   changing the task's release, product, or acquisition gates.

## Goal

Make the active Pi launcher safe and predictable: automation uses run-scoped
Claude configuration, reviewers remain dormant until the primary asks, lower
workers can count lines without shell authority, and Loop-58 can adopt the
fixes with a narrow, verified hot-swap.

## Requirements

### Claude configuration isolation

1. Port the already-reviewed stale-bridge GC and per-automation
   `CLAUDE_CONFIG_DIR` propagation without replacing newer Pi routing code.
2. Test processes must always use a fresh temporary Claude config directory.
3. Startup GC may remove only loop-owned registrations whose run is provably
   terminal or whose declared tmux/PID liveness is gone. Live, foreign,
   malformed, and ambiguous registrations fail closed and remain.
4. Claude, governess, Nanny, Au Pair, and other loop-owned tmux processes must
   inherit the same run-scoped config directory.

### Dormant reviewer contract

5. A peer reviewer must not read task files, inspect external lanes, or submit
   utility packets before the primary sends a targeted bridge request.
6. Mandatory delegation remains in force once such a request arrives. The
   primary agent retains the existing immediate-decomposition guidance.
7. Startup and interactive peer prompts, plus tests, must make the ordering
   explicit and non-contradictory.

### Safe line counts

8. Add a broker-native `count_lines` inspection tool. It accepts one through
   eight declared regular files, follows the same canonical containment,
   protected-path, symlink, and maximum-file-size checks as reads, and returns
   exact newline counts without starting a shell or subprocess.
9. Models receive no broader command allowlist. Shell `wc`, options, paths
   outside declared scope, directories, oversized files, and duplicate or
   empty requests remain rejected.
10. Nanny and Au Pair inspection profiles may use `count_lines`; evidence
    accounting treats a successful call as repository-backed inspection.

### Live adoption

11. Focused tests, the full loop suite, build, diff hygiene, Harness preflight,
    and stop-gate must pass before hot-swap.
12. Preserve both live main-agent panes/processes and all Harvto task
    worktrees. Restart only Governess, Nanny, and Au Pair.
13. Back up the home Claude registry, garbage-collect stale loop bridges, and
    retain the current live Loop-58 bridge until Claude exits so its unchanged
    pane command remains recoverable. Fresh runs must use strict run-scoped MCP
    config and never add another home registration.
14. Verify the dormant reviewer contract in prompt tests (it applies on the
    next fresh reviewer launch), requestor-correct bridge delivery, a
    successful bounded line-count canary, and no stale home-level loop bridges.

## Non-goals

- Changing Harvto's task scope, T4 gate, product/release decisions, sampling
  constants, or acquisition data.
- Giving local models general shell access.
- Restarting or compacting Claude or Codex.
- Merging or pushing a branch.
