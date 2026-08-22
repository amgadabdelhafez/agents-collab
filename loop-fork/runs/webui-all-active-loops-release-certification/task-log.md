# Task webui-all-active-loops-release-certification

Created: 2026-08-22T18:30:14Z
Mode: maintenance
Description: Correct the exact-byte independent review binding for the committed all-active-loop Web UI stack without changing production source or tests.

## What I changed

- Marked the incomplete pre-commit review hash as superseded in every current
  outward-facing review record while retaining immutable attempt snapshots.
- Bound the complete committed Web UI source/test diff to SHA-256
  `1b88b125b8f36627461bd8bc013cd07e41c33af4fc713e65341e97be27a77c9f`.
- Added a deterministic exact-byte instrument that also binds the previously
  omitted API contract test to SHA-256
  `a573133761f544119a8d830caebc5855ffb9eca2531f4218ecee3e9051607fb1`.

## Why

The original hash was calculated before the newly added API contract test was
tracked, so the stated exact-byte review boundary was narrower than the
committed implementation even though the file had been read and its tests had
passed.

## Notes

- The committed implementation range remains
  `3ae56bd529dfd9db30d7db528231f620d825aaa8..bc99161301788fa2e46d19b2da21580050b336c9`.
- The exact-byte instrument passed and re-ran the API contract test: 7 tests,
  25 assertions, zero failures.
- `active_loop_inventory` and `multi_loop_adapter_review` each returned literal
  `PASS` after reviewing the complete committed diff and the formerly omitted
  tracked test.
- Production source and test bytes were not changed by this correction.
