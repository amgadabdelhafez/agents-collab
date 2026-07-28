# Verification

## Acceptance checks

- `loop --help` documents `--caveman` and `--helper-caveman`.
- Invalid modes fail before launch with a precise error.
- Default paired prompts contain upstream `lite` guidance and exactness overlay.
- Explicit `off` leaves both main and helper prompts free of Caveman guidance.
- Helper default prompt contains upstream `full` compact reinforcement.
- Existing bridge, delegation, tool, and result payloads are byte-equivalent.
- Manifest records both selected modes; Governess displays them.
- Caveman source pin and MIT notice are present.
- Focused tests, `bun run test:ci`, `bun run build`, `git diff --check`, and
  `scripts/verify.sh` pass or pre-existing failures are isolated and recorded.

## UI proof

The Governess line is a terminal UI change. Capture the rendered line or a
deterministic pane-render snapshot showing both modes and the upstream short pin.

