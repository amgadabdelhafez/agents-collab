# Review index — reviewed SHA 3b0e4f06

Reviewed SHA (exact): `3b0e4f063b791a6d9f89746b2efba439af2b3fef`.
Base integration SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`.

## Verdicts

| Reviewer | Location / identifier | Writes | Verdict |
|---|---|---|---|
| `codex-cold-plan-reviewer` | `/root/cold_current_review` | zero | `REFUSE` |
| paired Codex reviewer | bridge message `cbcff842-d378-40c2-a96f-145cdfcf3716` | zero | `REFUSE` |

Both verdicts are literal `REFUSE`. **No `PASS` is claimed anywhere, by any
party, for this SHA or for its successor.** A successor commit closing these
findings is not an acceptance; it must receive a fresh, different cold zero-write
exact-SHA plan review.

Full records:
- `review-refuse-codex-cold-plan-reviewer-3b0e4f06.md`
- `review-refuse-codex-paired-cbcff842-3b0e4f06.md`

## Role of Run 130 Claude

The Run 130 Claude writer role is the **recorder/transcriber** of both verdicts.
It is **not a reviewer**, it authored neither verdict, and it returned no verdict
of its own. It is the sole Claude writer role for Run 130; no concurrent writer
exists.

## Finding-to-closure mapping

| # | Finding | Raised by | Closure in the successor |
|---|---|---|---|
| C1 | Contradictory provenance outcome: helper both throws and returns `unknown` | both reviewers | `readTmuxEndpointState(target)` contracted **total, non-throwing, fail-closed**; derives the endpoint only through module-private `targetOf`; catches `TmuxTargetProvenanceError` and every provenance failure and returns `unknown`; exposes no raw socket; fake or unprovenanced input returns `unknown` and never releases. All contradictory throw language removed from `plan.md` and `verify.md`. |
| C2 | Two-versus-three focused gates | both reviewers | Stated as exactly **three** separate supported single-file commands in `spec.md`, `plan.md`, and `verify.md`: `bun run test:file -- tests/loop/run-state.test.ts`, `bun run test:file -- tests/loop/launch-reservation.test.ts`, `bun run test:file -- tests/loop/tmux-socket.test.ts`; then `bun run test:ci`, `bun run check`, `bun run build`, `git diff --check`. Each applicable test gate requires an explicit empty named failure set. |
| C3 | Overbroad `loop-fork/.harness/**` glob | reviewer one | Replaced with exact authority: `loop-fork/.harness/tasks.json` modifying only task `loop-resume-terminal-reservation-v1`; ephemeral `loop-fork/.harness/current-task`, required absent at closure; `loop-fork/.harness/evidence/loop-resume-terminal-reservation-v1/**`. `runs/loop-resume-terminal-reservation-v1/**` and the three specs stay separately listed. No `current-run` and no other `.harness` path, task, hook, config, debt, or evidence subtree is writable. |
| C4 | Normalization erases ownership evidence before reservation authority sees it | reviewer two | Reservation-specific fail-closed read boundary contracted in `run-state.ts`: `OwnershipField<T>` (`absent`/`valid`/`invalid`/`conflicting`), `ReservationManifestRead` (`valid(manifest + RunOwnershipEvidence)` or `refuse(manifestPath, optional manifestSha256/runId, readonly reasons)`), `RunOwnershipEvidence` preserving presence and validity separately; no prefix `parseInt`; `launchAttemptPid` absent distinct from present-invalid; enumerated `state` never falling back to `status` when invalid; release aliases never collapsing to absence; `storedManifests` and reservation scanning retaining refusal sentinels; `assertNoConflict` refusing before any counter or run allocation/write. Six direct contract cases added, each refusing with exact manifest bytes preserved and no run directory or counter change. |

## Scope note

Reviewer two **ACCEPTED** the two-path tmux-socket expansion
(`loop-fork/src/loop/tmux-socket.ts`, `loop-fork/tests/loop/tmux-socket.test.ts`).
That acceptance is a scope finding, not an approval of the contract; reviewer
two's overall verdict remains `REFUSE`.

## Successor commit character

The successor is **contract-only**. It changes zero product, test, and fixture
bytes; installs nothing; runs no gates, probes, tmux, device, or Web UI work; and
performs no merge, rebase, or push. It stops before source for a different cold
zero-write exact-SHA plan review.
