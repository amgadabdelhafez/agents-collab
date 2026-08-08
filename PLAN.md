# PLAN — D-007 mid-run delivery accountability

## Run 46 (2026-08-08) — bounded shipping-first cycle

Fix only the confirmed Codex bridge producer gap: a run can retain a stale
`manifest.codexThreadId` after the live Codex seat re-threads, and a failed
app-server delivery attempt leaves the message pending without a durable exact
failure reason.

Live UAT is primary evidence. Run 46's manifest records
`019fe333-f4fb-74e2-ab79-2e065999c825`, while its run-scoped Codex history
records this session's bootstrap prompt under
`019fe333-f715-7520-a79c-cf62b26d9636`. The current producer reads only the
manifest ID in `bridge-store.ts`, passes it to `injectCodexMessage` in
`bridge-runtime.ts`, and catches every thrown delivery error as bare `false`.

Smallest patch: preserve pending semantics and tmux fallback, but append one
typed, non-terminal bridge attempt event linked to the message ID. Record exact
thrown errors and fixed `codex app-server rejected injection` for non-throwing
false refusal. Extend the existing retry test only. No runtime seat repair,
manifest refresh, silent-misdelivery fix, transport matrix, dependency change,
install, push, merge, or other backlog item.

Acceptance: affected focused test, build/type smoke, one focused happy-path
smoke, `git diff --check`, native zero-write Claude PASS, passing
`runs/d007-mid-run-delivery/eval.json`, and one scoped commit. Stop after commit
for root independent review.

The charter-named defect Markdown is absent from the working tree and all local
Git refs. Nanny task `7b20e433-c9c6-44d6-a7cb-3f6c670b1194` independently
confirmed absence. Claude review `a5aa2651-f977-433d-a094-e63642c5db46`
accepted an explicit waiver to proceed on the charter text without creating a
defect document or specs bundle, and returned REVISE on the false-refusal path.
That bounded finding is now patched.

### Fresh-loop handover

Preserve five modified files without staging or committing:

- `loop-fork/src/loop/bridge-store.ts` adds typed, non-terminal,
  duplicate-suppressed `delivery-failed` events while preserving pending state.
  SHA-256: `2e8b865d76b9bde4cbfbe597d8ea109474dfddb733ee6e3659bfabf13d3eb290`.
- `loop-fork/src/loop/bridge-runtime.ts` records exact thrown reasons and a
  fixed reason for non-throwing refusal. SHA-256:
  `1a5cd659b44fc5bc589a1c58e0b6d63fe991c287f6c33933ebe71d9613a136c5`.
- `loop-fork/tests/loop/bridge.test.ts` extends the existing retry test across
  throw, false refusal, and eventual success. SHA-256:
  `12a531c4a283158d5f597574b0877e47be8451fcf92de3cb7ba5c259ace45791`.
- `PLAN.md` and `status.md` contain required session continuity only.

Checks complete: focused defect 1 pass/0 fail; focused happy path 1/0; affected
two-module Bun build passed; scoped TypeScript passed using the existing
read-only dependency tree at
`/private/tmp/agents-collab-main-readme/loop-fork/node_modules`; `git diff
--check` passed. Full product build and full bridge suite are baseline-blocked
by this worktree's absent dependencies; the bridge suite reached 65 pass and
43 child-process failures because child processes could not inherit the
external preload.

Post-correction checks: focused regression 1/0 with 5 expectations; focused
happy path 1/0 with 4 expectations; affected two-module build passed; scoped
TypeScript passed; `git diff --check` passed. Native zero-write review
`cd81ba6b-4b67-40b8-b643-248802a137ef` returned PASS on all five reviewed
paths and independently reproduced all checks plus two negative controls. Final
bounded action: write `runs/d007-mid-run-delivery/eval.json`, commit the explicit
scoped paths once, and stop for root independent review.

---

# Prior task history — D-001 Governess handover launch order

## Run 42 (2026-08-08) — bounded v1.0.35 fix

Fix only the confirmed handover reservation-order defect. Runs 14-32 and 34-37
each contain two validated bundles followed by the same self-conflict: the
replacement launcher sees the live predecessor manifest as owner of the same
workspace. Current `defaultGovernessDeps.launchReplacementLoop` spawns before
`stopGovernessLoop` marks the predecessor terminal, and launch reservation
correctly treats any manifest with a live `tmuxSession` as owning.

Smallest change: after validating the handoff manifest and before spawning the
replacement, atomically persist the predecessor as stopped and remove only its
active `tmuxSession` target. A configured manifest that cannot be read or
persisted fails closed before spawn. Preserve validated handoff files, dirty
worktree bytes, socket files, all unrelated run metadata, lanes, and processes.

Add exactly one regression in `governess-exit.test.ts` that observes the
predecessor release before the spawn callback and checks the real
`manifestCanStillOwnWorkspace` producer returns false. Verify the named test,
the full focused Governess-exit suite, scoped type/build/check smoke, and one
producer-backed handoff smoke. Then obtain Claude zero-write concrete-diff
review, write `runs/d001-governess-handover/eval.json`, commit once, and stop
for independent root review.

---

# Prior session history — tmux socket normalization

## Run 38 (2026-08-08) — V5-R1 DECLARATION PASS; NO IMPLEMENTATION

The first high-risk declaration received Claude zero-write REVISE
`d83fd1e4-c01d-4f1c-a79f-752b14c20fe9` because six-site migration cannot close
the broader verify-8/10 consumer matrix. Corrected V5-R1 explicitly defines the
ten-file slice as a prerequisite only, leaves verify 10 open, closes no task
checkbox, and received zero-write PASS
`7125b3a9-090c-41f0-aeb9-fe0362ce58ee`. No source/test implementation began.

V5-R1 atomically covers only the six named literal-dead producers in bridge
status, Governess doctor, the two launch-reservation interlocks, proxy stop
reasoning, and paired-options persisted tmux reuse. Outstanding later work
remains tmux launch/resume/attach; both tmux-control readers; bridge
capture/send/buffer and remaining BridgeStatus consumer coverage; both GC
paths; panel enumeration; governess-pane-liveness; Governess pane effects; and
Governess handover. A V5-R1 PASS must never be described as verify-10 closure.

The exact ten preimages and no-partial-apply boundary are PASS-bound. Immediately
before any future source/test edit, rehash all ten; any mismatch restarts review.
After implementation, republish command-12 entries 4, 5, and 9 because proxy
source/test and paired-options source will supersede their prior values. The
prior fourteen-file PASS remains valid only for its exact bytes; V5-R1 will
modify eight of those fourteen. The exact six preserved postimages to rehash are
`tmux.ts`, `tmux.test.ts`, `governess.ts`, `governess-exit.test.ts`,
`governess-exit.ts`, and `tmux-socket.test.ts` at their current PASSed hashes.

Intentional operational consequence: an inactive no-session legacy manifest
with unknown target remains owning/conflicting and can permanently block launch
with no recovery path. This follows the founder-approved Gate 2 direction
`approved — fail closed, no recovery. proceed to T-00`; it is intended, not a
new defect.

## Run 38 (2026-08-08) — SCOPED ROOT TECHNICAL PASS; RELEASE CLOSED

Harness-owner root review independently PASSed only the combined V4 + V4-A +
V4-B-R1 fourteen-file slice. Peer PASS is
`8dae02e3-d70e-48f1-a237-d752f26d0e1c`; root independently rederived all
fourteen hashes, HEAD `fe44f280c4a21e840e586f0f9d8098c865ed0d62`, empty
index, clean diff check, exact 21-entry porcelain, six frozen hashes, exact spec
bundle hashes, 354/0 supported focused tests, 845-file whole-tree check, scoped
TypeScript, fourteen-path Biome, five old-API hits, six protected producers,
and the V4-B-R1 negative control. Root review wrote zero repository bytes.

This is not a release PASS. `runs/tmux-socket-normalization/eval.json` is absent;
only T-00 is checked while T-01 through T-18 remain unchecked; verify 10 is
open; criterion 11 is attestation-only; and full build, `test:ci`, smokes,
governed verify, two-server certification, installed-binary check, eval, and
final live audit remain uncertified. No stage, commit, merge, install, or
release claim is authorized.

Next bounded slice is planning/review only: rederive all six verify-10 producers
and owning tests from current source and approved spec text, freeze exact
preimages, declare one no-partial-apply high-risk slice with named per-site
unknown-target regressions and structured skip-record evidence, then obtain
Claude zero-write PASS or REVISE before any source/test edit. Preserve every
PASSed postimage and all named invariants; continue T-01 through T-18 in
dependency order only after this slice.

Harness-owner resolution 1 is complete through local proof. Declaration V4's
eleven postimages remain byte-identical. V4-A changed only the three authorized
diagnostic-bearing paths after Claude zero-write PASS
`ae4c524c-c7dc-4770-a88e-4c76f90f1877`; V4-B-R1 changed only the stale
`launchServerArgv` inventory/qualification guard after Claude zero-write PASS
`e6497e50-3de8-453b-93b8-57faf6088d09`. No fourth source/test path changed.

All seven focused suites now pass with 354 tests and zero failures: proxy 30,
tmux-socket 45, tmux 106, bridge 108, governess-exit 33,
governess-runtime 14, and launch-reservation 18. Exact fourteen-path Biome
passes. Mandatory whole-tree `bun run check` checks 845 files with zero
diagnostics. Exact command 7 exits zero. `git diff --check`, the five-hit
old-API inventory, the six protected-producer comparison, all hashes, and the
exact 21-entry porcelain boundary pass.

Standing proof rule: a guard test for any module in a change's write scope must
be included in that change's focused proof set. V4's original five-suite set
omitted both `tests/loop/tmux-socket.test.ts` and
`tests/loop/codex-tmux-proxy.test.ts`; that omission allowed the stale
composer-count assertion to survive and made withheld-PASS verdict
`68f3ae2a-fd60-4719-90bd-68029db23e62` incomplete. Both suites are now
permanent members of this candidate's proof set.

Current amended command-12 hashes are proxy source
`8e163f2a4b072cb49b37f1abd78a7e62e9ec52a1526ebde35228803af47781e4`,
proxy test
`0897bf9eedd7fe5a855163fea2f228518f038188022fc60d541d3ba12124ea22`,
and tmux-socket test
`320877af1ddfbfa36e360e640a3e0474961f6f06591a45b98bfbe381ad011734`.
The other six command-12 hashes and all eleven V4 hashes remain frozen exactly.

Claude native zero-write exact-postimage verdict
`8dae02e3-d70e-48f1-a237-d752f26d0e1c` is PASS on the combined fourteen-file
candidate after independent hashes and proof reruns. No product-supervisor
release gate exists. Do not stage, commit, merge, install, close verify 10,
touch backlog, or use the forbidden artifact.

## Run 38 (2026-08-08) — V4-A PLANNING RECORD (SUPERSEDED)

Objective: complete the exact atomic eleven-file Declaration V4 slice authorized
by request `1bca0a82-0710-40bb-9d71-09803dfa1e56` and PASS
`03838bd5-d78a-43bb-ac33-62e870938af2`, preserve all nine frozen files and the
exact 21-entry dirty boundary, then obtain Claude's zero-write postimage verdict.

Implementation is complete in the declared source/test scope. Non-paired tmux
handoff probes, remain-on-exit, gone re-probes, and attach now retain the one
resolved launch socket while paired argv remains socketless. Paired launch emits
the exact JSON manifest-path line. Bridge, Governess replacement launch/restart,
replay, and launch reservation now derive liveness authority from persisted
manifest handles. Replacement identity persists both session and manifest path;
the launcher uses exactly five reads/four 50 ms waits and distinguishes
not-ready, dead, and unknown. B6/B7 preserve undefined-target unknown semantics;
B7 unknown now throws before either option or manifest mutation.

Exact focused proofs pass: tmux 106/0, bridge 108/0, governess-exit 33/0,
governess-runtime 14/0, launch-reservation 18/0. The exact TypeScript command,
five-hit old-API inventory, `git diff --check`, nine frozen hashes, and exact
21-entry status boundary pass. All eleven write-scope files pass scoped Biome.

Blocker: exact command 6, `cd loop-fork && bun run check`, exits 1 only in three
frozen paths already pinned by V4: `codex-tmux-proxy.ts`, its test, and
`tmux-socket.test.ts`. Their hashes still match command 12 exactly; changing them
would violate the declaration, while `verify.md` line 8 forbids tolerating a
pre-existing failure. No V4 write-scope path controls Biome or the check script.
Claude independently reproduced all hashes, focused suites, inventory,
porcelain, and the eight strictly intra-file frozen diagnostics. Final verdict
`68f3ae2a-fd60-4719-90bd-68029db23e62` is **PASS WITHHELD**, explicitly not
REVISE: no implementation defect exists, but only the harness owner can repair
the declaration. Exact command 7 is the scoped two-root `bunx tsc ... src/cli.ts
src/loop/caveman-skill.d.ts` command and exits 0. Claude's whole-project tsc
findings, including displaced pre-existing lines in `launch-reservation.ts`, are
recorded as non-blocking debt, not command-7 evidence.

Harness-owner ruling `69c74846-0c82-4d3e-a213-20b710e3b0fe` selects resolution
1: unfreeze exactly the three diagnostic-bearing files for lint-only repair
while preserving mandatory whole-tree command 6. Repo-wide `bun run fix` and
`ultracite fix` are expressly prohibited; direct Biome use must name only the
three paths. All
eleven V4 postimages and nine current command-12 hashes were frozen again. Exact
command 6 reproduces exactly eight diagnostics: four in proxy source, two in its
test, and two in `tmux-socket.test.ts`; no others exist. Self-contained V4-A
declaration `8e357c9b-0dd4-4c47-98d5-48be0cb75492` specifies one-to-one mechanical
repairs, C1/six-producer preservation, exact preimages, post-edit hash
republication, fourteen-file diff boundary, and complete proofs. No source/test
edit may begin until Claude returns explicit PASS. Claude PASS
`b6312267-a00b-4860-9f2e-7951247a71a2` is now binding with two corrections:
the `collectTsFiles` rewrite must preserve the full
`entry.isFile() && entry.name.endsWith(".ts")` predicate, and direct scoped Biome
must be reported separately from authoritative whole-tree Ultracite command 6.
No staging, commit, remote, release, verify-10 closure, backlog mutation, or
forbidden-artifact access is authorized.

## Run 37 (2026-08-08) — V4 CONTINUATION VALIDATED; SOURCE STEP DEFERRED

Objective remains the exact eleven-file Declaration V4 slice from request
`1bca0a82-0710-40bb-9d71-09803dfa1e56`, authorized by Claude PASS
`03838bd5-d78a-43bb-ac33-62e870938af2`, followed by exact proof commands 1-13
and a separate Claude zero-write exact-postimage verdict.

Run-37 continuation gate passed before any source/test edit. Launch charter
SHA-256 matched
`9a59223f3983c4cef7c15d0edd93234265ffb0c8e42a15d1a2219b79a9d3c488`.
The complete Run-36 handoff at epoch `1786205616368960` was read and validated:
`codex.json`
`db838ed4d45f55326ad02a94c5d9583a395967498bde8b52f8828349ae512f8a`,
`claude.json`
`d229a1ec7cf99f4129225e50e645ea5bb632aa9ec7f24f7582e109dac1387300`,
and `continuation.md`
`eb04308d710193e4745251dd2dac769f55a3632c173faf4cfbf7a6a683e7fb3f`
matched `manifest.json`. Both bundles are exact nine-key `ready` objects for
the same epoch and HEAD. Run-36 `transcript.jsonl` was inspected completely.

Inherited final docs matched `PLAN.md`
`4068987a31ec35c2bb34764fe0bb635fe5064eae62c4c15a9dfcff2033857151`
and `status.md`
`5ef0014bd5595a18adcefbfb90787f5390caade40ba829fe1c55bfa84371326f`.
World Model bootstrap bytes matched
`e405fdb2dcbcb037d52857edb5d42cd71ec903a418d7f71ad9803c8dc871b74b`,
embedded capsule SHA-256 matched
`54490c7ef56c4ac9d04e6cf4f18f337659d39b80dbe2b61b1a20c912387ebb38`,
all indexed commit bindings were
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`, and live HEAD matched.
The statement-limited capsule has no top-level repository-commit field and was
not used as continuity authority; validated handoff bytes plus native Git
supplied that binding.

Exact V4 request and bound PASS were recovered in full from Run-34
`bridge.jsonl`. Native porcelain matched the inherited exact 14-entry baseline,
the index was empty, and `git diff --check` passed. All eleven V4 write-scope
preimages and all nine frozen hashes matched Declaration V4 exactly. Three
bounded source/test edit packets were routed before code authoring:
`c9b44603-1eab-403f-8b62-db6c8edea936`,
`0c95289e-b97e-4c34-87d0-ea5617c99737`, and
`7ad7a92a-611c-4156-8c3f-1858581c3eb8`; all returned `risk-not-low` to the
driver with no patch, artifact, or remaining write reservation. Target source
interfaces and call sites were inspected, but no implementation patch started.

Governess decision `e15477c4-99e0-474d-ab81-13a3584f7131` reached the fresh-loop
preparation threshold before the atomic source step and forbids starting that
broad slice in this loop. Run 37 therefore changes only `PLAN.md` and
`status.md`; no source/test edit, partial apply, proof command 1-13, stage,
commit, push, merge, PR, deploy, release, install, dependency/backlog/product
mutation, verify-10 closure, criterion-11 promotion, or forbidden-artifact
access occurred.

Risks: V4 remains a risk-high atomic cascade. Partial application could contact
the wrong tmux server, accept unknown liveness as authority, lose durable
replacement identity, invert reservation authority, or alter paired argv.
Implementation authority expires on any guarded preimage drift. Optional
`replacementManifestPath` must be explicitly narrowed; never coerce absence
with `?? ""`. Routed status/search evidence remains non-authoritative because
prior helper output omitted or truncated entries; native evidence controls.

Fresh-loop next bounded action: validate the Run-37 handoff and final doc
postimages, rehash all twenty guarded files immediately before the first edit,
require exact V4 preimages, then implement the complete eleven-file slice
atomically. Preserve five reads/four 50 ms sleeps, B6/B7 stored-session
ternaries and undefined-target semantics, six protected producers, paired argv
invariance, unrelated dirty bytes, open verify 10, and criterion 11 as
Codex-attestation-only. Run exact proof commands 1-13, compute postimages, and
request Claude zero-write exact-postimage PASS or REVISE.

## Run 36 (2026-08-08) — V4 CONTINUATION REVALIDATED; IMPLEMENTATION DEFERRED

Objective remains unchanged: implement the exact eleven-file Declaration V4
slice from request `1bca0a82-0710-40bb-9d71-09803dfa1e56`, authorized by
Claude PASS `03838bd5-d78a-43bb-ac33-62e870938af2`, then run exact proof
commands 1-13 and obtain a separate Claude zero-write exact-postimage verdict.

Run-36 continuation gate passed before any source/test edit. Launch charter
SHA-256 matched
`64554e9ada6ba490bdb0a0cd9407f955a5254b4611b21f001484a44a34316313`.
The complete accepted Run-35 handoff bundle at epoch `1786204357097144` was
read and validated: `codex.json`
`f5bd085e347275d057339551769749532e45f0781ac43e3af7d7860c437cf816`,
`claude.json`
`fe1b9f96554cea2a40d77e47c0bfe6b0aa0631c2a24ffb4e00d21b91cbbf7126`,
and `continuation.md`
`6e64d74b29910b03954794069f021e67c09a0414cd9602b3f92cbb1773a11ba4`
matched `manifest.json`; `acceptance.json` binds that manifest digest to this
replacement session. Prior Run-35 `transcript.jsonl` was inspected completely.

Run-35 final docs matched their published postimages: `PLAN.md`
`9cb1ec6de78fd790ddb574e11455a42460147631e4fa81acac57bc514e2f25b4`
and `status.md`
`064043a3f120620880a84dbb20294ff0c72d4dba51fe1f63390197fe62c3a451`.
World Model bootstrap bytes matched
`e405fdb2dcbcb037d52857edb5d42cd71ec903a418d7f71ad9803c8dc871b74b`,
embedded capsule SHA-256 matched
`54490c7ef56c4ac9d04e6cf4f18f337659d39b80dbe2b61b1a20c912387ebb38`,
and live HEAD matched
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`.

