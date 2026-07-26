# Plan: Lower-Agent Pane Cleanup

1. Extend the observability snapshot with latest activity time and per-job
   usage metadata needed by both renderers.
2. Replace the standalone LOWER table with a common-column utility agent row and
   tighten AGENT/LLM widths for the 176-column pane.
3. Compact the worker header, group transcript entries by job, and render
   outcome-first request/tool/result details at 58x20.
4. Parse and restore only Progress and Next as two bottom board lines with row
   budgeting.
5. Add focused geometry/content tests, run broad verification, obtain
   independent evaluation, integrate locally, and refresh display panes only.
