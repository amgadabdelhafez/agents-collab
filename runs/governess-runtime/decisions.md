# Decisions: governess-runtime

- Session rename commands remain opt-in and are deduplicated; pane-border labels
  are the default non-invasive naming surface.
- Observation and rendering are always safe; prompt answers, nudges and role
  messages require a current fence and safe target; restart/handover/teardown
  require explicit confirmation; commit/push/merge/deploy/discard are forbidden.
- An ambiguous dispatched control is not retried automatically. This favors
  at-most-once delivery over duplicate composer injection.
- A replacement loop is acknowledged only after its tmux session has three live
  panes. The old loop is preserved on missing bundles, agent non-exit, launch
  error, or readiness failure.
- Historical `runs/`, regression fixtures and old spec evidence are immutable
  evidence and are not renamed; runtime/product surfaces are canonicalized.
- The board optimizes for one-glance agent comparison: one row per agent, with
  detailed execution/code/read/plan subcategories removed from the primary
  table. The retained `activity` composite shows total, text, thinking and tool
  counts; recent bridge lines continue to explain the actual work beneath it.