Exact V4 request and its bound PASS were recovered from Run-34
`bridge.jsonl`. Live porcelain matched the inherited exact 14-entry baseline;
the index was empty; `git diff --check` passed. All eleven V4 write-scope
preimages and all nine frozen hashes matched Declaration V4 exactly. Relevant
feature spec, plan, task, and verify contracts were re-read, and existing dirty
diffs plus target call sites were inspected. No implementation patch was
started.

Governess decision `c2c69b05-3c45-4cca-817d-71ee49135d30` reached the fresh-loop
preparation threshold before the atomic source step and forbids starting that
broad slice in this loop. Run 36 therefore changes only `PLAN.md` and
`status.md`; no source/test edit, partial apply, proof command 1-13, stage,
commit, push, merge, PR, deploy, release, install, backlog/product mutation,
verify-10 closure, criterion-11 promotion, or forbidden-artifact access
occurred.

Risks: V4 remains a risk-high atomic cascade; partial application could contact
the wrong tmux server, grant authority from unknown liveness, lose durable
replacement identity, or change paired argv. Implementation authority expires
on any of the twenty guarded preimage drifts. Helper git-status packet output
may omit untracked entries; Run-36 baseline evidence therefore comes from the
native full `git status --porcelain=v1` listing, which returned all 14 expected
entries including `specs/tmux-socket-normalization/`.

Fresh-loop next bounded action: validate the Run-36 handoff and final doc
postimages, rehash all eleven write files and nine frozen files immediately
before the first edit, require exact V4 preimages, then implement the complete
eleven-file slice atomically. Preserve explicit optional
`replacementManifestPath` narrowing, five reads/four 50 ms sleeps, B6/B7
stored-session ternaries and undefined-target semantics, six protected
producers, paired argv invariance, unrelated dirty bytes, open verify 10, and
criterion 11 as Codex-attestation-only. After implementation, run proof
commands 1-13, compute postimages, and request Claude zero-write exact-postimage
PASS or REVISE.

## Run 35 (2026-08-08) — IMPLEMENT DECLARATION V4 AFTER LATER PASS

Objective: implement the exact eleven-file Declaration V4 slice from bridge
request `1bca0a82-0710-40bb-9d71-09803dfa1e56`, authorized by Claude's later
zero-write PASS `03838bd5-d78a-43bb-ac33-62e870938af2`, then run exact proof
commands 1-13 and obtain a separate Claude zero-write exact-postimage verdict.

Pre-edit gate passed. Run-34 `codex.json` and `claude.json` matched their
declared SHA-256 values and parsed as exact nine-key `ready` objects for epoch
`1786202950621399` at HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`. The complete V4 request and PASS
bodies were recovered from Run-34 `bridge.jsonl`; the PASS record has
`replyTo: 1bca0a82-0710-40bb-9d71-09803dfa1e56` and supersedes the stale
bundle narrative that no verdict existed. Live HEAD, exact 14-entry porcelain
inventory, empty index, `git diff --check`, all eleven write-scope hashes, all
nine frozen hashes, and final Run-34 docs matched exactly before this update.

Implement atomically inside only the eleven V4 paths. Preserve the three
intentional changes, Option A identity chain, five-read/four-delay bounded
race, exact old-API inventory, B6/B7 stored-session ternaries and undefined
target semantics, six protected producers, paired argv invariance, unrelated
dirty bytes, open verify 10, and criterion 11 as Codex-attestation-only.
Explicitly narrow optional `replacementManifestPath` before calling
`replacementSessionAlive`; never coerce absence with `?? ""`. A missing path
must enter the declared launch-error path.

Non-blocking observations recorded without reopening the gate: Run-34 doc
mtimes followed the V4 send despite the prior-update narrative, and Run-33 has
contested final-doc claims. Neither narrative is implementation authority;
exact V4 plus its later PASS are authoritative for this slice.

Verification: exact V4 proof commands 1-13, postimage SHA-256 for all eleven
write files, unchanged SHA-256 for all nine frozen files, exact 21-entry status,
then Claude native zero-write PASS or REVISE on complete diff and evidence. No
stage, commit, push, merge, deploy, release, install, backlog mutation,
verify-10 closure, or forbidden-artifact use.

Preparation-threshold handover: Governess decision
`adeb5361-6c32-4c23-8ee6-de606ac3cec6` arrived before the eleven-file source
step began and requires a fresh loop rather than another broad slice. Run 35
therefore stops after the continuation gate and documentation update. Exact
Run-35 changed scope is only `PLAN.md` and `status.md`; no source/test file was
edited, no proof command 1-13 ran, and no helper patch exists. Six exact edit
packets were routed and all returned `risk-not-low` to the driver, leaving no
reserved write scope. Two external Run-34 evidence audits returned
`protected-scope`; their claims were independently rederived natively.

Fresh-loop next bounded action: re-read this Run-35 handoff, rehash all eleven
V4 write files and nine frozen files again immediately before the first edit,
require exact V4 preimages, then perform the complete atomic eleven-file slice.
Do not treat this preparation handoff as a new review gate: exact V4 PASS
`03838bd5-d78a-43bb-ac33-62e870938af2` remains bound to request
`1bca0a82-0710-40bb-9d71-09803dfa1e56` while all twenty hashes match.

## Run 34 (2026-08-08) — DECLARATION V4 REVIEW ONLY; IMPLEMENTATION CLOSED

Objective: issue one self-contained risk-high Declaration V4 that closes V2
REVISE `9f0d802f-ea41-40d6-a229-03ae73a2f4fc` and all three V3 REVISE
`d9e75210-830b-4af2-a2c2-9fa8600c4a13` blockers, then obtain Claude zero-write
PASS or REVISE. Governess decision `cb3aa86f-5905-442e-aed5-99abbcfd83de`
requires fresh-loop handover after this atomic review step; no source/test
implementation may start in Run 34 even if V4 passes.

Validated exact Run-33 continuation: both epoch `1786201567205832` nine-key
`ready` bundles and their requested hashes; HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`; inherited `PLAN.md`
`b2d559d60564fd5b666e3315e9a1105b7762093681f7d599e8d7b9226acceb83`;
inherited `status.md`
`823990e5c417d7cf87e93c51f9bbf45e3dcb47d14bd660399d9ba2fbe7f534c4`;
exact 14-entry porcelain inventory; and clean `git diff --check`. Recovered
complete durable bodies for Option A relay
`2d0d5fe1-395c-42bf-8844-9254c06bd055`, V2 REVISE, V3 request
`074bb791-5dff-44e1-a76b-dd2fb080521c`, and V3 REVISE from exact Run-32/33
bridge journals. Forbidden artifact remained unopened and unused.

All eleven V4 write-scope and nine frozen hashes matched immediately before the
first V4 send attempt. That attempt failed locally before bridge delivery
because message construction evaluated the literal
`${JSON.stringify(manifestPath)}`; no repository or bridge write occurred.
Before corrected delivery, rehash all twenty again. Correct authority wording:
standing human authority is approval Gate 2; `2d0d5fe1` is Claude's durable
relay of the human Option A selection, not a root-signed envelope.

V4 remains exactly eleven source/test files, risk high, atomic/no-partial-apply.
It must preserve all V3 requirements; pin both launch-reservation ternary
conditions to stored `tmuxSession`; add both undefined-target regressions;
enumerate six call removals plus four value-import removals; freeze nine files;
and require exact post-slice porcelain inventory. Next bounded action: rehash,
send corrected V4, obtain explicit zero-write PASS or REVISE, then hand off.

Corrected V4 was delivered as bridge request
`1bca0a82-0710-40bb-9d71-09803dfa1e56` after a second exact twenty-file hash
gate. Claude's handover crossed that delivery: Claude bundle message
`a0d1502c-dfc4-426f-bcc0-5b50184eda60` says V4 was unauthored from Claude's
view and exits without a verdict. Therefore V4 has no PASS or REVISE and grants
no implementation authority. Fresh loop must recover the exact request body,
rehash all twenty files, and obtain Claude zero-write PASS or REVISE before any
source/test edit. Do not resend or implement from this summary.

## Run 33 (2026-08-08) — DECLARATION V3 REVIEWED: REVISE; NO IMPLEMENTATION

Root authorized Option A for V3. Run 32 continuation was validated before use:
`codex.json`
`fdfbda5e03d23a83a649da3bda098336f7f283180000316e8a17526516cdb954`
and `claude.json`
`6d7436f8748b535e3c9527dc4292cf65cdb3e20d19acda3a7a51c51f9be1db10`
were exact nine-key `ready` objects for epoch `1786199976864679` at
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`. Inherited final docs were
recomputed and matched `PLAN.md`
`1640281ccf4e1773df2c064450df3b45638602cee19b13aea924a3b93620c276`
and `status.md`
`77f32ee7ee01df62e6092a2225a97f9b33a1106578d34c4dbce90c481c0ceb83`.
World Model file hash, logical capsule SHA, and every indexed repository
`commitSha` also matched the Run-33 charter values.

Recovered exact durable records from Run-32 `bridge.jsonl`: Claude REVISE
`9f0d802f-ea41-40d6-a229-03ae73a2f4fc` blocks V2; Option A decision
`2d0d5fe1-395c-42bf-8844-9254c06bd055` authorizes an eleven-file V3 adding
only `loop-fork/src/loop/governess-exit.ts`. The forbidden artifact was not
opened or used.

Exact risk-high Declaration V3 was sent for Claude zero-write review as bridge
request `074bb791-5dff-44e1-a76b-dd2fb080521c`, with follow-up nudge
`19c0c05d-545c-4753-a778-c5820fbaa317`. No PASS or REVISE arrived before
Governess preparation decision `18b20bd2-86f7-468d-aa00-30e4d731a2ee`.
The declaration is self-contained and binds Option A's paired manifest-path
stdout contract, sibling parser, persisted `replacementManifestPath`, explicit
pre-existing-state failure, deliberate replay non-use, B4 `(session,
manifestPath)` probes, five-attempt/four-delay first-probe race handling, three
intentional changes, named regressions, all V2-preserved semantics, and amended
proof command 11. Proof commands 8 and 12 remain unchanged.

All eleven live write-scope preimages matched immediately before sending V3:

1. `loop-fork/src/loop/tmux.ts` — `ccba303ca1f72cbd7e4851e8a64978e4e1e3aa02ce3820b610de9e7e9b36cc14`
2. `loop-fork/tests/loop/tmux.test.ts` — `6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20`
3. `loop-fork/src/loop/bridge-runtime.ts` — `80da0a08db4646100383075debed43aaca27f879d2fc64899cb8f3fa97ce6610`
4. `loop-fork/tests/loop/bridge.test.ts` — `f13e5a70d43a094cc3451abd05bf7f56a358bacbbf1dcbea50eb032041c1facf`
5. `loop-fork/src/loop/governess.ts` — `f66230f454c1cf447af398018c497a63be356b00389be8a9132ffe338496bd3c`
6. `loop-fork/tests/loop/governess-exit.test.ts` — `afb7af8fc97872775745ee021c69388cd1da984c6aa8f129ddbc23ac436603f5`
7. `loop-fork/src/loop/governess-replay.ts` — `73a3f31bc4ed1fc2eec8981bd504c6a1508ebeea3c5a36e169abe38e55dff7f9`
8. `loop-fork/tests/loop/governess-runtime.test.ts` — `35fd448af45f91815a16ac829d9019d63038ffe97d0027dc90fffa4ffe7f1991`
9. `loop-fork/src/loop/launch-reservation.ts` — `543fc32c1b7e7bef549f8844154bc5e7d2fcb3d2b919fceb5d16159751218a27`
10. `loop-fork/tests/loop/launch-reservation.test.ts` — `865a8c2cd8023d54bf5befe33f79520bd72155e3a7701dc286142072ef567528`
11. `loop-fork/src/loop/governess-exit.ts` — `0bdc21256973386a1911f269a9a40b6a449acb0d1068afe37cec8919b3707b33`

Five frozen hashes matched: `tmux-control.ts`
`138ea1a5524ceb8c2091e28361f051ebfee7473189d9612b7d32de9ea9a6484c`,
`tmux-socket.ts`
`cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`,
`run-state.ts`
`60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`,
`codex-tmux-proxy.ts`
`2a41aa89e09a75c6a6c366a1b4f0f1faa018416d311d99f12aa85ca6192ecb6c`,
and `codex-tmux-proxy.test.ts`
`6993d5bc3b89a3f71bc6d946dced60c84302f4c94a92466d9a291c668ad7602b`.
`governess-exit.ts` had zero old-API hits before declaration, preserving proof
command 8's exact five-hit inventory.

No source/test edit or proof command 1-12 ran. V2 and V3 remain prohibited.
Fresh-loop action is Declaration V4 under the zero-write REVISE recorded below,
not implementation. Rehash all eleven write-scope and nine frozen files before
V4; fail closed on drift. Obtain Claude PASS on V4, then rehash again before
the atomic eleven-file implementation. Do not stage, commit, push, merge,
deploy, release, install, touch backlog, close verify 10, or promote criterion
11 beyond Codex attestation.

### Claude zero-write verdict on V3 — REVISE (2026-08-08)

Verdict delivered as bridge message `d9e75210-830b-4af2-a2c2-9fa8600c4a13`,
replying to `074bb791-5dff-44e1-a76b-dd2fb080521c`. Zero writes to source or
test files by Claude. Implementation stays closed until a V4 PASS.

Independently re-verified clean at review time, all matching the declaration:
all eleven write-scope preimages, all five frozen hashes, and the six protected
producers at `launch-reservation.ts:121`, `launch-reservation.ts:224`,
`bridge-runtime.ts:1105`, `governess-replay.ts:326`, `codex-tmux-proxy.ts:388`,
`paired-options.ts:75`. Target API confirmed present: `tmux-control.ts:140`
`tmuxTargetLiveness`, `tmux-control.ts:169` `tmuxTargetLivenessAsync`,
`tmux-socket.ts:424` `targetFromManifest`, `run-state.ts:1230`
`readRunManifestHandle`. Stdout contract confirmed viable: `tmux.ts:4047` emits
through `deps.log`, wired at `tmux.ts:3803-3805` as `console.log(line)` —
unprefixed, stdout, line-start — and captured at `governess.ts:6454` with
`stdout: "pipe"`, decoded at `governess.ts:6464`, so the anchored sibling regex
matches. Intentional change 1 confirmed as a real behavior change:
`governess.ts:6485-6491` currently rejects only `"dead"`, so `"unknown"` accepts
and grants handover today.

Three blockers, all requiring a Declaration V4:

1. **B6/B7 ternary condition unpinned; fail-open the frozen line hides.**
   `launch-reservation.ts:119-121` and `:222-224` read
   `manifest.tmuxSession ? await deps.tmuxLiveness(...) : "dead"`. V3 freezes
   lines 121/224 but leaves the condition on 120/223 inside the migration and
   unpinned. Migrating that condition to `target ?` flips a manifest that has a
   `tmuxSession` but no usable target from a real probe to literal `"dead"`,
   granting cleanup and launch authority over a possibly-live run, while the
   protected producer stays byte-identical and proof commands 9 and 11 both look
   clean. `tmux-control.ts:136-146` states the opposite invariant verbatim: an
   unusable target is `"unknown"`, never `"dead"`, because `"dead"` grants
   cleanup authority and an absent target is not evidence a run stopped
   (verify 10). Under the approved fail-closed legacy-manifest policy this is the
   production population. V4 must pin the condition to the manifest's own
   `tmuxSession` field and add a named regression at **both** B6 and B7 for a
   manifest with a `tmuxSession` but a legacy/unusable target. The existing B7
   unknown regression is a different input: a probe that returns `"unknown"`, not
   an undefined target before any probe runs.

2. **Proof command 8 unreachable from the declared edit list.** Baseline
   `rg -n 'tmuxSessionLiveness(Async)?' src/loop` is 15 hits; 5 are retained, so
   10 must go. V3 enumerates 6 and says "migrate exactly". The four unlisted
   import sites are `launch-reservation.ts:21`, `bridge-runtime.ts:57`,
   `governess.ts:157`, `governess-replay.ts:27`. `launch-reservation.ts:21` must
   keep `type TmuxLiveness` and swap only the value import.

3. **No proof command bounds the modified-file set.** Command 11 diffs only the
   eleven declared paths and cannot see a twelfth file change; command 12 pins
   five files. Four subsystem files are pinned by nothing:
   `tests/loop/tmux-control.test.ts`
   `3e87a72d210f831c8a52b7e42c91c72fad33d1c13c658f6b4001f727cf2d1c30`,
   `tests/loop/run-state.test.ts`
   `546ecf48b755e150b469df2d03db56a30c5ba8821cf70610d7001c3ac76087c3`,
   `tests/loop/tmux-socket.test.ts`
   `67f4775c27be38515ae837f1687c48f7d676684c407ee7ae085fd01f0b7db889`, and
   `src/loop/paired-options.ts`
   `6c25b857d73f45d0270c3f6e8f1418cc447862eda54004c35a360d6753fdc56f`.
   `paired-options.ts` is clean today, explicitly out-of-slice, and holds 2 of
   the 5 retained hits plus protected producer `:75`; it belongs in the frozen
   list. Add a `git status --porcelain` command requiring the recorded
   pre-implementation inventory.

Non-blocking: seven of the eleven write-scope files are clean in the working
tree — `bridge-runtime.ts`, `bridge.test.ts`, `governess.ts`,
`governess-exit.test.ts`, `governess-replay.ts`, `governess-runtime.test.ts`,
`governess-exit.ts` — so command 11 is a pure view of this slice for those.
Only `tmux.ts`, `tmux.test.ts`, `launch-reservation.ts`, and
`launch-reservation.test.ts` mix pre-existing dirty bytes; V4 should say so.

V2-closure question resolved from this repository's own record, not from
assertion: the Run-32 section of `status.md` documents REVISE
`9f0d802f-ea41-40d6-a229-03ae73a2f4fc` as finding V2 B3/B4 unimplementable
because the replacement manifest path was neither reported nor persisted,
`resolveExistingRunId` never matches `manifest.tmuxSession`, and the only
enumeration primitive is private in frozen `run-state.ts`. V3's Option A
mechanism — paired stdout manifest-path contract, sibling parser, persisted
`replacementManifestPath`, and an explicit ban on `resolveExistingRunId` and any
scan — addresses each of those. That part of the authorization chain is
discharged; the three blockers above are independent of it.

## Run 32 (2026-08-08) — BLOCKED: V3 DECLARATION REQUIRED

**Do not implement V2.** Claude REVISE
`9f0d802f-ea41-40d6-a229-03ae73a2f4fc` supersedes the earlier
implementation-ready reading of PASS
`28bfdf88-6a33-4145-afea-345987936ec6`. V2 B3/B4 is not implementable inside
the declared ten-file scope.

The replacement launcher reports only a tmux session. The old-run
`GovernessHandoffManifest` is not a `RunManifest`,
`resolveExistingRunId` does not compare `manifest.tmuxSession`, and no
replacement manifest path is persisted for B4 after restart. A local manifest
scan is both ambiguous and unbuildable in scope: its only enumeration primitive,
private `readStoredRunIds` in frozen `run-state.ts`, is unavailable without
voiding proof command 12.

V3 direction requires human authority before source/test work:

- Option A (Claude recommendation): emit and parse the replacement run manifest
  path, add `src/loop/governess-exit.ts` to write scope, persist
  `replacementManifestPath`, and declare bounded handling plus a named test for
  the first-probe manifest race.
- Option B: retain ten-file scope but narrow B4 so only B3 uses launch-time
  manifest identity; this changes the accepted declaration requirement.
- Option C, exporting a session resolver from frozen `run-state.ts`, is
  rejected because it voids the frozen hash and proof command 12.

No option is authorized by the current human scope. Wait for the human's V3
choice and a new Claude PASS before implementation.

### Run-32 guard evidence

Run-31 `codex.json` and `claude.json` matched their expected hashes and were
exact nine-key `ready` bundles for epoch `1786198210449677` at
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`. Inherited Run-31 docs matched
their expected hashes and remain narrative-only with no peer verdict. Bridge
lineage was recovered as V1 `5544c153-4e9f-42ba-b4c9-b7a57270eaf8`, REVISE
`c3c0a0b8-09e3-4387-8d8d-f48671df21a7`, V2
`34a28988-301f-4c56-b689-31a40d83cf92`, and PASS
`28bfdf88-6a33-4145-afea-345987936ec6`.

