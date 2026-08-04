# Plan

1. Freeze the ontology, taxonomy, statement schema, competency questions, and
   authority boundary.
2. Implement an atomic SQLite schema and validated statement store.
3. Implement deterministic Git/file/import/Markdown-link materialization and
   explicit candidate-observation ingestion.
4. Implement bounded neighborhood, history, conflict, explanation, and decision
   context queries.
5. Expose the functionality through `loop world` without changing ordinary
   startup or Governess control paths.
6. Verify with a real temporary Git repository, source mutation, rebuilds,
   temporal supersession, conflicting assertions, and bounded retrieval.
