# Review index — reviewed SHA 3df5b236

Reviewed SHA (exact): `3df5b2369620e2b45220671f51e0a247227cde48`.
Parent SHA: `1b2817a0f6c13b39fc88ca3aef9f708e05da0c85`.
Integration base SHA: `62e8103d9181bad85012830f8170cca8e21fd0d6`.

## Verdicts

| Reviewer | Location / identifier | Method | Writes | Verdict |
|---|---|---|---|---|
| `codex-cold-successor-reviewer` | `/root/cold_successor_review` | immutable Git objects only, `GIT_OPTIONAL_LOCKS=0` | none: no filesystem, index, ref, Harness, process, runtime, or verdict-artifact write | `REFUSE` |

The verdict is literal `REFUSE`. **No `PASS` is claimed anywhere, by any party,
for this SHA or for its successor.** A successor commit closing this finding is
not an acceptance; it must receive a fresh cold zero-write exact-SHA plan review.

Full record:
- `review-refuse-codex-cold-successor-reviewer-3df5b236.md`

Earlier indexes `review-index-3b0e4f06.md` and `review-index-1b2817a0.md`, and
the three existing `REFUSE` records, cover different reviewed SHAs and are
unchanged. This is the **fourth** independent cold `REFUSE` in this lineage.

## Role of Run 130 Claude

The Run 130 Claude writer role is the **recorder/transcriber** of this verdict.
It is **not a reviewer**, it authored no verdict, and it returned no verdict of
its own. It is the sole Claude writer role for Run 130; no concurrent writer
exists.

## Finding-to-closure mapping

| # | Finding part | Closure in the successor |
|---|---|---|
| R4-1a | `verify.md` blob `72a36ebab368bcd9c8115dcf4e69c0b980622a47` lines 33-37 forbid change and install classes but not live tmux, merge, rebase, or push | The authority-and-scope list now adds two prohibitions: no merge, no rebase, and no push under contract, implementation, test, or review authority; and no live tmux operation of any kind under those authorities, enumerating tmux session or server create, attach, detach, kill, `send-keys`, socket bind, socket probe, and every other live tmux interaction. It also states that product implementation stops at a frozen, independently accepted exact SHA. |
| R4-1b | `verify.md` blob `72a36eba…` lines 203-208 let fresh install authority flow directly into an explicit `--tmux` launch with no separate tmux authority | "Review and runtime certification" now names three separate, strictly sequential authorities, each **required and not yet held**: acceptance (`PASS`, which alone authorizes nothing further); installation, requiring fresh exact-candidate installation authority obtained after `PASS` and naming that exact SHA; and live tmux lifecycle certification, requiring a separate, fresh, explicit tmux authority obtained after installation. Installation authority never implies tmux launch authority and there is no automatic flow from install to `--tmux`. |
| R4-1c | `plan.md` blob `6a76e8dfbe60c03ef148238bc79bd95305f4c159` lines 100-103 repeat the same defect in step 9 | Step 8 now states the implementation freeze and the merge/rebase/push/live-tmux prohibition. Step 9 is relabelled **not authorized by this plan; recorded as required and not yet held**, and enumerates the same three separate sequential authorities with the same no-automatic-flow rule. |
| R4-1d (radius extension) | `spec.md` blob `6642136010c7207dba8dd8ab352918f039693488` lines 92-93 carried the same install-flows-into-tmux defect: "After explicit install authority, the successor binary hash is recorded and an explicit `--tmux` launch succeeds without editing Run 42." The reviewer cited only `verify.md` and `plan.md`; this site was found by applying the correction radius to all current content. | The acceptance bullet is replaced by the same prohibition sentence plus the same three-authority sequence, marked required and not yet held. |

The contract records these later authorities as **required and not yet held** and
asserts that none of them already exists. No later authority is granted here.

## Preserved, not weakened

Current task scope; the four ownership corrections C1-C4; all prior `REFUSE`
evidence (`review-index-3b0e4f06.md`, `review-index-1b2817a0.md`, and the three
existing `REFUSE` records); the exact Run 42 literals; the seven named commands
and their per-command explicit empty named failure sets; the exact spec write
authority (the three listed spec paths) and the exact Harness write authority;
and the bounded source/test path set.

## Successor commit character

The successor is **contract-only**. It changes zero product, test, fixture, and
dependency bytes; installs nothing; runs no RED, source, tests, gates, probes,
tmux, device, or Web UI work; and performs no merge, rebase, or push — which is
also the boundary it writes into the contract. It stops before source for a new
cold zero-write exact-SHA plan review.
