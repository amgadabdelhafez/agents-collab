# Task fixture-provenance-policy

Created: 2026-07-31T03:14:13Z
Mode: planned
Description: Require producer-derived provenance for fixtures that certify cross-component seams

## What I changed

- Started from an explicit spec and verifier contract.
- Scoped the change to the eval policy and reusable verification template.

## Why

Consumer-authored expectations are not evidence of a producer's actual output.
The policy makes that distinction reviewable without banning synthetic unit tests.

## Notes

Regression: no

## Verification

- Harness unit policy assertions: PASS on attempt 002.
- Harness full repository gate: PASS, including lint, typecheck, compiled build,
  every single-file certified test, and empty baseline allowlist.
- `git diff --check`: PASS.
- Independent review: CONCUR, no blocking findings; evidence at
  `artifacts/independent-review/concur.md`.

The first policy assertion missed a Markdown line break and was corrected to a
whitespace-tolerant assertion. The first unwrapped full-gate attempt ran inside a
socket-restricted sandbox and the localhost proxy test reported `EADDRINUSE`;
the same test passed outside that sandbox, and the Harness-recorded full run then
passed. Ultracite also normalized seven pre-existing loop102 Harness JSON files
that otherwise blocked the mandatory repository-wide lint gate; only array layout
changed.
