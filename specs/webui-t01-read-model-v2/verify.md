# Verification

- Canonical run identity comes only from matching manifest path and manifest
  repo/run IDs.
- Missing, malformed, stale, mismatched, changing, and conflicting sources are
  explicit and fail closed.
- Every source freshness threshold passes below/equal/above fake-clock tests.
- Requirement and observation remain separate and aggregate status follows the
  versioned normative matrix.
- Timeline ordering is deterministic; evidence references are opaque, bounded,
  escaped, redacted, and containment checked.
- Legacy T-00 manifests remain representable with unknown adapter/config.
- Tests prove the read dependency surface cannot import or invoke write,
  migrate, rebuild, expire, acknowledge, send, spawn, kill, restart, or default
  tmux capabilities.
- Focused suites, `test:ci`, `check`, `build`, committed diff audit, and an
  independent exact-SHA review pass with task-scoped baseline failures empty.
