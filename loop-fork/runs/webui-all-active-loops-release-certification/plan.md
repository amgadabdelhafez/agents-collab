# webui-all-active-loops-release-certification Plan

Mode: maintenance
Description: Correct the exact-byte independent review binding for the committed all-active-loop Web UI stack without changing production source or tests.

## Objective

Replace the incorrect pre-commit review-hash claim with a transparent,
independently reviewed binding to every committed Web UI source and test byte.

## Scope

The committed incremental diff from `3ae56bd529dfd9db30d7db528231f620d825aaa8`
through `bc99161301788fa2e46d19b2da21580050b336c9`, the previously omitted API
contract test, current outward-facing review records, and a deterministic
exact-byte verification instrument.


## Proposed Tasks

### 1. Correct the certification record

- [x] Obtain a fresh independent verdict for the complete committed diff.
- [x] Mark the old incomplete hash claim as superseded everywhere it is current.
- [x] Preserve immutable attempt snapshots as historical evidence.

### 2. Test and verify

- [x] Verify the full diff hash and API contract test content deterministically.
- [x] Re-run the focused API contract test and diff check.
- [x] Pass independent review, Harness preflight, and stop gate.

## Non-goals

- Production source or test changes.
- Rewriting immutable prior-attempt logs.
- Merging, tagging, releasing, or deploying from this correction task.
