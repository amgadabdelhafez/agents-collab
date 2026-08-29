# Verdict index — implementation candidate eb6841ad

Run 130 Claude is the sole writer and the **recorder/transcriber** of the row
below. It authored no verdict, claims no `PASS`, and performed no self-review.

| Reviewer | Location | Writes | Reviewed SHA | Verdict |
|---|---|---|---|---|
| cold implementation reviewer | `/root/cold_impl_review` | zero | `eb6841adb5a026470f464feb548b927e52da40c3` | `REFUSE` |

No `PASS` exists for any implementation SHA. The corrected successor recorded
here is therefore not accepted and requires a fresh independent zero-write
exact-SHA implementation review.

## Finding-to-closure mapping

| Finding | Closure |
|---|---|
| `parseCanonicalPid` and `parseUtcInstant` classified explicit `null` as `absent`, collapsing presence into absence and letting a null alias be discarded in favour of a valid sibling spelling | A shared `presenceOf` helper: `undefined` is `absent`, `null` is `invalid` naming the key. Applied at all four ownership parsers, including `parseStatusField` and `parseStateField`, which carried the identical defect. Six regression tests, five of which were RED against `eb6841ad`. |

## Preserved, not weakened

The exact Run 42 positive case and its 2814-byte fixture hash
`5e466b4ab2c8602bda8b7aefc1d8372356a2f1ae096c2e792769ccb947093b22`; every prior
refusal case; the evidence-backed release predicate with no legacy fall-through;
the endpoint seam and `targetOf` target opacity; the canonical PID rules and the
UTC calendar round-trip; the exact Harness write authority; and the seven named
commands with their per-command explicit empty named failure sets. Every earlier
verdict record is untouched; each names a different reviewed SHA.
