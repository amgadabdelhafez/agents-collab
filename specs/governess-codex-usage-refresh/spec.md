# Spec: Governess Codex Usage Refresh

## Problem

A live governed pair can keep showing Codex lifecycle, quota, and bridge data
while every transcript-backed field remains blank. Run 50 exhibited this split:
the per-run Codex rollout contained valid model, context, token, and activity
records and parsed successfully outside the process, but the governess row kept
an empty usage snapshot. Governess resolves `sessionRef` and `codexHome` once at
startup, so a missing or later-corrected manifest binding cannot self-heal.

## Goal

Keep transcript-backed Codex usage populated by refreshing manifest-derived
agent bindings in the running governess without restarting either agent.

## Non-goals

- Changing Usage Tracker quota or pricing semantics.
- Restarting Claude, Codex, or the utility worker.
- Modifying Codex rollout contents or global Codex configuration.
- Adding new automatic control, handoff, or role-change behavior.

## Background

The unified board combines independent inputs: lifecycle hooks, Usage Tracker
limits, bridge journals, and per-session transcripts. A healthy quota cell does
not prove that the transcript binding is healthy. The manifest is already the
canonical source of Claude session and Codex thread identifiers.

## User journeys

1. A governed loop starts with complete manifest bindings and both rows populate.
2. A Codex thread identifier is absent or corrected after governess startup; the
   next tick adopts it and transcript-backed fields populate.
3. A transient unreadable or incomplete manifest does not erase a known-good
   in-memory session binding.

## Acceptance criteria

- [x] Before each tick reads agent usage, governess refreshes non-empty session
      identifiers from the current run manifest.
- [x] An absent-to-present or changed Codex thread identifier is adopted without
      restarting Claude or Codex.
- [x] A transient missing/malformed manifest does not erase a known-good binding.
- [x] Focused tests cover initial, late, changed, and transiently missing bindings.
- [x] Full tests, build, repository verification, and independent evaluation pass.
- [x] Live run 50 shows Codex model, run mode, context, tokens, and activity after
      replacing only the governess pane; agent PIDs remain unchanged.

## Out-of-scope risks

Quota refreshes and bridge delivery must remain independent. The refresh path
must not write the run manifest or touch any agent pane.

## Open questions

None.
