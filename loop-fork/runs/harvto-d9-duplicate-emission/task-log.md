# Task harvto-d9-duplicate-emission

Created: 2026-08-17T19:41:49Z
Mode: emergent
Description: D9 P2: reproduce four duplicate bridge emissions of one resolved acknowledgement and enforce idempotent single delivery.

## What I changed

- Updated `src/loop/bridge-store.ts` so explicit acknowledgement retries reuse the earliest
  reconstructed matching acknowledgement, comparing the recomputed source/target/body signature
  plus exact subject, reply, task, thread, and ordered artifact references. Distinct pending
  predecessors are superseded with the canonical acknowledgement ID without self-supersession;
  delivered and expired explicit acknowledgements remain replay fences, while untyped legacy and
  non-ack messages retain their prior behavior.
- Added D9 controls in `tests/loop/governess-p0-runtime.test.ts` for the Run197 four-attempt
  reproduction, correlation-field distinctness, same-key retry and pre-append crash convergence,
  earliest legacy canonical selection, malformed/untyped compatibility, and expired acknowledgement
  replay fencing.

## Why

## Notes
