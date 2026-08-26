# Plan

1. Research and inventory existing authoritative readers, ledgers, revisions,
   redaction helpers, and unsafe maintenance boundaries.
2. Define the read-only capability interface, canonical DTOs, source revisions,
   quality/freshness/conflict model, requirement/observation matrix, and opaque
   evidence references in RED tests.
3. Implement pure source materializers and deterministic projection/timeline
   composition only in the five new modules.
4. Verify malformed, missing, stale, changing-source, conflicting, legacy,
   dense, containment, and no-write cases with fake clocks and producer-derived
   fixtures.
5. Run focused suites, full regression, build, scoped static/diff/security
   gates, then obtain independent exact-SHA review before Harness completion.