All ten V2 source/test preimages and all five frozen hashes still match. Five
two-file edit routes settled `risk-not-low`; no helper patch exists and no
scope remains reserved. No source/test implementation or proof command 1-12
ran. Governess requested fresh-loop handover before the atomic slice began.

### Superseded pre-REVISE plan — historical only

Before REVISE `9f0d802f-ea41-40d6-a229-03ae73a2f4fc`, Run 32 intended to
implement V1 plus V2 atomically in ten files, preserve B1/B2/B4-B7 semantics,
make B3 unknown fail closed, run proof commands 1-12, and request exact-postimage
review. That plan is no longer actionable. Preimage freshness does not cure the
missing replacement-manifest identity seam.

## Run 31 (2026-08-08) — F2 + SIX/SEVEN DECLARATION PASS

Planning only. No source/test implementation or test rerun occurred. Run-30
handoffs validated exactly: `codex.json`
`b6d860c715f963a92d96abdcf552b1d73ec68f025d6659519d81871c6f995a68`
and `claude.json`
`c10f547bf1814fec71f6b60a4021d63f6711253744076e379da085ec8e33452a`
are both `ready`, epoch `1786196308640713`, at `gitHead`
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`. Inherited live hashes
`PLAN.md` `435b30fe2eece4b578b4c279c2dde3a41756f35040303200db937da117517f04`
and `status.md` `96a5ded84916ee0997b227f126b45279e38be74ad998c94f3ca144426f08fa78`
matched before this Run-31 write. Those bytes carried no peer verdict; this
write supersedes them and likewise carries no verdict unless an exact later
hash is explicitly reviewed.

**Identifier reconciliation.** Claude decision
`98d15af3-ffaa-4ed1-a3e8-8614d08c4f7b` confirms
`92566b55-09db-41c5-bf4c-6b85672935d8` as canonical durable Run-16 T-05
review-verdict provenance carrying three corrections, reply_to
`5499a4cb-f715-447a-ab63-56280c833811`. Calling it an F2 correction is a later
characterization, not record-of-record wording. User-supplied
`92566b55-09db-41bf-8e9b-93c70e39e3ac` is preserved verbatim as unmatched and
grants no authority.

**Exact declaration PASS.** V1 bridge request
`5544c153-4e9f-42ba-b4c9-b7a57270eaf8` received narrow `REVISE`
`c3c0a0b8-09e3-4387-8d8d-f48671df21a7`: identify B3 as an intentional behavior
change and correct the post-slice textual inventory from three to five hits.
V2 `34a28988-301f-4c56-b689-31a40d83cf92` applied exactly those two
replacements. Claude zero-write verdict
`28bfdf88-6a33-4145-afea-345987936ec6` explicitly `PASS`ed V1 plus the V2
replacements. Risk is `high`: F2 launch-window socket plumbing and the six
old-API expressions/seven semantic branches must land atomically. PASS is bound
to the exact preimages below; any drift requires a new review.

Exact future write scope and current preimages:

- `loop-fork/src/loop/tmux.ts` —
  `ccba303ca1f72cbd7e4851e8a64978e4e1e3aa02ce3820b610de9e7e9b36cc14`
- `loop-fork/tests/loop/tmux.test.ts` —
  `6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20`
- `loop-fork/src/loop/bridge-runtime.ts` —
  `80da0a08db4646100383075debed43aaca27f879d2fc64899cb8f3fa97ce6610`
- `loop-fork/tests/loop/bridge.test.ts` —
  `f13e5a70d43a094cc3451abd05bf7f56a358bacbbf1dcbea50eb032041c1facf`
- `loop-fork/src/loop/governess.ts` —
  `f66230f454c1cf447af398018c497a63be356b00389be8a9132ffe338496bd3c`
- `loop-fork/tests/loop/governess-exit.test.ts` —
  `afb7af8fc97872775745ee021c69388cd1da984c6aa8f129ddbc23ac436603f5`
- `loop-fork/src/loop/governess-replay.ts` —
  `73a3f31bc4ed1fc2eec8981bd504c6a1508ebeea3c5a36e169abe38e55dff7f9`
- `loop-fork/tests/loop/governess-runtime.test.ts` —
  `35fd448af45f91815a16ac829d9019d63038ffe97d0027dc90fffa4ffe7f1991`
- `loop-fork/src/loop/launch-reservation.ts` —
  `543fc32c1b7e7bef549f8844154bc5e7d2fcb3d2b919fceb5d16159751218a27`
- `loop-fork/tests/loop/launch-reservation.test.ts` —
  `865a8c2cd8023d54bf5befe33f79520bd72155e3a7701dc286142072ef567528`

Frozen read-only dependencies: `tmux-control.ts`
`138ea1a5524ceb8c2091e28361f051ebfee7473189d9612b7d32de9ea9a6484c`,
`tmux-socket.ts`
`cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`,
and `run-state.ts`
`60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`.

**F2 A1-A3.** Never mint a `TmuxTarget` outside `targetFromManifest` or import
`createManifestHandle` outside `run-state.ts`. Thread the one resolved
non-paired `launchContext.socket` through `probeHandoffSession`,
`keepSessionAttached`, `isSessionGone`, `attachSessionIfInteractive`, and
`deps.attach`, using existing launch-only composers. Leave the already-qualified
non-paired attach hint unchanged. Preserve the confirmed-missing predicate and
`allowMissingSocket`; named-socket missing and unrelated stderr remain separate
`unknown` regressions. Paired execution receives no launch-window socket, and a
positive test must compare full shared/both-start probe argv byte-for-byte.

**Seven branches.** Migrate old API expressions at
`bridge-runtime.ts:1101,1164`, `governess.ts:6485,6571`,
`governess-replay.ts:325`, and `launch-reservation.ts:80` to existing target
APIs. Every branch gets a manifest-handle-derived target, exact
`["tmux","-S",socket,"has-session","-t",session]` assertion, and a named
unknown regression. Bridge status stays unknown/non-tmux; bridge live-check is
false. B3 replacement launch is the sole intentional behavior change: today
only dead rejects and unknown is accepted; after the slice, unknown fails with
an explicit error and requires retry/recovery. Separate named dead and unknown
regressions are mandatory. Replacement-alive returns unknown without alive/dead
authority; replay does not accept readiness; reservation line 120 treats
unknown as still owning and rejects conflict; reservation line 223 treats
unknown as fatal and throws before mutation. The last two are opposite
semantics and require separate tests. All branches except B3 preserve current
accept/reject behavior.

**Proof.** From `loop-fork/`, run supported focused suites for `tmux.test.ts`,
`bridge.test.ts`, `governess-exit.test.ts`, `governess-runtime.test.ts`, and
`launch-reservation.test.ts`; then `bun run check`; documented source typecheck
`bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler
--module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts`;
old-API `rg` inventory; manual six-producer byte comparison; `git diff --check`;
exact ten-file diff review; and frozen dependency/proxy rehash.
Expected old-API textual inventory is exactly five hits after implementation:
`tmux-control.ts:44,70` definitions, `tmux-control.ts:114` comment, and
`paired-options.ts:38,55` import/call. Comment and import are textual hits, not
migration expressions; all four in-slice source modules and proxy must have
zero hits.

Preserve W2/A2, F1, corrected risk-C, proxy C1, paired argv invariance,
criterion 11 as Codex attestation only, exact dirty-tree contents, and all six
inline verify-10 producers. `paired-options.ts:55` remains the distinct
socket-blind consumer; line 75 remains the fail-open producer. Verify 10 stays
open. Never inspect or use the forbidden artifact. No staging, commit, push,
merge, PR, deploy, release, dependency change, product-run mutation, backlog,
or accepted-slice rework.

Run 31 stops at this planning PASS. No implementation or proof suite starts in
this run. Next loop must rehash all ten preimages before using the PASS, then
implement V2 atomically and run its twelve proof commands.

**Final Run-31 closure.** Claude acknowledgement
`e9d4857f-f00d-411c-95b6-7e79d3a096af` independently re-derived the then-live
document hashes, all ten write-scope and five frozen source/test hashes, HEAD,
empty index, exact 14-entry dirty tree, and clean `git diff --check`. It confirms
declaration PASS `28bfdf88-6a33-4145-afea-345987936ec6` travels to the next loop
while those ten preimages remain unchanged. Proof commands 1-12 remain unrun;
the PASS certifies declaration exactness, not implementation or test success.
This final handover write supersedes the document pair checked in that
acknowledgement; only the Run-31 handover bundle records the final live pair,
which carries no peer verdict.

## Run 30 (2026-08-08) — B2-R PASS PLANNING GATE

Authoritative zero-write B2-R PASS bridge verdict
`1f4a0d31-813c-43c9-a94d-e58f1b809c4b` reviewed and approved the exact
hashes below. This is planning only: no source/test implementation, test
rerun, staging, commit, push, merge, deployment, or release occurred.

Exact reviewed hashes:

- `PLAN.md` —
  `66c1eb5cbea0b79fef052aeb8af170f19be7dc8cf305c70893d5019109e91da6`
- `status.md` —
  `e3f33f1771fc6e5bd63e11f9142898657b0c2b60df3dfdc14291b9c5e745fa52`
- `loop-fork/src/loop/codex-tmux-proxy.ts` —
  `2a41aa89e09a75c6a6c366a1b4f0f1faa018416d311d99f12aa85ca6192ecb6c`
- `loop-fork/tests/loop/codex-tmux-proxy.test.ts` —
  `6993d5bc3b89a3f71bc6d946dced60c84302f4c94a92466d9a291c668ad7602b`
- `loop-fork/src/loop/tmux-socket.ts` —
  `cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`
- `loop-fork/src/loop/run-state.ts` —
  `60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`

Criterion 11 remains Codex attestation only, not independent reviewer
verification. Verify 10 remains explicitly open. All existing history
below is preserved unchanged.

**Run-30 planning objective.** Produce one exact, zero-implementation
declaration for the remaining F2 A1-A3 work plus the post-C1 six-expression,
seven-semantic-branch `tmuxSessionLiveness` migration, then obtain Claude PASS
or REVISE before any source/test edit.

**Live inventory re-derived.** Current old-API migration expressions are exactly
six: `bridge-runtime.ts:1101,1164`, `governess.ts:6485,6571`,
`governess-replay.ts:325`, and the async default dependency binding at
`launch-reservation.ts:80`. That reservation binding feeds two distinct semantic
consumer branches, `deps.tmuxLiveness(...)` at lines 120 and 223; both require
their own target/socket argument assertion and named unknown-state regression.
The three proxy consumers from accepted Run-21
decision `59eac508-6550-49cf-bf87-17c69c0f6612` are gone because C1 PASSed.
`paired-options.ts:55` remains the distinct socket-blind old-API probe item;
its separate inline verify-10 producer remains at `paired-options.ts:75`. The
two `tmux-control.ts` legacy definitions and their focused tests are not
migration consumers.

**Recovered boundary evidence.** Durable Run-20 message
`59eac508-6550-49cf-bf87-17c69c0f6612` requires optional manifest-derived
target threading only through non-paired `runInTmux` probe paths, byte-identical
paired probe argv, per-semantic-consumer target/socket argument assertions, and
named unknown regressions. Durable Run-16 correction is recorded as
`92566b55-09db-41c5-bf4c-6b85672935d8`: F2 is non-paired execution only;
the already-qualified non-paired attach hint is not F2; preserve
`probeHandoffSession`'s confirmed-missing predicate and `allowMissingSocket`
semantics while socket-qualifying probe, keep-attached, `isSessionGone`, and
interactive attach; add named-socket-missing versus unrelated-stderr coverage.
The user-supplied identifier `92566b55-09db-41bf-8e9b-93c70e39e3ac` has no
matching durable record under the run journals and must be reconciled during
the next Claude planning review rather than silently substituted.

**Preparation-threshold handover.** Governess decision
`607eedd4-cd33-4cd0-8094-5f3993aaa51f` stopped this turn before declaration
drafting, preimage enumeration, or Claude declaration review. No source/test
file changed. Fresh loop must consume inventory tasks
`26157c36-9fa3-4bd0-861a-3dc79f9c406b`,
`7d2d6198-7280-47db-b285-79918bdf153d`, and
`edd59ea9-7dfb-4f24-84b0-53f16975b1e0`; identify exact source/test write scope
and current SHA-256 preimages; state risk `high` for the atomic behavioral
cascade; list focused tests, source typechecks, old-API inventory, paired argv
invariance, and `git diff --check`; then send the exact declaration to Claude
for zero-write PASS or REVISE. Do not implement until PASS.

**Preserved boundaries.** Do not rework proxy C1, W2/A2, F1, or corrected
risk-C. Do not edit the six inline verify-10 producers, `paired-options.ts`, or
backlog. Do not use the forbidden artifact, stage, commit, push, merge, deploy,
release, or claim verify 10 closed.

**Final Run-30 handover closure.** Read-only inventory tasks
`26157c36-9fa3-4bd0-861a-3dc79f9c406b`,
`7d2d6198-7280-47db-b285-79918bdf153d`, and
`edd59ea9-7dfb-4f24-84b0-53f16975b1e0` all completed and support the inventory
and recovered-boundary statements above. Claude zero-write verdict
`cf5d2fe1-e05d-405b-8c35-3d2baeb2abed` PASSed the pre-handover document bytes
`PLAN.md` `28eb59c05d95189ab7bcb5cf463942c03b7288126e173fa270df77cbb0a98032`
and `status.md` `6a14f9f407370046d9ef43f15970b59e6d2c2dbed28e6752dc491e3ee4937dd2`.
This final continuity addendum changes both documents and does not claim that
verdict covers their new hashes. Required handover bundle is written only after
final hashes and diff-check are derived. Next loop starts at declaration
completion and Claude review, not implementation.

## Run 29 (2026-08-08) — B2-R CLOSURE AND GOVERNED HANDOVER

Run-29 validated both Run-28 handoffs. Frozen C1 postimages:
`codex-tmux-proxy.ts`
`2a41aa89e09a75c6a6c366a1b4f0f1faa018416d311d99f12aa85ca6192ecb6c`,
`codex-tmux-proxy.test.ts`
`6993d5bc3b89a3f71bc6d946dced60c84302f4c94a92466d9a291c668ad7602b`.
Frozen dependency preimages: `tmux-socket.ts`
`cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`,
`run-state.ts`
`60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`.
V4 declaration `d6d66743-ec7c-44f9-8081-38c6c602ca00` was recovered
verbatim. Prior Claude PASS `19c1ae0e-9069-4d02-b476-af1fcb3f2126`
approved that unchanged declaration against its original pinned preimages.

**B2 correction (Run-28 sentence).** The protected proxy site relocated
from line 908 to line 388. Its liveness predicate migrated from manifest
`tmuxSession`/bare-session liveness to the handle-derived
`TmuxTarget | undefined` target. The literal `: "dead";` tail remains
verbatim. Verify 10 remains open.

**Review and handover state.** Claude verdict
`e736f0a0-6355-4470-b13c-5263b5135fe4` is REVISE on documentation B2-R
only. V4 criteria 1-10 PASS; criterion 11 remains Codex attestation only,
not independent reviewer verification. Reviewer re-ran the proxy suite
(30 pass, 0 fail, 83 expectations), V4 TypeScript check (exit 0), C1
`git diff --check` (exit 0), and the pre-correction document diff-check
(exit 0). C1 remains `risk: medium`; this B2-R documentation correction
is low risk. Verify 10 remains open.

Exact C1 changed scope remains only `loop-fork/src/loop/codex-tmux-proxy.ts`
and `loop-fork/tests/loop/codex-tmux-proxy.test.ts`. Run 29 changes only
`PLAN.md` and `status.md`. Pre-existing W2/F1-era dirty files and grouped
untracked paths remain preserved and uncommitted; nothing is staged.
Those unchanged paths are `launch-reservation.ts`, `tmux-control.ts`, `tmux.ts`,
their existing dirty tests plus `run-state.test.ts`, untracked
`tmux-socket.test.ts`, `runs/tmux-socket-normalization/`, and
`specs/tmux-socket-normalization/`.

**B2-R correction.** Current producer registries name
`codex-tmux-proxy.ts:388`. Live forward directives use the line-number-free
anchor: the `proxyStopReason` session-presence ternary and its literal
`: "dead";` tail. Historical defect/review facts remain historical; frozen
spec blockquotes remain untouched. No G3 rerun, utility C1 retry, risk
weakening, backlog work, commit, remote mutation, or verify-10 closure claim
occurs.

**B1 and next bounded action.** Derive final `PLAN.md` and `status.md`
SHA-256 hashes only after this final document write, rerun
`git diff --check -- PLAN.md status.md`, then request Claude B2-R-only
re-verification against those exact bytes. No code change is requested.

## Run 28 (2026-08-08) — DIRECT C1 DRIVER IMPLEMENTATION

Continue the validated Run-27 handoff under fresh standing human authority.
Both handoff bundles at epoch `1786190856388818` were read completely and
independently rehashed: `codex.json`
`28950427d8fffe35247dae54e02c974eb870ff4914a651c0139fa254affc8ccc` and
`claude.json`
`22d6528da84cead4076d8f56b8e71cef0d64352c624631cbf711881b8aba4d36`.
Both report `ready` at live HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`. Final G4 PASS
`4565a50b-3bcc-4f58-9d3a-5d3eff36c2c1` remains authoritative; G3 is already
discharged and must not be rerun.

The complete unchanged V4 C1 declaration was recovered from Run-23 bridge
message `d6d66743-ec7c-44f9-8081-38c6c602ca00`; Claude PASS
`19c1ae0e-9069-4d02-b476-af1fcb3f2126` binds it to the exact four preimages.
Fresh hashes match all four: proxy source
`4321a68c626acb181d1da413722a25c71b5efa43a04f7bf40b01df1764c3b3fa`,
proxy test
`defdf56ab8d585bff228317590c6246f9fbc8bbd6c97e6bd2eef9ff3012c5a46`,
`tmux-socket.ts`
`cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`,
and `run-state.ts`
`60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`.

Implement C1 directly in the Codex driver lane at preserved `risk: medium`.
Guard every edit against the pinned preimages. Change only
`loop-fork/src/loop/codex-tmux-proxy.ts` and
`loop-fork/tests/loop/codex-tmux-proxy.test.ts`: migrate all three proxy
liveness decisions to handle-derived `TmuxTarget | undefined`, retain the
documented record/handle two-read window and post-probe identity/state guards,
and add focused stale-evidence and unusable-target regressions. Preserve the
`proxyStopReason` session-presence ternary and literal `: "dead";` tail, all
other inline
verify-10 producers, paired argv bytes, and open verify 10. Never inspect or use
`db8b36fc-be5e-4710-b20c-ecb3fa037fb0`; no backlog work.

