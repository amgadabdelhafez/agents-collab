# Task project-world-model-validation

Created: 2026-08-04T19:50:11Z
Mode: planned
Description: Mutation-killing World Model validation certification

## What I changed

- Revalidated persisted statement rows for predicate, status, evidence hash,
  provenance, authority source, confidence, timestamps, and validity order.
- Rejected direct statements with empty authority provenance or inverted
  validity and candidate assertions claiming deterministic-producer authority.
- Added producer-backed corrupt-row and invalid-input tests, including empty,
  array, and malformed assertion files through the CLI.
- Normalized Git subprocess output to bytes so the targeted production
  TypeScript compile remains green.

## Why

Claude's exact-SHA review of `adabbb9bf9cc850110d523800a793dbeb7bcd0b0`
found that the fail-closed claim was not falsifiable: disabling three named
guards did not fail the suite. Each knowledge-integrity guard now has a test
that reaches its real consumer and asserts the expected failure.

## Notes

- CLI argument-parser branches and Git producer-availability failures remain
  deliberately outside per-throw mutation certification. They do not convert
  untrusted state into trusted World Model statements.
- No authority, routing, automatic injection, lifecycle behavior, or live
  binary is changed by this follow-up.
