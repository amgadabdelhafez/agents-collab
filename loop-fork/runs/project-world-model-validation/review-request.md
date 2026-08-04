PURPOSE

Resubmit Project World Model Phase 0 after exact-SHA dissent
`9dd0426a-371c-4b28-ae75-f4c718fd53f0`. This descendant makes the
fail-closed-validation claim falsifiable without broadening World Model
authority.

REQUESTED ACTION

Review the exact candidate SHA stamped by the governed sender. Reply CONCUR or
provide blocking findings. No deployment clearance is requested.

LINEAGE

- Cleared deployed ancestor: `cca045a7ff7b925f4559732ae4968d851b3e6db6`
- Reviewed parent with validation dissent:
  `adabbb9bf9cc850110d523800a793dbeb7bcd0b0`
- Candidate: supplied and verified by
  `evals/release/send-stamped-review.sh`

PRESERVED FINDINGS

The prior review passed lineage, stamp validity, isolation, CLI-only importer
scope, zero authority imports, read-only Git producer calls, the original
10-test suite, and tree cleanliness. This follow-up changes validation and
tests only.

MUTATION-CERTIFIED BOUNDARIES

- Persisted entity type, predicate, status, evidence SHA-256, evidence source,
  extraction method, authority class, source kind, confidence, observedAt,
  validFrom, validTo, and validity ordering.
- Empty database path and ontology mismatch.
- Direct entity type/key and statement predicate/status/observed authority,
  evidence provenance, authority provenance, evidence SHA-256, confidence,
  timestamps, validity ordering, and supersession target.
- Candidate status/predicate/evidence source/evidence body or SHA-256 and
  deterministic-producer authority escalation.
- Context seed, depth, statement-count, and timestamp bounds.
- Empty, array, and malformed assertion files through the real CLI path.

DELIBERATELY NOT PER-THROW MUTATION-CERTIFIED

- CLI argument spelling and shape branches. Command failure smoke covers the
  interface, and these branches do not validate stored knowledge.
- Git subprocess availability and repositories with no tracked files. These
  are producer-availability failures, not trust-boundary conversions.
- Runtime JSON parser internals. A nonzero CLI regression proves malformed JSON
  propagation without duplicating the runtime parser suite.

PROOF

- Focused World Model suite: 43 pass, 0 fail.
- Focused World Model CLI suite: 6 pass, 0 fail.
- Complete sequential `bun run test:ci`: exit 0.
- Harness-certified complete suite: exit 0 at
  `runs/project-world-model-validation/artifacts/unit/verify.log`.
- `bun run check`: pass across 804 files.
- `bun run build`: pass.
- Targeted production TypeScript compile: pass.
- Harness preflight and stop-gate: pass.

LIMITS

- No automatic context injection, routing, permissions, release, deployment,
  or lifecycle authority was added.
- No binary was deployed and no live loop was mutated.
