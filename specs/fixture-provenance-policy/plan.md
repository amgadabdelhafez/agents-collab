# Plan: Cross-Component Fixture Provenance

## Approach

Place the normative rule beside the eval framework and add a reusable enforcement
checklist to the verifier template. Keep the rule technology-neutral and permit
either checked-in raw bytes or a durable hash-bound reference when data is unsafe.

## Sequence

1. Add the normative fixture-provenance section to `evals/README.md`.
2. Add a conditional fixture checklist to `specs/_template/verify.md`.
3. Verify formatting, content, and diff scope; obtain independent review.

## Risks

- Teams may treat a hash alone as reproducible. Mitigation: require producer,
  version, capture command/time, raw hash/reference, and normalization together.
- Raw captures may contain secrets. Mitigation: require sanitization before commit.
