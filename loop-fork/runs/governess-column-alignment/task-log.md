# Task governess-column-alignment

Created: 2026-07-28T03:10:33Z
Mode: emergent
Description: Align main-agent and helper token and tool columns

## What I changed

- Reused the primary-agent column widths for every helper field before the
  token and activity columns.
- Added helper `ACTIVE/QUEUE` and `CTX MISS` fields in the reclaimed aligned
  space.
- Expanded the primary activity label to `TEXT/THINK/TOOL` and aligned it
  exactly above helper `CALLS/TOOLS`.
- Added regression assertions for the exact visible start positions of both
  aligned column pairs.

## Why

The helper table used an independent narrow schema, which placed its token and
tool metrics well to the left of the equivalent Claude/Codex metrics and made
vertical comparison harder.

## Notes

Regression: yes
Regression id: governess-agent-helper-column-alignment
Regression symptom: Main-agent and helper token/tool columns did not share a
visual grid.
Regression guard: tests/loop/governess.test.ts

## Verification

- Harness unit verification: 63 pass, 0 fail.
- `bun run build`: passed.
- Live Loop 57 at 187 columns reports both token headers at character 114 and
  both activity/tool headers at character 139.
- The live board occupies 17 non-empty rows in its 20-row pane without
  duplicate history frames.
- Claude PID `70452`, Codex PID `70454`, Nanny PID `192`, Au Pair PID `197`,
  and dashboard PIDs `75034`, `75036`, and `75039` were preserved; only the
  Governess pane was respawned (`85903` to `2063`).
