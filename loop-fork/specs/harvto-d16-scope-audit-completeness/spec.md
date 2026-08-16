# D16 Complete Scope Audit Evidence

## Problem

A scope audit can finish successfully and present a clean/safe conclusion after omitting paths that
Git reports. In run 60, utility job `3466ccae-7ca4-4eb9-be18-b645a77aa019` used the `git-status`
profile and a successful broker call, but its completed result listed eight paths from a nine-entry
Git set and omitted `loop-fork/specs/harvto-d5-silent-completion/`. It then affirmed that no
production or test path existed. Supporting job `6747f5a7-f35a-446d-9690-3b7f64feed42` returned a
successful `list_files` call as an empty directory even though native inspection found `spec.md`,
`plan.md`, `tasks.md`, and `verify.md`.

These historical helper outputs are evidence of the defect only. They are not trusted proof, and
this task must not route another utility job or incur provider spend.

## Required behavior

For a scope audit, Git-derived structured evidence is authoritative and synthesized prose is
advisory.

The authoritative path set must represent, without silent collapsing or omission:

- untracked/added and deleted paths;
- unstaged and staged paths;
- rename/copy source and destination identity;
- an explicitly requested committed base/head range;
- tracked paths excluded from helper-visible routing/content policy, without exposing file content.

Each normalized record must identify its Git state and applicable surface. A canonical sorted
serialization must carry its exact record count and SHA-256. Path identity must be repository
relative, deduplicated by the canonical record contract, and robust to whitespace and rename/copy
syntax.

Before a caller renders or acts on `complete` or `clean`, the consumer must independently validate
the canonical records, count, and hash. Missing evidence, malformed records, duplicates,
truncation, count/hash mismatch, or a helper claim that omits broker/Git records must produce a
durable failed or unknown result. It may not be represented as completed-clean.

A genuinely clean scope must produce a validated zero-record manifest and a clean result. The fix
must not replace false clean with an unconditional unknown.

## Replay and compatibility

- The same persisted scope result validates identically after replay and cannot become clean due to
  a second synthesis or delivery attempt.
- Existing non-scope utility results remain materializable.
- Historical scope results without the new evidence may be displayed as legacy/unverified, but no
  current consumer may promote them to authoritative clean proof.
- Broker exclusions may continue to hide protected contents from helpers; they may not hide the
  existence/state metadata of a tracked changed path from the authoritative consumer manifest.

## Exact-base proof

Production source stays unchanged at base `ee559c4f75dfe36e2dd61c607d48a3aba4faa500` until one
named regression reproduces the observed boundary: known Git/broker paths, one synthesized omission,
and a completed/clean result. Preserve command, fixture path set, broker evidence, recorded result,
and decisive assertion. If the boundary already fails closed, record contrary proof and skip source
changes.

## Acceptance criteria

- The observed omission is reproduced at exact base before a production edit.
- Added, deleted, renamed/copied, staged, unstaged, committed-range, and tracked routing-ignored
  classes each have deterministic coverage.
- Consumer reconciliation rejects missing, malformed, duplicate, truncated, or count/hash-mismatched
  evidence.
- A helper summary cannot omit an authoritative path while the job remains authoritative-clean.
- A genuinely clean fixture remains validated-clean.
- Durable replay and non-scope legacy controls pass.
- Focused controls and the complete mandatory verification suite pass.
- Git-derived D16-only scope is committed explicitly and receives Claude zero-write exact-SHA
  `PASS`; Harness closes exactly once afterward.

## Non-goals

No broad model-quality guarantee, generic factuality repair, protected-content disclosure, D15 or
D6-D12 work, provider/model/dependency change, UI change, utility routing/spend, Harvto access,
merge, rebase, push, deploy, release, or root `.loop/` mutation.
