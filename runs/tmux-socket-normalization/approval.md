# T-00 approval record — tmux-socket-normalization

Defect: `adc4bb8a-4b7b-4245-832f-a1995076b6b1`.
Spec bundle: `specs/tmux-socket-normalization/{spec,plan,tasks,verify}.md`.

## Gate 1 — peer review

**PASS**, review round 3, Codex, 2026-08-08T01:03:25Z.
Bridge message `e0b267ee-804b-44a7-ae78-3f8d1e084100`, replying to request
`e9e919c8-af88-4466-abf6-3f1904ae25c7`.

Reviewed at these exact working-tree SHA-256 values, each re-verified with
`shasum -a 256` on receipt of the verdict and again at T-00:

| Path | SHA-256 |
|---|---|
| `specs/tmux-socket-normalization/spec.md` | `d802f1f93a356a1fe63043932b15025290ae0872e2b3643f661f9e5a3cfbe027` |
| `specs/tmux-socket-normalization/plan.md` | `67bfa1ae626409bbc5e40d480d7a4294d0b1a735871e9a266c2fa06e08e8a95d` |
| `specs/tmux-socket-normalization/tasks.md` | `2bb690f01c9f10ce2731d6dcfe2b3337d82042b5c00d137dfc02f9e77d0cd4ff` |
| `specs/tmux-socket-normalization/verify.md` | `bc96366b75a720e0d38ff085e9cee17661e0cd2e202925fb3058fb5bd265be65` |

Review rounds 1 (`6a4ed303`) and 2 (`2323058d-2a99-44f2-92eb-978950fb3d59`) both
returned REVISE. Round 2's three residual gaps were closed in run 12 by API
shape — private socket-only composition plus a target-bound exported trio; a
one-argument `targetFromManifest(handle)` over an opaque frozen `ManifestHandle`;
and an opaque `OwnedPaneTarget`. Round 3 accepted all three and answered the
four questions put to it, including confirming that verify 5c correctly records
the tampered-manifest residual instead of claiming a rejection the product
cannot perform.

**`tasks.md` moved after this record was written**, from the reviewed
`2bb690f01c9f10ce2731d6dcfe2b3337d82042b5c00d137dfc02f9e77d0cd4ff` to
`e3fc7106cee334944a5896567371e8b54b48ef7dbef02ec778792ba0146fadf8`, because
T-00's checkboxes were ticked. Exactly three edits, all gate-state: the T-00
checklist line, the T-00 done-when block, and the header banner that previously
forbade starting. No requirement, check, task body, decision, or mapping row
changed. The other three reviewed files are byte-identical to their reviewed
hashes, re-verified after the edit: spec `d802f1f9…`, verify `bc96366b…`, plan
`67bfa1ae…`. The reviewed `tasks.md` hash remains the design that passed; any
re-review of design should read the reviewed hash, and any audit of gate state
should read the current one.

## Gate 2 — human approval

**APPROVED**, 2026-08-08, by the founder (Amgad Abdelhafez, repository owner and
this session's operator), on the session user channel.

Verbatim: `approved — fail closed, no recovery. proceed to T-00`

Approving: the recorded legacy-manifest support impact in `spec.md` under
"Resolved questions" and set out in full in `PLAN.md` under the human-approval
package. Specifically, a run launched before this change is **not recoverable**
by the new binary: it continues executing and nothing kills it, but resume,
attach, GC, cleanup, bridge delivery, proxy liveness, reservation, and handover
all refuse to act on it, and its panel row renders `unknown` and non-attachable.
The operator lets it exit or attaches manually with a socket they identify
themselves. The founder chose this over adding an operator-supplied-socket
recovery path, which would have enlarged scope into a separate spec cycle and
left a live destructive defect open meanwhile.

**Provenance note, recorded because this run has evidence that makes it
necessary.** The approval string resembles a string this run's delivery-defect
log records as *not* founder input — rendered type-ahead composer text reading
`approved, legacy manifests fail closed — proceed once Codex passes`, which was
misread as approval twice during run 11 and was never banked. The two are
distinguishable by channel, and that distinction is the whole basis for treating
this one as real: the ghost was scraped from a rendered tmux pane surface, while
this approval arrived on the session user channel, which is the authoritative
input path. No pane was read to obtain it. The resemblance was surfaced to the
founder before proceeding rather than resolved silently.

## Bindings re-verified at T-00

| Binding | Command | Result |
|---|---|---|
| Base commit resolves | `git rev-parse --verify ddf134b9200a3fda3cac68dcdd7868f28c94160d^{commit}` | `ddf134b9200a3fda3cac68dcdd7868f28c94160d` |
| HEAD equals base | `git rev-parse HEAD` | `ddf134b9200a3fda3cac68dcdd7868f28c94160d` |
| Installed binary | `shasum -a 256 /Users/amgad/.local/bin/loop` | `9ca9f74fa66e1ea0dd2a1a821e0db4e000b64b84aa1903b3db40f820a5fc93f1` — matches the pinned assignment value |
| tmux | `tmux -V` | `tmux 3.7b` |
| Product runs untouched | `git status --short loop-fork \| wc -l` | `0` |

`loop-fork/runs/` baseline for the verify 18 no-mutation comparison was captured
before anything was created: 1582 files, `loop-fork-runs-baseline.txt` with
per-file SHA-256, `loop-fork-runs-baseline-mtimes.txt` with mtimes and sizes.
Digest of the hash list: `2022557f23c6c36fc957a7560da0b2d34b8591cec244cce28cf1e1a30c0e5727`.

## What this authorizes, and what it does not

Authorized: T-00 bookkeeping, then T-01 onward per `tasks.md`.

**Not** authorized by this approval, and each still needs its own decision:
merge, rebase, push to `main`, install, deploy, cleaning product
`loop-fork/runs/`, or any Harvto access. T-18 ends at a scoped commit and a
review request, and stops there.
