# Project World Model validation certification

## Objective

Make the Phase 0 fail-closed-validation claim falsifiable by adding one
producer-backed regression per load-bearing guard identified by exact-SHA
review dissent `9dd0426a-371c-4b28-ae75-f4c718fd53f0`.

## Required mutation-killing coverage

- Corrupt persisted entity type fails on `entities()`.
- Corrupt persisted predicate fails on `statements()`.
- Corrupt persisted statement status fails on `statements()`.
- Malformed evidence SHA-256 fails on assertion ingestion.
- Empty database path fails before SQLite opens.
- Invalid `observedAt`, `validFrom`, and `validTo` each fail independently.
- Invalid confidence, missing evidence provenance, invalid candidate authority,
  and missing superseded statements fail independently.
- Empty seeds and out-of-range context depth/count bounds fail independently.
- Empty, array, and malformed assertion files fail through the CLI/read path.

## Read-path hardening

Persisted statement rows are untrusted derived state. Reading them must
revalidate evidence SHA-256, temporal fields, confidence, evidence provenance,
predicate, and status. Validation must not silently normalize an invalid row
into a trusted `WorldStatement`.

## Deliberately non-mutation-certified throws

- CLI argument spelling/shape branches remain covered by command failure smoke,
  not one mutation per parser branch; they do not validate stored knowledge.
- Git subprocess errors and repositories with no tracked files remain ordinary
  producer availability failures and are not ontology-integrity boundaries.
- JSON parser syntax errors use the runtime parser directly; a nonzero CLI test
  proves propagation without duplicating the parser's own suite.

## Authority and scope

- This follow-up changes validation and tests only; it does not broaden World
  Model authority, automatic context injection, routing, or lifecycle control.
- No deployment is requested or performed.
