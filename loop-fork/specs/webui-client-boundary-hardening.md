# Web UI client boundary hardening

## Problem

The live Web UI validator checks known required values but previously tolerated
unknown object fields, non-canonical date strings, arbitrary evidence-ID suffixes,
non-literal policy labels, and invalid numeric counters. Because the browser
consumes the validated object directly, tolerated fields make the public
read-only boundary wider than the declared DTO contract.

## Required behavior

- Every DTO object rejects enumerable own keys outside its declared required and
  optional fields. The dynamic `details` map remains keyed only by the exact run
  route IDs in `fleet.runs`.
- All timestamps use the server's canonical UTC millisecond form from
  `Date.toISOString()`, including its signed expanded-year form, and round-trip
  exactly through `Date`.
- Every evidence reference matches the server-generated opaque form
  `ev_` followed by exactly 16 lowercase hexadecimal characters.
- Governess policies accept only the declared `Read-only release` label.
- Literal-union fields require a JSON string of the exact allowed value; arrays
  and other values are never coerced before membership checks.
- Counters and byte quantities are nonnegative safe integers. Token counts and
  compaction counts follow the same rule. Costs are finite and nonnegative,
  percentages are within 0 through 100, and interpretation confidence is within
  0 through 1.
- The server skips invalid persisted hook counters, normalizes invalid optional
  compaction counters to zero, and saturates diagnostic sequence sums so it
  never emits a number outside the client contract.
- Invalid network payloads continue to surface only as `LiveSnapshotError`.

## Acceptance

- A complete valid fixture exercises every otherwise-vacuous nested validator.
- Negative tests independently cover each DTO object level and each scalar
  consumer, including values below range, fractional counters, and unsafe
  integers.
- Current live server output passes the same client validator.
- Focused tests, the complete Web UI suite, full CI tests, build, and the existing
  no-secret/no-path scan pass from the final committed bytes.
- An independent zero-write reviewer binds its verdict to the exact final diff.

## Non-goals

No new public fields or data sources, runtime mutation, UI redesign, dependency
change, deployment, release, or direct merge to `main` is authorized here.