Verification: `git diff --check`; V4's focused proxy test and TypeScript
commands; supported handoff suites
`bun run test:file -- tests/loop/tmux-socket.test.ts` and
`bun run test:file -- tests/loop/run-state.test.ts` from `loop-fork/`; then
Claude zero-write native review against exact postimage hashes. Iterate until
Codex and Claude both pass. Do not commit, push, open a PR, deploy, release, or
mutate product runs in this C1 step.

**Run-28 atomic step complete; fresh-loop handover requested by Governess.**
Direct guarded edits changed only proxy source and proxy test. Proxy postimage
SHA-256 is
`2a41aa89e09a75c6a6c366a1b4f0f1faa018416d311d99f12aa85ca6192ecb6c`;
test postimage SHA-256 is
`6993d5bc3b89a3f71bc6d946dced60c84302f4c94a92466d9a291c668ad7602b`.
`tmux-socket.ts` and `run-state.ts` remain byte-identical to their pinned V4
preimages. All six protected inline verify-10 producers remain present; the
protected proxy site relocated from line 908 to line 388; its liveness
predicate migrated from manifest `tmuxSession`/bare-session liveness to the
handle-derived `TmuxTarget | undefined` target; the literal `: "dead";` tail
remains verbatim. Verify 10 remains open.

Checks complete: proxy focused suite 30/30 pass; `tmux-socket` 45/45 pass;
`run-state` 33/33 pass; V4 TypeScript command exits 0; final
`git diff --check` exits 0. Initial proxy run had two test-only failures: status
normalization expected `"completed"` instead of canonical `"done"`, and an
existing cleanup test tried requested shutdown while its manifest remained
active without a target. Test setup/assertion were corrected without weakening
unknown behavior; rerun passed. Self-review additionally made dead-tmux bridge
cleanup conditional on successful guarded reconciliation and resets death
evidence when reconciliation declines stale evidence.

Next bounded action: Claude zero-write native review of exact two-file
postimages and cited checks. If PASS, preserve this dirty tree for fresh-loop
continuation; if REVISE, carry exact blockers forward without starting backlog
work. No PR action is authorized in this prepared handover step.

Claude's reviewer lane remained idle for Run 28 and entered its own handover
before inspecting C1. It issued no review verdict. Therefore C1 peer review is
still pending and must be the first bounded action in the fresh loop.

## Run 27 (2026-08-08) — CURRENT GOVERNED HANDOVER

