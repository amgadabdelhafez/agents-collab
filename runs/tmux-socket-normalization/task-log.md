# Task Log: tmux-socket-normalization

Feature: tmux-socket-normalization
Spec: `specs/tmux-socket-normalization/spec.md`
Worktree: `/private/tmp/agents-collab-tmux-socket-normalization-run11`
Started: 2026-08-08T00:33Z (run 12; spec authored in run 11)
Status: in-progress

---

## Understanding

Defect `adc4bb8a-4b7b-4245-832f-a1995076b6b1`. Every tmux invocation in the
product resolves its server from ambient environment, and nothing records which
server a run was created on. `RunManifest` persists only a session *name*, which
is meaningless without its socket. A consumer running under a different ambient
socket therefore reads a live run as dead — and three consumers convert that
into a positive dead verdict and act destructively on it: `claude-config-gc`
garbage-collects the run's Claude config, `run-process-cleanup` treats every run
as orphaned and signals its processes, and `tmux-control` returns `"dead"` on
any nonzero exit, which admits a duplicate launch against a live workspace and
shuts the Codex proxy down with `reason: "dead-tmux"`.

Done means: a run's server is an explicit, validated, persisted absolute socket
path resolved once at launch; every later consumer targets that recorded socket
instead of re-deriving one; and a target that cannot be identified is `unknown`
and blocks destructive action rather than reading as dead. 18 requirements
(R1-R18) map onto 18 verify checks.

## Approach

Spec-first, with implementation gated behind two approvals. One new chokepoint
module `loop-fork/src/loop/tmux-socket.ts` owns socket identity and command
composition; the manifest gains `tmuxSocket`; consumers migrate band by band;
and the migration is enforced by a *derived* check that reads the source, never
by a hand-written file list — because four different tmux identity conventions
exist in this codebase and three of them are invisible to a field-name grep.

The design's load-bearing choice is that provenance is enforced by API shape
rather than asserted in prose. Composition is target-bound and socket-only
composition is module-private; targets come only from a one-argument
`targetFromManifest(handle)` over an opaque frozen `ManifestHandle`; pane
identity is an opaque `OwnedPaneTarget`. This is what makes the wrong-run
pairing unconstructible rather than merely discouraged.

---

## Progress entries

### 2026-08-08T00:33Z — run 12 start, state verified before any work

Charter SHA-256 verified as `6aba015b0f5290483bbaa9266f8f8b18b31c51c4864c07d3ef51804c52ae880e`
before reading it. World-model bootstrap file SHA-256 `1e921375…` and
capsuleSha256 `5fffa0f7…` both verified. All six inherited working-tree file
hashes re-verified against run 11's `claude.json` handover and matched exactly.
HEAD confirmed at base `ddf134b9200a3fda3cac68dcdd7868f28c94160d`.

### 2026-08-08T00:43Z — three round-2 gaps closed, review round 3 requested

Closed all three residual gaps by API shape rather than by stronger assertions.
(A) Socket-only `tmuxArgv` made module-private and unexported; exported surface
became the target-bound trio `targetArgv` / `paneArgv` / `serverArgv`, each
supplying every target-naming flag itself and rejecting caller-supplied
`-S`/`-t`/`-s`. (B) `targetFromManifest(handle)` reduced to exactly one
parameter over an opaque frozen `ManifestHandle` minted only by the manifest
read path, making an A-manifest/B-socket target unconstructible; verify 5 split
into 5a constructibility / 5b cross-run non-contact / 5c a *recorded residual*,
because a manifest edited to name the wrong live server cannot be distinguished
without a second source of truth. (C) Opaque `OwnedPaneTarget` with
`paneTargetFromManifest(handle, field)` as sole constructor, making
`(TmuxTarget, paneId)` a compile error. R12 gained three derived rules to keep
those boundaries from decaying. Revised R3, R6, R10, R12; verify 3, 5, 6; T-02,
T-03, T-05, T-10, T-11; plus the acceptance mapping and `plan.md` decisions.

### 2026-08-08T00:45Z — peer blocked, held without inferring

Supervisor reported Codex blocked at the Luna rate-limit modal with review
traffic queued. Held implementation, injected nothing — no keys, no modal
choice, no composer text — and did not read peer state from the quiet channel.
Resolved itself 18 minutes later; disposition `cc231708` was never exercised.

### 2026-08-08T00:55Z — self-audit caught a real defect I had waved off

Routed a bundle consistency audit; Governess returned it `protected-scope`, so
it ran here. Three properties came back clean. The fourth — anchor citation
hygiene — I had initially skipped as "hard to derive mechanically", which was
wrong: it was two greps. It found **11 real violations** of the bundle's own
rule that `R1-R18` and `verify 1-18` must never be cited as bare numbers. Ten
predated run 12 and had survived both prior review rounds; one was mine, inside
the very sentence stating the rule. All 11 fixed, both greps now empty, and the
earlier "audit clean" claim was explicitly corrected to Codex rather than left
standing.

### 2026-08-08T01:03Z — review round 3: PASS

Codex accepted at spec `d802f1f9…`, tasks `2bb690f0…`, verify `bc96366b…`, plan
`67bfa1ae…`, all re-verified against the working tree on receipt. All four
attack questions answered rather than deferred: 5a/5b/5c accepted with 5c
credited for not claiming an impossible rejection; R12's target-flag rule
adequate as specified with AST needed only if full indirect coverage is claimed;
the `serverArgv` residual rejected as a concern since it emits no session
target; and the acceptance bijection independently confirmed row-for-row against
my own derivation.

### 2026-08-08 — T-00 gate cleared

Founder approved the legacy-manifest support impact on the session user channel:
`approved — fail closed, no recovery. proceed to T-00`. The resemblance to a
recorded ghost-composer string was surfaced to the founder before proceeding,
not resolved silently; the two are distinguishable by channel, and this one
arrived on the authoritative input path with no pane read. All T-00 bindings
re-verified and recorded in `approval.md`: base resolves, HEAD equals base,
installed binary matched the then-pinned `9ca9f74f…` T-00 snapshot, tmux 3.7b,
`loop-fork` status count 0. Captured the `loop-fork/runs/` pre-state baseline (1582 files, digest
`2022557f…`) for the verify 18 no-mutation comparison, before creating anything.

---

### 2026-08-09 — T-15 installed-binary forward compatibility

Reverified runtime truth superseded the T-00 binary snapshot: the installed
v1.0.38 binary is now SHA-256 `88dcfe2d…`, not `9ca9f74f…`. Against an isolated
HOME and tmux root, it read a byte-identical copy of the producer manifest
containing `tmuxSocket`; `governess doctor 1` exited zero and reported
`checks.manifest: true`. The copied manifest remained SHA-256 `4a629cf9…` and
no other file appeared in the isolated root. Full evidence is in
`forward-compat.txt`. No install or live-run contact occurred.

---

## Blockers

None open. Both gates are now cleared: peer review PASS at exact hashes, and
explicit founder approval. Prior blockers — the three round-2 provenance gaps
and the peer modal block — are closed and recorded above.

---

## Final summary

[Written at task completion.]
