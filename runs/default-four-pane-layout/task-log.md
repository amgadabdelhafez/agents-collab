# Default four-pane layout task log

- Captured loop 47 at 235x52: top agents 118x30 and 116x30; bottom governess
  176x20 and worker 58x20. Tmux canonical layout is a 60/40 vertical split,
  equal top agents, and a 75/25 bottom split.
- Changed the default governess height from 25% to 40%.
- New governed loops create the full-width bottom governess before splitting a
  25%-wide worker pane to its right.
- Added `LOOP_UTILITY_PANE_WIDTH`; retained `LOOP_UTILITY_PANE_HEIGHT` as a
  deprecated compatibility alias. Worker opt-out remains unchanged.
- Updated actual/fallback pane manifest bookkeeping and focused assertions.
- Focused tmux tests: 52 pass. Full suite: 798 pass with the same four known
  Codex model/config expectation failures. Build and diff check pass.
- Real tmux smoke at 235x52 produced top 117x31 / 117x31 and bottom 176x20 /
  58x20, matching loop 47's proportions and bottom widths exactly.