Complete the authorized post-G1 sequence without widening scope. Run-26
handoff bundles were read completely and rehashed exactly: `codex.json`
`2653b158b744f465be18c74a85d070774fc342ff6a272651fd95a94d1d2ab51b`
and `claude.json`
`e37b04b6e22536c1f1f6d6b321d4a4f587abda0055221d16afedf11a8f87c73d`.
Both report `status: ready` at G1 HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`, which matched live Git twice.

Exactly one replacement G3 was dispatched as task
`50ed52dc-98f9-4e15-b5af-dd61ddba154d`, using Claude reply
`d91387d2-356c-469a-8306-17ca72df645f` and the human-fixed two-step read plan.
It completed read-only and returned literal lines `tmux-socket.ts` and
`export const readRunManifestHandle = (`. Claude's initial G4 FAIL
`199dde35-fd17-49b6-bf3f-43e4eea5c4e8` was superseded by final `G4 PASS`
`4565a50b-3bcc-4f58-9d3a-5d3eff36c2c1` after review against the authorized
criteria. Human authority allowed exactly one replacement G3, so do not rerun
it. The PASS discharged only the explicit G4 precondition; it did not release
C1 from any other gate.

After PASS, Run-26 bundle hashes and live HEAD were revalidated. G2 matched all
four V4 preimages exactly: proxy source
`4321a68c626acb181d1da413722a25c71b5efa43a04f7bf40b01df1764c3b3fa`,
proxy test
`defdf56ab8d585bff228317590c6246f9fbc8bbd6c97e6bd2eef9ff3012c5a46`,
`tmux-socket.ts`
`cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`,
and `run-state.ts`
`60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`.
The complete unchanged V4 declaration was recovered from bridge message
`d6d66743-ec7c-44f9-8081-38c6c602ca00`, with historical PASS
`19c1ae0e-9069-4d02-b476-af1fcb3f2126`.

Unchanged C1 was submitted as edit task
`9f343be2-81bb-48c1-bbbb-f61bce41f36d` with V4's `risk: medium`, exact four-file
read scope, exact two-file write scope, capabilities, authority flags,
objective, and eleven criteria. Governess returned it to Codex with reason
`risk-not-low`; no helper executed, no artifact exists, and no source/test byte
changed. Do not silently change V4 to `risk: low`: that would no longer be the
unchanged PASSed declaration.

Next bounded action: resolve the `risk-not-low` route rejection under fresh
authority while preserving V4 unchanged, then dispatch C1 once. For any returned
artifact, independently hash it, inspect the full patch, and run
`git apply --check` before guarded apply. After any valid apply, run only
`bun run test:file -- tests/loop/tmux-socket.test.ts` and
`bun run test:file -- tests/loop/run-state.test.ts` from `loop-fork/`, then
request Claude native review.

Preserve the `proxyStopReason` session-presence ternary and literal
`: "dead";` tail, all six verify-10 producers, paired
argv invariance, open verify 10, and every unrelated dirty-tree byte. Never
inspect, use, salvage, or apply `db8b36fc-be5e-4710-b20c-ecb3fa037fb0`. Do
not implement backlog defects.

## Run 26 (2026-08-08) — SUPERSEDED BY RUN 27

Continue the post-G1 governed gates without changing the preserved dirty-tree
baseline or protected boundaries. Validate both Run-25 bundles under
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/25/handoff/1786188095974989/`
and live G1 HEAD `fe44f280c4a21e840e586f0f9d8098c865ed0d62`. Treat G4
FAIL `53fe5e56-dc2a-4a33-89e9-b78f6c6ff7aa` only as a delivery-evidence
failure. Dispatch exactly one successful replacement G3 visibility probe with
literal two-line output: helper-workspace existence proof for
`loop-fork/src/loop/tmux-socket.ts`, then the exact single source line from
`loop-fork/src/loop/run-state.ts` containing
`export const readRunManifestHandle = (`. Fail closed on any missing,
approximate, truncated, empty, or error output. Obtain explicit Claude G4 PASS
on those exact bytes before unchanged V4 C1.

Current atomic step is blocked before dispatch. Eight `route_task` submissions
were rejected by schema/path validation and created no helper task. Early
rejections used incorrect paths; human correction established the exact two
targets above. Corrected attempts still failed because the broker requires a
registered linked-worktree root and exact path operands repeated in
`read_scope`. Claude was asked for the valid packet shape in bridge message
`cb15d7ec-7d4e-4b7a-be63-1c71168e2d5b`, but Governess then required this
fresh-loop handover before Claude answered. No G4 verdict was requested and C1
remains undispatched.

Next bounded action: retrieve Claude's pending packet-shape answer, resolve the
registered worktree root without broad inspection, and dispatch the one
authorized replacement G3. After exact G4 PASS: complete Run-25 bundle and G1
validation, rehash all four G2 preimages, dispatch unchanged PASSed V4 C1,
independently hash and run `git apply --check` on any returned artifact, then
use only `bun run test:file -- tests/loop/tmux-socket.test.ts` and
`bun run test:file -- tests/loop/run-state.test.ts` for focused native tests
before Claude review. Direct `bun test` refusals are not suite failures.

Preserve the `proxyStopReason` session-presence ternary and literal
`: "dead";` tail, all six verify-10 producers, paired
argv invariance, open verify 10, and every unrelated dirty-tree byte. Never
inspect, use, salvage, or apply `db8b36fc-be5e-4710-b20c-ecb3fa037fb0`. Do
not implement backlog defects.

## Run 25 (2026-08-08) — SUPERSEDED BY RUN 26

Finish the post-G1 governed gates without changing product code. Validate both
Run-24 bundles, reproduce the two focused suites natively from `loop-fork/`,
revalidate the World Model and Run-23/Run-22 commit bindings after HEAD moved,
rehash all four V4 preimages, run one bounded G3 helper-workspace visibility
probe, and obtain an explicit Claude G4 verdict. Dispatch unchanged V4 C1 only
after exact `G4 PASS`.

Completed evidence:

- Run-24 `claude.json`, `codex.json`, and `continuation.md` hashes match
  `handoff/1786186746232375/manifest.json`; both bundles were read completely
  and bind current G1 HEAD `fe44f280c4a21e840e586f0f9d8098c865ed0d62`.
- G1 commit inspection returns exactly `run-state.ts` and `tmux-socket.ts`, 803
  insertions and no deletions.
- Literal `bun test` commands were run natively and each exited 2 with the
  repository's intentional unsupported-command diagnostic. They are recorded
  as command refusals, not suite failures. Supported native commands passed:
  `tmux-socket.test.ts` 45/45 with 114 expectations; `run-state.test.ts` 33/33
  with 79 expectations; both exit 0.
- Run-25 World Model bootstrap file hash
  `fbd5e1932553371f63c59210f688228bd64eed07eefbdb8ec94dca5a3fde3ecf`
  and capsule hash
  `453bf4e300d30878059d11759617b6a24278d640fe72d00a10df4bc960417b3c`
  match the charter. Every entity and statement binding is current G1 HEAD.
- Run-23 and Run-22 bundle plus continuation hashes match their manifests.
  Both generations bind old HEAD
  `ddf134b9200a3fda3cac68dcdd7868f28c94160d`; retain them as historical
  evidence, not proof of current-HEAD content.
- G2 matches all four V4 hashes exactly.
- G3 task `e7e390c2-fada-414b-a4cc-86a429b4d7ca` completed read-only. Its
  returned listing contains `tmux-socket.ts`, and its summary contains literal
  `export const readRunManifestHandle = (`. The result did not return verbatim
  `run-state.ts` bytes or an artifact/check reference, so fail-closed G4 review
  is required rather than inferring success.

G4 is terminally closed for this slice. Claude decision
`53fe5e56-dc2a-4a33-89e9-b78f6c6ff7aa` returned explicit `G4 FAIL` against
task `e7e390c2-fada-414b-a4cc-86a429b4d7ca`: `artifactRefs` and `checks` are
empty, no verbatim `run-state.ts` bytes were delivered, the `~1330` symbol
location is paraphrase, and `paneSummary` truncates mid-token at `launch-r`.
C1 remains undispatched. Do not rerun G3 in Run 25. Next loop requires fresh
human direction before a replacement probe; bind exact bytes to an artifact or
use a short exact line window that survives the result channel.

Preserve the `proxyStopReason` session-presence ternary and literal
`: "dead";` tail, all six
inline verify-10 producers, paired argv invariance, open verify 10, and all
unrelated dirty content. Never inspect, use, salvage, or apply
`db8b36fc-be5e-4710-b20c-ecb3fa037fb0`. Do not implement backlog defects.

## Run 24 (2026-08-08) — SUPERSEDED BY RUN 25

Execute the Run-23 V4 continuation exactly. Validate both Run-23 handoff
bundles and hashes, then discharge G1 with one clean prerequisite commit
containing only `loop-fork/src/loop/tmux-socket.ts` and
`loop-fork/src/loop/run-state.ts`. This commit exists only to make the pinned
dependency preimages visible to helper workspaces; staging alone is not proof.

**G1 complete.** Commit
`fe44f280c4a21e840e586f0f9d8098c865ed0d62` contains exactly those two source
files. Cached preimages matched V4 immediately before commit and
`git diff --cached --check` passed. Post-commit status is the preserved
unrelated baseline remainder: nine modified plus three grouped untracked paths,
with an empty index. No proxy, verify-10 producer, backlog, test, run artifact,
or spec content was committed.

Claude's late zero-write G1 scope review returned PASS in bridge message
`e91ddd5c-12f9-49a7-abff-6d6fc4d3b87d`: exactly the two committed source paths
were required; `tmux-socket.test.ts` and every other file were excluded. The
review arrived after commit. Reply `af3a9832-71a3-40ea-826f-4ea26f2bf115`
corrected its expected post-G1 count from 8 modified to the observed 9 modified;
three grouped untracked paths is correct.

After G1 moves HEAD: rerun the focused `tmux-socket` and `run-state` tests;
revalidate the Run-24 World Model capsule and its old commit binding; revalidate
the Run-23 and Run-22 bundle hashes and commit bindings; then perform G2 drift
hashes for all four V4 preimages. G3 must be a bounded read-only helper-workspace
probe whose recorded task id and verbatim output show both a
`loop-fork/src/loop/` listing containing `tmux-socket.ts` and a `run-state.ts`
read containing literal `export const readRunManifestHandle = (`. Missing,
empty, error, absent-symbol, or unrunnable output fails closed. Obtain Claude
G4 confirmation before dispatching unchanged V4 C1
`d6d66743-ec7c-44f9-8081-38c6c602ca00`, already approved by PASS
`19c1ae0e-9069-4d02-b476-af1fcb3f2126`.

Preserve the `proxyStopReason` session-presence ternary and literal
`: "dead";` tail, all six inline verify-10 producers,
and all unrelated content represented by the 10-modified plus 4-untracked
starting baseline. Never inspect, use, or apply
`db8b36fc-be5e-4710-b20c-ecb3fa037fb0`. Do not address backlog defects.

Current blocker at handoff: the first focused tmux-socket command was
auto-routed as task `49e0cd0e-92fc-4f3d-bfb2-9dfb21753cf4` and returned exact
failure `Direct run_check failed: Path does not exist:
tests/loop/tmux-socket.test.ts`. This is an unrunnable instrument result, not a
test failure. Two explicit absolute-path route attempts were rejected before
task creation with `route_task command packet is not deterministically
executable`. Neither focused suite has a valid post-G1 result. Next bounded
action: run both focused suites from `loop-fork/` through an accepted execution
route, then continue post-HEAD-move binding validation. G2, G3, G4, and C1
remain untouched.

## Run 23 (2026-08-08) — SUPERSEDED BY RUN 24

Current objective was declaration-only C1 preparation for
`loop-fork/src/loop/codex-tmux-proxy.ts`: migrate proxy liveness from bare
session evidence to `TmuxTarget | undefined` plus synchronous
`tmuxTargetLiveness`, while preserving the two-file write scope. No source or
test code was written, no helper was dispatched, no artifact was applied, and
nothing was staged or committed.

**Continuity and design validation complete.** Both Run-22 bundles were read
completely and independently rehashed against their manifest: `claude.json`
`c52a6d02b5034bf7db9e2fdd09098218712c365fce166f0317f466a22c45996c`
and `codex.json`
`4b5bbfb7ffb4f242692b6c3f41c3ced6870eb7b83f875890c95cc35b52212a27`.
Live Git remained branch `codex/tmux-socket-normalization-run11`, HEAD
`ddf134b9200a3fda3cac68dcdd7868f28c94160d`, no staged changes, ten modified
plus four untracked entries. New Claude evidence was accepted: a
`ManifestHandle` cannot provide run state or session, so C1 keeps
`readRunManifest` and documents the unavoidable independent record/handle read
window with a post-probe guard re-check. Read scope is exactly proxy source,
proxy test, `run-state.ts`, and `tmux-socket.ts`; `tmux-control.ts` is omitted.
Its verified literal contract remains synchronous:
`tmuxTargetLiveness(target: TmuxTarget | undefined, run: typeof spawnSync = spawnSync): TmuxLiveness`,
returning `"unknown"` for an undefined target.

**Declaration V4 PASS.** Four zero-write rounds completed: V1
`6ad95dba-2e75-4802-83dc-691b22885718` REVISE via `7b4d114a`; V2
`de02bfa3-ea34-405c-9e82-7d395eaef4a5` REVISE via `c2ada7b2`; V3
`50c80cb4-6ce6-42a3-9fba-24737a433363` REVISE via `f949efd0`; V4
`d6d66743-ec7c-44f9-8081-38c6c602ca00` explicit PASS via
`19c1ae0e-9069-4d02-b476-af1fcb3f2126`. PASS is bound to exact preimages:
proxy source `4321a68c626acb181d1da413722a25c71b5efa43a04f7bf40b01df1764c3b3fa`,
proxy test `defdf56ab8d585bff228317590c6246f9fbc8bbd6c97e6bd2eef9ff3012c5a46`,
`tmux-socket.ts`
`cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`,
and `run-state.ts`
`60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`.

**Hard pre-dispatch gate.** `readRunManifestHandle` exists only in the
uncommitted +127/-0 `run-state.ts` change, and `tmux-socket.ts` is untracked and
absent from HEAD. A prior utility workspace reported an untracked spec directory
empty, so local hashes or tracked status cannot prove helper visibility. Under
separate human authorization, make both pinned dependency preimages visible;
rehash only as a drift guard; then dispatch a bounded read-only G3 probe that
must return both a `loop-fork/src/loop/` listing containing `tmux-socket.ts` and
the literal `export const readRunManifestHandle = (` from `run-state.ts`.
Record task id and verbatim output. Any absence, empty result, missing symbol,
probe error, or unrunnable probe fails G4 and returns C1 for review. Only after
G4 passes may the PASSed V4 edit packet be dispatched unchanged.

**Preserved boundaries.** Keep the `proxyStopReason` session-presence ternary
shape and literal `: "dead";` tail; all six inline verify-10
producers remain unchanged and verify 10 stays open. Never inspect, reuse,
salvage, or apply task/artifact `db8b36fc-be5e-4710-b20c-ecb3fa037fb0`.
W2, F1, corrected risk-C, paired argv invariance, `paired-options.ts`, and
D-001 through D-012 remain outside C1. If G1 is later discharged by committing,
HEAD changes and the World Model commit binding plus Run-22 handoff evidence
must be revalidated.

**Next bounded action:** obtain separate human authorization for G1. Then run
the mandatory positive G3 visibility probe and ask Claude to confirm whether
its verbatim result clears G4 before dispatching V4. Do not dispatch, guarded
apply, commit, push, merge, open a PR, deploy, release, or mutate a product run
before those gates.

## Run 22 (2026-08-08) — SUPERSEDED by Run 23

Continue the approved atomic T-05 boundary without reworking W2, F1, corrected
risk-C, the six inline fail-open verify-10 sites, or `paired-options.ts`. Do not
work D-001 through D-012 in this worktree.

**Continuity gate passed before edits.** Run-21 handoffs matched and were read
completely: `codex.json`
`246c8ab2afacb9851773170298593f7a0090655050a837aff0bffc324b2f101c`
and `claude.json`
`d682d0f9c588f5cc75ad047f47e15cad5bacb1cfdde5998b17eb3d73c9483ac5`.
Claude PASS `70159484-7644-4792-a0ea-bd9c1f20d15f` is authoritative; the
Codex bundle's REVISE blocker is stale. Live Git state was independently
confirmed at HEAD `ddf134b9200a3fda3cac68dcdd7868f28c94160d` on branch
`codex/tmux-socket-normalization-run11`, with no staged files, ten modified
files, and four grouped untracked entries. Direct Git status confirms
`specs/tmux-socket-normalization/` exists and its four spec files are untracked;
the contrary utility audit was false and is not relied on.

**First bounded action complete.** `tmux-control.ts:140-175` confirms
`tmuxTargetLiveness` is synchronous and returns `TmuxLiveness`, while
`tmuxTargetLivenessAsync` returns `Promise<TmuxLiveness>`; neither signature
changes. All nine `./tmux-control` importers were accounted. The two omission
concerns are intentional: `governess-pane-liveness.ts` imports bounded-control
helpers only, and `panel.ts` imports timeout/kill constants only. Neither has a
session-liveness symbol to migrate. `paired-options.ts` remains the distinct
verify-10 backlog probe.

**Run-21 terminal artifacts rejected or withheld.** Replay patch
`c866dccc5cc1185ea5d547462bee81923ede27cb2726b3a0de2a474f9e8c38b5`
and corrected F2 patch
`6a1394541963d335ef098ed8d162ddaa8e3e5ccef2eff22d6fde48c92c77fd19`
were independently hashed, fully inspected, and rejected after
`git apply --check` failed at lines 36 and 7. Governess patch
`e6b1579aa110a523912c359c2779ec3ec7e1877be25e7235eaa1206483fec460`
passed apply-check but is partial, omits tests, and imports
`createManifestHandle` outside its sole `run-state.ts` producer boundary; it is
not usable. Every declared preimage still matches its manifest hash. None was
applied.

**Proxy artifact rejected; no apply.** Corrected proxy task
`db8b36fc-be5e-4710-b20c-ecb3fa037fb0` returned patch SHA-256
`d233f2fc991385892558987d1b2fffb6e282ccfdfbddcb0fc6f5cecdaf43b9f0`
and manifest SHA-256
`dd5adb4529ac61d775d40d8beac1a80eabff7a0906fcd5aaba641bbb3b7411b6`.
Both were independently hashed and read completely; the two live preimages
matched. `git apply --check` failed at line 67. Content review also rejected the
patch because it imports sole-producer `createManifestHandle` into the proxy,
uses unsafe record casts, and changes the explicitly open line-908 verify-10
producer. No focused test or typecheck ran on the corrupt artifact. Proxy
baseline remains 20 pass / 0 fail.

**Claude zero-write verdict: REVISE.** Message
`03738b58-e93c-4858-a8b2-8b44c9b39791` confirms B1 and the nine-importer
inventory but blocks C1 on four points: read scope cannot inspect
`readRunManifestHandle`; double-reading the manifest leaves target/guard
identity unresolved; line 908 needed an exact boundary decision; and the dirty
baseline is ten modified plus four untracked. Human authority now resolves the
open points: preserve `codex-tmux-proxy.ts` line 908 and all six inline
verify-10 producers exactly in C1, defer Claude blocker 3, and use a
single-handle-derived manifest read so target identity and guard evidence come
from the same read with no second-read race. Governess decision
`f6755f3f-3fb8-4921-9730-db5cae8e6181` requires a fresh-loop handover now.

**Next bounded action:** send the resolved C1 declaration to Claude for a
zero-write re-check before dispatch. Its read scope must expose
`readRunManifestHandle`; its design must use one handle-derived manifest read
for both target identity and guard evidence; and it must preserve proxy line
908 plus all six inline verify-10 producers. State the already-verified
synchronous target-liveness contract literally if `tmux-control.ts` is omitted
from read scope. Do not guarded-apply current task
`db8b36fc-be5e-4710-b20c-ecb3fa037fb0`. Preserve paired argv byte-invariance,
W2, F1, corrected risk-C, and the open verify-10 backlog.

## Run 21 (2026-08-08) — SUPERSEDED by Run 22

Implement one atomic T-05 continuation: F2 A1-A3 plus all nine confirmed old
session-liveness migrations, with named unknown-state regressions per semantic
consumer and positive paired invariance. Preserve W2, F1, corrected risk-C
PASS, and keep verify 10 open at its six inline fail-open sites.

**Continuity gate passed before edits.** Run-20 handoffs matched exact required
SHA-256 values and were read completely: `codex.json`
`4b15f5feac08418aa682398766f0fc15d84524ec600b5d23bd7c179fba09ad78`
and `claude.json`
`7c0f0506dcef7b4283bbf3b1df7122861902c6d190da2830b74da77d643b6ea1`.
Inherited `PLAN.md` and `status.md` matched Run-20 hashes
`529ece3e8ed77d77bb90dcc3ed9735d1593e3861318744c2b4095df420ab8c2a`
and `c1d3bab24154213c502bdbe5323198a42eb23ca823762799871cff5a1c7f9669`.
HEAD, branch, and exact dirty-tree membership also match the handoff. World
Model file/capsule hashes and repository commit match, but the capsule is
truncated and is not implementation authority.

**Boundary decision consumed and accepted.** Claude decision
`59eac508-6550-49cf-bf87-17c69c0f6612` confirms the nine expressions: two in
`governess.ts`, one in `governess-replay.ts`, two in `bridge-runtime.ts`, three
in `codex-tmux-proxy.ts`, and one async use in `launch-reservation.ts`.
`paired-options.ts` is a distinct verify-10 backlog item. B1 resolution: thread
an optional manifest-derived target into `probeHandoffSession`, supplying it
only from non-paired `runInTmux` paths, including `isSessionGone`; both paired
`startPairedSession` sites remain socketless and byte-identical. C1-C4 are
accepted: proxy shared type plus three sites stay atomic; risk-C contract lands
before consumers and is already PASS; every semantic consumer gets explicit
target/socket assertions and a named unknown regression; paired argv receives
a positive byte-invariance assertion.

**Execution plan.** Three non-overlapping helper edit packets are active:
F2 `0c1a5dd3-0e83-4e55-9fec-6fca5275e6ec`, proxy
`e18c5cb5-ad2c-411f-84e1-ea650a76a1d1`, and reservation
`000c4c06-fbf0-49c2-80b5-655047d08efc`. Reservation's three emitted patch
files were independently hashed and inspected; every file failed
`git apply --check` as corrupt and proposed a nonexistent provenance-breaking
constructor, so none was applied or executable. Corrected replacement task
`955a5a4a-f3f8-475a-98fb-69070b533ad6` is active. Remaining source/test pairs will be
routed after slots free. For every helper artifact: independently hash and
inspect full patch, run `git apply --check`, guarded-apply exact preimages, then
run its focused test and source typecheck. Finish with nine-site inventory,
focused aggregate tests, `git diff --check`, and Claude peer verdict. Do not
touch the six inline verify-10 producers, paired-options, or other backlog.

**Final Run-21 handover state.** Governess message
`a6e3d4c0-4122-475d-b8f2-cc791596d96e` ordered a fresh-loop handover at the
preparation threshold. No source/test artifact was applied. HEAD remains
`ddf134b9200a3fda3cac68dcdd7868f28c94160d`; branch and the inherited exact
10-modified plus 4-untracked membership remain unchanged. Accepted hashes are
still exact: `tmux-control.ts`
`138ea1a5524ceb8c2091e28361f051ebfee7473189d9612b7d32de9ea9a6484c`,
`tmux-control.test.ts`
`3e87a72d210f831c8a52b7e42c91c72fad33d1c13c658f6b4001f727cf2d1c30`,
`tmux.ts` `ccba303ca1f72cbd7e4851e8a64978e4e1e3aa02ce3820b610de9e7e9b36cc14`,
`tmux.test.ts`
`6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20`,
and F1 `tmux-socket.test.ts`
`67f4775c27be38515ae837f1687c48f7d676684c407ee7ae085fd01f0b7db889`.

**Artifact disposition.** Reservation task
`000c4c06-fbf0-49c2-80b5-655047d08efc` emitted three independently hashed and
fully inspected patch files; all failed `git apply --check` at line 32 and
proposed nonexistent `createTmuxTarget`. F2 task
`0c1a5dd3-0e83-4e55-9fec-6fca5275e6ec` emitted patch SHA-256
`fb91f8d850510209956f021d02549a2800c6433caaa2275567f811864f3d5318`;
full inspection found insufficient C4 proof and `git apply --check` failed at
fragment line 24. Corrected reservation task
`955a5a4a-f3f8-475a-98fb-69070b533ad6` emitted patch SHA-256
`89843151a90edf8f2c9d165440e8131b4cca651fbb24a2b91ebf67df2c1cd9c0`;
it was independently hashed and fully inspected, failed `git apply --check` at
line 25, and illegally imported `createManifestHandle` outside the sole
`run-state.ts` producer. None was applied. Focused execution cannot run on an
unparseable artifact.

Bridge task `b0aa4048-8855-40e4-a17b-0a7b89264787` then emitted patch
SHA-256 `859717c25071b701e60edc2fd962915a9c2269e9f1ecb08d904c3a1be67755a5`.
It was independently hashed and fully inspected; `git apply --check` failed at
line 22. No focused test ran and nothing was applied.

**Boundary review.** Claude verdict
`983e5105-3dac-4a22-8455-73b79fe837d7` is REVISE. Reply
`03c95f89-b56d-43bf-8e9b-93c70e39e3ac` restates B1/C1: F2 gets an optional
launch-window socket only from non-paired `launchContext`, threading through
`probeHandoffSession`, `keepSessionAttached`, `isSessionGone`,
`attachSessionIfInteractive`, and `deps.attach`; C4 covers every paired-run
shared argv plus both `startPairedSession` probes. Proxy does not change
`tmuxSessionLiveness`; its own shared callback/default atomically switch to the
already-existing `tmuxTargetLiveness` API.

**Open helper state at handover.** Original proxy
`e18c5cb5-ad2c-411f-84e1-ea650a76a1d1` failed by runtime limit with no
artifact and must be reissued with `tmux-control.ts` and `tmux-socket.ts` as
read-only context. Replay `bb70cb06-25d3-4345-bc57-b8801b662cbf` completed
after handover finalization with unvalidated artifact
`0f5c77c4-bda3-453b-89ae-12c26aca65f4.patch`; successor must independently
hash, fully inspect, `git apply --check`, and focused-test it before any apply.
Running when last checked: Governess
`0a545a31-96d6-4405-a106-f03b4ccb0197` and corrected F2
`8b98217d-3eeb-49e1-aa4d-38f4139e0af8`. Pull all terminal results next loop.

**Next bounded action:** fresh Codex loop verifies this handover and live
preimages, consumes all pending results, and asks Claude to PASS the corrected
B1/C1 boundaries before guarded apply. Independently hash, fully inspect, and
`git apply --check` every artifact; focused-test only parseable artifacts in a
safe exact-preimage environment. Keep W2, F1, risk-C, paired invariance, and
verify 10's six inline fail-open sites unchanged. No commit, push, merge, PR,
deployment, or release occurred.

## Run 20 (2026-08-08) — SUPERSEDED by Run 21

Governess ordered a fresh-loop handover at the preparation threshold before
implementation began. Human-assigned objective remains one atomic T-05
consumer slice: F2 A1-A3 plus all nine old session-liveness caller migrations,
with a named unknown-state regression at every consumer. Preserve W2, F1, and
the corrected risk-C PASS; do not start unrelated backlog work.

**Continuity verified before repository work.** Run-19 handoff bundles matched
their required SHA-256 values exactly: `codex.json`
`9ce6ed799018982e7a47ecc92459957a68f4b43a79527badd5ac87e15fb23723`
and `claude.json`
`fb3e759260be5b1e304215825e5675f6b1e075211ef0c0a00f9e64a0b7d935f7`.
Both complete bundles were read. The inherited docs matched the Run-19 hashes:
`PLAN.md` `e19bec9ad0df7f93406c179802dc0be4ae8a80702b23ed2094b973d49d9c9132`
and `status.md`
`8856f6467c82410354ee9d95531d9d83c5b4d34db82cb2713a12dedd79e58059`,
with exactly one current handover heading each. Git is still at HEAD
`ddf134b9200a3fda3cac68dcdd7868f28c94160d` on
`codex/tmux-socket-normalization-run11`, with the exact inherited 10 modified
plus 4 untracked entries and no staged, extra, renamed, or missing entry.

**Accepted slices preserved.** Live hashes still match Run 19:

- `loop-fork/src/loop/tmux-control.ts` —
  `138ea1a5524ceb8c2091e28361f051ebfee7473189d9612b7d32de9ea9a6484c`.
- `loop-fork/src/loop/tmux.ts` —
  `ccba303ca1f72cbd7e4851e8a64978e4e1e3aa02ce3820b610de9e7e9b36cc14`.
- `loop-fork/tests/loop/tmux-control.test.ts` —
  `3e87a72d210f831c8a52b7e42c91c72fad33d1c13c658f6b4001f727cf2d1c30`.
- `loop-fork/tests/loop/tmux.test.ts` —
  `6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20`.
- F1 confinement test `loop-fork/tests/loop/tmux-socket.test.ts` —
  `67f4775c27be38515ae837f1687c48f7d676684c407ee7ae085fd01f0b7db889`.

Run-19 Claude handoff independently records risk C PASS, so no risk-C rework is
pending. The classifier remains confirmed-missing-only `dead`; ENOENT and
generic diagnostics remain `unknown`.

**Pre-implementation boundary review requested.** Current live source has ten
old session-liveness expressions: `governess.ts` twice,
`governess-replay.ts` once, `bridge-runtime.ts` twice,
`codex-tmux-proxy.ts` three times, `paired-options.ts` once, and
`launch-reservation.ts` once. The Run-19 handover separately names nine caller
migrations and the distinct `paired-options.ts` socket-blind probe remainder,
so the likely nine are all expressions except `paired-options.ts`; this is an
inference, not yet treated as authority. Targeted Claude request
`ea79d53a-6ccb-469d-81de-6dfd863065fd` asks for the exact nine-expression
mapping, exact F2 A1-A3 boundary, named-test granularity, and compile-order
constraints before implementation. No answer arrived before Governess ordered
handover.

**Routing evidence.** The bounded Git-status audit task
`db3374a5-44cc-44da-b449-b75ee918ba75` confirmed the ten modified entries but
under-counted untracked directories and could not report HEAD/branch. Its
13-entry conclusion is rejected; direct native porcelain independently showed
the expected fourth untracked `specs/tmux-socket-normalization/` entry and exact
14-entry membership. Four exact file-read/search packets were rejected with
`route_task utility packet is not deterministically bounded`; no worker wrote
repository bytes.

**Next bounded action:** verify the fresh handoff, immediately pull Claude's
response to request `ea79d53a-6ccb-469d-81de-6dfd863065fd`, and settle the
nine-expression/F2 mapping before any edit. Then route non-overlapping bounded
edit packets against exact live preimages, review and apply each artifact only
after independent `git apply --check`, and run the focused test after every
apply. Keep paired `runInTmux` attach/hint work deferred until disk-backed
`ManifestHandle` fixtures exist. Keep the six inline verify-10 producers and
the distinct `paired-options.ts` probe open unless Claude explicitly maps one
into the requested slice. No source/test implementation, commit, push, merge,
PR, deployment, release, discard, or product-run mutation occurred in Run 20.

## Run 19 (2026-08-08) — SUPERSEDED by Run 20

Governess requested a fresh-loop handover after the corrected risk-C atomic
slice landed and passed local focused checks. Do not start F2 or the caller
cascade in this loop. Preserve all predecessor work and continue from the next
bounded action below.

**Continuity verified directly.** Run-19 charter SHA-256 matched
`6246793302f0fa867f7090b2f64d765f131a0c4dca3b60ffd73cbb960842d19f`.
Every Run-18 handoff component matched its manifest; acceptance referenced
manifest digest
`5b0bd3e6f10a64055288db0336c2d77f3ed74b5a59eb0a1c8468a578983863ae`;
the complete Run-18 transcript was read. Git started and remains at HEAD
`ddf134b9200a3fda3cac68dcdd7868f28c94160d` on branch
`codex/tmux-socket-normalization-run11`. World-model file and capsule hashes
matched, but the bootstrap still lacks `repositoryCommit`; it was not relied
on. Direct Git, Run-19 manifest/journals, and the validated handoff supplied
continuity.

**Risk C implemented.** `tmux-control.ts` now owns and exports the existing
`NO_SESSION_RE`, `MISSING_TMUX_SOCKET_RE`, and
`isConfirmedMissingTmuxSession`. `tmux.ts` imports the shared helper and no
longer duplicates those definitions. Target-bound sync liveness captures
stderr and returns `dead` only for `NO_SESSION_RE`; generic connection errors,
ENOENT, overlong path, non-socket, permission, empty, and unrecognised stderr
return `unknown`. Target-bound async liveness pipes stderr only, settles on
`close` after stderr drainage, and preserves timeout kill, signal/error
handling, and single settlement. Existing session-only APIs and the initial
preflight `allowMissingSocket` opt-in remain unchanged.

Final risk-C live hashes:

- `loop-fork/src/loop/tmux-control.ts` —
  `138ea1a5524ceb8c2091e28361f051ebfee7473189d9612b7d32de9ea9a6484c`.
- `loop-fork/src/loop/tmux.ts` —
  `ccba303ca1f72cbd7e4851e8a64978e4e1e3aa02ce3820b610de9e7e9b36cc14`.
- `loop-fork/tests/loop/tmux-control.test.ts` —
  `3e87a72d210f831c8a52b7e42c91c72fad33d1c13c658f6b4001f727cf2d1c30`.
- `loop-fork/tests/loop/tmux.test.ts` remains
  `6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20`.

**Artifact failures were contained.** Helper task
`cc40ad93-b2b5-488a-8c96-cc9b258c6617` claimed source artifact
`c9b5ce40-ff77-4b23-b7eb-555cd3c56eda.patch`, SHA-256
`7947000b5ac303296c69c0c39f3d767b715f21d21763fb876c81a614807e1298`,
was a valid unified diff. That claim is false: independent
`git apply --check` failed exactly at patch line 44. The artifact was never
applied or salvaged. Three later control-source helper artifacts were also
rejected and unapplied: non-applying at live
source line 118 plus wrong AND semantics; corrupt at patch line 23; and a
one-hunk artifact corrupt at patch line 22. After bounded edit routing was
exhausted, Codex applied the settled control change directly against unchanged
preimage
`9f9edd3754f7a40c8810d3cd41dc534ea1e68b9ee1a1efc412dbe3737f1ccb67`.
The valid `tmux.ts` artifact
`75eaf3db63fe5faa8800b2a9a5dc5fd2482c438dd8af5fa8ef96e8fb251cf099`
and test artifact
`35b6774df8c4a053a5f4bcc85f63814e5bd18353533f271720925dfa3c3b8f64`
were guarded-applied. Focused testing then caught that the test artifact ended
mid-test (`Unexpected end of file` at line 355); Codex completed only the
truncated async cases and added the missing async unknown diagnostics. No bad
artifact was salvaged or partly applied.

**Local verification passed.** From `loop-fork/`:

- `LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/tmux-control.test.ts`
  — **30 pass / 0 fail / 40 expect() calls**.
- `LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/tmux.test.ts`
  — **104 pass / 0 fail / 536 expect() calls**.
- Documented source typecheck from `docs/testing/commands.md` — exit 0.
- `bunx biome check` on the four risk-C files — exit 0, no fixes required.
- `git diff --check` — exit 0.

Bare `bunx tsc --noEmit --pretty false` remains a non-gate failure with broad
pre-existing repository errors; no clean result is claimed. Claude final
live-tree review request `7a953bd7-f57c-4396-bff6-81cb25337219` is pending at
handover creation and must be consumed before risk C is treated as peer-passed.

**Next bounded action:** consume Claude's final risk-C verdict and fix only an
exact blocker if returned. If PASS, begin one atomic T-05 continuation:
implement F2 A1-A3 and migrate all nine old session-liveness callers to the
target-bound APIs with named per-site unknown tests. Verify 10 remains open at
six inline producers across T-06, T-08, and T-10; `paired-options.ts` still
needs its distinct socket-blind probe correction. Keep paired `runInTmux`
attach/hint argv deferred until disk-backed `ManifestHandle` fixtures exist.

## Run 18 (2026-08-08) — SUPERSEDED by Run 19

Governess requested a fresh-loop handover after the Run-18 risk-C disposition.
No source or test patch landed in this run. F1 remains complete from Run 17;
F2 and the nine-caller liveness cascade remain unstarted.

**Continuity verified directly.** Launch charter SHA-256 matched
`ad1603970b3f413f84f264bfacc3555980814a5a2252dd89d36033461fabba8b`.
Every Run-17 handoff component matched `manifest.json`, acceptance referenced
manifest digest
`65d504bdd57c25d0d2cc833ea308ca183c1824c576a60251a7a303206d205dd0`,
and the complete Run-17 transcript was read. Git remained at HEAD
`ddf134b9200a3fda3cac68dcdd7868f28c94160d` on branch
`codex/tmux-socket-normalization-run11` with 10 modified plus 4 untracked
entries. World-model file and capsule hashes matched, but its bootstrap JSON
again lacked the required repository-commit field; it was not relied on. The
Run-18 manifest, Git, handoff bundle, and journals supplied continuity.

**Risk-C reissue completed but is rejected and unapplied.** Edit task
`60034e78-5c36-45eb-89e0-1634aff6d22f` returned artifact
`700e069b-52cc-4b8b-b342-34d715952486.patch`, independently hashed to
`11e2b7fc8b1ac5c40856e769e2894c5ec7fdb632abac46545e503402bb846a08`.
The helper correctly declared the live dirty preimages, which remain:

- `loop-fork/src/loop/tmux-control.ts` —
  `9f9edd3754f7a40c8810d3cd41dc534ea1e68b9ee1a1efc412dbe3737f1ccb67`.
- `loop-fork/tests/loop/tmux-control.test.ts` —
  `f1796fe75b99ab61a6c5bb0538e56422c7781f4250e73a40a9b02939474117eb`.

Independent review found two terminal rejection grounds. First,
`git apply --check` failed exactly with
`error: corrupt patch at .loop/utility-artifacts/60034e78-5c36-45eb-89e0-1634aff6d22f/700e069b-52cc-4b8b-b342-34d715952486.patch:25`.
Second, the artifact classifies broad `/error connecting to/i` as dead, but
Claude's producer-backed verdict in message
`5de017fb-c02b-44a8-b844-4de6a0edf101` established that ENOENT is ambiguous:
an external reaper can unlink a socket while the tmux server and workspace
remain alive. The artifact was not applied or salvaged, and no risk-C test ran.
Current predecessor bytes remain unchanged. The focused predecessor baseline
is **9 pass / 0 fail / 16 expect() calls**.

**Binding corrected risk-C decision.** Target-bound liveness returns `dead`
only for the existing `NO_SESSION_RE` evidence (`no server running`,
`no sessions`, missing-session forms). Generic `error connecting`, ENOENT,
file-name-too-long, non-socket, permission, empty, and unrecognised stderr stay
`unknown`. Timeout, signal, spawn error, and absent target also stay `unknown`;
exit zero stays `live`. Async settles on `close` after stderr drains, uses
`["ignore", "ignore", "pipe"]`, and preserves kill-on-timeout and
single-settle behavior. Move `NO_SESSION_RE`, `MISSING_TMUX_SOCKET_RE`, and
`isConfirmedMissingTmuxSession` from `tmux.ts` into `tmux-control.ts` as one
source of truth; `tmux.ts` imports them. Keep `allowMissingSocket` only for the
existing initial preflight at `tmux.ts:3297`; do not add it to target APIs.

**Long-helper correction.** The five-poll escalation premise was withdrawn.
`task_status.updatedAt` is the last state transition, not a heartbeat; PID
`35923` remained alive and CPU-active until normal completion. Supervisor
cancellation messages were explicitly superseded after terminal completion.
Future stall decisions must use actual worker/runtime evidence, while still
holding write reservations until an explicit terminal task state.

**Next bounded action:** reissue corrected risk C against the unchanged live
preimages as non-overlapping guarded edit packets: source relocation/behavior
in `tmux-control.ts` plus `tmux.ts`, and focused regression coverage in
`tmux-control.test.ts` plus `tmux.test.ts` if needed for the shared predicate.
Require valid unified diffs, independent `git apply --check`, guarded preimage
equality, guarded apply, focused tests, and Claude artifact review. Then resume
F2 A1-A3 and the atomic nine-caller migration. Preserve paired `runInTmux`
attach/hint argv and keep verify 10 open at its six separate sites.

---

## Run 17 (2026-08-08) — SUPERSEDED by Run 18

Governess message `a2293f11-865e-4137-bbb3-3e9d924dd570` requested a fresh-loop
handover at the context threshold. The documented sequence was preserved: F1
landed first; no F2 or nine-site liveness-cascade source/test edit started.

**Continuity verified directly.** Run-17 charter SHA-256 matched
`6d66ed14ae4264003ee4c175a87a3d9f29f42e31cc30b3a576b32949f48bec5d`.
Run-16 handoff component hashes matched `manifest.json`, acceptance referenced
manifest digest `167b22ffe322e597d26f7173f1d3b0a7d54cdda9c35e3f91656a59c2d8d96ae8`,
and the complete prior transcript was inspected. HEAD and branch remain
`ddf134b9200a3fda3cac68dcdd7868f28c94160d` and
`codex/tmux-socket-normalization-run11`. The world-model file and capsule hashes
matched, but its JSON again lacked the required repository-commit field, so it
was not relied on; Git, the run manifest, handoff bundles, and transcript
supplied the evidence.

**F1 COMPLETE through guarded apply.** Edit task
`6d02e3de-f954-44f5-a8a7-64847fefbed0` produced patch SHA-256
`2a2fb75bbf828384c62ee94f02dba08b3bebe66287660667ff83aa8d2e36957c`.
Codex reviewed the patch, independently ran `git apply --check` successfully,
then used the guarded apply path. `loop-fork/tests/loop/tmux-socket.test.ts`
moved from preimage
`d8793c89defa77e06b1e0362ad7471c6f87b92fee495536f19687b306f9ff299`
to postimage
`67f4775c27be38515ae837f1687c48f7d676684c407ee7ae085fd01f0b7db889`.
The confinement test now recursively scans every `.ts` file below
`loop-fork/src`, reports repo-relative forward-slash importers, and preserves
all per-region composer occurrence assertions. Focused proof:
`LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/tmux-socket.test.ts`
— **45 pass / 0 fail / 114 expect() calls**.

**Risk-C edit task is terminal but rejected; no patch was bypassed.** Task
`f9f9f9d7-943d-4fba-be8d-237f2bee2a31` returned artifact
`1d27de56-e096-4daa-87ef-03af7617c0a7.patch`, SHA-256
`6127aa114ad8f04d2cd013de01b958087a898feef9a8d54204ace72e40de4ff1`.
Independent validation failed exactly:
`error: corrupt patch at .../1d27de56-e096-4daa-87ef-03af7617c0a7.patch:26`.
It was not applied and no focused risk-C test ran. Its intended logical change
was confirmed-missing-only `dead` semantics, stderr capture, preserved bounded
timeout/single-settle behavior, and the named risk-C branches, but none of that
is present in the working tree. Utility read task
`f5db64e7-0e39-42e6-b1cf-cf7d9d322431` only inspected the malformed artifact
and changed no files.

**Guard the dirty preimages, not HEAD.** Both risk-C files already contain
accepted uncommitted predecessor work. Exact live versus HEAD hashes are:

- `loop-fork/src/loop/tmux-control.ts`: working tree
  `9f9edd3754f7a40c8810d3cd41dc534ea1e68b9ee1a1efc412dbe3737f1ccb67`;
  HEAD `6472d6dc779ab242421df3e3d1ee42d23f10bd9de78ec4f8c815d49d2dcab86d`.
- `loop-fork/tests/loop/tmux-control.test.ts`: working tree
  `f1796fe75b99ab61a6c5bb0538e56422c7781f4250e73a40a9b02939474117eb`;
  HEAD `480c9a674ade563f832e611d6a90c18840e1baf85d400980d928365f94a720ed`.

Before `apply_task_patch`, confirm every guarded preimage equals the listed
working-tree hash, never the HEAD hash. A HEAD-based patch would discard prior
uncommitted work and must be rejected even if plain Git can apply it.

**Next bounded action:** produce a fresh valid risk-C guarded patch against the
live two-file preimages, require `git apply --check`, apply through the guarded
path, and run focused tmux-control tests. Then implement F2 at accepted A1-A3
boundary and migrate all nine old session-liveness callers atomically. Preserve
paired `runInTmux` attach/hint argv until disk-backed `ManifestHandle` fixtures
land. Verify 10 remains open at its separate six named sites.
If a reissued helper remains non-terminal after five polls spaced about ten
seconds apart, escalate to Governess for cancel/reissue. Treat its write
reservation as released only after an explicit Governess terminal state, never
because the channel is quiet.

---

## Run 16 (2026-08-08) — SUPERSEDED by Run 18

Governess message `a759fff3-70df-4ef4-b59e-9b77987ea6c2` requested a fresh-loop
handover at the context threshold. No F2 or liveness-cascade source/test edit
started. All predecessor work remains preserved and uncommitted.

**Continuity verified directly.** Charter SHA-256 matched
`0ab2441448b9d1366acc2698480a1dcf5a68ea38bff190a19052fe4489949ddc`.
Run-15 handoff component digests matched `manifest.json`; HEAD remains
`ddf134b9200a3fda3cac68dcdd7868f28c94160d`. World-model file and capsule
hashes matched, but its JSON had no repository-commit field, so it was treated
as unusable and Git/handoff/transcript evidence was inspected directly.

**Current atomic step result: F1 remains open; no patch was bypassed.**

- First F1 edit task `90b577e4-5b8e-499f-a11b-caf671a7c5c0` returned logical
  content with a malformed hunk count. Guarded apply and `git apply --check`
  both rejected it: `patch does not apply`.
- Correction task `793694f6-7d0e-4402-a52b-6599edcde31a` declared the exact
  live preimage
  `d8793c89defa77e06b1e0362ad7471c6f87b92fee495536f19687b306f9ff299`,
  but its artifact `db746626fd7bcf4ff34cadb10fe06f5ea791d14b5086b89b5e70e344db88b39c`
  also fails `git apply --check` at the confinement hunk. It was not applied.
- F2 edit route `fca32cae-204a-4c81-a77e-43542ba92045` returned to the driver
  as `risk-not-low`; no F2 edit was made.
- Two read-only liveness audits were rejected with exact error
  `route_task utility packet is not deterministically bounded`; direct
  inspection confirmed the Run-15 call-site inventory remains accurate.

**Peer answer consumed.** Claude message
`92566b55-09db-41c5-bf4c-6b85672935d8` confirms F2 is non-paired-only and all
nine listed session-liveness call sites remain one atomic T-05 cascade. Three
scope corrections are binding: the non-paired attach hint is already fixed and
is not F2; `probeHandoffSession` keeps its confirmed-missing predicate and only
its argv/socket plumbing changes; named-socket missing versus unrelated stderr
needs its own test. Paired argv remains deferred to disk-backed manifest-handle
fixture work. Verify 10 remains open at its separate six named sites.

**Liveness decision (Claude risk C): tighten in-slice.** When the nine callers
move to `tmuxTargetLiveness` / `tmuxTargetLivenessAsync`, `"dead"` will require
confirmed-missing stderr from the manifest-derived socket. Unrecognised nonzero
errors remain `"unknown"`; timeout and absent target remain `"unknown"`.
Tests must name confirmed-missing session, no-server-on-named-socket,
unrecognised stderr, and timeout. Landing the cascade with the current
any-nonzero-means-dead predicate is not accepted.

**Next bounded action:** land F1 through a fresh valid guarded patch; implement
F2 at Claude's corrected A1-A3 boundary; tighten target-bound liveness as
decided; then land all nine cascade sites atomically. Do not reimplement W2.
Preserve paired layout behavior and keep verify 10 open at its six named sites.

Current settled W2 hashes remain unchanged:

- `loop-fork/src/loop/tmux.ts` —
  `1a9a8a98da43fd4e7da835b727caa59957778ad8a4b0b53a422d9d6c44adfa44`
- `loop-fork/tests/loop/tmux.test.ts` —
  `6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20`
- `loop-fork/tests/loop/tmux-socket.test.ts` —
  `d8793c89defa77e06b1e0362ad7471c6f87b92fee495536f19687b306f9ff299`

---

## Run 15 (2026-08-08) — SUPERSEDED by Run 18

Review request `36377404-db4a-4684-85c8-d544f56a8b2d` got Claude PASS in
`d2b9db67-2403-460f-b15a-e24057172125`. Live W2 hashes exactly matched the
current tables below. Independent clean-env suite: **1706 pass / 0 fail / 0
skip**. Do not reimplement W2.

**F1 (medium):** confinement guard is non-recursive; must cover all
`loop-fork/src`.

**F2 (high):** non-paired `probeHandoffSession`, `keepSessionAttached`, and
interactive attach omit `-S`; classify as existing T-05 remainder + verify 12,
not paired band.

**Next bounded action:** implement F1/F2 with target-bound T-05
liveness/attach cascade; preserve paired band and verify 10 six-site tracking.

**Review provenance** (Claude ack `1a9cd48f-6a61-4e32-82f7-7cc35698a74c`):

1. **F1 detail:** `tmux-socket.test.ts:572` scans `src/loop` non-recursively
   and misses `src/loop/hooks` plus top-level `src/*.ts` including `cli.ts`,
   `claude-loop.ts`, `codex-loop.ts`, `oss-loop.ts`, `install.ts`; invariant
   is currently true by repo-wide grep, so guard hole not live violation;
   fix recurse from `src`.

2. **F2 detail:** `tmux.test.ts:415` has socketless `has-session`,
   `calls[2]` socketless `set-window-option`, `defaultDeps.attach`
   `tmux.ts:3727-3736` socketless attach, and `runInTmux` call sites
   `4011/4035/4065` cannot carry socket; under `LOOP_TMUX_SOCKET` or
   `TMUX_TMPDIR` this contacts default server after named-socket creation.
   Decision: F2 is explicit named per-site work in existing T-05 remainder
   plus verify 12, not paired band and not folded into 64-literal count.

3. Claude did not re-run Codex seeded writes because review barred edits;
   Claude verified non-vacuity structurally, while executed
   `Expected 1/Received 2` and `Expected 2/Received 3` evidence belongs to
   Codex.

4. Tooling failures: `route_task` rejected bounded packets with exact errors
   `route_task command packet is not deterministically executable` and
   `route_task utility packet is not deterministically bounded` under
   relative and absolute paths; helper routes
   `79084a28-3e8e-4f60-be6b-679ad0592a59` and
   `bed3ed43-b199-49c6-aeb2-3d624fd5e58c` returned utility-unavailable;
   Claude completed reads natively. Attribute independent 1706/0/0 to Claude
   where existing wording is ambiguous.

---

Defect: `adc4bb8a-4b7b-4245-832f-a1995076b6b1` (confirmed).
Branch: `codex/tmux-socket-normalization-run11`.
Worktree: `/private/tmp/agents-collab-tmux-socket-normalization-run11` (isolated run-11).
Base commit: `ddf134b9200a3fda3cac68dcdd7868f28c94160d` — exact merged `main`,
resolved this session with
`git rev-parse --verify ddf134b9200a3fda3cac68dcdd7868f28c94160d^{commit}`
(printed the full SHA, so the binding resolves).
Installed binary under test: `/Users/amgad/.local/bin/loop`,
`shasum -a 256` = `9ca9f74fa66e1ea0dd2a1a821e0db4e000b64b84aa1903b3db40f820a5fc93f1`
— matches the pinned SHA-256 in the assignment, verified this session.
Anticipated change scope after approval: `loop-fork/src/`, `loop-fork/tests/`,
root `specs/tmux-socket-normalization/`, `evals/smoke/`, `scripts/verify.sh`, the
new migration-check script, `docs/dependency-map.md`, and
`runs/tmux-socket-normalization/`. `status.md` already exists and records plan
mode; it must be updated when implementation starts. Product `loop-fork/runs/`
evidence remains read-only.

Supersedes the previous plan for `claude-kickoff-submit-guard`, which shipped on
`codex/claude-kickoff-submit-guard` and is merged in `ddf134b9`.

## State as of Run 14 (superseded by Run 18 above; hashes re-verified live)

**IMPLEMENTATION IN PROGRESS — run 14, 2026-08-08.** The approval gate is
CLEARED (peer review round 3 PASS plus founder approval; see the human-approval
package below). T-00 through T-04 are COMPLETE and peer-PASSed, T-05
slices 1 and 2 have landed, and the W2/A2 non-paired launch-window wiring is
complete and green. Everything in
this section below the run-14 block is the pre-approval record, kept for
provenance and no longer a description of current state.

### Graceful handover — W2/A2 complete, uncommitted

Codex completed the fixture-scoped non-paired wiring and stopped at the
governess boundary. `runInTmux` resolves the launch socket once, reuses it for
the explicit-ID pre-probe, every non-paired creation/retry, and the attach hint,
and leaves the paired layout band unchanged. The hostile-ambient, explicit
failure, and derived import/call-scope guards are present. Exact current hashes:

- `loop-fork/src/loop/tmux.ts` —
  `1a9a8a98da43fd4e7da835b727caa59957778ad8a4b0b53a422d9d6c44adfa44`
- `loop-fork/tests/loop/tmux.test.ts` —
  `6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20`
- `loop-fork/tests/loop/tmux-socket.test.ts` —
  `d8793c89defa77e06b1e0362ad7471c6f87b92fee495536f19687b306f9ff299`

Clean-environment full suite: **1706 pass / 0 fail**. Documented source
typecheck and `bun run check` pass; normal and whitespace-insensitive numstat
agree; all 1,582 `loop-fork/runs/` files remain byte-identical. Both requested
seeded defects failed their named guard and were restored. Independent review
request `d89784cd-7189-4bf7-9755-d61c21096bfc` is queued but was unread when the
graceful handover began.

**Next fresh-loop action:** validate the three hashes and consume or re-request
independent review of W2/A2. Do not redo the slice. Once reviewed, continue the
already-open T-05/T-06 sequencing below; verify 10's six named fail-open sites,
paired attach-hint fixtures, consumer plumbing, and T-11 onward remain open.

### Run 14 — T-00…T-04 complete, T-05 slices 1–2 landed (uncommitted)

Full detail, evidence, and the correction record live in `status.md`. The table
below is the original T-01/T-02 snapshot, kept for provenance; **its hashes are
superseded** — `status.md` carries the current ones.

| Path | SHA-256 | State |
|---|---|---|
| `runs/tmux-socket-normalization/environment-probes.sh` | `d5b6a7083a76657e56dd12cf187d15853cfd9acd786b883a4eda1c129616ac70` | new |
| `runs/tmux-socket-normalization/environment-probes.txt` | `3b33078426d48ffe202f4d0b30905fea10048ec9de6e7d3fd965350a9ac4b95b` | new |
| `loop-fork/src/loop/tmux-socket.ts` | `0cbf8b40ebe3a1f59ba9eb1da3d46a8692d1cc5402267be0dd88a394e0baf02a` | new |
| `loop-fork/tests/loop/tmux-socket.test.ts` | `e434975fdd4bca0defa06a65d06a7fa435baf6fb6d20db9a23e28114d78e45cf` | new |

**T-01 measured (tmux 3.7b, Darwin 25.5.0 arm64, uid 501).** `-S` beats `-L`;
`$TMUX` is `<socket>,<pid>,<session-index>`; parse-from-right is required
because a first-field parse truncates `…/so,ck-c` to `…/so`; the Darwin budget
is 103 usable bytes (104 fails `File name too long`). Teardown killed by
explicit socket path only, with a non-vacuous zero-survivor proof.

Measured en route and relevant to T-14: `tmux -S <path> start-server` with no
session creates the socket file but the **server exits immediately**, so a
certification smoke cannot hold a server open with `start-server` alone.

**T-02 landed** with the chokepoint module and 34 focused tests. Verified:
documented `tsc` invocation clean, `bun test` 34 pass / 0 fail, `biome check`
clean. The verify-5a negative type tests were proven **non-vacuous** in a
temporary tree — stripping the three directives yields `TS2554`, `TS2741`
(missing `[targetBrand]`), and `TS2345`.

Two fail-opens were found and fixed **in the tests themselves**: prose
containing the literal expect-error token is parsed by TypeScript as a real
directive, and the formatter re-wrapping an inline object literal moves the
suppressed error off the directive's line. Both silently degrade an assertion
into an unused directive.

**ROLE: Claude is reviewer as of 2026-08-08; Codex drives.** The next action
below belongs to the DRIVER, not to this file's author.

**Next bounded action after W2 review:** T-05 remainder, in this order.
1. Target-bound liveness — the signature cascade reaching 7 modules
   (`governess.ts:6485,6571`, `governess-replay.ts:325`,
   `bridge-runtime.ts:1101,1164`, `codex-tmux-proxy.ts:219,407,982`,
   `paired-options.ts:55`, `launch-reservation.ts:80`). Must land as one piece:
   changing `tmux-control.ts`'s signature alone breaks all of them at once.
2. Attach-hint rework (verify 12). Blocked on test fixtures, not on design: the
   hint needs a `ManifestHandle`, whose sole producer reads from **disk**, so
   the four affected `runInTmux` tests need real on-disk manifests instead of
   in-memory fakes at non-existent paths.
3. Then T-06 onward. Verify 10 stays **open** until all six named fail-open
   sites are migrated with per-site named tests.

### Pre-approval record (superseded by the block above)

**Plan and spec only. No implementation has started and none may start until
the approval gate clears.** `git status --short loop-fork | wc -l` = 0.

The spec bundle `specs/tmux-socket-normalization/{spec,plan,tasks,verify}.md`
is written and has been revised once against peer review round 1
(`6a4ed303`, verdict REVISE, fully consumed).

**Review round 2 returned REVISE** (`2323058d-2a99-44f2-92eb-978950fb3d59`).
Finding 2 (skip-record schema and sink), panel row states, legacy disposition,
pane subordinate design, and the Linux labelled inference are all **closed**.

> **AS RAISED in round 2 — three residual gaps, all one theme: provenance was
> asserted but not enforced by API shape.** Preserved verbatim as the record of
> what was asked; each is answered directly below.
>
> - **A.** `tmuxArgv(socket, args)` is still socket-bound, so a valid socket
>   from run B can be composed with args naming run A. Make it target-bound, or
>   make socket-only composition private/unexported with derived enforcement.
> - **B.** verify 5 promises `targetFromManifest` rejects an A-manifest/B-socket
>   pairing, but a same-object field swap cannot be detected without a registry,
>   signature, or provenance token. Either assert the API has no second socket
>   argument, or define a real immutable handle.
> - **C.** Pane operations shaped `(TmuxTarget, paneId)` still permit pairing
>   target A with pane B. Require an owning manifest or opaque `OwnedPaneTarget`.

**Closed in run 12; review round 3 subsequently returned PASS.** All three took the
enforce-by-shape branch rather than the assert-harder branch:

- **A closed.** Socket-only `tmuxArgv` is now module-private and unexported.
  The exported composition surface is the target-bound trio `targetArgv` /
  `paneArgv` / `serverArgv`, which supply every target-naming flag themselves
  and reject a caller-supplied `-S`/`-t`/`-s` in `args`. R12 gains two derived
  rules that keep the boundary real: no import or re-export of the private
  helper outside `tmux-socket.ts`, and no target flag in an argv literal outside
  it. (R3, R12; verify 6.)
- **B closed, and narrowed to what is actually checkable.** `ManifestHandle` is
  an opaque frozen handle stamped by the manifest read path with `runId`,
  manifest pathname, and the SHA-256 of the bytes read.
  `targetFromManifest(handle)` takes **exactly one parameter**, so the
  A-manifest/B-socket pairing is *unconstructible* rather than
  detected-and-rejected — which is the honest form, since one plain object
  cannot reveal a same-object field swap. Verify 5 splits into 5a
  (constructibility bound, `@ts-expect-error` plus runtime
  `TmuxTargetProvenanceError`), 5b (cross-run non-contact against two real
  servers), and 5c (the tampered-manifest residual, **recorded rather than
  claimed as covered**). (R3, R6; verify 5.)
- **C closed.** `OwnedPaneTarget` is opaque with no public constructor;
  `paneTargetFromManifest(handle, field)` is the only production constructor and
  yields nothing when the handle's socket or session is unknown. Every
  pane-effecting signature takes it, so `(TmuxTarget, paneId)` and a bare
  `paneId: string` are compile errors and a third derived-check violation.
  Atomic clearing becomes the second line of defence, not the only one.
  (R10, R12; verify 3.)

Revised scope: R3, R6, R10, R12; verify 3, 5, 6; T-02, T-05, T-10, T-11; plus
the acceptance-criteria mapping and `specs/.../plan.md` decisions. `status.md`
carries the full round-2 findings text, exact changed scope with hashes,
blockers, and the next bounded action.

Two design points below were strengthened by review round 1 and are marked
inline where they appear: the target is opaque and manifest-derived (Design 2,
Decision 5), and fail-closed skips emit a structured record to an injected sink
(Design 4). Design 2's composer signature and the pane-operation shape, which
round 2 rejected, are now revised as above. Sequencing step 2's approval gate is
still open, and the human legacy-manifest sign-off is still ungiven.
**[DISCHARGED 2026-08-08 — round 3 PASS plus founder approval; see the run-14
block at the top of this file.]**

## Defect

Every tmux invocation in the product resolves its server from ambient
environment (`TMUX_TMPDIR`, `TMUX`, the default `/tmp/tmux-$(id -u)/default`).
Nothing records which server a run was actually created on. The manifest stores
only a session *name* (`tmuxSession`), which is meaningless without the socket
it lives on. A launcher run started under one ambient socket and a control-plane
consumer run under another look at two different servers, and the consumer
concludes the session does not exist.

### Verified: no socket identity exists anywhere in the product

`grep -rn '"-S"' --include='*.ts' src` in `loop-fork/` returns **nothing**. The
only socket isolation in the repo is a test-only PATH shim,
`evals/smoke/fixtures/isolated-tmux.sh`, which injects `-L
"${LOOP_SMOKE_TMUX_SOCKET}"` in front of the product's argv. Production code has
no socket concept at all.

### Verified: the ambient split turns into destructive fail-open, not just a bad read

Three consumers convert "not on *my* ambient server" into a positive
"dead/absent" verdict and then act on it:

1. `loop-fork/src/loop/claude-config-gc.ts:72` `defaultTmuxSessionAlive`
   returns `false` — not `undefined` — whenever `tmux has-session` exits
   nonzero. Only a `signalCode` (timeout) yields `undefined`. A live run on
   another socket therefore reads as dead and its Claude config is garbage
   collected out from under it.
2. `loop-fork/src/loop/run-process-cleanup.ts:93` `defaultListTmuxSessions`
   maps stderr containing `no server running` to an **empty set**, i.e. "there
   are no tmux sessions". Every loop run then looks orphaned and its processes
   are eligible for cleanup, while the real sessions are alive on the other
   socket.
3. `loop-fork/src/loop/tmux-control.ts:43,64` `tmuxSessionLiveness` /
   `tmuxSessionLivenessAsync` return `"dead"` on any nonzero exit. This feeds
   `launch-reservation.ts:99-110,202-208` (the active-launch interlock, which
   then permits a second concurrent launch against a live workspace) and
   `codex-tmux-proxy.ts:219-248` (which shuts the proxy down with
   `reason: "dead-tmux"` while the workspace is running).

`panel.ts:848` (`list-sessions`) and `governess-replay.ts:64`
(`list-panes`) have the same blindness in the read-only direction, and
`panel.ts:1169` / `tmux.ts:3602,4024` print `tmux attach -t <session>` with no
socket, which is exactly the non-attachable instruction the defect names.

### Verified: complete consumer inventory (derived, not hand-listed)

`grep -rEn '(\[|\()\s*"tmux"' --include='*.ts' src | sed 's/:[0-9]*:.*//' | sort -u`
yields exactly ten files that build a tmux argv:

```
src/install.ts
src/loop/bridge-runtime.ts
src/loop/claude-config-gc.ts
src/loop/governess-pane-liveness.ts
src/loop/governess-replay.ts
src/loop/governess.ts
src/loop/panel.ts
src/loop/run-process-cleanup.ts
src/loop/tmux-control.ts
src/loop/tmux.ts
```

The argv inventory is necessary but not sufficient. **Four** naming conventions
carry tmux identity, and three of them are invisible to a field-name grep. Full
detail and exact line anchors are in `spec.md`; summarised here:

1. `tmuxSession` / `tmux_session` — thirteen files.
2. `replacementSession` — `governess-handoff.ts:38,224,244`,
   `governess-exit.ts:14,60-63,96`, and `governess-replay.ts:307`.
   `governess-exit.ts:87` treats a persisted *name* as sufficient identity.
3. Bare positional `session: string` on shared APIs, which no field-name grep
   finds — `tmux-control.ts:44,65`, `panel.ts:37,70,756`, `paired-options.ts:64`,
   `governess-pane-liveness.ts:44,50,61,180`, `governess.ts:283`,
   `governess-exit.ts:28`, and ~16 sites in `tmux.ts`.
4. **Persisted pane identity**, not previously named by anyone:
   `run-state.ts:124-132` and `217-225` persist `tmuxPaneAuPair`,
   `tmuxPaneGoverness`, `tmuxPaneLeft`, `tmuxPaneNanny`, `tmuxPaneRecon`
   (`string[]`), `tmuxPaneRight`, `tmuxPaneUtility` beside `tmuxSession`.

Excluded after checking: `sessionRef` is an LLM usage-transcript reference
(`governess.ts:213`), not a tmux session.

`BridgeStatus` publishes only `tmuxSession`. These are cross-module identity
seams, not harmless display data. That a hand-derived grep missed a real seam
twice is the argument for the derived check below.

The migration must be enforced by derived checks, not by either hand-written
list. Checks must cover both Bun array invocation (`["tmux", ...]`) and Node
command/args invocation (`spawn("tmux", [...])`), plus session-only calls to
the shared liveness API. A seeded violation for each invocation form proves
the checks are non-vacuous.

## Design

### 1. Persist an explicit absolute socket path

Add `tmuxSocket?: string` to `RunManifest`, `RunManifestInput`, manifest
creation/update paths, and the read path in `run-state.ts`, with
`tmuxSocket`/`tmux_socket` read compatibility and canonical `tmuxSocket` writes.
Add manifest round-trip tests for creation, update, camel-case read, snake-case
read, and preservation through unrelated updates.

The value is an **absolute filesystem path** to the tmux socket, e.g.
`/private/tmp/loop-smoke-x/tmux/tmux-501/default`, and it is passed as
`tmux -S <path>`.

Absolute path, not `-L <label>`: `-L` is resolved against `TMUX_TMPDIR` at each
invocation, so a label is still ambient-dependent and would not fix the defect.
`-S` is the only fully explicit form. Empty, relative, NUL-containing,
over-budget, or conflicting camel/snake socket values are unusable identity and
must enter the same observable unknown/fail-closed path as a missing legacy
value; they must never be resolved relative to a consumer's cwd.

### 2. One chokepoint

New module `loop-fork/src/loop/tmux-socket.ts` owning:

- `resolveTmuxSocket(env)` — launch-time resolution (rules below). Not reachable
  from any post-launch consumer path.
- a branded validated absolute socket value and an **opaque** `TmuxTarget`
  identity carrying `{ socket, session }`, so session-only APIs cannot
  accidentally cross servers. **Peer review, round 1:** branding the socket is
  necessary but not sufficient — a *valid* socket can still be paired with
  another run's session, or sourced from hostile ambient state, and no static
  check can prove runtime provenance. `TmuxTarget` therefore has **no public
  constructor**. **Round 2 (gap B), revised:** its only production constructor
  is `targetFromManifest(handle)`, taking **exactly one parameter** — an opaque
  frozen `ManifestHandle` stamped by the manifest read path with `runId`,
  manifest pathname, and the SHA-256 of the bytes read. One parameter and no
  socket parameter anywhere public makes an A-manifest/B-socket target
  *unconstructible*; an unbranded plain object throws
  `TmuxTargetProvenanceError`. This replaces the round-1 wording, which asked
  `targetFromManifest` to *detect* a same-object field swap it cannot see;
- an **opaque** `OwnedPaneTarget`, **round 2 (gap C)**, with no public
  constructor and `paneTargetFromManifest(handle, field)` as its only production
  constructor, yielding nothing when the handle's socket or session is unknown.
  Every pane-effecting signature takes it, so `(TmuxTarget, paneId)` and a bare
  `paneId: string` do not compile;
- `TmuxSkipRecord` plus an injected recorder/sink — the observable form of every
  fail-closed skip, carrying `consumer`, run identity, `session`/`pane` or
  explicit absence, `socketState`, `reason`, and `effectSkipped`;
- the target-bound composition trio `targetArgv(target, verb, args?)`,
  `paneArgv(ownedPane, verb, args?)`, and `serverArgv(target, verb, args?)` —
  the only exported helpers allowed to compose a server-contacting tmux
  command. Each emits `["tmux", "-S", socket, ...]` for Bun, splits into
  command/args for Node `spawn` without dropping `-S`, supplies every
  target-naming flag itself, and rejects a caller-supplied `-S`/`-t`/`-s`.
  **Round 2 (gap A), revised:** socket-only `tmuxArgv(socket, args)` is kept
  **module-private and unexported**, because `tmuxArgv(socketB, ["has-session",
  "-t", sessionA])` type-checks and would reintroduce the defect one layer down;
- `tmuxAttachCommand(target)` — shell-escapes both socket and session and is the
  only attach-hint formatter;
- `TmuxSocketUnknownError` — the fail-closed signal for legacy targeting;
- `TmuxTargetProvenanceError` — thrown when an unbranded object reaches
  `targetFromManifest`.

Every server-contacting invocation routes through one of the three exported
composers, and all shared liveness/control APIs accept a `TmuxTarget` or an
`OwnedPaneTarget`, never a bare session and never a socket plus a
caller-supplied `-t`.
`install.ts`'s bounded `tmux -V` is not a server consumer and remains the sole
audited direct invocation exception; forcing launch-time socket resolution into
installation would create a false dependency and would not improve isolation.
The migration checker permits only that exact `tmux -V` probe and proves a
second direct invocation in `install.ts` still fails.

### 3. Resolution rules at launch (preserves intentional override)

In precedence order, resolved **once** per run and then persisted:

1. `LOOP_TMUX_SOCKET` — explicit operator override. Must be absolute; a
   relative value is a hard launch error, never silently resolved.
2. `$TMUX` is set (we are launching from inside tmux) — parse the socket path
   by removing the final two comma-delimited tmux metadata fields, preserving a
   legal comma in the socket pathname. A malformed, relative, or empty parsed
   path is a hard launch error, not permission to fall back to another server.
   This keeps a run launched from inside an operator's custom-socket server on
   that same server.
3. Otherwise the platform default, computed from the ambient environment at
   that moment: `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/default`, then `resolve()`d.

Rule 3 is what preserves compatibility with an operator who intentionally
exports `TMUX_TMPDIR`: their choice is still honoured, it is just **frozen and
recorded** instead of re-read by every later consumer.

Socket paths are bounded by platform `sun_path`: 103 usable pathname bytes on
Darwin and 107 on Linux after the terminating NUL. Validation uses UTF-8 byte
length, not JavaScript character count, rejects embedded NUL, and reports byte
length and platform limit. Resolution fails before manifest reservation or
tmux creation, avoiding a durable active-looking run with an unusable socket.
`evals/smoke/large-prompt-launch.sh` already carries a Darwin-only character
count assertion; migrate it to the same byte-based property used by the
producer.

Fresh launches resolve once before the early manifest binding and persist the
socket with the deterministic session identity. Resume/reattach and all hidden
control-plane commands use the manifest value and ignore later
`LOOP_TMUX_SOCKET`, `TMUX`, and `TMUX_TMPDIR`. An active manifest with a session
but no usable socket is legacy/ambiguous and blocks resume or duplicate launch.
An existing socket-bearing manifest is never overwritten by current ambient
state.

### 4. Fail closed for ambiguous legacy targeting

A manifest with `tmuxSession` but no usable `tmuxSocket` is **ambiguous**, not
implicitly ambient. Consumers must not guess. This applies to reads and effects:
`has-session`, `list-panes`, `capture-pane`, `send-keys`, buffer operations,
pane respawn, session kill, attach, proxy shutdown, stale-state clearing, and
handover/replacement probes.

- Liveness readers return `"unknown"` — never `"dead"`.
- `claude-config-gc` and `run-process-cleanup` treat `undefined`/`unknown` as
  "do not touch" and skip, logging the skip. Their current
  nonzero-exit-means-dead and `no server running`-means-empty-set branches are
  removed for socket-bearing manifests and made non-destructive for legacy ones.
- `launch-reservation` refuses the launch on `"unknown"` (it already refuses on
  `"unknown"` at :205; the change is that a cross-socket miss now *produces*
  `"unknown"` instead of `"dead"`).
- Bridge delivery stays durably queued and does not issue tmux commands when
  target socket is unknown. Governess does not respawn, send, replay, tear down,
  or accept a handover from session-only evidence. Proxy liveness receives the
  manifest target and preserves the proxy on unknown.
- Attach hints are only printed with `-S`; a legacy manifest prints an explicit
  "socket unknown, cannot compose an attach command" line rather than a
  command that will silently target the wrong server.

Per the global evidence rule, a skip is a fail-open unless it is observable:
every fail-closed skip emits a record, and a test asserts the record.
**Peer review, round 1:** "emits a record" was underspecified — an unstructured
log line is untestable and can disappear in production, which turns the
fail-closed skip back into a fail-open. The record is now the structured
`TmuxSkipRecord` above, delivered to an injected sink, asserted **by field** per
consumer. A skip must never be inferred by scraping rendered terminal output;
this run produced direct evidence of a monitor misreading rendered type-ahead
text as real content.

### 5. Server-scoped enumeration and secondary identity seams

`run-process-cleanup` must no longer compare every manifest against one ambient
server-wide set of session names. It groups valid manifests by socket (or probes
each `TmuxTarget`), keys results by `(socket, session)`, treats a command failure
as unknown for affected targets, and preserves every missing/invalid-socket
manifest with an observable reason. Same session name on two sockets is not a
collision.

Panel enumeration uses only the deduplicated set of valid socket paths found in
run manifests. It does not add an ambient default, because doing so would
reintroduce guessing and cannot recover a legacy session's identity. Rows and
attach hints retain socket identity; legacy rows are rendered as unknown and
non-attachable. One failed socket query does not erase rows from other known
sockets and is surfaced as partial/unknown evidence.

`BridgeStatus` carries `tmuxSocket`/known-target state alongside
`tmuxSession`. Governess handover state and replay must carry or resolve the
replacement target's socket, not persist/probe only a replacement session
name. Pane ownership revalidation includes socket as well as session and pane.
Clearing stale tmux topology clears `tmuxSocket` atomically with session/panes.

### 6. Test-shim migration (hazard, must land in the same change)

`evals/smoke/fixtures/isolated-tmux.sh` prepends `-L`. Once the product emits
`-S`, tmux receives both. tmux resolves `-S` in preference to `-L`, so the shim
would be silently defeated and the smokes would start touching a shared server.
All smoke call sites therefore switch from label-valued
`LOOP_SMOKE_TMUX_SOCKET`/the `-L` shim to setting product
`LOOP_TMUX_SOCKET` to an absolute socket path and using real tmux `-S` for
inspection and cleanup. Search covers `large-prompt-launch.sh`,
`active-launch-interlock.sh`, `paste-submit-readiness.sh`, and any additional
derived call sites. A task explicitly *verifies* the
`-L` vs `-S` precedence empirically (`tmux -L a -S <path> start-server` then
`ls <path>`) rather than trusting the reading above.

## Decisions

1. **Absolute `-S` path, not `-L` label.** A label is re-resolved against
   ambient `TMUX_TMPDIR` on every call, so it does not close the defect.
2. **Resolve once, persist, never re-derive.** Any consumer that recomputes the
   socket from environment reintroduces the split. The manifest is the single
   source of truth after launch.
3. **Legacy manifests are `unknown`, never `dead`.** The current code's
   nonzero-exit-means-dead is the destructive half of this defect; converting
   the miss to `unknown` is the fix, and `unknown` must block destructive paths.
4. **`$TMUX` inheritance is honoured, ambient re-read is not.** Launching from
   inside a server is an intentional override and stays supported; silently
   re-reading `TMUX_TMPDIR` in a consumer is the bug and is removed.
5. **Identity is an opaque, manifest-derived pair.** Shared APIs carry a
   validated socket with session/pane operations. This prevents migration from
   adding `-S` while still allowing callers to pass the wrong run's socket.
   Strengthened after peer review round 1: the pair has no public constructor
   and is built only by `targetFromManifest`, because a validated socket paired
   with the wrong session is still a cross-server call, and the derived checker
   (Decision 6) structurally cannot catch it. Strengthened again after round 2:
   `targetFromManifest(handle)` takes one opaque `ManifestHandle` and nothing
   else, so the wrong pairing is unconstructible rather than rejected at
   runtime; composition is target-bound, with socket-only `tmuxArgv` private;
   and persisted pane fields, while still subordinate to `(socket, session)` and
   cleared atomically, are now reachable only through an opaque
   `OwnedPaneTarget`. Round 2's objection was exactly that the previous
   subordination invariant was caller discipline; it is now a type.
6. **The migration is enforced by derived checks.** `scripts/` gains a check
   that catches Bun-array and Node command/args direct invocations, bare-session
   shared liveness calls, and unqualified attach hints, plus the three
   round-2 API-shape rules: private `tmuxArgv` never imported or re-exported
   outside `tmux-socket.ts`, no target-naming flag in an argv literal outside
   it, and no pane-effecting signature taking a bare pane id. Each of the three
   carries its own independently nonzero seeded violation. It is wired into
   `scripts/verify.sh`; exact `install.ts` `tmux -V` is the only audited
   non-server exception.
7. **Regressions are producer-backed and use two real servers.** A single-server
   test cannot observe this defect at all — that is precisely why it shipped.
8. **`install.ts` symlink-output defect stays out of scope**, per the
   assignment. No install output, alias, symlink, or copy behavior changes;
   bounded `tmux -V` remains socket-independent.

## Acceptance criteria

To be written as `specs/tmux-socket-normalization/verify.md` and numbered there.
The properties, stated now so the spec cannot drift from them:

1. Resolution precedence is `LOOP_TMUX_SOCKET`, then parsed `$TMUX`, then
   `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/default`; each successful result is absolute.
   `LOOP_TMUX_SOCKET` overrides `$TMUX`. A socket pathname containing a comma in
   `$TMUX` is preserved by parsing from the right.
2. Empty, malformed, relative, NUL-containing, and over-budget launch values
   fail before manifest reservation/tmux creation. Byte-length boundary tests
   cover Darwin and Linux limits and include a multibyte path.
3. Manifest create/read/update round trips preserve canonical `tmuxSocket`;
   snake-case legacy input is accepted only when unambiguous. Missing, invalid,
   or conflicting socket fields become explicit unknown targeting.
4. A producer-backed completed launch writes `tmuxSocket` as the exact absolute
   socket A path, and that socket exists. Early manifest inspection proves the
   socket is bound with `tmuxSession` before the first asynchronous startup
   boundary. Failed startup retains both identities for bounded cleanup.
5. Resume/reattach uses the persisted socket. A legacy active manifest blocks
   resume and duplicate launch; hostile consumer ambient values cannot rewrite
   the manifest socket.
6. Derived migration checks report no server-contacting direct tmux invocation,
   bare-session liveness call, or unqualified attach formatter. Seeded Bun-array,
   Node command/args, and install-file violations each make the checker fail;
   exact bounded `tmux -V` remains accepted.
7. Producer-backed two-server regression creates real servers A and B, with a
   same-named decoy session on B. Product launch creates the real run on A.
   Consumers run with `LOOP_TMUX_SOCKET`, `TMUX`, and `TMUX_TMPDIR` all pointing
   at B, yet read/capture/send/bridge/liveness operations reach only A by using
   the manifest target. Decoy B content remains unchanged.
8. Consumer matrix has named assertions for `tmux.ts` launch/resume/attach,
   `tmux-control`, bridge capture/send/buffer paths and status schema,
   `claude-config-gc`, `run-process-cleanup`, `launch-reservation`,
   `codex-tmux-proxy`, `paired-options`, panel enumeration,
   `governess-pane-liveness`, Governess effects, handover, and replay. Each
   assertion identifies invoked socket, result, and prohibited side effect;
   “every consumer” is not certified by one shared-helper assertion.
9. Destructive two-server direction proves `claude-config-gc` does not remove A
   registration, `run-process-cleanup` does not signal A-owned PIDs or mark its
   manifest failed, launch reservation does not admit a duplicate, proxy does
   not stop, bridge stale-state cleanup does not clear topology, and Governess
   does not kill/respawn on B-derived evidence.
10. Legacy/invalid manifest targeting yields `unknown` from every liveness
    reader, blocks launch/resume/handover acceptance, queues bridge delivery,
    skips both GC paths and all tmux effects, preserves manifest/process state,
    and emits a consumer-specific skip record. Assertions are per consumer.
11. Server-scoped enumeration keys by `(socket, session)`: same-name sessions
    on A and B remain distinct, panel rows include qualified attach commands,
    cleanup evaluates each manifest against its own server, and one unavailable
    server cannot produce a dead verdict for another.
12. All attach hints and interactive attach argv include shell-safe
    `-S <socket> -t <session>`. Spaces and shell metacharacters round trip as
    data. Legacy rows print an explicit unknown-socket line and no attach command.
13. `-L` versus `-S` precedence is verified empirically and recorded. All smoke
    call sites use absolute `-S` identities; a repository search proves the old
    product-facing label shim is gone or no longer on product PATH.
14. Fixture provenance: new-path integration evidence comes from the compiled
    product producer and records binary SHA-256, tmux version, capture command,
    UTC time, environment, and manifest SHA-256. Legacy fixtures are generated
    deterministically by removing only `tmuxSocket` from producer output and
    record source/derived hashes; hand-authored fixtures cannot certify the seam.
15. Cleanup trap is installed before server/process creation and runs on success,
    assertion failure, and signal. It records server PIDs and every run-owned
    launcher/pane/bridge/proxy/app-server PID before teardown; kills both servers;
    removes both socket files and temporary roots; then polls every recorded PID
    with a bounded deadline and fails if any survives.
16. Zero-survivor proof is non-vacuous: it fails when no server and no run-owned
    PID were recorded, and a positive control using a known-live recorded PID
    demonstrates survivor detection before real cleanup. Post-cleanup proof
    requires no live recorded PID, no A/B socket, no sessions on either explicit
    socket, and no touched host/product run path.
17. Existing bounded-control timeout semantics remain: timeout/error is unknown,
    interactive attach alone remains unbounded, and every non-interactive tmux
    command retains a finite kill-on-timeout bound.
18. `install.ts` output/symlink behavior is byte-for-byte outside the patch.
    Product `loop-fork/runs/` and Harvto have pre/post no-mutation evidence.

## Verification approach

- Focused tests cover socket resolution/validation, manifest round trip, command
  and attach composition, each migrated consumer, legacy/invalid fail-closed
  behavior, timeout preservation, and same-session-name/different-socket cases.
  Expected files include `tests/loop/tmux-socket.test.ts`,
  `tests/loop/run-state.test.ts`, existing consumer test files, and
  `tests/install.test.ts` only to prove install behavior did not change.
- Migration-check tests run against temporary seeded source trees for all direct
  invocation forms. They do not edit tracked source to prove non-vacuity.
- New `evals/smoke/tmux-socket-normalization.sh` is producer-backed: build once,
  hash the compiled candidate, launch a real run on A, create a same-name decoy
  on B, execute the explicit consumer matrix under hostile B ambient state,
  and run trap-safe cleanup plus zero-survivor proof. Public executable
  entrypoints are used where available; consumers with no CLI surface are
  invoked by a focused Bun harness against the producer-written manifest and
  the same two real servers, not a hand-authored manifest. No installed binary
  deployment occurs during certification.
- Existing smokes affected by the shim migration run explicitly:
  `bash evals/smoke/large-prompt-launch.sh`,
  `bash evals/smoke/active-launch-interlock.sh`, and
  `bash evals/smoke/paste-submit-readiness.sh`, with candidate path/hash options
  where those scripts support them. Exact commands and candidate SHA-256 are
  recorded in eval artifacts.
- Repository checks run from `loop-fork/` exactly as documented:
  `bun run check`, the documented `bunx tsc --noEmit ...` command,
  `bun run build`, and `env -u TMUX -u TMUX_PANE bun run test:ci`.
- After focused/full/smoke evidence passes, a different evaluator agent writes
  `runs/tmux-socket-normalization/eval.json` with
  `baseline_failures: []`. Then run
  `scripts/verify.sh tmux-socket-normalization tmux-socket-normalization`; no
  tolerated-failure count or pre-existing failure is accepted.
- Refresh `docs/dependency-map.md` after cross-module identity/schema changes
  with `scripts/refresh-dependency-map.sh`, inspect the diff, and include it in
  verification. Scorecard currently contains only template rows and no actual
  touched subsystem graded D/F; record that observed state in eval rather than
  inventing a grade.
- The test suite is run with `TMUX` and `TMUX_PANE` unset
  (`env -u TMUX -u TMUX_PANE`); `src/cli.ts:79` `shouldAwaitAutoUpdate` is
  `!process.env.TMUX && ...`, so running from inside a pane fails three
  `tests/loop.test.ts` auto-update assertions for environmental reasons. This
  is a known instrument property recorded in the prior plan, not a base defect.
- Formatting: touched files formatted with biome directly. `bun run fix` is not
  used, because it rewrites `runs/` evidence.
- Panel and attach text are terminal output, not web UI. `capture-ui.sh` cannot
  capture them and there is no DOM. Verification uses exact render assertions
  plus `tmux capture-pane` evidence and records web screenshot/DOM as not
  applicable, consistent with existing terminal-pane verify contracts.
- Before and after verification, snapshot `git status --short` and hashes/mtimes
  of in-scope `loop-fork/runs/` paths discovered by read-only inventory. Do not
  inspect, address, signal, or mutate Harvto. Any mutation outside the isolated
  smoke temp root and root task-evidence directory fails certification.

## Risks

- **Smoke shim defeat (highest).** Covered by the `-S`/`-L` precedence task; if
  that migration is missed, the smokes silently start using the operator's real
  tmux server. Mitigation: the smoke asserts the socket file it created is the
  one the product actually used, so a defeated shim fails loudly.
- **Panel enumeration is server-scoped.** `list-sessions` cannot span sockets.
  The panel enumerates the union of valid sockets referenced by run manifests,
  never the ambient default, and renders legacy rows as unknown. Under-scoping
  would hide runs; adding ambient scope would guess and can merge same-name
  sessions. Same-name A/B tests cover both errors.
- **Socket path length.** Long worktree paths under `/private/tmp/...` plus a
  socket suffix can approach the 104-byte `sun_path` limit. Handled by the
  launch-time budget assertion, which fails early rather than at first connect.
- **Manifest forward-compatibility.** Older installed binaries reading a
  manifest with `tmuxSocket` should ignore it because the field is additive,
  but this is inference until verified. Add a compatibility check using the
  pinned installed binary against a copied, non-product fixture only; never
  point it at live product runs. New binaries deliberately fail closed for old
  manifests missing the field.
- **Handover identity drift.** Replacement sessions currently persist only a
  name. If launch and observer sockets differ, replay can accept or kill the
  wrong server. Migration must make replacement target durable or resolve it
  from the replacement producer manifest, with same-name two-server coverage.
- **Quoting and API drift.** Absolute paths may contain spaces, commas, and shell
  metacharacters; argv execution and human attach hints have different quoting
  requirements. Central helpers and round-trip tests cover both.

## Out of scope

- The `install.ts` symlink-output defect. Assigned to a future governed loop.
- Product `loop-fork/runs/` is preserved and not modified. Root
  `runs/tmux-socket-normalization/` is task evidence required by governance.
  Harvto is not inspected or touched.

## Sequencing

1. Author `specs/tmux-socket-normalization/{spec,plan,tasks,verify}.md` from the
   root `specs/_template/` shape, consistent with `specs/constitution.md`. Map
   all eighteen acceptance properties one-to-one between `spec.md` and numbered
   `verify.md`; make tasks bounded but keep the socket identity/schema,
   consumers, shim migration, and two-server certification in one governed
   feature. Include fixture provenance and rollback conditions.
2. Send the complete bundle and this reviewed root plan for independent peer
   review. Incorporate findings, record decisions for panel scope and legacy
   disposition, then obtain explicit human approval. No source, test, smoke,
   script, docs, or run-eval implementation changes before approval.
3. On approval, update existing `status.md` to implementation state and create
   `runs/tmux-socket-normalization/` evidence paths without altering
   `loop-fork/runs/`. Re-verify HEAD/base SHA and installed binary SHA-256.
4. Implement socket validation/target types, manifest schema/read/write support,
   and early launch binding first. Prove focused resolver and manifest tests.
5. Migrate launch/resume/attach and shared bounded control APIs, then migrate
   bridge, GC/cleanup, reservation/proxy/options, panel, Governess pane effects,
   handover, and replay. After each band, run its focused tests and the derived
   inventory; do not leave a mixed ambient/explicit intermediate commit marked
   complete.
6. Migrate all smoke isolation call sites from label/`-L` behavior to absolute
   product `LOOP_TMUX_SOCKET` plus inspector `tmux -S`. Run precedence and
   seeded migration-check non-vacuity tests before any smoke that could contact
   a host server.
7. Run producer-backed two-server regression with trap installed before setup;
   collect provenance, per-consumer evidence, destructive non-effects, cleanup,
   positive control, and zero-survivor proof.
8. Run affected existing smokes, complete sequential suite, build/type/lint,
   refresh dependency map, and no-mutation comparisons. A different evaluator
   writes passing `eval.json`; then run governed `scripts/verify.sh`.
9. Request exact-candidate-SHA independent review. Do not deploy, merge, clean
   product runs, or touch Harvto in this task.

## Human-approval package — APPROVED 2026-08-08

> **Both gates are cleared.** Peer review round 3 returned PASS (`e0b267ee`, at
> spec `d802f1f9…`, tasks `2bb690f0…`, verify `bc96366b…`, plan `67bfa1ae…`,
> all re-verified against the working tree on receipt). The founder then
> approved the support impact below on the session user channel:
>
> **`approved — fail closed, no recovery. proceed to T-00`**
>
> Approving party: the founder (Amgad Abdelhafez), 2026-08-08. Full record,
> including the T-00 binding re-verifications and a provenance note on why this
> approval is distinguishable from a ghost-composer string this run has logged,
> is in `runs/tmux-socket-normalization/approval.md`. T-00 is cleared; T-01 is
> next. The package text below is retained as the record of what was approved.

**The one decision requested:** approve the recorded legacy-manifest support
impact. Everything else in this bundle is already settled by peer review.

**What is being approved.** A run launched *before* this change has a manifest
carrying a session name but no socket. The new binary will refuse to manage it
rather than guess which server it lives on. Concretely, for such a run:

| Behaviour | Before | After approval |
|---|---|---|
| The run itself | keeps executing | keeps executing — **nothing kills it** |
| Resume / reattach | ambient guess, often right | refused, explicit unknown-socket line |
| Panel row | shown | shown, rendered `unknown`, non-attachable |
| GC, cleanup, reservation, proxy, bridge, Governess | act on an ambient guess | skip, with a recorded reason |
| Operator's path | none needed | let it exit, or attach manually with a socket they identify themselves |

**Why this is the safe direction, not the convenient one.** The alternative is
inferring an ambient socket, and that inference *is* the defect: it is what
makes a live run read as dead and get its Claude config garbage-collected, its
processes signalled, its proxy shut down with `reason: "dead-tmux"`, and a
second launch admitted against a live workspace. Refusing to guess trades a
recoverable inconvenience for the removal of a destructive fail-open.

**Scope of the blast.** Only runs in flight across the upgrade are affected, and
only until they exit. Nothing persists past that. New runs are unaffected
because they record their socket at launch.

**What approval does *not* authorize.** Implementation still starts at T-00
bookkeeping and then T-01, in that order. No merge, push, install, or deploy is
in scope; `loop-fork/runs/` is not cleaned; Harvto is not touched.

**If the founder declines**, the fallback is not "guess the ambient socket" —
that reinstates the defect. It is to add a recovery path (an operator-supplied
socket for a named legacy run) as a separate, later change, which enlarges scope
and delays closing a live destructive defect. Say so if that trade is preferred.

### The three answers this gate accepts

| Answer | Consequence |
|---|---|
| **Approve** | T-00 bookkeeping clears, then T-01 (the `-S` over `-L` precedence probe) starts. Nothing else changes; no merge, push, install, or deploy is in scope |
| **Decline, add a recovery path** | Nothing starts. An operator-supplied-socket recovery design needs its own spec and review cycle, and a live destructive defect stays open meanwhile |
| **Approve but hold implementation** | The approval is recorded here and in `status.md` so a later session resumes from a cleared gate; this run stops at the spec boundary |

### Recording the answer

Whoever takes the answer writes it here in the founder's own terms, with the
date and the approving party named, and updates T-00's third done-when box in
`tasks.md`. Peer review is already recorded as PASS at the four hashes above;
this box is the only one left. An approval that cannot be attributed to a named
human is not an approval and must not clear the gate.

## Codex review handoff — 2026-08-07 (ARCHIVAL — superseded by run 14)

> This section described the pre-approval review state. Round 3 returned PASS
> and the founder approved on 2026-08-08, so its closing instruction ("no
> source, test, smoke, script, run-eval, commit, or deployment work is
> authorized before human approval") is **discharged, not current**. Current
> state is the run-14 block at the top of this file.

Current objective: pre-implementation independent review of the four-file spec
bundle for defect `adc4bb8a-4b7b-4245-832f-a1995076b6b1`.

Round 1 review verdict was REVISE. Round 2 review confirmed the skip-record
schema/sink, panel row states, legacy disposition, and pane invariant wording
improved, but remained REVISE on target provenance, asking for three things
before approval: make the composer target-bound or keep any socket-only
composer private/unexported; make verify 5 mechanically satisfiable rather than
promising rejection of a synthetic same-object field swap without a provenance
mechanism; and enforce pane ownership through API shape (`OwnedPaneTarget` or
manifest-bound operations), not caller discipline.

**Run 12 revised all three** — see "Current state (handover)" above for the
closure detail. Composition is now the target-bound trio with socket-only
`tmuxArgv` module-private; provenance is an opaque one-parameter
`ManifestHandle` making the wrong pairing unconstructible, with verify 5 split
into 5a/5b/5c and the tampered-manifest residual recorded rather than claimed;
pane ownership is the opaque `OwnedPaneTarget`. Changed: R3, R6, R10, R12;
verify 3, 5, 6; T-02, T-05, T-10, T-11; the acceptance-criteria mapping; and
`specs/tmux-socket-normalization/plan.md` decisions. No implementation has
started.

Next bounded action: review round 3 on the revised bundle at the exact hashes
recorded in `status.md`. Preserve current uncommitted spec/status changes. No
source, test, smoke, script, run-eval, commit, or deployment work is authorized
before human approval.
