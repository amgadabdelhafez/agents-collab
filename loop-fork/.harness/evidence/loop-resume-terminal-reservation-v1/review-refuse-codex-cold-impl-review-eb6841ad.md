# Independent cold implementation review of eb6841ad — literal REFUSE

Recorded by the Run 130 Claude writer acting as **recorder/transcriber, not
author and not reviewer**. No `PASS` is authored or claimed by the recorder, and
no self-review was performed.

- Reviewer identity: cold implementation reviewer at `/root/cold_impl_review`.
- Reviewed SHA (exact): `eb6841adb5a026470f464feb548b927e52da40c3`.
- Parent SHA: `d7d6e03f252fbf3efe35519495a80ffbcf78a726`.
- Contract SHA: `b0b113394c52bd27d1db7261e16e7c3a9e6a1203`.
- Base integration SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`.
- Review kind: independent zero-write exact-SHA implementation review.
- Attestation: zero writes.
- Verdict: literal **`REFUSE`**. That candidate is unfrozen.

## Blocking finding — presence collapsed into absence

`parseCanonicalPid` and `parseUtcInstant` in `loop-fork/src/loop/run-state.ts`
both opened with `if (value === undefined || value === null)` and returned
`ABSENT_FIELD`. `readAliasField` invokes a parser only when the key is
**present** (`alias in parsed`), so the `undefined` branch means non-presence;
folding `null` into it made a present, explicitly null field indistinguishable
from a field that was never written.

That is the precise failure mode `OwnershipField` exists to prevent. A manifest
carrying `"workspaceReleasedAt": null` reported `absent` rather than `invalid`,
so the reservation evaluated its conjunction against evidence it never had, and
a null `launchAttemptPid` bypassed the present-invalid refusal entirely. Worse,
`readAliasField` continues scanning after an `absent` result, so a null primary
alias sitting beside a valid legacy spelling resolved to the valid one — the
null was not merely mis-classified, it was discarded.

## Closure

Presence is now decided once, in a shared `presenceOf` helper: `undefined` is
`absent`, `null` is `invalid` with the key named in the reason, and anything
else falls through to the parser's own validation. It is applied at all four
ownership parsers.

The finding named `parseCanonicalPid` and `parseUtcInstant`. The identical
pattern also stood in `parseStatusField` and `parseStateField`, where it was the
same fail-open with a sharper edge: `"state": null` read as absent, which lets
the legacy `status` mapping supply the lifecycle state, so
`{"state": null, "status": "stopped"}` could reach a terminal verdict. Both were
fixed, because leaving two known instances of the refused defect in place is a
partial correction, not a bounded one. No path, dependency, lockfile, version,
provider, Web UI, device, or tmux scope was widened.

## Regression tests

`loop-fork/tests/loop/run-state.test.ts`: explicit `null` is invalid-present for
`launchAttemptPid`, `workspaceReleasedAt`, `state`, and `pid`; and a null alias
refuses even when the other spelling is valid, for both the release marker and
the launch-attempt pid.

`loop-fork/tests/loop/launch-reservation.test.ts`: null `launchAttemptPid`, null
`workspaceReleasedAt`, null release alias beside a valid `workspace_released_at`,
and null `state` beside a terminal `status`. Each asserts exact manifest bytes
unchanged, a run-directory listing still exactly `["42"]` (no new directory,
hence no counter step), and the launch rejected — every refusal lands before any
write.

RED evidence, recorded rather than rounded up: five of the six new cases failed
against `eb6841ad`. The sixth, `a null workspaceReleasedAt blocks release`,
already passed there, because `absent` also fails conjunct 5 — it reached the
right verdict by the wrong route. It is retained as a regression guard and its
prior passing state is stated here rather than presented as a fix.
