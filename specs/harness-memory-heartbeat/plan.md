# Plan

1. Verify upstream Pickbrain at an exact commit, test Pi ingestion, install the
   binary and Pi assets with backups, and verify local retrieval.
2. Prove the existing Nanny/Au Pair Pi runtime boundary and add only missing
   regression evidence or installation wiring.
3. Add a bridge-journal version, race-safe event wait, atomic persisted
   reconciliation state, and a five-minute maximum reconciliation interval.
4. Add deterministic checkpoint production at observed pre-compaction
   boundaries, then a separate curated promotion command with fail-closed
   schemas and provenance.
5. Build a frozen local retrieval corpus/query fixture, measure Markdown,
   Witchcraft, and local-only Honcho, and record an accept/reject decision.

Each numbered item is a separate commit and exact-SHA review gate. A later
slice cannot be deployed merely because an earlier slice passed.
