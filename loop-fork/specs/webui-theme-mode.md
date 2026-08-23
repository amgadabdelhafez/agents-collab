# Web UI appearance modes

## Problem

The Web UI currently renders only its dark palette. Operators need a deliberate
Light or Dark choice and a Follow system option that tracks the operating-system
preference without changing any run data or live adapter behavior.

## User outcome

An Appearance control is available from every Web UI route and state. Choosing
Light or Dark updates the full interface immediately and persists locally.
Choosing Follow system resolves from `prefers-color-scheme` and responds to a
system preference change without a reload.

## Requirements

- Support exactly three stored modes: `system`, `light`, and `dark`.
- Default missing, inaccessible, or invalid local storage to `system`.
- Apply the initial resolved theme before React renders to avoid a wrong-theme
  application flash.
- Persist only the appearance mode in browser local storage. Do not send it to
  the server or include it in the live DTO.
- Expose both the selected mode and resolved theme on the document root for
  deterministic styling and DOM verification.
- Update the document `color-scheme` and theme-color metadata with the resolved
  theme.
- Keep the control keyboard accessible, explicitly labelled, and usable at the
  390 by 844 mobile viewport.
- Give every neutral surface, input, overlay, and application-chrome element a
  readable light-theme treatment while retaining the existing status colors and
  information hierarchy.
- Honor reduced-motion behavior already defined by the application.

## Acceptance

- Focused tests cover parsing, resolution, persistence failure, initial DOM
  application, and live system preference changes.
- Server-rendered markup verifies the labelled three-option control.
- Production Web UI build and full sequential regression pass.
- Browser DOM evidence proves each selected mode, persistence after reload, and
  Follow system resolution.
- Screenshots cover desktop Dark and Light plus mobile Follow system, with no
  clipped header control or unreadable surfaces.

## Non-goals

No live-data schema change, server mutation, account-level preference, new
dependency, redesign of fleet/run information architecture, release, deployment,
or direct merge to `main` is included.
