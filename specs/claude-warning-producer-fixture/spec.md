# Claude Warning Producer Fixture

## Problem

Claude Code 2.1.220 can render a transient `no MCP server configured with that
name` line while starting a development channel even though the same
`--mcp-config` is valid and the bridge subsequently connects. Existing tmux
tests hand-author the surrounding Claude startup prompt, so they cannot certify
the real producer shape or ordering. The captured 220x60 ready frame also proves
that Claude's rotating suggestion is plain captured text followed by blank pane
rows, so the current text-only readiness check times out on an empty composer.

## Goal

Capture the real startup output in a disposable, isolated Claude/tmux session
without submitting a model request, preserve complete producer provenance, and
accept the captured empty composer only after a detached, single-command-queue
snapshot and an acknowledged, content-preserving cursor probe prove it is
empty.

## Non-goals

- Do not change Claude Code or suppress a vendor-owned warning in production.
- Do not launch a Loop run, mutate live Claude configuration, or spend a model
  invocation.
- Do not use a synthetic fixture to certify the Claude-to-Loop seam.
- Do not deploy until the corrected source, producer evidence, full gates, and
  independent exact-commit review all pass.

## Acceptance criteria

- [ ] The capture uses Claude Code 2.1.220, a dedicated `CLAUDE_CONFIG_DIR`, a
      disposable tmux server/session, and a valid strict MCP config whose server
      name matches the development-channel argument.
- [ ] The exact capture command, UTC time, terminal geometry, producer version,
      raw SHA-256, and safety review are recorded adjacent to the fixture.
- [ ] No prompt is submitted and no Claude model request is made during capture.
- [ ] A focused test replays captured producer output and proves the launcher
      handles the startup confirmation before treating the composer as ready.
- [ ] Rotating suggested text is accepted only in a detached, unpiped pane after
      one bound snapshot establishes a quiet activity boundary and ordered
      `End,C-l` causes `window_activity` to advance while the cursor remains at
      column 2. A matching unsent draft moves to End, is restored to Home with
      its own acknowledgment, and remains fail-closed.
- [ ] Existing synthetic unit-only variants are clearly labeled or replaced so
      they are not presented as integration evidence.
- [ ] Focused tests, repository verification, Harness gates, and independent
      review pass with an empty baseline.
