# Spec: Governess Effort Parsing

## Problem

Governess scans the complete captured agent pane for `effort` text and accepts
the first following word as live reasoning effort. Ordinary conversation such
as `effort args` or `effort limb` therefore overwrites the provider-derived
value and renders fabricated effort values in the main agent table.

## Goal

Only a recognized agent effort level from the pane status line may override
provider-derived usage. Narrative pane content must not corrupt the EFF column.

## Requirements

1. Accept only the supported effort levels `low`, `medium`, `high`, `max`,
   `xhigh`, and `ultra` from pane text.
2. Prefer the last recognized effort marker because the live TUI status line is
   at the bottom of a captured pane.
3. If pane text has no recognized marker, preserve the effort already read from
   provider/run evidence.
4. Do not change agent lifecycle, routing, recovery, or launch policy.

## Acceptance criteria

- Narrative `effort args` and `effort limb` text cannot enter the EFF column.
- A later valid status-line marker still overrides provider-derived effort.
- Focused Governess tests, the repository verifier, build, and diff check pass.

