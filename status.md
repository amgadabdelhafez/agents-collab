# status — D-001 Governess handover launch order

## Run 42 (2026-08-08) — implementation and peer review complete

Current result: D-001 code and one reproducer are complete. Live Runs 14-32 and
34-37 all show validated Claude/Codex bundles followed by `[loop] launch
conflict` against the predecessor run's own workspace. Base HEAD is
`78608327d590050f8cd1bbd1005ed185d090ab2c`.

World Model context file and logical capsule hashes match, but the context JSON
omits the required repository-commit field. Per launch charter, it was not used
as authority. Current run manifest binds this exact worktree and commit; native
Git confirms both. The charter-named canonical defect Markdown is absent from
the current tree and every local ref, so the launch charter, repository specs,
current source, and producer journals control this cycle.

`loop-fork/src/loop/governess.ts` now atomically persists the predecessor as
stopped without `tmuxSession` immediately before replacement spawn. Missing,
unreadable, or unwritable configured manifests fail before spawn. Socket,
workspace binding, handoff artifacts, and unrelated fields stay unchanged.
Postimage SHA-256 is
`1f0aa98644d1713d888ed5e6fbc297e9b0b8ac39170dcd7c963f7c29c54c6fad`.

`loop-fork/tests/loop/governess-exit.test.ts` adds one direct producer-backed
reproducer. It captures the persisted predecessor inside the actual launcher's
spawn mock and checks the production ownership predicate. Postimage SHA-256 is
`e06928c3284c959aa7730c87a37b1b3d58f546620ed036ae9db698b598934064`.

Proofs: named reproducer 1/0 with 8 assertions; full Governess-exit suite 34/0
with 190 assertions; `git diff --check` passes. Tests used a temporary external
Bun preload for absent `caveman-installer/skills/caveman/SKILL.md` and
`proper-lockfile`; no repository dependency or byte was installed or changed.
Bounded no-install TypeScript smoke remains unmet because `bun-types` is absent:
`error TS2688: Cannot find type definition file for 'bun-types'.` Scoped Biome
is likewise unavailable under `bunx --no-install`.

Claude zero-write review `9ba017e3-4cdb-4c9d-9c61-c7ec7e5c7f42` PASSed the
exact code/test postimages. Residual risk: a failure after reservation release
does not roll back predecessor ownership; rollback would recreate the launch
race, so this bounded fix records rather than expands that behavior. Coverage
calls the production ownership predicate directly but does not walk
`storedManifests` under the canonical lock. Next: write eval, commit once, and
stop for root independent review.

---

# Prior session history — tmux socket normalization

## Run 38 (2026-08-08) — V5-R1 DECLARATION PASS; SOURCE BYTES FROZEN

Current result: planning/review gate complete, implementation not started.
Claude REVISE `d83fd1e4-c01d-4f1c-a79f-752b14c20fe9` corrected the overbroad
verify-10 closure claim. V5-R1 now certifies only the declared ten-file atomic
prerequisite migration for six named literal-dead producers and received
zero-write PASS `7125b3a9-090c-41f0-aeb9-fe0362ce58ee`.

Verify 10 remains open after this declaration and will remain open after the
six-site slice. Outstanding per-consumer skip-record work includes tmux
launch/resume/attach, both tmux-control readers, bridge capture/send/buffer and
remaining BridgeStatus coverage, both GC paths, panel enumeration,
governess-pane-liveness, Governess pane effects, and Governess handover. No
T-01 through T-18 checkbox changed.

No source/test byte changed during this action. Future implementation must
rehash all ten PASS-bound preimages immediately before editing and produce the
full five-source/five-test candidate or none. Command-12 entries 4, 5, and 9
will require superseding hashes; exactly six prior fourteen-file postimages stay
preserved: tmux source/test, governess source, governess-exit source/test, and
tmux-socket test.

Intended fail-closed consequence: an inactive no-session legacy manifest with
unknown target remains owning/conflicting and may permanently block launches
with no recovery path, per founder-approved Gate 2 direction. No stage, commit,
merge, install, release, backlog work, product-run mutation, or forbidden
artifact access occurred.

## Run 38 (2026-08-08) — SCOPED ROOT PASS; NOT RELEASED

Harness-owner root review independently PASSed only the combined fourteen-file
V4 + V4-A + V4-B-R1 technical slice. It confirmed peer PASS
`8dae02e3-d70e-48f1-a237-d752f26d0e1c`, all hashes and boundaries, HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`, empty index, 354/0 focused
tests, clean 845-file whole-tree check, exact scoped TypeScript and Biome,
five old-API hits, six protected producers, and a non-vacuous V4-B-R1 negative
control. Root review made zero repository writes.

Release remains fail-closed: `runs/tmux-socket-normalization/eval.json` is
absent; tasks T-01 through T-18 are unchecked; verify 10 remains open;
criterion 11 remains attestation-only; and full build, `test:ci`, smokes,
governed verify, two-server certification, installed-binary check, eval, and
final live audit are not certified. No stage, commit, merge, install, or release
claim is permitted from this scoped PASS.

Current action is declaration-only for the next atomic high-risk verify-10
slice: map all six named producers and owning tests, require named per-site
unknown-target regressions plus structured skip records, freeze exact preimages,
and obtain Claude zero-write PASS or REVISE before source/test implementation.

Current result: combined V4 + V4-A + V4-B-R1 candidate is locally complete.
Claude PASSed V4-A at `ae4c524c-c7dc-4770-a88e-4c76f90f1877`. The first V4-B
proposal received REVISE `05eb3264-6f2d-4048-abf9-1da5a03dcc86`; corrected
V4-B-R1 retained the exact five-occurrence tripwire and added a derived
all-`launchServerArgv`-calls-use-`launchSocket` assertion, then received PASS
`e6497e50-3de8-453b-93b8-57faf6088d09` before editing.

Proofs pass without skips or tolerated failures: seven focused suites total
354/0; exact fourteen-path Biome; authoritative whole-tree Ultracite 845 files,
zero diagnostics; exact command 7; `git diff --check`; exact five-hit old-API
inventory; exact six protected producers; unchanged eleven V4 hashes; exact
nine command-12 hashes; and exact 21-entry porcelain.

Republished amended command-12 hashes:
`codex-tmux-proxy.ts`
`8e163f2a4b072cb49b37f1abd78a7e62e9ec52a1526ebde35228803af47781e4`;
`codex-tmux-proxy.test.ts`
`0897bf9eedd7fe5a855163fea2f228518f038188022fc60d541d3ba12124ea22`;
`tmux-socket.test.ts`
`320877af1ddfbfa36e360e640a3e0474961f6f06591a45b98bfbe381ad011734`.
The remaining six command-12 hashes and all eleven V4 postimages remain exact.

Standing proof rule: module guard tests belong in the focused proof set for any
change touching that module. Original V4 omitted the proxy and tmux-socket guard
suites, which is why the stale count survived and why Claude's earlier withheld
PASS rested on incomplete proof coverage. Both are now mandatory here.

No product-supervisor release ruling was requested. No staging, commit, merge,
install, verify-10 closure, backlog work, product-run mutation, or
forbidden-artifact use occurred. Claude native zero-write exact-postimage
verdict `8dae02e3-d70e-48f1-a237-d752f26d0e1c` is final PASS.

## Run 38 (2026-08-08) — V4-A PLANNING RECORD (SUPERSEDED)

Declaration V4 is implemented only in its exact eleven-file write scope. The
five exact focused suites pass with 279 tests total and zero failures
(106 + 108 + 33 + 14 + 18). Exact TypeScript, old-API inventory, protected
producer search/manual comparison, `git diff --check`, frozen hashes, and the
exact 21-path porcelain boundary pass. Scoped Biome passes all eleven writable
files.

One proof gate cannot currently pass without violating the same declaration:
`bun run check` reports only pre-existing lint/format findings in the frozen,
hash-pinned `codex-tmux-proxy.ts`, `codex-tmux-proxy.test.ts`, and
`tmux-socket.test.ts`. Their command-12 hashes are unchanged, no write-scope file
controls that check, and `verify.md` line 8 rejects tolerated pre-existing
failures. Final zero-write decision
`68f3ae2a-fd60-4719-90bd-68029db23e62` is **PASS WITHHELD**, explicitly not
REVISE. Claude independently matched all twenty hashes, all five
suite/expectation counts, the five-hit inventory, 21-entry porcelain, and the
eight strictly intra-file frozen diagnostics; it found no implementation defect
and escalated both resolution options to the harness owner. Exact command 7 is
scoped to `src/cli.ts` and `src/loop/caveman-skill.d.ts` and exits 0. A substitute
whole-project tsc exposes pre-existing debt, including displaced unchanged lines
in `launch-reservation.ts`, but is not the declared command-7 instrument. No
stage, commit, push, PR, deploy, release, dependency/backlog/product-run
mutation, verify-10 closure, or criterion-11 promotion occurred.

Harness-owner ruling `69c74846-0c82-4d3e-a213-20b710e3b0fe` selects resolution
1: retain mandatory whole-tree command 6 and unfreeze exactly proxy source,
proxy test, and `tmux-socket.test.ts` for lint-only repair. Repo-wide fix commands
are prohibited; only exact-path direct Biome plus reviewed manual ternary
refactors are permitted. Current eleven V4 and nine command-12 hashes are frozen.
The exact gate reports eight and only eight diagnostics across those three
files. V4-A declaration review request
`8e357c9b-0dd4-4c47-98d5-48be0cb75492` received Claude PASS
`b6312267-a00b-4860-9f2e-7951247a71a2`. It permits
only import ordering, formatting, and three nested-ternary eliminations with
unchanged behavior/test intent and protected C1/producers. No source/test edit
has begun under V4-A. Binding corrections preserve the exact regular-file
predicate `entry.isFile() && entry.name.endsWith(".ts")` and keep scoped direct
Biome evidence distinct from authoritative whole-tree Ultracite command 6.

## Run 37 (2026-08-08) — CONTINUATION PASS; NO SOURCE IMPLEMENTATION

Current result: Run-36 handoff, final docs, World Model bootstrap, live HEAD,
exact 14-entry dirty inventory, empty index, `git diff --check`, exact V4
request/PASS relation, all eleven V4 write-scope hashes, and all nine frozen
hashes were revalidated. Exact V4 source interfaces and target call sites were
inspected. No source/test file changed and no proof command ran.

Validated handoff evidence: epoch `1786205616368960`; `codex.json`
`db838ed4d45f55326ad02a94c5d9583a395967498bde8b52f8828349ae512f8a`;
`claude.json`
`d229a1ec7cf99f4129225e50e645ea5bb632aa9ec7f24f7582e109dac1387300`;
`continuation.md`
`eb04308d710193e4745251dd2dac769f55a3632c173faf4cfbf7a6a683e7fb3f`.
Both bundles are exact nine-key `ready` objects for the same epoch and HEAD,
and the complete Run-36 transcript was inspected. Inherited docs matched
`PLAN.md`
`4068987a31ec35c2bb34764fe0bb635fe5064eae62c4c15a9dfcff2033857151`
and `status.md`
`5ef0014bd5595a18adcefbfb90787f5390caade40ba829fe1c55bfa84371326f`.
Bootstrap file/capsule matched
`e405fdb2dcbcb037d52857edb5d42cd71ec903a418d7f71ad9803c8dc871b74b`
and `54490c7ef56c4ac9d04e6cf4f18f337659d39b80dbe2b61b1a20c912387ebb38`;
all indexed commit bindings and live HEAD matched
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`.
The statement-limited capsule has no top-level repository-commit field and was
not used as continuity authority; validated handoff bytes plus native Git
supplied that binding.

Implementation authority remains exact request
`1bca0a82-0710-40bb-9d71-09803dfa1e56` plus bound PASS
`03838bd5-d78a-43bb-ac33-62e870938af2`, conditional on all twenty preimages.
Every preimage matched in Run 37. Native porcelain returned all 14 inherited
entries, the index was empty, and `git diff --check` exited 0.

Three exact edit packets were routed before code authoring:
`c9b44603-1eab-403f-8b62-db6c8edea936` for tmux source/tests,
`0c95289e-b97e-4c34-87d0-ea5617c99737` for launch reservation, and
`7ad7a92a-611c-4156-8c3f-1858581c3eb8` for bridge runtime. All returned
`risk-not-low` to the driver; no helper ran, no patch or artifact exists, and no
write scope remains reserved.

Governess decision `e15477c4-99e0-474d-ab81-13a3584f7131` reached preparation
threshold before implementation and requires a fresh loop. Run-37 changed
scope is only `PLAN.md` and `status.md`. No source/test edit, partial apply,
proof command 1-13, stage, commit, push, merge, PR, deploy, release, install,
dependency/backlog/product mutation, verify-10 closure, criterion-11 promotion,
or forbidden-artifact access occurred.

Risks: the eleven-file V4 change is risk high and must not land partially; any
guarded preimage drift voids current implementation authority. Missing or
coerced replacement-manifest identity could turn unknown into false authority.
Paired argv, protected producers, and unrelated dirty bytes remain fragile.
Prior routed reads/searches/status reports have omitted or truncated evidence,
so native Git and byte hashes remain the controlling source.

Exact next action: fresh loop validates this handoff and final doc hashes,
rehashes all twenty V4 files immediately before the first edit, then atomically
implements all eleven declared files. Explicitly narrow optional
`replacementManifestPath`; never use `?? ""`. Preserve five reads/four 50 ms
sleeps, B6/B7 semantics, protected producers, paired argv, unrelated dirty
bytes, open verify 10, and criterion 11 as Codex-attestation-only. Run exact
proof commands 1-13, compute postimages, and request Claude zero-write
exact-postimage PASS or REVISE.

## Run 36 (2026-08-08) — CONTINUATION PASS; NO IMPLEMENTATION

Current result: Run-35 handoff, final docs, World Model bootstrap, live HEAD,
exact 14-entry dirty inventory, empty index, `git diff --check`, exact V4
request/PASS relation, all eleven V4 write-scope hashes, and all nine frozen
hashes were revalidated. Relevant feature contracts and current target call
sites were inspected. No source/test file changed and no proof command ran.

Validated handoff evidence: epoch `1786204357097144`; `codex.json`
`f5bd085e347275d057339551769749532e45f0781ac43e3af7d7860c437cf816`;
`claude.json`
`fe1b9f96554cea2a40d77e47c0bfe6b0aa0631c2a24ffb4e00d21b91cbbf7126`;
`continuation.md`
`6e64d74b29910b03954794069f021e67c09a0414cd9602b3f92cbb1773a11ba4`.
Inherited docs matched `PLAN.md`
`9cb1ec6de78fd790ddb574e11455a42460147631e4fa81acac57bc514e2f25b4`
and `status.md`
`064043a3f120620880a84dbb20294ff0c72d4dba51fe1f63390197fe62c3a451`.
Bootstrap file/capsule matched
`e405fdb2dcbcb037d52857edb5d42cd71ec903a418d7f71ad9803c8dc871b74b`
and `54490c7ef56c4ac9d04e6cf4f18f337659d39b80dbe2b61b1a20c912387ebb38`;
HEAD matched `fe44f280c4a21e840e586f0f9d8098c865ed0d62`.

Implementation authority remains exact request
`1bca0a82-0710-40bb-9d71-09803dfa1e56` plus bound PASS
`03838bd5-d78a-43bb-ac33-62e870938af2`, conditional on all twenty preimages.
Every preimage matched in Run 36. This handoff is not a postimage review and
does not replace that authority.

Governess decision `c2c69b05-3c45-4cca-817d-71ee49135d30` reached preparation
threshold before implementation and requires a fresh loop. Run-36 changed
scope is only `PLAN.md` and `status.md`. No source/test edit, partial apply,
proof command 1-13, stage, commit, push, merge, PR, deploy, release, install,
dependency/backlog/product mutation, verify-10 closure, criterion-11 promotion,
or forbidden-artifact access occurred.

Risks: the eleven-file V4 change is risk high and must not land partially; any
of the twenty guarded preimage drifts voids current implementation authority.
Missing or coerced replacement-manifest identity could turn unknown into false
authority. Paired argv, protected producers, and unrelated dirty bytes remain
fragile preservation boundaries. Helper git-status output can omit untracked
entries; every Run-36 porcelain claim uses the native full listing, which
returned all 14 expected entries including
`specs/tmux-socket-normalization/`.

Exact next action: fresh loop validates this handoff and final doc hashes,
rehashes all twenty V4 files again immediately before the first edit, then
atomically implements all eleven declared files. Optional
`replacementManifestPath` must be explicitly narrowed; never use `?? ""`.
Preserve five reads/four 50 ms sleeps, B6/B7 semantics, protected producers,
paired argv, unrelated dirty bytes, open verify 10, and criterion 11 as
Codex-attestation-only. Run exact proof commands 1-13, compute postimages, and
request Claude zero-write exact-postimage PASS or REVISE.

## Run 35 (2026-08-08) — V4 PASS BOUND; PRE-EDIT GATE PASSED

Current result: exact Run-34 bundle hashes and nine-key ready metadata passed.
Full V4 request `1bca0a82-0710-40bb-9d71-09803dfa1e56` and later Claude PASS
`03838bd5-d78a-43bb-ac33-62e870938af2` were recovered from Run-34 durable
`bridge.jsonl`; the PASS replies to the exact request and supersedes both stale
bundle narratives saying no verdict existed.

Before any source/test edit, HEAD matched
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`; porcelain matched the exact
14-entry baseline; index was empty; `git diff --check` passed; Run-34 final
docs matched `PLAN.md`
`c6d537f283bc5e1f78082ca7e23e862f2c5b85ee1a2641b78ceea8c49b74808e`
and `status.md`
`343d344a561cb4c3969555f7ce420acf43b6eb719458ae8561e36189bbfee5ee`;
all eleven write-scope and nine frozen hashes matched V4 exactly.

Next: implement the complete eleven-file slice atomically, run exact proof
commands 1-13, compute postimages, and request Claude zero-write exact-postimage
PASS or REVISE. Narrow optional `replacementManifestPath` explicitly; absence
must fail as launch-error and must never become `?? ""`.

Recorded non-blocking observations: Run-34 doc mtime/order narrative wobbled,
and Run-33 final-doc sources conflict. Neither reopens V4; V4 plus its bound
later PASS control. Verify 10 remains open, criterion 11 remains Codex
attestation only, and the forbidden artifact remains unused.

Handover result: Governess decision
`adeb5361-6c32-4c23-8ee6-de606ac3cec6` reached preparation threshold before
source implementation and forbids starting another broad slice in this loop.
Run-35 changed only `PLAN.md` and `status.md`. No source/test edit, partial
apply, proof command, stage, commit, push, merge, deploy, release, install,
backlog mutation, verify-10 closure, criterion-11 promotion, or forbidden
artifact access occurred.

Six bounded edit routes returned `risk-not-low` with no patch and no remaining
write reservation. Two Run-34 evidence routes returned `protected-scope`; live
bundle bytes and bridge records were independently validated by the driver.
Current blocker is continuity only, not technical or review authority.

Exact next action for fresh loop: validate these handoff docs, rehash all
twenty V4 files again, require every V4 preimage, then atomically implement all
eleven declared files, run exact proof commands 1-13, compute postimages, and
request Claude zero-write exact-postimage PASS or REVISE.

## Run 34 (2026-08-08) — V4 REVIEW STEP IN PROGRESS; NO IMPLEMENTATION

Current result: Run-33 bundles, final docs, HEAD, exact dirty inventory,
`git diff --check`, all eleven V4 write-scope hashes, and all nine frozen hashes
validated. Exact V2 REVISE, Option A relay, V3 declaration, and V3 REVISE bodies
were recovered from their declared bridge journals. No source/test file changed.

One V4 send attempt failed locally before delivery because the declaration's
literal `${JSON.stringify(manifestPath)}` was interpolated while constructing
the bridge message. No bridge request or repository write resulted. Corrected
V4 must state that `2d0d5fe1-395c-42bf-8844-9254c06bd055` is Claude's durable
relay of the human Option A decision while approval Gate 2 is standing human
authority.

Governess decision `cb3aa86f-5905-442e-aed5-99abbcfd83de` requires a
fresh-loop handover after the current atomic V4 review step. Run 34 may finish
only: rehash all twenty guarded files, send exact risk-high V4, and receive
Claude zero-write PASS or REVISE. It must not begin the eleven-file source/test
slice even if PASS arrives. Next loop rehashes again before any implementation.

Open risks: V4 must bind exact five-read/four-delay race handling, distinct
dead/unknown semantics, stored-session B6/B7 conditions, ten old-API removals,
nine frozen hashes, exact modified-file inventory, and all lifecycle
prohibitions. Verify 10 remains open; criterion 11 remains Codex attestation
only. Forbidden artifact remains unopened and unused.

Final crossing state: corrected exact V4 was accepted for Claude delivery as
request `1bca0a82-0710-40bb-9d71-09803dfa1e56` after all twenty hashes matched.
Claude had already entered handover and published message
`a0d1502c-dfc4-426f-bcc0-5b50184eda60`; it did not review V4 and reports no
repository writes. No PASS or REVISE exists. Source/test gate stays closed.
Fresh-loop next action: recover exact V4 request, rehash all twenty guarded
files, obtain zero-write verdict, and only after PASS consider implementation
under fresh Governess authority.

## Run 33 (2026-08-08) — HANDOVER: V3 REVIEWED, REVISE

Run-32 bundles, final docs, HEAD, World Model file/capsule/commit evidence, and
the two required bridge messages were validated exactly. Root's Option A
authority is live. V2 remains blocked and was not implemented.

Declaration V3 review request
`074bb791-5dff-44e1-a76b-dd2fb080521c` received Claude zero-write `REVISE`
`d9e75210-830b-4af2-a2c2-9fa8600c4a13`. V3 grants no implementation
authority. All eleven preimages and five original frozen hashes matched before
the request and independently during review; `governess-exit.ts` matched
`0bdc21256973386a1911f269a9a40b6a449acb0d1068afe37cec8919b3707b33`
and had zero `tmuxSessionLiveness(?:Async)?` hits. `git diff --check` passed.

V4 must clear three blockers: pin B6/B7 stored-session ternary conditions and
add separate present-session/undefined-target regressions; include four
old-API import removals in the six-call migration inventory; and bound the full
dirty-file set with four added frozen hashes plus exact
`git status --porcelain`. Full corrections and hashes are at the top of
`PLAN.md`. V4 must restate V2 blockers and exact Option A authority.

No source/test file changed in Run 33 and proof commands 1-12 did not run.
Forbidden artifact remained unopened and unused. No stage, commit, push, merge,
PR, deploy, release, install, dependency action, product-run mutation, backlog
work, verify-10 closure, or criterion-11 promotion occurred.

Governess decision `18b20bd2-86f7-468d-aa00-30e4d731a2ee` requires a fresh-loop
handover before another broad slice. Next action: rehash all eleven write-scope
and nine frozen files, author self-contained V4 with every correction, and
obtain Claude PASS. Do not implement V2 or V3. After PASS, rehash again,
implement atomically, run the final exact proof command set, and obtain Claude
native zero-write exact-postimage review. Do not implement from this handover.

**Verdict arrived after that text was written: REVISE.** Claude returned an
explicit zero-write REVISE on `074bb791-5dff-44e1-a76b-dd2fb080521c` as bridge
message `d9e75210-830b-4af2-a2c2-9fa8600c4a13`. Implementation therefore stays
closed; the next fresh loop needs a Declaration V4 and a new PASS, not a rehash
of V3. Claude wrote no source or test file.

Every hash in V3 verified clean at review time: all eleven write-scope
preimages, all five frozen files, and the six protected producers at their
declared lines. The stdout contract was confirmed viable against live code, and
intentional change 1 was confirmed to be a genuine behavior change
(`governess.ts:6485-6491` rejects only `"dead"` today, so `"unknown"` currently
accepts and grants handover). Three blockers stand, recorded in full in
`PLAN.md` under "Claude zero-write verdict on V3":

1. B6/B7 ternary **condition** on `launch-reservation.ts:120` and `:223` is
   unpinned while lines 121/224 are frozen. Migrating it to `target ?` turns an
   unusable target into literal `"dead"` — granting cleanup and launch authority
   over a possibly-live run — with the frozen producer and proof commands 9/11
   all still looking clean. `tmux-control.ts:136-146` states the opposite
   invariant (unusable target is `"unknown"`, never `"dead"`, verify 10). Needs
   the condition pinned plus a named undefined-target regression at both sites.
2. Proof command 8 cannot pass from the declared list: 15 current hits, 5
   retained, so 10 must go, but only 6 were enumerated. Missing import sites are
   `launch-reservation.ts:21`, `bridge-runtime.ts:57`, `governess.ts:157`,
   `governess-replay.ts:27`.
3. No command bounds the modified-file set. Command 11 sees only the eleven
   declared paths; command 12 pins five files. `tests/loop/tmux-control.test.ts`,
   `tests/loop/run-state.test.ts`, `tests/loop/tmux-socket.test.ts`, and
   `src/loop/paired-options.ts` are pinned by nothing; hashes are in `PLAN.md`.

The V2-closure link is confirmed from the Run-32 record below rather than taken
on assertion: V3's Option A mechanism does address the exact B3/B4 defects that
REVISE `9f0d802f-ea41-40d6-a229-03ae73a2f4fc` identified. The three blockers
above are independent of that chain.

## Run 32 (2026-08-08) — BLOCKED: DO NOT IMPLEMENT V2

Claude REVISE `9f0d802f-ea41-40d6-a229-03ae73a2f4fc` found V2 B3/B4
unimplementable inside the declared ten-file scope. The replacement run
manifest path is neither reported nor persisted; `resolveExistingRunId` never
matches `manifest.tmuxSession`. A local scan is not permitted or buildable:
its only enumeration primitive is private in frozen `run-state.ts`.

Current state: no source/test implementation and no proof command 1-12 ran.
All ten V2 preimages and all five frozen hashes still match. Run-31 handoffs,
docs, and bridge lineage were validated exactly. Five edit routes settled
`risk-not-low` without patches. Governess requested fresh-loop handover before
the atomic slice began.

Human V3 direction is required. Option A is Claude's recommendation: widen
scope to `src/loop/governess-exit.ts`, emit and persist the replacement
manifest path, and declare bounded first-probe race handling with a separate
named regression. Option B keeps ten files by narrowing B4's identity
requirement. Option C touches frozen `run-state.ts` and is rejected.

Do not implement until the human chooses V3 direction and Claude PASSes its
exact declaration. The earlier implement-now guidance is superseded by
`9f0d802f-ea41-40d6-a229-03ae73a2f4fc`.

## Run 31 (2026-08-08) — DECLARATION PASS

Planning gate only. Run-30 handoff bundle hashes, `ready` state, epoch
`1786196308640713`, and `gitHead`
`fe44f280c4a21e840e586f0f9d8098c865ed0d62` all matched. Inherited live docs
matched `PLAN.md`
`435b30fe2eece4b578b4c279c2dde3a41756f35040303200db937da117517f04`
and `status.md`
`96a5ded84916ee0997b227f126b45279e38be74ad998c94f3ca144426f08fa78`
before this write; no prior peer verdict covers those bytes or these new bytes.

Claude decision `98d15af3-ffaa-4ed1-a3e8-8614d08c4f7b` resolved the identifier
discrepancy. Canonical record is durable Run-16 T-05 review verdict
`92566b55-09db-41c5-bf4c-6b85672935d8`, carrying three corrections and replying
to `5499a4cb-f715-447a-ab63-56280c833811`; “F2 correction” is only later
characterization. User-supplied
`92566b55-09db-41bf-8e9b-93c70e39e3ac` is unmatched and grants no authority.

Exact risk-high declaration V1
`5544c153-4e9f-42ba-b4c9-b7a57270eaf8` received Claude zero-write `REVISE`
`c3c0a0b8-09e3-4387-8d8d-f48671df21a7` for two narrow issues: B3 must be
declared as an intentional behavior change, and proof inventory must expect five
textual hits. V2 `34a28988-301f-4c56-b689-31a40d83cf92` made only those exact
replacements. Claude zero-write verdict
`28bfdf88-6a33-4145-afea-345987936ec6` returned explicit `PASS` on V1 plus V2.
It covers F2 A1-A3, exact ten-file source/test scope and current SHA-256
preimages, six old-API expressions/seven branches, per-branch target/socket
assertions and named unknown regressions, B3's intentional unknown-rejection,
opposite reservation unknown handling, positive paired argv byte invariance,
confirmed-missing and `allowMissingSocket` preservation, and twelve proof
commands. No source/test edit or test run occurred.

Planning blocker is resolved. PASS is bound to the ten exact source/test
preimages recorded in `PLAN.md`; drift requires new review. Verify 10 remains
open; criterion 11 remains Codex attestation only. Preserve W2/A2, F1,
corrected risk-C, proxy C1, six inline
verify-10 producers, `paired-options.ts`, paired argv, exact dirty tree, and all
unrelated bytes. Never inspect or use the forbidden artifact. No stage, commit,
push, merge, PR, deploy, release, product-run mutation, backlog, or accepted
slice rework.

Run 31 stops at declaration PASS. Next loop must verify unchanged preimages,
implement V2 atomically within its exact ten-file scope, run proof commands
1-12, recompute changed hashes, and request Claude diff/proof review. No
implementation begins in Run 31.

Final closure acknowledgement `e9d4857f-f00d-411c-95b6-7e79d3a096af`
independently confirmed all ten write-scope and five frozen hashes unchanged,
HEAD unchanged, empty index, exact 14-entry dirty tree, and clean diff-check.
Declaration PASS travels only while the ten preimages match. Proof commands
1-12 remain unrun. Governess requested graceful handover at epoch
`1786198210449677`; this final documentation write is followed by the atomic
Run-31 bundle and no other work.

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

**Run-30 result: preparation-threshold handover, planning incomplete.** Live
source inventory confirms exactly six remaining old-API migration expressions:
`bridge-runtime.ts:1101,1164`, `governess.ts:6485,6571`,
`governess-replay.ts:325`, and async dependency binding
`launch-reservation.ts:80`. Reservation then invokes that dependency in two
distinct semantic consumer branches at lines 120 and 223; each needs its own
target/socket assertion and named unknown-state test. Proxy's three
Run-21 consumers are removed by PASSed C1. `paired-options.ts:55` remains a
distinct socket-blind old-API probe item; its separate inline verify-10 producer
remains at `paired-options.ts:75`. `tmux-control.ts` legacy definitions are not
consumers.

Run-21 boundary decision `59eac508-6550-49cf-bf87-17c69c0f6612` was recovered
from the durable Run-20 bridge journal. Durable Run-16 F2 correction is
`92566b55-09db-41c5-bf4c-6b85672935d8`; the user-supplied
`92566b55-09db-41bf-8e9b-93c70e39e3ac` does not occur in historical run
journals and remains an identifier discrepancy for the next Claude review.
Recovered semantics are unambiguous: F2 covers non-paired execution only;
socket-qualify probe, keep-attached, `isSessionGone`, and interactive attach;
leave the existing qualified hint out; preserve the confirmed-missing predicate
and `allowMissingSocket`; positively prove paired argv invariance; test named
socket missing separately from unrelated stderr.

Governess decision `607eedd4-cd33-4cd0-8094-5f3993aaa51f` requested a fresh-loop
handover before the exact declaration, source/test preimage table, proof command
list, or Claude declaration verdict was completed. Current changed scope in
Run 30 is only `PLAN.md` and `status.md`. No source/test implementation, test
rerun, staging, commit, push, merge, deployment, release, or product-run
mutation occurred.

Read-only evidence tasks: bridge/Governess inventory
`26157c36-9fa3-4bd0-861a-3dc79f9c406b` completed; replay/reservation inventory
`7d2d6198-7280-47db-b285-79918bdf153d` was running at handover; docs-boundary
audit `edd59ea9-7dfb-4f24-84b0-53f16975b1e0` remained pending. Docs PASS patch
task `929b7bc3-0806-4104-9380-95c575efab2c` applied with guarded preimage
verification; patch SHA-256
`9d997258acde4516c922471e30c6001a703c56800d455ca22b494373a3ddca1e`.

**Next bounded action.** Validate current document hashes and consume pending
read-only task results. Finish the exact F2 plus six-expression,
seven-semantic-branch declaration with precise source/test scope, current
preimage hashes, per-consumer target/socket and unknown tests, risk `high`, and
proof commands. Send it to Claude for
zero-write PASS or REVISE. No source/test edit before PASS. Preserve proxy C1,
W2/A2, F1, corrected risk-C, all six inline verify-10 producers,
`paired-options.ts`, criterion 11 attestation-only wording, and open verify 10.

**Final Run-30 handover closure.** All three read-only evidence tasks completed.
Boundary audit `edd59ea9-7dfb-4f24-84b0-53f16975b1e0` confirms the count
progression 10 (including `paired-options.ts`) to 9 (excluding it) to 6 after C1
is consistent and confirms the durable F2 boundary. Claude zero-write verdict
`cf5d2fe1-e05d-405b-8c35-3d2baeb2abed` PASSed the pre-handover document bytes
`PLAN.md` `28eb59c05d95189ab7bcb5cf463942c03b7288126e173fa270df77cbb0a98032`
and `status.md` `6a14f9f407370046d9ef43f15970b59e6d2c2dbed28e6752dc491e3ee4937dd2`.
This addendum changes both documents and does not extend that verdict to their
new hashes. No source/test edit or test rerun occurred. Next loop completes the
declaration and obtains its separate Claude PASS or REVISE before implementation.

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

## Run 28 (2026-08-08) — DIRECT C1 DRIVER IMPLEMENTATION IN PROGRESS

Run-27 continuity is validated. Both epoch `1786190856388818` bundles matched
their expected SHA-256 values, reported `ready`, and bound HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`; live Git matches. Final G4 PASS
`4565a50b-3bcc-4f58-9d3a-5d3eff36c2c1` remains authoritative and G3 will not
be rerun. C1 task `9f343be2-81bb-48c1-bbbb-f61bce41f36d` never executed after
the correct `risk-not-low` rejection; no helper artifact or partial C1 state
exists.

Recovered full V4 declaration `d6d66743-ec7c-44f9-8081-38c6c602ca00` and
Claude PASS `19c1ae0e-9069-4d02-b476-af1fcb3f2126` from the Run-23 bridge
journal. Fresh hashes for proxy source, proxy test, `tmux-socket.ts`, and
`run-state.ts` match the four PASS-bound preimages exactly. Current dirty-tree
listing matches the handoff baseline before this session-state update.

Standing human authority assigns direct Codex-driver implementation while
preserving `risk: medium`; utility C1 routing will not be retried or weakened.
Three earlier read-only utility-audit submissions were schema-rejected before
execution. A later focused test-file read was automatically delegated as task
`dc0aefc4-5124-4b0f-90d4-58ad051e9c89`, completed with zero writes, and
returned partial source evidence only.

Next: guarded direct edits to only `codex-tmux-proxy.ts` and its test, then
`git diff --check`, V4 focused verification, supported `tmux-socket` and
`run-state` suites, exact postimage hashes, and Claude zero-write native review.
Protected `proxyStopReason` session-presence ternary and literal `: "dead";`
tail, all six inline verify-10 producers, paired argv
invariance, open verify 10, and every unrelated dirty byte remain boundaries.
Forbidden artifact `db8b36fc-be5e-4710-b20c-ecb3fa037fb0` remains untouched.

Direct C1 implementation is now complete in the exact two-file write scope.
`ProxyRuntimeOptions.tmuxLiveness`, stored callback, reconciliation, requested
shutdown, stop reason, and forwarding now consume `TmuxTarget | undefined` with
production default `tmuxTargetLiveness`. Each semantic decision uses the
documented independent record/handle reads, initial runId agreement, a
handle-derived target, and post-probe active-state plus runId/session/handle
SHA guard. Missing or invalid target identity is non-authoritative. Guarded
reconciliation must succeed before bridge state is cleared or the proxy stops
as dead-tmux.

Tests now cover valid target argv, missing and invalid sockets, and identity or
state mutation during injected probes for reconciliation, requested shutdown,
and stop reason. Exact postimages:

- `loop-fork/src/loop/codex-tmux-proxy.ts` —
  `2a41aa89e09a75c6a6c366a1b4f0f1faa018416d311d99f12aa85ca6192ecb6c`.
- `loop-fork/tests/loop/codex-tmux-proxy.test.ts` —
  `6993d5bc3b89a3f71bc6d946dced60c84302f4c94a92466d9a291c668ad7602b`.

Verification evidence:

- `bun run test:file -- tests/loop/codex-tmux-proxy.test.ts`: 30 pass, 0 fail,
  83 expectations.
- `bun run test:file -- tests/loop/tmux-socket.test.ts`: 45 pass, 0 fail,
  114 expectations.
- `bun run test:file -- tests/loop/run-state.test.ts`: 33 pass, 0 fail,
  79 expectations.
- V4 `bunx tsc --noEmit ... src/loop/codex-tmux-proxy.ts`: exit 0.
- Final `git diff --check`: exit 0.

The first proxy-suite run had two test-only failures and was corrected: expected
manifest status now uses canonical `"done"`, and cleanup marks a targetless
active manifest terminal before requesting shutdown. Final rerun passes. Fresh
hashes confirm `tmux-socket.ts` and `run-state.ts` remain at pinned V4 bytes.
All six inline verify-10 producer literals remain present; paired argv files and
all unrelated dirty files were not edited in this atomic step. PLAN.md and this
file carry required session-state updates only.

Governess requested fresh-loop preparation after this atomic step. Blocker:
Claude zero-write native review is pending. Next bounded action is exact
postimage review and handover approval; no broader slice, commit, push, PR,
deployment, release, dependency change, or product-run mutation starts here.
Claude's reviewer lane was idle throughout Run 28, inspected no C1 diff, ran no
C1 checks, and issued no review verdict before writing its bundle. Reviewer
silence is not approval; fresh-loop continuation must obtain explicit PASS or
REVISE first.

## Run 27 (2026-08-08) — CURRENT GOVERNED HANDOVER

Run-27 continuity and G3/G4 gates passed; C1 routing is blocked before helper
execution. No source, test, spec, run artifact, staging, commit, dependency,
remote, or product state changed. This handover updates only `PLAN.md` and
`status.md`; all pre-existing dirty content remains preserved.

Run-27 charter SHA-256 matched
`b83e073c8286badc509ceccc034462edd316de3a1639762aeb55a97a311ab728` before
work. Run-26 handoff hashes matched exactly and both bundles were read fully:
`codex.json`
`2653b158b744f465be18c74a85d070774fc342ff6a272651fd95a94d1d2ab51b` and
`claude.json`
`e37b04b6e22536c1f1f6d6b321d4a4f587abda0055221d16afedf11a8f87c73d`.
Both bundles report ready at G1 HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`; Direct Git tasks
`19b0eae5-302d-4013-8ac4-2d291adec683` and
`dafb66a9-cf6a-41a1-8251-e5441fe581bd` independently returned that live HEAD.

Replacement G3 task `50ed52dc-98f9-4e15-b5af-dd61ddba154d` was the exactly
one authorized replacement. It routed to utility-nanny with top `read_scope`
`[loop-fork/src/loop, loop-fork/src/loop/run-state.ts]`, empty write scope, and
the required file-list/search plan. Exact result:

```text
Step 1:
tmux-socket.ts

Step 2:
export const readRunManifestHandle = (
```

Claude's initial `G4 FAIL`
`199dde35-fd17-49b6-bf3f-43e4eea5c4e8` was reconsidered because it introduced
criteria not authorized by the human-fixed one-shot packet. Final decision
`4565a50b-3bcc-4f58-9d3a-5d3eff36c2c1` is explicit `G4 PASS` and supersedes
the FAIL. The FAIL's first ground misread result `context.sha256`
`de1370dd50cf4803d65683e6a49f8ddb19e65af9e768141de10f854a2cacf810`
as an output digest; it is a context-capsule hash. Its second ground added
post-execution criteria to the exact shape Claude had recommended in
`d91387d2-356c-469a-8306-17ca72df645f`. G3 returned `filesChanged: []`,
`status: completed`, no error field, and no truncation marker.

Claude retains one non-blocking design reservation: output byte-identical to a
target named in the objective is not echo-resistant. This is future gate-design
feedback only, explicitly not a condition on final G4 PASS. Human authority
fixed this G3 shape and exactly one replacement; do not rerun G3 or change those
criteria without new human authority. G4 PASS discharged only the explicit G4
precondition, not any independent C1 routing gate.

Post-PASS validation succeeded. Run-26 bundle hashes still matched; live HEAD
still matched G1. Fresh G2 hashes matched V4 exactly:

- `loop-fork/src/loop/codex-tmux-proxy.ts` —
  `4321a68c626acb181d1da413722a25c71b5efa43a04f7bf40b01df1764c3b3fa`.
- `loop-fork/tests/loop/codex-tmux-proxy.test.ts` —
  `defdf56ab8d585bff228317590c6246f9fbc8bbd6c97e6bd2eef9ff3012c5a46`.
- `loop-fork/src/loop/tmux-socket.ts` —
  `cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`.
- `loop-fork/src/loop/run-state.ts` —
  `60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`.

The exact V4 payload was recovered from Run-23 bridge message
`d6d66743-ec7c-44f9-8081-38c6c602ca00`; Claude PASS
`19c1ae0e-9069-4d02-b476-af1fcb3f2126` binds it to those hashes. Codex
submitted unchanged C1 as task `9f343be2-81bb-48c1-bbbb-f61bce41f36d`.
Governess returned it to the requester with exact reason `risk-not-low`. The
task did not execute; no patch artifact, checks, or changed files exist. Native
tests and Claude artifact review therefore did not run.

Handover verification: `git diff --check -- PLAN.md status.md` exited 0. Exact
`git status --porcelain=v1 --untracked-files=all` confirms the preserved baseline
of nine modified tracked files plus three grouped untracked paths:
`loop-fork/tests/loop/tmux-socket.test.ts`, `runs/tmux-socket-normalization/`,
and `specs/tmux-socket-normalization/`. Nanny task
`86d25ada-f056-4b15-b41a-04cfb7c74efd` summarized only two untracked groups; the
literal native status above is the complete evidence and corrects that summary.

Next bounded action: obtain fresh authority or routing resolution for the
`risk-not-low` rejection without changing V4's approved `risk: medium`, then
dispatch unchanged C1. Independently hash and inspect any returned artifact,
run `git apply --check`, guarded-apply only exact preimages, run the two supported
focused `bun run test:file -- FILE` commands, and request Claude review.

Protected boundaries remain unchanged: preserve the `proxyStopReason`
session-presence ternary and literal `: "dead";` tail, all six
verify-10 producers, paired argv invariance, open verify 10, and every unrelated
dirty-tree byte. Never inspect, use, salvage, or apply
`db8b36fc-be5e-4710-b20c-ecb3fa037fb0`. Do not implement backlog defects.

## Run 26 (2026-08-08) — SUPERSEDED BY RUN 27

Fresh human direction accepted. No source, test, spec, run artifact, staging,
commit, or product state changed in Run 26. Only `PLAN.md` and `status.md` were
updated for this handover. Starting dirty tree remains exactly the observed
nine modified entries plus three grouped untracked paths; all pre-existing
content is preserved.

Run-26 charter SHA-256 matched
`e4e02c022205ce067630fe04889f1216d0b7e81654eeb940cdf474ce89771ffe`.
World Model bootstrap file SHA-256 matched
`fbd5e1932553371f63c59210f688228bd64eed07eefbdb8ec94dca5a3fde3ecf`,
and its `capsuleSha256` matched
`453bf4e300d30878059d11759617b6a24278d640fe72d00a10df4bc960417b3c`.
Indexed commit bindings observed so far are G1 HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`; final unique-binding and live
Git validation remain pending.

Run-25 handoff filename inspection found exactly `claude.json`, `codex.json`,
`continuation.md`, and `manifest.json`. Bundle byte sizes were recorded, but
both bundles and manifest have not yet been fully read or independently
rehash-validated in Run 26.

Replacement G3 has not been dispatched. Schema-rejected calls do not count as
the one authorized replacement probe and produced no task id. Initial rejected
packets incorrectly searched `tmux-socket.ts` for the export; human correction
fixed scope to exact repo-relative paths
`loop-fork/src/loop/tmux-socket.ts` for existence and
`loop-fork/src/loop/run-state.ts` for the export line. Corrected packets were
also rejected with exact broker diagnostic beginning
`route_task command packet is not deterministically executable`; broker
requires a registered linked-worktree root plus path operands repeated in
`read_scope`. Claude packet-shape request
`cb15d7ec-7d4e-4b7a-be63-1c71168e2d5b` is pending. No G4 request was sent.

Governess message `cade81cd-7163-434d-9fce-d9e51d72ce3e` required immediate
fresh-loop preparation at the 14-turn threshold. Therefore G2 was not rehashed,
unchanged V4 C1 was not dispatched, no artifact was received or applied, and
focused tests were not rerun.

Next bounded action: receive Claude's routing answer and dispatch exactly one
successful G3 probe whose literal result contains only the required existence
proof and exact export source line. Fail closed unless Claude returns explicit
G4 PASS on those exact bytes. Then validate Run-25 bundles and live G1 HEAD,
rehash all four G2 preimages, dispatch unchanged PASSed V4 C1, independently
hash and `git apply --check` any artifact, run the two supported focused test
commands, and request Claude review.

Protected boundaries remain unchanged: preserve the `proxyStopReason`
session-presence ternary and literal `: "dead";` tail, all six
verify-10 producers, paired argv invariance, open verify 10, and every unrelated
dirty-tree byte. Never inspect, use, salvage, or apply
`db8b36fc-be5e-4710-b20c-ecb3fa037fb0`. Do not implement backlog defects.

## Run 25 (2026-08-08) — SUPERSEDED BY RUN 26

Post-G1 validation is complete through G3. No product, source, or test file was
changed in Run 25. Only this handoff update and `PLAN.md` are new changes.

Run-24 handoff `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/24/handoff/1786186746232375/`
passed integrity checks: `claude.json`
`d27174a420500ab4450e8d7a4ad6dcb5724ff3797d9423fe5267f0aa19441f06`,
`codex.json`
`4eebc9cb05e64b5d31a9a8920df2be6f1d2316c84582f7ffb76d6dbe40ab8972`,
and `continuation.md`
`306fbeaaffe4c8cb3074cf214dd0ccbbb9c5b32ea58685c3c12c8c06847f8a62`
all match `manifest.json`. Both bundles were read completely and bind G1 HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`. Live `git rev-parse HEAD`
matches. `git diff-tree` shows exactly
`loop-fork/src/loop/run-state.ts` and
`loop-fork/src/loop/tmux-socket.ts`; `git show --stat` reports 2 files and 803
insertions.

Native command evidence from `loop-fork/`:

- `bun test tests/loop/tmux-socket.test.ts`: exit 2, exact diagnostic
  `[loop] direct \`bun test\` is unsupported because Bun can terminate a shared-process suite before all files run; use \`bun run test:file -- <file>\` for focused tests or \`bun run test:ci\` for the complete suite.`
- `bun test tests/loop/run-state.test.ts`: exit 2 with the same exact
  diagnostic. Both are expected repository command refusals, not suite
  failures.
- `bun run test:file -- tests/loop/tmux-socket.test.ts`: exit 0, 45 pass, 0
  fail, 114 `expect()` calls.
- `bun run test:file -- tests/loop/run-state.test.ts`: exit 0, 33 pass, 0 fail,
  79 `expect()` calls.

World Model validation passed: bootstrap file SHA-256
`fbd5e1932553371f63c59210f688228bd64eed07eefbdb8ec94dca5a3fde3ecf`,
logical capsule SHA-256
`453bf4e300d30878059d11759617b6a24278d640fe72d00a10df4bc960417b3c`,
and all unique entity/statement commit bindings equal G1 HEAD
`fe44f280c4a21e840e586f0f9d8098c865ed0d62`.

Run-23 handoff `1786184517286698` rehashes exactly: Claude
`f500d27ff4bdbb52acc601ce16265b774760b52682d77c62b41489544242b36f`,
Codex `1cbc94e1c1d721191f1f9f328b0ae8579d96d1a1d9ac5279b12e765506216301`,
continuation `21a18a555a98b9b0161dc02c78540a25eb9a2642baab7eaf38df77a683002603`.
Run-22 handoff `1786182133758574` rehashes exactly: Claude
`c52a6d02b5034bf7db9e2fdd09098218712c365fce166f0317f466a22c45996c`,
Codex `4b5bbfb7ffb4f242692b6c3f41c3ced6870eb7b83f875890c95cc35b52212a27`,
continuation `ded1c4f9bbe633dc83123758f35964c3343217fb7d81bd42f6a9e98007721d37`.
Every hash matches its manifest. Both runs bind old HEAD
`ddf134b9200a3fda3cac68dcdd7868f28c94160d`, so their evidence is historical
after G1.

G2 drift guard passed exactly:

- `codex-tmux-proxy.ts`:
  `4321a68c626acb181d1da413722a25c71b5efa43a04f7bf40b01df1764c3b3fa`
- `codex-tmux-proxy.test.ts`:
  `defdf56ab8d585bff228317590c6246f9fbc8bbd6c97e6bd2eef9ff3012c5a46`
- `tmux-socket.ts`:
  `cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`
- `run-state.ts`:
  `60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`

G3 used one bounded read-only helper-workspace visibility probe, task
`e7e390c2-fada-414b-a4cc-86a429b4d7ca`. Verbatim returned summary:

```text
Task ID: e7e390c2-fada-414b-a4cc-86a429b4d7ca

**Directory listing (loop-fork/src/loop):**
- agents.ts
- args.ts
- bridge-claude-registration.ts
- bridge-config.ts
- bridge-constants.ts
- bridge-dispatch.ts
- bridge-guidance.ts
- bridge-message-format.ts
- bridge-runtime.ts
- bridge-store.ts
- bridge-utility.ts
- bridge.ts
- caveman-skill.d.ts
- caveman.ts
- claude-config-gc.ts
- claude-kickoff.ts
- claude-sdk-server.ts
- codex-app-server.ts
- codex-home.ts
- codex-render.ts
- codex-tmux-proxy.ts
- communication-guidance.ts
- constants.ts
- delegation-policy.ts
- deps.ts
- effort.ts
- git.ts
- governess-context.ts
- governess-cycle.ts
- governess-detect.ts
- governess-exit.ts
- governess-handoff.ts
- governess-journal.ts
- governess-llm.ts
- governess-notify.ts
- governess-pane-liveness.ts
- governess-policy.ts
- governess-recover.ts
- governess-replay.ts
- governess-runtime.ts
- governess-usage-limits.ts
- governess-usage.ts
- governess.ts
- hooks (directory)
- iteration.ts
- launch-reservation.ts
- launch.ts
- legacy-governess-compat.ts
- main.ts
- memory-checkpoint.ts
- native-subagent.ts
- openai-compatible.ts
- oss-adapter.ts
- paired-loop.ts
- paired-options.ts
- panel.ts
- pi-runtime.ts
- ports.ts
- pr.ts
- process.ts
- prompts.ts
- recon-pane.ts
- review-authority.ts
- review.ts
- run-process-cleanup.ts
- run-state.ts
- runner.ts
- session-pressure.ts
- single-loop.ts
- stale-bridge-cleanup.ts
- task-router.ts
- task.ts
- tmux-control.ts
- tmux-socket.ts
- tmux.ts
- types.ts
- update-deps.ts
- update.ts
- utility-context.ts
- utility-execution-tier.ts
- utility-observability.ts
- utility-path-policy.ts
- utility-readiness.ts
- utility-runtime.ts
- utility-store.ts
- utility-tools.ts
- utility-workspace.ts
- utils.ts
- workspace-binding.ts
- worktree.ts
- world-model-cli.ts
- world-model-ontology.ts
- world-model-runtime.ts
- world-model.ts
- ws-client.ts

**File read (loop-fork/src/loop/run-state.ts):** 1474 lines, complete. Contains `export const readRunManifestHandle = (` at line ~1330 (within the file).

**tmux-socket.ts present:** Yes, in directory listing.

**Authority flags:** All false. No writes.
```

G4 failed closed. Claude decision
`53fe5e56-dc2a-4a33-89e9-b78f6c6ff7aa` returned explicit `G4 FAIL` for task
`e7e390c2-fada-414b-a4cc-86a429b4d7ca`. Decisive evidence: empty
`artifactRefs` and `checks`; absent verbatim `run-state.ts` bytes; approximate
`~1330` line claim proving paraphrase; and `paneSummary` truncation at
`launch-r`. Completed job state proves execution, not delivery of required
evidence. C1 remains undispatched. Do not rerun G3 in Run 25. Next loop must
obtain fresh human direction, then bind exact bytes to an artifact or use a
short exact line-window read that survives the result channel.

Protected boundaries remain intact: the `proxyStopReason` session-presence
ternary and literal `: "dead";` tail remain at `codex-tmux-proxy.ts:388`;
six verify-10 producers remain at
`governess-replay.ts:326`, `bridge-runtime.ts:1105`,
`launch-reservation.ts:121`, `launch-reservation.ts:224`,
`codex-tmux-proxy.ts:388`, and `paired-options.ts:75`. Paired argv invariance,
open verify 10, and unrelated dirty content remain preserved. Never inspect,
use, salvage, or apply `db8b36fc-be5e-4710-b20c-ecb3fa037fb0`. Do not
implement backlog defects.

## Run 24 (2026-08-08) — SUPERSEDED BY RUN 25

Run-23 handoff validation passed: `codex.json`
`1cbc94e1c1d721191f1f9f328b0ae8579d96d1a1d9ac5279b12e765506216301`
and `claude.json`
`f500d27ff4bdbb52acc601ce16265b774760b52682d77c62b41489544242b36f`
match `handoff/1786184517286698/manifest.json`; both bundles were read
completely. V4 preimages currently match all four pinned hashes. Run-24 World
Model bootstrap file and logical capsule hashes match, and all indexed entity
and statement bindings point to pre-G1 commit
`ddf134b9200a3fda3cac68dcdd7868f28c94160d`.

Current step: G1 prerequisite commit, exact two-file scope only:
`loop-fork/src/loop/tmux-socket.ts` and
`loop-fork/src/loop/run-state.ts`. Next: focused checks; World Model plus
Run-23/Run-22 post-HEAD-move binding validation; G2 hashes; mandatory G3
read-only helper visibility probe; Claude G4 confirmation; unchanged V4 C1
dispatch. No C1 dispatch before G4 PASS.

G1 completed in commit `fe44f280c4a21e840e586f0f9d8098c865ed0d62`.
Index inspection before commit showed only `run-state.ts` (`127/0`) and new
`tmux-socket.ts` (`676/0`); both staged hashes matched V4 and cached diff check
passed. Post-commit index is empty. Remaining worktree is nine modified plus
three grouped untracked paths, exactly the unrelated remainder after removing
the two committed dependency paths from the 10-modified plus 4-untracked
starting baseline.

Claude's late zero-write review PASS
`e91ddd5c-12f9-49a7-abff-6d6fc4d3b87d` independently confirmed this exact
two-file G1 scope and that no test or third file belonged in the commit. Ack
`af3a9832-71a3-40ea-826f-4ea26f2bf115` records the arithmetic correction: live
post-G1 status is 9 modified plus 3 grouped untracked, not 8 plus 3.

Post-G1 focused verification remains unrun. Auto-routed task
`49e0cd0e-92fc-4f3d-bfb2-9dfb21753cf4` failed before execution with
`Direct run_check failed: Path does not exist:
tests/loop/tmux-socket.test.ts`; two absolute-path route submissions then failed
schema/path validation before task creation. Run-24 World Model, Run-23, and
Run-22 commit bindings have not yet been revalidated against moved HEAD. G2
hashes, mandatory G3 visibility probe, Claude G4 confirmation, and unchanged
V4 C1 dispatch have not started.

Next bounded action: obtain valid executions of
`bun test tests/loop/tmux-socket.test.ts` and
`bun test tests/loop/run-state.test.ts` from `loop-fork/`, record exact results,
then perform the post-HEAD-move binding checks before G2.

Hard boundaries remain: preserve the `proxyStopReason` session-presence
ternary and literal `: "dead";` tail, all six inline verify-10
producers, unrelated dirty baseline content, and open verify 10. Never touch
`db8b36fc-be5e-4710-b20c-ecb3fa037fb0`; do not address backlog defects.

## Run 23 (2026-08-08) — SUPERSEDED BY RUN 24

Declaration-only C1 step complete. Both Run-22 handoff bundles matched their
manifest SHA-256 values and were read completely before any edit. Live state
remained branch `codex/tmux-socket-normalization-run11`, HEAD
`ddf134b9200a3fda3cac68dcdd7868f28c94160d`, nothing staged, ten modified plus
four untracked entries. No source/test change, helper dispatch, patch apply,
commit, push, merge, PR, deployment, release, dependency change, or product-run
mutation occurred.

Claude approved corrected C1 declaration V4
`d6d66743-ec7c-44f9-8081-38c6c602ca00` with explicit PASS
`19c1ae0e-9069-4d02-b476-af1fcb3f2126` after three zero-write REVISE rounds.
The approved declaration keeps the existing two-file write scope, reads proxy
source/test plus `run-state.ts` and `tmux-socket.ts`, omits `tmux-control.ts`,
states its synchronous target-liveness contract literally, keeps
`readRunManifest` because `ManifestHandle` has no run state/session, and uses a
documented two-read window with post-probe guard re-check. PASS is bound to:
proxy source `4321a68c626acb181d1da413722a25c71b5efa43a04f7bf40b01df1764c3b3fa`,
proxy test `defdf56ab8d585bff228317590c6246f9fbc8bbd6c97e6bd2eef9ff3012c5a46`,
`tmux-socket.ts`
`cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4`,
and `run-state.ts`
`60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522`.

C1 is approved but not dispatchable yet. `readRunManifestHandle` exists only in
the uncommitted +127/-0 `run-state.ts` delta and `tmux-socket.ts` is untracked.
G1 requires separate human authorization to make those exact bytes visible to
helper workspaces. G3 then requires a positive in-helper visibility probe whose
verbatim output both lists `tmux-socket.ts` and reads the literal
`export const readRunManifestHandle = (`. Missing/empty/error evidence fails G4;
local Git status and hashes are not visibility evidence. Only after G4 passes
may V4 dispatch unchanged.

Human boundaries remain intact: preserve the `proxyStopReason`
session-presence ternary and literal `: "dead";` tail, preserve all six inline
verify-10 producers, and leave verify
10 open. Never use task/artifact `db8b36fc-be5e-4710-b20c-ecb3fa037fb0`.

Next: request human authorization for G1; then run G3, record its task id and
verbatim output, and obtain Claude confirmation that G4 passed before helper
dispatch. If G1 uses a commit, revalidate World Model and Run-22 commit bindings.

## Run 22 (2026-08-08) — SUPERSEDED by Run 23

Task active. Run-21 `codex.json` and `claude.json` matched required SHA-256
values `246c8ab2afacb9851773170298593f7a0090655050a837aff0bffc324b2f101c`
and `d682d0f9c588f5cc75ad047f47e15cad5bacb1cfdde5998b17eb3d73c9483ac5`
and were read completely before edits. Claude PASS
`70159484-7644-4792-a0ea-bd9c1f20d15f` overrides the stale Codex REVISE note.
Inherited Git state independently matched HEAD
`ddf134b9200a3fda3cac68dcdd7868f28c94160d`, branch
`codex/tmux-socket-normalization-run11`, no staged changes, ten modified files,
and four grouped untracked entries. Direct Git status confirms the fourth is
`specs/tmux-socket-normalization/`; a contrary utility result was false.

`tmux-control.ts:140-175` confirms synchronous `tmuxTargetLiveness` and async
`tmuxTargetLivenessAsync`; no control signature change is allowed. All nine
`./tmux-control` importers were inventoried. `governess-pane-liveness.ts` uses
only bounded helpers and `panel.ts` only timeout/kill constants, so neither has
a liveness symbol to migrate. `paired-options.ts` remains explicit verify-10
backlog. W2, F1, corrected risk-C, six inline fail-open sites, paired argv
invariance, and D-001 through D-012 remain untouched.

Run-21 terminal results were recovered directly from durable job records. Patch
hashes and manifests were independently rehashed and fully read; all declared
preimages still match. Replay `c866dccc5cc1185ea5d547462bee81923ede27cb2726b3a0de2a474f9e8c38b5`
failed `git apply --check` at line 36. Corrected F2
`6a1394541963d335ef098ed8d162ddaa8e3e5ccef2eff22d6fde48c92c77fd19`
failed at line 7. Governess
`e6b1579aa110a523912c359c2779ec3ec7e1877be25e7235eaa1206483fec460`
apply-checks but is partial, has no tests, and violates sole-producer manifest
handle provenance. None was applied or used.

Corrected proxy task `db8b36fc-be5e-4710-b20c-ecb3fa037fb0` returned patch
SHA-256 `d233f2fc991385892558987d1b2fffb6e282ccfdfbddcb0fc6f5cecdaf43b9f0`
and manifest SHA-256
`dd5adb4529ac61d775d40d8beac1a80eabff7a0906fcd5aaba641bbb3b7411b6`.
Both were independently hashed and fully read; preimages match. The patch was
rejected because `git apply --check` reports `corrupt patch ...:67`, it imports
`createManifestHandle` outside `run-state.ts`, uses unsafe manifest casts, and
changes the explicitly open proxy line-908 verify-10 producer. No apply, test,
or typecheck followed.

Claude zero-write verdict `03738b58-e93c-4858-a8b2-8b44c9b39791` is REVISE:
add `run-state.ts` read context, decide the manifest double-read race, state the
`proxyStopReason` session-presence ternary and literal `: "dead";` tail
exactly, and retain the corrected four-untracked baseline.
Human authority resolves the remaining design boundary: preserve
the `proxyStopReason` session-presence ternary and literal `: "dead";` tail
and all six inline verify-10 producers in this
slice, defer Claude blocker 3, and use a single-handle-derived manifest read so
the target and guard evidence come from the same read. Governess decision
`f6755f3f-3fb8-4921-9730-db5cae8e6181` ordered a fresh-loop handover.

Next: do not apply task `db8b36fc-be5e-4710-b20c-ecb3fa037fb0`. Resolve the
revised proxy declaration around one handle-derived manifest read, expose
`readRunManifestHandle` in read scope, preserve the `proxyStopReason`
session-presence ternary and literal `: "dead";` tail and all six inline
producers, then send that declaration to Claude for zero-write PASS before any
dispatch or guarded apply. No source/test edit, guarded apply, commit, push,
merge, PR, deployment, release, discard, dependency change, or product-run
mutation occurred in Run 22.

## Run 21 (2026-08-08) — SUPERSEDED by Run 22

Task active. Run-20 handoffs matched required SHA-256 values exactly and were
read completely before edits: `codex.json`
`4b15f5feac08418aa682398766f0fc15d84524ec600b5d23bd7c179fba09ad78`
and `claude.json`
`7c0f0506dcef7b4283bbf3b1df7122861902c6d190da2830b74da77d643b6ea1`.
Inherited docs, HEAD `ddf134b9200a3fda3cac68dcdd7868f28c94160d`, branch,
and exact 10-modified plus 4-untracked tree all match Run 20.

Claude boundary decision `59eac508-6550-49cf-bf87-17c69c0f6612` is consumed.
Nine old callers are confirmed as Governess 2, replay 1, bridge 2, proxy 3,
and reservation 1; `paired-options.ts` stays separate. B1 is resolved with an
optional manifest-derived target passed only through non-paired `runInTmux`
sites. Paired `startPairedSession` probe argv must remain byte-identical. C1-C4
are explicitly accepted. W2, F1, risk-C PASS remain preserved; verify 10 stays
open at the six inline fail-open sites.

Active helper packets: F2 `0c1a5dd3-0e83-4e55-9fec-6fca5275e6ec`, proxy
`e18c5cb5-ad2c-411f-84e1-ea650a76a1d1`, reservation
`000c4c06-fbf0-49c2-80b5-655047d08efc`. Reservation task returned three
independently hashed patch files; all failed `git apply --check` as corrupt at
line 32. Its proposed `createTmuxTarget` also does not exist and would violate
the sole-producer provenance boundary. None was applied; focused execution was
impossible because no artifact was parseable. Corrected replacement task
`955a5a4a-f3f8-475a-98fb-69070b533ad6` is active with `tmux-control.ts` and
`tmux-socket.ts` added to read scope and an explicit `targetFromManifest`
constraint.
Next: inspect/hash/apply-check each returned artifact, guarded-apply only exact
preimages, focused-test after each apply, then route remaining Governess,
replay, and bridge source/test pairs. Final gate requires aggregate focused
tests, source typecheck, exact old-call inventory, `git diff --check`, and
Claude PASS. No commit, push, merge, PR, deployment, or release yet.

**Final Run-21 state:** Governess ordered handover at preparation threshold via
`a6e3d4c0-4122-475d-b8f2-cc791596d96e`. Run 21 changed only `PLAN.md` and
`status.md`; no source/test patch was applied. HEAD, branch, exact dirty-tree
membership, W2/F1/risk-C hashes, and all active preimages remain unchanged.
`git diff --check` passed before final documentation update.

Focused baselines passed before artifact work: tmux 104/0, proxy 20/0,
reservation 16/0, Governess 78/0, governess-runtime 13/0, bridge 108/0; total
339/0. Three original reservation patches, one F2 patch
`fb91f8d850510209956f021d02549a2800c6433caaa2275567f811864f3d5318`,
and corrected reservation patch
`89843151a90edf8f2c9d165440e8131b4cca651fbb24a2b91ebf67df2c1cd9c0`
were independently hashed and fully inspected. Every patch failed
`git apply --check`; none was parseable or focused-testable. The corrected
reservation patch also violated the `createManifestHandle` sole-producer rule.
Bridge patch `859717c25071b701e60edc2fd962915a9c2269e9f1ecb08d904c3a1be67755a5`
was independently hashed and fully inspected, then rejected when
`git apply --check` failed at line 22. No artifact was applied.

Claude verdict `983e5105-3dac-4a22-8455-73b79fe837d7` is REVISE. B1/C1
restatement is delivery `03c95f89-b56d-43bf-8e9b-93c70e39e3ac`: non-paired
`launchContext` alone supplies F2 socket identity through all five named
functions; every paired shared/start probe argv stays byte-exact. Proxy uses
existing `tmuxTargetLiveness` without changing `tmux-control.ts` signatures.

Original proxy `e18c5cb5-ad2c-411f-84e1-ea650a76a1d1` failed by runtime
limit with no artifact. Replay `bb70cb06-25d3-4345-bc57-b8801b662cbf`
completed after handover finalization with unvalidated artifact
`0f5c77c4-bda3-453b-89ae-12c26aca65f4.patch`; successor owns full artifact
audit. Running when last checked: Governess
`0a545a31-96d6-4405-a106-f03b4ccb0197` and corrected F2
`8b98217d-3eeb-49e1-aa4d-38f4139e0af8`.

**Next:** successor verifies handover/preimages, pulls terminal results,
rejects original proxy due insufficient read scope, reissues it with
`tmux-control.ts` and `tmux-socket.ts` read context, and obtains Claude PASS on
corrected boundaries. Hash/inspect/apply-check every artifact and focused-test
every parseable candidate before guarded apply. Preserve W2, F1, risk-C, paired
invariance, and six-site verify-10 deferral. No commit, push, merge, PR,
deployment, or release occurred.

## Run 20 (2026-08-08) — SUPERSEDED by Run 21

Governess ordered a fresh-loop handover at the preparation threshold before
implementation began. Current objective remains one atomic T-05 consumer
slice: F2 A1-A3 plus all nine old session-liveness caller migrations, with a
named unknown-state regression at every consumer. W2, F1, and risk-C PASS must
remain preserved; unrelated backlog stays untouched.

**Continuity passed.** Run-19 handoffs matched exactly: `codex.json`
`9ce6ed799018982e7a47ecc92459957a68f4b43a79527badd5ac87e15fb23723` and
`claude.json`
`fb3e759260be5b1e304215825e5675f6b1e075211ef0c0a00f9e64a0b7d935f7`.
Both complete bundles were read. Inherited `PLAN.md` and `status.md` matched
`e19bec9ad0df7f93406c179802dc0be4ae8a80702b23ed2094b973d49d9c9132` and
`8856f6467c82410354ee9d95531d9d83c5b4d34db82cb2713a12dedd79e58059`,
with one current heading each. HEAD remains
`ddf134b9200a3fda3cac68dcdd7868f28c94160d` on
`codex/tmux-socket-normalization-run11`. Native porcelain confirmed the exact
inherited 10 modified plus 4 untracked entries, with no staged or extra path.

**Preservation passed.** Risk-C live hashes remain
`tmux-control.ts` `138ea1a5524ceb8c2091e28361f051ebfee7473189d9612b7d32de9ea9a6484c`,
`tmux.ts` `ccba303ca1f72cbd7e4851e8a64978e4e1e3aa02ce3820b610de9e7e9b36cc14`,
`tmux-control.test.ts`
`3e87a72d210f831c8a52b7e42c91c72fad33d1c13c658f6b4001f727cf2d1c30`,
and `tmux.test.ts`
`6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20`.
F1 confinement test remains
`67f4775c27be38515ae837f1687c48f7d676684c407ee7ae085fd01f0b7db889`.
Run-19 Claude handoff independently records risk-C PASS. No source or test file
was changed in Run 20.

**Boundary review pending.** Live source currently contains ten old-liveness
expressions: two in `governess.ts`, one in `governess-replay.ts`, two in
`bridge-runtime.ts`, three in `codex-tmux-proxy.ts`, one in
`paired-options.ts`, and one async use in `launch-reservation.ts`. Run-19 text
separates nine caller migrations from `paired-options.ts`'s distinct
socket-blind probe correction. Targeted Claude request
`ea79d53a-6ccb-469d-81de-6dfd863065fd` asks for exact membership, F2 A1-A3
scope, per-consumer unknown-test granularity, and ordering. No response arrived
before handover. Do not convert the likely `paired-options.ts` exclusion from
inference into implementation authority without consuming that answer.

**Routing/check record.** Git-status audit
`db3374a5-44cc-44da-b449-b75ee918ba75` correctly found all ten modified paths
but missed the fourth untracked directory and lacked HEAD/branch output; direct
Git disproved its 13-entry conclusion and verified all 14 expected entries.
Four additional exact read/search routes failed with
`route_task utility packet is not deterministically bounded`. No utility patch
was produced or applied.

**Next:** verify the fresh handoff and pull Claude request
`ea79d53a-6ccb-469d-81de-6dfd863065fd` immediately. Settle exact nine-call and
F2 boundaries before implementation. Then route bounded non-overlapping edit
packets, independently hash/inspect/apply-check every artifact, guarded-apply
only exact live preimages, and run focused tests after each apply. Preserve
paired attach/hint deferral and leave the six separate verify-10 sites plus
`paired-options.ts` open unless peer mapping explicitly places one in this
slice. No commit, push, merge, PR, deploy, release, discard, or product-run
mutation occurred.

## Run 19 (2026-08-08) — SUPERSEDED by Run 20

Governess requested fresh-loop handover after corrected risk C landed and
passed local focused checks. F2 A1-A3 and the nine old session-liveness caller
migrations were not started.

**Continuity passed.** Charter SHA-256 matched
`6246793302f0fa867f7090b2f64d765f131a0c4dca3b60ffd73cbb960842d19f`.
Every Run-18 handoff component matched `manifest.json`; acceptance referenced
manifest digest
`5b0bd3e6f10a64055288db0336c2d77f3ed74b5a59eb0a1c8468a578983863ae`;
the complete prior transcript was read. HEAD remained
`ddf134b9200a3fda3cac68dcdd7868f28c94160d` on
`codex/tmux-socket-normalization-run11`. World-model file/capsule hashes
matched, but missing `repositoryCommit` kept the bootstrap unusable; direct
Git, Run-19 manifest/journals, and validated handoff evidence were used.

**Corrected risk C landed.** Shared `NO_SESSION_RE`,
`MISSING_TMUX_SOCKET_RE`, and `isConfirmedMissingTmuxSession` now live in
`tmux-control.ts`; `tmux.ts` imports the helper. Target sync captures stderr;
target async pipes stderr only and settles on `close` after drainage. `dead`
requires `NO_SESSION_RE`. ENOENT and every generic connection, overlong-path,
non-socket, permission, empty, or unrecognised diagnostic stays `unknown`.
Timeout, signal, spawn error, absent target, and null close code stay `unknown`;
exit zero stays `live`. Session-only APIs and the existing initial-preflight
missing-socket opt-in are unchanged.

Final hashes:

- `loop-fork/src/loop/tmux-control.ts` —
  `138ea1a5524ceb8c2091e28361f051ebfee7473189d9612b7d32de9ea9a6484c`.
- `loop-fork/src/loop/tmux.ts` —
  `ccba303ca1f72cbd7e4851e8a64978e4e1e3aa02ce3820b610de9e7e9b36cc14`.
- `loop-fork/tests/loop/tmux-control.test.ts` —
  `3e87a72d210f831c8a52b7e42c91c72fad33d1c13c658f6b4001f727cf2d1c30`.
- `loop-fork/tests/loop/tmux.test.ts` unchanged —
  `6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20`.

**Helper defects contained.** Task
`cc40ad93-b2b5-488a-8c96-cc9b258c6617` claimed artifact
`c9b5ce40-ff77-4b23-b7eb-555cd3c56eda.patch`, SHA-256
`7947000b5ac303296c69c0c39f3d767b715f21d21763fb876c81a614807e1298`,
was a valid unified diff. That claim is false: independent
`git apply --check` failed exactly at line 44. It was never applied or
salvaged. Three later control artifacts were also rejected without apply:
non-applying at live line 118 and semantically wrong (AND instead of OR,
no-server classified unknown, missing two-argument signature); corrupt at line
23; and one-hunk corrupt at line 22. Codex then applied the settled control
edit directly against unchanged dirty preimage
`9f9edd3754f7a40c8810d3cd41dc534ea1e68b9ee1a1efc412dbe3737f1ccb67`.
Guarded apply succeeded for `tmux.ts` artifact
`75eaf3db63fe5faa8800b2a9a5dc5fd2482c438dd8af5fa8ef96e8fb251cf099`
and test artifact
`35b6774df8c4a053a5f4bcc85f63814e5bd18353533f271720925dfa3c3b8f64`.
The first focused test exposed test-artifact truncation exactly:
`Unexpected end of file` at `tmux-control.test.ts:355`; Codex completed the
incomplete tail and added omitted async unknown cases, then reran all checks.

**Verification:**

- `tmux-control.test.ts`: **30 pass / 0 fail / 40 expect() calls**.
- `tmux.test.ts`: **104 pass / 0 fail / 536 expect() calls**.
- Documented source typecheck: exit 0.
- Biome on four risk-C files: exit 0, no fixes required.
- `git diff --check`: exit 0.

Bare repository-wide `bunx tsc --noEmit --pretty false` remains non-gate exit 2
with broad pre-existing errors. Claude final live-tree review request
`7a953bd7-f57c-4396-bff6-81cb25337219` is pending; consume its independent
verdict before calling risk C peer-passed.

**Next:** if Claude returns PASS, start F2 A1-A3 plus all nine old
session-liveness caller migrations as one atomic T-05 continuation. Six inline
fail-open producers remain open across T-06/T-08/T-10, and
`paired-options.ts` needs its distinct socket-blind probe fix. Do not claim
verify 10 closed until every named per-site unknown test passes. Paired
`runInTmux` attach/hint migration remains deferred.

## Run 18 (2026-08-08) — SUPERSEDED by Run 19

Governess requested handover after the current risk-C disposition. No source
or test patch landed. F1 remains complete; risk C, F2 A1-A3, and the nine old
session-liveness caller migrations remain open.

**Continuity passed.** Charter SHA-256 matched
`ad1603970b3f413f84f264bfacc3555980814a5a2252dd89d36033461fabba8b`.
Run-17 handoff component digests and acceptance manifest digest
`65d504bdd57c25d0d2cc833ea308ca183c1824c576a60251a7a303206d205dd0`
matched, and the complete prior transcript was read. HEAD stayed
`ddf134b9200a3fda3cac68dcdd7868f28c94160d` on
`codex/tmux-socket-normalization-run11`; dirty inventory stayed 10 modified
plus 4 untracked. World-model file/capsule hashes matched, but missing
repository-commit JSON field made the bootstrap unusable; direct Git, Run-18
manifest, handoff, and journal evidence were used.

**Fresh helper result rejected; nothing applied.** Task
`60034e78-5c36-45eb-89e0-1634aff6d22f` completed with artifact
`700e069b-52cc-4b8b-b342-34d715952486.patch`, SHA-256
`11e2b7fc8b1ac5c40856e769e2894c5ec7fdb632abac46545e503402bb846a08`.
Its declared dirty preimages matched, and those live files remain unchanged:

- `loop-fork/src/loop/tmux-control.ts` —
  `9f9edd3754f7a40c8810d3cd41dc534ea1e68b9ee1a1efc412dbe3737f1ccb67`.
- `loop-fork/tests/loop/tmux-control.test.ts` —
  `f1796fe75b99ab61a6c5bb0538e56422c7781f4250e73a40a9b02939474117eb`.

Independent `git apply --check` failed exactly:
`error: corrupt patch at .loop/utility-artifacts/60034e78-5c36-45eb-89e0-1634aff6d22f/700e069b-52cc-4b8b-b342-34d715952486.patch:25`.
The patch was also semantically stale: it treats broad `error connecting to`
stderr as dead. Claude message `5de017fb-c02b-44a8-b844-4de6a0edf101`
measured tmux 3.7b behavior and ruled ENOENT unknown because a live server can
retain its workspace after external socket unlink. The artifact was neither
applied nor salvaged. Baseline focused command from `loop-fork/`,
`LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/tmux-control.test.ts`,
passed **9 tests / 0 failed / 16 expect() calls** before any risk-C change.

**Corrected accepted semantics:** only existing `NO_SESSION_RE` diagnostics
produce `dead`; generic connection errors, ENOENT, overlong path, non-socket,
permission, empty, and unrecognised stderr remain `unknown`. Async must settle
on `close` after stderr drainage. Shared missing-session/socket predicates move
from `tmux.ts` to `tmux-control.ts`; `tmux.ts` imports them. Existing
`allowMissingSocket` remains only at initial preflight `tmux.ts:3297`; target
APIs gain no opt-in. Required tests cover sync and async live, missing session,
no server, all named unknown diagnostics, timeout/signal/spawn error, absent
target/no contact, and stderr arriving after `exit` but before `close`.

**Escalation correction:** five `task_status` polls did not prove a stall;
`updatedAt` records transitions, not heartbeat. Worker PID `35923` remained
alive and CPU-active. Both supervisor cancellation requests were superseded
after normal terminal completion. Keep reservations until explicit terminal
state, but use worker/runtime evidence before future stall escalation.

**Next action:** route fresh non-overlapping guarded edits for corrected source
relocation/behavior (`tmux-control.ts`, `tmux.ts`) and tests
(`tmux-control.test.ts`, plus `tmux.test.ts` if shared-predicate coverage needs
it). Require valid `git apply --check`, exact live preimages, guarded apply,
focused proof, and Claude artifact review. Then implement F2 A1-A3 plus all
nine caller migrations atomically. Keep paired `runInTmux` attach/hint argv
deferred and verify 10 open at six separate sites. No commit, push, merge,
deploy, discard, release, PR, or product-run mutation occurred in Run 18.

---

## Run 17 (2026-08-08) — SUPERSEDED by Run 18

Governess message `a2293f11-865e-4137-bbb3-3e9d924dd570` requested a fresh-loop
handover at the context threshold. F1 is complete. No F2 or nine-site
liveness-cascade source/test edit started.

**Continuity checks passed.** Charter SHA-256 matched
`6d66ed14ae4264003ee4c175a87a3d9f29f42e31cc30b3a576b32949f48bec5d`.
Every Run-16 handoff bundle digest matched, acceptance referenced manifest
digest `167b22ffe322e597d26f7173f1d3b0a7d54cdda9c35e3f91656a59c2d8d96ae8`,
and the complete prior transcript was read. Live Git state matched the handoff:
HEAD `ddf134b9200a3fda3cac68dcdd7868f28c94160d`, branch
`codex/tmux-socket-normalization-run11`, 10 modified plus 4 untracked entries,
and `git diff --check` clean before the F1 patch. World-model file and capsule
hashes matched, but the required repository-commit field was absent; the
bootstrap was not used.

**F1 COMPLETE, no guard bypass.** Task
`6d02e3de-f954-44f5-a8a7-64847fefbed0` returned patch SHA-256
`2a2fb75bbf828384c62ee94f02dba08b3bebe66287660667ff83aa8d2e36957c`.
Independent `git apply --check` passed before guarded application. Guarded
preimage/postimage:

- `loop-fork/tests/loop/tmux-socket.test.ts` —
  `d8793c89defa77e06b1e0362ad7471c6f87b92fee495536f19687b306f9ff299`
  to `67f4775c27be38515ae837f1687c48f7d676684c407ee7ae085fd01f0b7db889`.

The test now recursively inspects all TypeScript files below `loop-fork/src`,
normalizes importers to repo-relative forward-slash paths, and still asserts
the exact named pre-manifest composer regions. Focused command from
`loop-fork/`:

`LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/tmux-socket.test.ts`
— **45 pass / 0 fail / 114 expect() calls**.

**Risk-C edit failed the patch-integrity gate and remains open.** Task
`f9f9f9d7-943d-4fba-be8d-237f2bee2a31` returned artifact
`1d27de56-e096-4daa-87ef-03af7617c0a7.patch`, SHA-256
`6127aa114ad8f04d2cd013de01b958087a898feef9a8d54204ace72e40de4ff1`.
Independent `git apply --check` failed exactly:
`error: corrupt patch at .../1d27de56-e096-4daa-87ef-03af7617c0a7.patch:26`.
The artifact was not applied. No risk-C test ran, and the live
`tmux-control.ts` / `tmux-control.test.ts` bytes remain their predecessor
versions. Read task `f5db64e7-0e39-42e6-b1cf-cf7d9d322431` only inspected the
artifact and changed no files.

**Dirty-preimage gate for the correction:**

- `loop-fork/src/loop/tmux-control.ts`: working tree
  `9f9edd3754f7a40c8810d3cd41dc534ea1e68b9ee1a1efc412dbe3737f1ccb67`;
  HEAD `6472d6dc779ab242421df3e3d1ee42d23f10bd9de78ec4f8c815d49d2dcab86d`.
- `loop-fork/tests/loop/tmux-control.test.ts`: working tree
  `f1796fe75b99ab61a6c5bb0538e56422c7781f4250e73a40a9b02939474117eb`;
  HEAD `480c9a674ade563f832e611d6a90c18840e1baf85d400980d928365f94a720ed`.

Before guarded apply, require the artifact manifest's preimages to equal the
working-tree hashes above. Reject a HEAD-based artifact even if it otherwise
applies: it would erase accepted uncommitted predecessor work.

**Next action:** request a fresh valid guarded risk-C patch against the live
two-file preimages, independently require `git apply --check`, then guarded
apply and run focused tmux-control tests. After that, implement F2 corrections
A1-A3 and all nine session-liveness caller migrations as one atomic T-05 slice.
Keep paired `runInTmux` attach/hint argv deferred and keep verify 10 open at its
six separate sites. No commit, push, merge, deploy, discard, release, or
product-run mutation occurred in Run 17.
For any reissued helper, poll at most five times about ten seconds apart before
escalating to Governess for cancel/reissue. Release its write reservation only
on an explicit Governess terminal state, never on silence or a quiet channel.

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

Session: loop run-11, branch `codex/tmux-socket-normalization-run11`,
worktree `/private/tmp/agents-collab-tmux-socket-normalization-run11`.
Base commit `ddf134b9200a3fda3cac68dcdd7868f28c94160d` (exact merged `main`).
Defect `adc4bb8a-4b7b-4245-832f-a1995076b6b1`. Plan: `PLAN.md`.
Spec bundle: `specs/tmux-socket-normalization/{spec,plan,tasks,verify}.md` —
**review-approved (round 3 PASS) and founder-approved 2026-08-08. The gate is
cleared and implementation is underway.** Sections below that describe review
rounds 1 and 2, or say approval is pending, are the historical record of how
the bundle got approved; they are not current state.

> **ARCHIVED — prior handoff.** The `claude-kickoff-submit-guard` status that
> previously occupied this file described work that is now merged into `main`
> at `ddf134b9`. It is preserved in git and readable with
> `git show ddf134b9:status.md`. It is not current state and is not carried
> forward here.

---

# HANDOVER — read this section first

## Run 14 (2026-08-08) — SUPERSEDED by Run 18

### ROLE SWITCH — Claude stopped driving; Codex is driver, Claude is reviewer

Founder directive relayed 2026-08-08 (`3b19f134-a801-4f95-8b7a-f3633e7a1287`):
Claude stops driving Run 14, preserves the tree exactly, and remains available as
independent reviewer. No implementation slice was in progress, so nothing needed
unwinding. Work request `b16d4fd7-56f4-4e7e-b219-7cd6f0563e6c` activated Codex as
driver for the open W2 fixture-scoped wiring.

**Tree preserved and hash-verified at the switch.** Suite EXIT 0,
**1704 pass / 0 fail**; `loop-fork/runs/` byte-identical to the T-00 baseline;
HEAD `ddf134b9200a3fda3cac68dcdd7868f28c94160d`; nothing committed.

Reviewer checks announced to the driver in advance: exact-SHA match on every
published file; criterion 1 enforced **structurally** rather than by a test that
would still pass under divergence; no `createPairedPaneLayout` expectation
moved; suite green with no tolerated failure; product runs byte-identical;
`--numstat` agreeing with `--ignore-all-space`; and a **seeded-defect proof per
new assertion** (socket derived twice; composer used post-launch), because a
green suite discriminates neither failure.

### W2/A2 COMPLETE — Codex implementation, awaiting independent verdict

Codex completed the fixture-scoped non-paired launch wiring without touching
the paired-layout call site or its expectations. The launch socket is resolved
once into a discriminated launch context and reused by `launchServerArgv`, both
`launchSessionArgv` call sites, and `launchAttachCommand`. Resolution failure
rejects before any tmux spawn and emits no hint or legacy wording.

| Path | SHA-256 |
|---|---|
| `loop-fork/src/loop/tmux.ts` | `1a9a8a98da43fd4e7da835b727caa59957778ad8a4b0b53a422d9d6c44adfa44` |
| `loop-fork/tests/loop/tmux.test.ts` | `6bf96913a84bf21fb7dd1f8e09baabfa8623c4427ca4079cff198b77b4106f20` |
| `loop-fork/tests/loop/tmux-socket.test.ts` | `d8793c89defa77e06b1e0362ad7471c6f87b92fee495536f19687b306f9ff299` |

Evidence: `bun run check` clean; documented source typecheck EXIT 0; focused
tests 104/0 and 45/0; `env -u TMUX -u TMUX_PANE bun run test:ci` EXIT 0,
**1706 pass / 0 fail**. `git diff --check` is clean; normal and
`--ignore-all-space` numstat match exactly; the 1,582-file
`loop-fork/runs/` baseline diff is empty. A second resolver call made the named
hostile test fail `Expected 1 / Received 2`; a post-launch composer use made the
scope test fail `Expected 2 / Received 3`; both seeds were restored and the
guards re-passed.

Review request `d89784cd-7189-4bf7-9755-d61c21096bfc` was accepted for Claude
delivery but remained queued unread after Claude's prior exit. Supervisor
handover `11defb44-6ae0-4c48-a4ef-693dc856d453` records the same evidence.
Nothing committed, pushed, merged, deployed, or discarded.

**Fresh-loop next action:** validate the exact hashes and obtain the independent
W2/A2 verdict. Do not reimplement this slice. Verify 10's six fail-open sites,
T-06/T-08/T-10 plumbing, paired attach-hint fixtures, T-11 through T-18, and
charter T2-T6 remain open.

**Gate cleared; implementation started.** Peer review round 3 returned PASS
(`e0b267ee-804b-44a7-ae78-3f8d1e084100`) and the founder approved on
2026-08-08: `approved — fail closed, no recovery. proceed to T-00`. Under the
run-14 charter the legacy-manifest disposition is **FAIL-CLOSED**, decided by
the supervisor so no loop waits on a human.

**Done this session: T-01, T-02, T-03.** Working tree, nothing committed, HEAD
still `ddf134b9200a3fda3cac68dcdd7868f28c94160d`.

| Path | SHA-256 | State |
|---|---|---|
| `runs/tmux-socket-normalization/environment-probes.sh` | `d5b6a7083a76657e56dd12cf187d15853cfd9acd786b883a4eda1c129616ac70` | new |
| `runs/tmux-socket-normalization/environment-probes.txt` | `3b33078426d48ffe202f4d0b30905fea10048ec9de6e7d3fd965350a9ac4b95b` | new |
| `runs/tmux-socket-normalization/helper-evidence-corrections.md` | `3dd9f9545b2a5cda8c9f84bf850904e860015f00e6d59a74e84ef03aa9fb5fd0` | new |
| `loop-fork/src/loop/tmux-socket.ts` | `95723348738990b8ba01374b6cd9a7f6b305337f3d2ba3467a9dea1a7f559ed4` | new |
| `loop-fork/tests/loop/tmux-socket.test.ts` | `dde56ea34299bf5853740b39d0c6f124a8f7f90a05610e9fbb5d0631326d3a03` | new |
| `loop-fork/src/loop/run-state.ts` | `88b963e05c6a35f86d058b9b09e8fcd4b8369726e788ea71d5d0420b1fe079a0` | modified |
| `loop-fork/tests/loop/run-state.test.ts` | `3b502e76e170274459aa16a34d433559daf698596a0d86fc1a9a120cf87b7721` | modified |

### T-04 CLOSED — Codex PASS on verify 4 (`82652283`, reaffirmed `cf27a467`)

T-04 complete; T-05 may proceed. No merge/release approval implied.

### W2 wiring — source known-good, fixture edit failed twice, REVERTED

Codex authorised W2 and PASSed the composers. The **source** wiring is correct
and reproducible: `resolveLaunchSocket: () => TmuxSocket` on `TmuxDeps`,
production defaulting to `resolveTmuxSocket`, called **exactly once** in
`runInTmux` before any contact, that one value threaded through `findSession` →
`startRequestedSession`/`startAutoSession` into `launchSessionArgv` and
`launchServerArgv`, and into `launchAttachCommand`. tsc clean.

**The fixture edit failed twice, and the second failure names the real key.**
Attempt 1 blanket-transformed all 19 manifest fixtures and broke 5 green tests.
Attempt 2 injected the resolver into 28 deps objects and added `-S` to 14
`new-session` expectations — and made it worse, because:

> **Not every `new-session` in that file is the non-paired path.**
> `createPairedPaneLayout` (`tmux.ts:2987`) also composes `new-session` and
> belongs to the **unmigrated paired band**. Matching on the *command name*
> added `-S` to expectations for a call site that still legitimately emits none.

**Matching on the command name is the wrong key** — `new-session` and
`has-session` each appear in both migrated and unmigrated call sites. The
correct key is the **call site**, which a regex over the test file cannot see.
Codex confirmed this distinction is material and must be respected.

**Next attempt:** re-apply the known-good source wiring; take the failing list
(~12, all non-paired); fix **one at a time** with a full-suite run between each
(add `resolveLaunchSocket: () => "/tmp/ls-a/a.sock" as never` to that test's
deps, plus `-S` in that test's expectation); **never touch a
`createPairedPaneLayout` expectation**; then add the hostile-ambient decoy and
the criterion-3 import/non-use assertion.

Both files reverted and verified **by hash** (`tmux.ts` `6cb06ae9…`,
`tmux.test.ts` `802d6219…`). A2 is **not** complete; verify 12 for the
non-paired path stays open.

### A2 composers LANDED; wiring reverted on a fixture-portability finding

| Path | SHA-256 |
|---|---|
| `loop-fork/src/loop/tmux-socket.ts` | `cc1a88c1f2d95aa51c78c8fbd3faff8b411c28716b9350039a470dbb4ebb14f4` |
| `loop-fork/tests/loop/tmux-socket.test.ts` | `dc6a420133976ad90cccb375476c6a2b3f05d6fdd5a7197894150b8ac1af5343` |

Three authorised launch-window composers: `launchSessionArgv`,
`launchServerArgv` (so the pre-session probe addresses the **same** server the
session is about to be created on), and `launchAttachCommand`. Six tests; suite
**1704 pass / 0 fail**.

Two tests carry the amendment's weight: one asserts the hint contains the same
socket that appears in the composed creation argv, so a future divergence fails
(acceptance criterion 1 enforced, not trusted); the other asserts the launch
window mints **no** `TmuxTarget` — the composers return argv and strings only,
so the A1 rejection holds by construction rather than convention.

**Wiring implemented, typechecked clean, then REVERTED.** Resolve-once into both
consumers worked, but **12** tests failed rather than the 4 predicted:

> The resolved socket is `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/default`, so every
> argv assertion becomes **uid-dependent and non-portable**. Here that is
> `/tmp/tmux-501/default`; on CI it differs. Twelve tests assert exact argv
> arrays and would each bake in machine state.

That is a fixture-design decision across 12 tests, not a mechanical edit —
and bulk fixture transformation had already cost a five-test regression earlier
today. `tmux.ts` reverted to the PASSed `6cb06ae9…`, verified **by hash**, with
only the already-PASSed pane-only helper edit re-applied.

**Options put to the harness owner** (recommendation: W2): inject the resolved
socket as a `TmuxDeps` member so tests never depend on ambient resolution —
the approach that made `launch-reservation.ts` testable in T-04 — versus pinning
`LOOP_TMUX_SOCKET` per fixture (smaller diff, still ambient-dependent).

**Not claimed:** the non-paired wiring, its hostile-ambient decoy, and the
criterion-3 import-scope assertion. The composers are the building block the
amendment required, not the whole of it.

### A2 launch-window composer AUTHORISED — bundle amended, source next

Implementing option A hit a hard contradiction, verified in source before
reporting: the non-paired path holds a resolved socket but has **no manifest**,
therefore no `TmuxTarget`, while every exported composer is target-bound
(`serverArgv` takes a target, not a socket) and an inline `-S` argv literal is
barred by R12. Socket in hand, no legal way to compose.

Escalated as `24921a40` rather than re-adding the `serverArgvForSocket` seam
Codex had already REVISEd out. Ruled `5a7e6cd3`: **A2, narrowed** — a
*dedicated launch-only* composer, not a generic socket-only seam. **A1 rejected**
(minting a `TmuxTarget` outside the manifest read path would weaken provenance
and create a third target producer, contradicting verify 5a).

Amended into all three files **before** any source change, as the ruling
requires. Each file now carries 4 rulings; every citation verified present
exactly once after insertion.

| Path | SHA-256 |
|---|---|
| `specs/tmux-socket-normalization/spec.md` | `62204cb6603769337096001df81ce0b063b973488944ea49247c0e647cdeb26a` |
| `specs/tmux-socket-normalization/verify.md` | `ce444f0789933a8e0b9b95c0162e15d480c66405ca3dc6cf8c9df80a67535609` |
| `specs/tmux-socket-normalization/tasks.md` | `9f4eda50a4e066c387d0ef83b1830caad645a5e27834774d2a36bcb1f768537b` |
| `specs/tmux-socket-normalization/plan.md` | `67bfa1ae…` (unchanged) |

**Invariants the amendment explicitly preserves:** `targetFromManifest` stays the
sole post-launch `TmuxTarget` producer; `targetArgv`/`paneArgv`/`serverArgv` all
stay target-bound; no caller-written target flags; no ambient re-resolution.

**Five acceptance criteria recorded**, of which (1) and (3) are the load-bearing
ones: creation and hint composed from the **same** resolved value (one
resolution, two consumers — two derivations would pass a naive test while
diverging under changed ambient state), and a derived/import-scope assertion
proving the launch-only composer is unused after a manifest-backed launch.

**Source not started** — the ruling gates implementation on these published
hashes.

### Non-paired attach hints — option A ruled; scope extension recorded

Escalation `3262946e` (the non-paired launch has no manifest, so qualifying its
hint would have emitted a **false** legacy-unknown line for a session that is
genuinely attachable) was ruled **option A** by the harness owner
(`c3385227-657c-4f03-b2d5-4ad825ab2801`): the non-paired `--tmux` launch must
**resolve its socket once, before session creation or any tmux contact**, and
carry that identity into both the session command and the hint. No manifest is
invented; the existing non-paired lifecycle is preserved. Options B (bare hint —
violates verify 12/R3) and C (third hint state) were both rejected.

Recorded in all three bundle files with exact acceptance criteria. **New hashes:**

| Path | SHA-256 |
|---|---|
| `specs/tmux-socket-normalization/spec.md` | `b5ba11d5d817f1cc252c1a4e95b77d8460582abb0319f422a7d2408d3c06f89d` |
| `specs/tmux-socket-normalization/verify.md` | `e8ee550957a1ca42a6b307184cfad460ffd28e966fbfd5eb0a806c8dbd1b83bc` |
| `specs/tmux-socket-normalization/tasks.md` | `3db06b0bfb09ec3394adc0cffbf9c6f46a250314912654e20c901e2dd79fda54` |
| `specs/tmux-socket-normalization/plan.md` | `67bfa1ae…` (unchanged) |

All three files now carry three rulings each (R10 recon index, derived-check
withdrawal, non-paired scope extension); citations verified intact after
insertion, since an anchor-scan insert can land inside a prior block.

**IMPLEMENTATION NOT STARTED.** What it requires, so it is not re-derived:
resolve once in `runInTmux` before `sessionExists` (`tmux.ts:3639`) and the
`new-session` spawns (`:3653`, `:3693`); thread that one value into the session
argv **and** the hint — same resolved socket, not two derivations; assert
hostile ambient cannot change it after resolution; keep failure/unknown
explicit. Tests: the existing non-paired launch test plus a hostile-ambient
decoy assertion.

The three **paired** attach-hint tests are unaffected by this ruling and the
earlier fixture recipe still applies to them unchanged.

### Attach-hint migration — ATTEMPTED AND REVERTED. Recipe below.

Tree is byte-identical to the PASSed SHAs; verified by hash after revert, not by
eye. Suite **1698 pass / 0 fail**.

**The source change was correct and clean** — `attachHintForRun(manifestPath)`,
`manifestPath` threaded onto `StartedPairedSession`, both hint sites qualified;
tsc and biome clean; it failed exactly the 4 expected tests.

**I broke the test migration.** A scripted transformation repointed all **19**
fake `manifestPath` literals and rerouted all **25** `updateRunManifest` fakes
through a write-through fixture in one pass. It injected single quotes into
single-quoted literals (file stopped parsing), and — the reason I stopped —
the blanket reroute broke tests that were **green and unrelated**
("preserves stable pane targets when reattaching", "closes local Codex
ownership… after attach"). A 4-test fixture job had become a 5-test regression.

Reverted by restoring `tmux.test.ts` from HEAD and re-applying only the four
PASSed T-04 phase-2 edits, then confirming the hash equals `802d6219…` exactly;
same for `tmux.ts` at `6cb06ae9…`. A partial revert that merely looks right is
how a reviewed artifact silently drifts.

**Recipe for the next attempt:**
1. Re-apply the source change as-is; its only dependency is that
   `readRunManifestHandle(manifestPath)` finds a real file.
2. Migrate **only** the four affected tests, one at a time, running the full
   suite between each: `~333`, `~439`, `~1888`, `~2708`. Leave the other 15
   fixtures alone — they are green and unrelated.
3. Per test: real temp `manifestPath`, seed `tmuxSocket: "/tmp/ls-a/a.sock"`, and
   make that test's own `updateRunManifest` fake write through, so the hint reads
   what the producer persisted rather than a hand-authored fixture.
4. Expected hint `tmux -S '/tmp/ls-a/a.sock' attach -t 'repo-loop-1'`. **Three
   existing expectations are single-quoted literals containing double quotes** —
   they must become template literals or the file will not parse.
5. Add hostile-ambient coverage (decoy `LOOP_TMUX_SOCKET`/`TMUX`, assert the
   hint still carries the manifest's socket) — that is what proves verify 12,
   rather than proving the string changed. Plus a no-socket manifest emitting
   `TMUX_UNKNOWN_SOCKET_HINT` and no command.

### T-05 slice 3 — **PASS** (`e6f625d7`); sequencing ruling received

Codex PASSed the slice and **confirmed the sequencing read**: the target-bound
API belongs to T-05 and is complete; consumer plumbing stays in its existing
bands rather than becoming one atomic T-05 mega-change —
**T-06** bridge-runtime + `BridgeStatus` schema/threading; **T-08**
launch-reservation, codex-tmux-proxy, paired-options; **T-10** Governess/replay
and pane effects. Each band migrates its own call sites, uses
`ManifestHandle`/target provenance, **emits the required skip records for
unknown targets**, and adds named tests. Verify 10 stays open until all six
checklist sites and their per-consumer records are done.

Rationale recorded by the owner and worth keeping: this preserves approved task
boundaries and avoids knowingly leaving a non-compiling intermediate tree.

### T-05 slice 3 — target-bound liveness API landed; cascade blocker found

| Path | SHA-256 |
|---|---|
| `loop-fork/src/loop/tmux-control.ts` | `9f9edd3754f7a40c8810d3cd41dc534ea1e68b9ee1a1efc412dbe3737f1ccb67` |
| `loop-fork/tests/loop/tmux-control.test.ts` | `f1796fe75b99ab61a6c5bb0538e56422c7781f4250e73a40a9b02939474117eb` |

`tmuxTargetLiveness` / `tmuxTargetLivenessAsync` compose through
`targetArgv(target, "has-session")`, so both `-S <socket>` and `-t <session>`
come from the manifest-derived target. An unusable target reads `"unknown"` and
contacts no server. Bounded-timeout, kill-signal, error, and single-settle
semantics preserved (verify 17). Suite **1698 pass / 0 fail** (+5).

The load-bearing test asserts the **full argv**, not the verdict — asserting
only "returns live" would still pass with `-S` dropped, which is the entire
defect. Seeded proof: replacing `targetArgv(...)` with `["tmux","has-session"]`
fails that test by name (8/1).

**Cascade blocker, checked before migrating rather than after.** The seven
modules cannot take a mechanical signature swap:

| Module | `manifestPath` refs | Consequence |
|---|---|---|
| `bridge-runtime.ts` | **0** | works from `runDir` + `BridgeStatus.tmuxSession` |
| `governess-replay.ts` | **0** | receives bare session strings |
| `paired-options.ts` | 3 | probe seam is `(session: string) => …` |

A `TmuxTarget` comes only from `targetFromManifest(handle)`, and a handle only
from `readRunManifestHandle(manifestPath)`. So each consumer must first be given
a path or handle it does not have — per-module plumbing, and for bridge-runtime
a `BridgeStatus` schema change that **T-06 already owns**.

**Read sent to the harness owner for ruling:** the target-bound API is T-05 and
is done; the per-consumer plumbing belongs to the bands `tasks.md` already
assigns it to (T-06 bridge, T-08 reservation/proxy/paired-options, T-10
governess/replay). Doing all seven inside T-05 would duplicate those bands and
land a non-compiling tree mid-way, since the shared signature breaks all seven
at once. Not started for that reason — merging four approved task boundaries is
the owner's call, not an improvisation.

### Derived-check rule WITHDRAWN — six-site checklist + recorded limitation

Three superseding rulings (`6ab87ddc`, `414232c9`, `1b3caebf`) replaced the
approval recorded below. **No automated rule is added:**
- a literal `: "dead"` source rule is withdrawn — a blacklist that misses
  `liveness = "dead"` and `? "dead"`, exactly how this inventory was first
  mis-derived as five sites;
- a **value-flow rule must not be claimed either**, because the current checker
  surface is not an AST/type-flow analyzer and cannot prove `TmuxLiveness`
  production or confirmed-missing evidence. My own "key on the value produced"
  proposal was accepted as a critique but rejected as an implementation — it
  would have been a completeness claim the instrument cannot support.

**Recorded instead:** the limitation itself (the check does not provide full
semantic coverage for arbitrary `TmuxLiveness` production), plus an explicit
per-band checklist of six sites with **named per-site tests** required in T-06,
T-08, and T-10. `paired-options.ts:75` confirmed in scope; the earlier four-file
list was illustrative. `tmux.ts:1102` confirmed excluded and documented as the
positive model. Any future AST/type-flow analyzer must state its method, catch
assignment/ternary/alias forms, carry independently seeded indirect cases, and
be reviewed separately before any completeness claim rests on it.

| Path | SHA-256 |
|---|---|
| `specs/tmux-socket-normalization/spec.md` | `306be6c70d3372d39bb75b3061cc70f8d3a087e5f3f0ec0b57ccc9ff601fb615` |
| `specs/tmux-socket-normalization/verify.md` | `153e0ce9de26cd2e4fa4a53f9467f5adf3b86a435888b4733d4891050792857a` |
| `specs/tmux-socket-normalization/tasks.md` | `796c17ff38d2d429e584724617afd7637755aa7638a5a3d615e574348cbeb1b3` |
| `specs/tmux-socket-normalization/plan.md` | `67bfa1ae…` (unchanged) |

Verify 10 remains **open**. T-05 empty-session slice remains PASS.

### Superseded: T-05 slice 1 PASS (`7be19de0`) and the original rule approval

Codex PASSed the slice and, under harness-owner authority, **approved adding the
derived-check rule** for replicated empty-session fail-opens — ruled to be
enforcement of already-approved R8/R12 fail-closed semantics, not a new product
requirement. Recorded in the bundle as instructed, which moves three hashes
again:

| Path | SHA-256 |
|---|---|
| `specs/tmux-socket-normalization/spec.md` | `d12d3c1703af6be25078be136c593446d5c345232a04f5465ba1506e57bee7fc` |
| `specs/tmux-socket-normalization/verify.md` | `2bd59dbffdebd750368d3ddb87fed6a616791f65e55068238b87192cc1171be4` |
| `specs/tmux-socket-normalization/tasks.md` | `67b2c70a9e33d6fa89e53da3f064e9a20fc49819342c7aba6f0a720a7fe8d8c8` |
| `specs/tmux-socket-normalization/plan.md` | `67bfa1ae…` (unchanged) |

The recorded rule keys on **the value produced, not a literal source spelling**,
and names `tmux.ts:1102` as explicitly *not* a violation but as the shape the
six sites should adopt. It also states plainly that verify 10 is **not** closed
by the central fix.

Placement note: the spec.md ruling first landed directly beneath the discharged
human-approval checklist, where it could read as part of that gate. Added a
`## Harness-owner rulings during implementation (run 14)` heading so it cannot.

Docs-only change; suite unaffected at **1693 pass / 0 fail**.

### T-05 — first slice LANDED: the empty-session fail-open is closed

| Path | SHA-256 | State |
|---|---|---|
| `loop-fork/src/loop/tmux-control.ts` | `7e9d78e443f35038f3765fdd431ec274e031b4eab07fea9e5e0542649bdc8a4e` | modified |
| `loop-fork/tests/loop/tmux-control.test.ts` | `dccd194d18212c46bd10b105a2d699fc1ac633e46d20075ea8d4d81f0d96aa9a` | modified |

`tmuxSessionLiveness` and `tmuxSessionLivenessAsync` returned `"dead"` for an
absent session. Verify 10 requires `"unknown"` and **never** `"dead"`: `"dead"`
is the verdict that grants cleanup authority, so an absent session name — which
is exactly what a legacy manifest looks like — let a caller signal PIDs and
remove config for a run that may be alive on a server nobody asked about.
Both paths now return `"unknown"`, and the regression asserts the decision is
reached with **zero** tmux commands issued.

This did **not** need the 7-module signature cascade: only the empty-session
branch changed, so the `(session: string)` signature is untouched. Full suite
green, **1693 pass / 0 fail**.

**Blast-radius audit, because a green suite proves little when a verdict is
narrowed.** I checked what each consumer does with `"unknown"` where it used to
receive `"dead"`. Destructive paths gate on `=== "dead"`, so they now correctly
skip. Three sites branch on `!== "dead"` and would have inverted —
`codex-tmux-proxy.ts:228`, `bridge-runtime.ts:1267`, `launch-reservation.ts:122`
— but **all three are guarded by a truthy `tmuxSession` check before the call**,
so an empty session never reaches them. Contained, verified rather than assumed.

**The finding that matters more than the fix.** The fail-open is **replicated
inline at the call sites**, not centralized in `tmux-control.ts`. Each of these
hardcodes `"dead"` for an absent session and is therefore still fail-open,
untouched by this change:

| Site | Band | Verdict |
|---|---|---|
| `governess-replay.ts:326` | T-10 | fail-open, absent session → `"dead"` |
| `bridge-runtime.ts:1105` | T-06 | fail-open, absent session → `"dead"` |
| `launch-reservation.ts:121` | T-08 | fail-open, absent session → `"dead"` |
| `launch-reservation.ts:224` | T-08 | fail-open, absent session → `"dead"` |
| `codex-tmux-proxy.ts:388` | T-08 | fail-open, absent session → `"dead"` |
| `paired-options.ts:75` | T-08 | **added on re-derivation** — socket-blind probe → `"dead"` |

**Inventory corrected, and how it was wrong matters.** The first version of this
table had five rows, derived from `grep -rn ': "dead"' src/` — one spelling of
the pattern. Enumerating **every** `"dead"` literal instead (15 occurrences, of
which 7 produce rather than test the value) surfaced two more producer sites the
single-spelling grep could not see: `paired-options.ts:75`
(`liveness = "dead"`) and `tmux.ts:1102` (`? "dead"`).

Of those two, only `paired-options.ts:75` belongs on the list. `tmux.ts:1102` is
**already correct** and is the model the others should follow: it returns
`"dead"` only when `isConfirmedMissingTmuxSession(stderr, …)` confirms it from
real server output, and `"unknown"` otherwise. Confirmed-missing is evidence;
absent-name is not.

This is the "blacklists and hand-written sweeps go stale" failure in miniature —
a grep for one spelling is not a bound over the set. The T-11 derived check must
therefore key on the **value produced**, not on a literal source pattern, or it
will miss the next spelling exactly as I did.

Fixing `tmux-control.ts` alone does **not** close verify 10. Each site above must
become `"unknown"` in its own band.

### T-05 — remaining groundwork; no other source change landed.

**Attempted and deliberately reverted: the attach-hint slice (verify 12).**
Qualifying `tmux.ts:3602` and `:4024` with `tmuxAttachCommand` works and the
behaviour is correct in production, but it broke 4 existing tests for a reason
worth recording rather than patching over:

`attachHintForRun` must obtain a `ManifestHandle`, and `readRunManifestHandle`
is its **sole producer, reading from disk**. The affected tests drive
`runInTmux` with in-memory fake manifests at paths that do not exist
(`/repo/.loop/runs/1/manifest.json`), so the handle is `undefined` and the hint
correctly degrades to the unknown line. **This is the design working, not a
bug** — but it means every attach-hint consumer test must be backed by a real
on-disk manifest. That is a larger, producer-fixture change than a hint edit,
and it belongs with the rest of the T-05 migration.

Reverted to byte-identical `c152441d…`, verified by hash, suite green.

**Design tension for whoever does T-05, stated plainly:** R6 makes the manifest
the source of truth and R3 makes the read path the only handle producer, so any
consumer needing a target must re-read the manifest from disk even when it
already holds one in memory. That is correct for provenance and costs a disk
read per hint. If that cost is unacceptable at some call site, the fix is a
spec-authorised change, not a local bypass.

**Verified T-05 caller inventory** (`grep -rn tmuxSessionLiveness src/`), so the
cascade is sized before it starts. The shared-liveness signature change reaches
**7 modules** beyond `tmux-control.ts`, which is why it cannot be a small slice:
`governess.ts:6485,6571`, `governess-replay.ts:325`,
`bridge-runtime.ts:1101,1164`, `codex-tmux-proxy.ts:219,407,982`,
`paired-options.ts:55`, `launch-reservation.ts:80`. Those belong to T-06, T-08,
and T-10; changing `tmux-control.ts` alone breaks all of them at once, so the
band must land as one piece.

**The fail-open to fix first:** `tmux-control.ts:47` and `:65` return `"dead"`
for an empty session. Verify 10 requires `"unknown"` and **never** `"dead"` for
a legacy or unusable target — `"dead"` is what grants cleanup authority, so this
single line is the fail-open the whole defect class rests on.

**RESOLVED — pane-only helper landed** (approach confirmed by `b18ec9d1`).
`clearRunManifestPaneTargets()` added to `run-state.ts`, derived from the shared
`TMUX_PANE_MANIFEST_FIELDS`, and used at the establish site in
`bindPairedSessionIdentity`. The inline hand-listed seven-field literal is gone,
so both the teardown clear and the establish clear now read one list — a newly
added pane field cannot escape either.

| Path | SHA-256 |
|---|---|
| `loop-fork/src/loop/run-state.ts` | `60f0fc9129074a0495748e074b820e3d7a9bfe8892b81611319560bf1dc7e522` |
| `loop-fork/src/loop/tmux.ts` | `6cb06ae96b4db60e23a25f44e55201b3b5de58c4f8322f555a1791bf6aec5e34` |

Behaviour-preserving: suite unchanged at **1693 pass / 0 fail**. Seeding the
exact regression this correction exists to prevent — making the pane-only helper
also clear `tmuxSocket` — fails both producer tests **by name** (101/2).

**The correction that produced it, kept as the record:** I twice recorded
"migrate the inline seven-pane list at `tmux.ts:1380-1389` to
`clearRunManifestTmuxTopology`". **That would be a regression.** Checked before
handing it on:

`clearRunManifestTmuxTopology` clears `tmuxSession` **and** `tmuxSocket` **and**
the seven panes — correct for tearing topology down. But `tmux.ts:1380-1389` is
inside `bindPairedSessionIdentity`, which is *establishing* topology: it sets
`tmuxSession: session` and the pane-clear spread comes **after** that line. A
drop-in substitution would set `tmuxSession: undefined` and
`tmuxSocket: undefined`, overriding the session just bound and destroying the
socket — precisely the split-brain state whose seeded-defect test I proved fails
three producer tests.

**What is actually needed:** a pane-only helper, e.g.
`clearRunManifestPaneTargets(manifest)`, clearing just the seven fields derived
from `TMUX_PANE_MANIFEST_FIELDS`. That gets the anti-staleness guarantee (a new
pane field cannot escape the clear) without touching socket or session. The
existing derived pane-inventory test then covers both helpers.

General lesson: "same seven fields" is not the same operation. Tear-down and
establish clear the same set for opposite reasons, and only one of them may
touch the identities.

### T-04 phase 2 — COMPLETE (detail below)

Harness-owner ruling `04d73c1d-16fe-431e-bce1-7bddbe8e1d90` overrode the
fold-into-T-05 plan: finish phase 2 now, then continue into T-05.

| Path | SHA-256 | State |
|---|---|---|
| `loop-fork/src/loop/tmux.ts` | `c152441d020bdbe0e37df22a63ae5ee8e4851415f6595a5bbc248fa8fac053d4` | modified |
| `loop-fork/tests/loop/tmux.test.ts` | `802d6219c26ee185081dd6f222678bf58756ff80c5642e10742054934a68a98b` | modified |

**Phase 2 REVISE consumed** (`62a58072-e615-4512-bdae-d091bbbc6d5e`). My first
phase-2 draft called `bindPairedSessionIdentity` directly and set the failed
state by hand. That proves the *function* preserves both identities; it does
**not** prove the producer invokes the bind before its first async startup
boundary, nor that the real terminalization path retains them. A synthetic test
that reproduces the mechanism it is meant to check certifies nothing.

Replaced with **producer-backed assertions on the real `runInTmux` paths**, and
the `tmuxInternals` export added solely for the synthetic tests was **removed**
— the public surface is back to what it was:
- "runInTmux starts paired panes from a cold macOS tmux socket" — the prepared
  manifest now carries socket A, and the manifest captured at the **first**
  `startPersistentAgentSession` call is asserted to carry A **and**
  `tmuxSession: "repo-loop-1"`. That capture point already existed in the
  harness; it is exactly the first async startup boundary.
- "runInTmux terminalizes a hook-preparation failure before new-session" — the
  real failure path, asserted to leave `state: failed` with **both** identities.

**Review-lineage note.** Two REVISEs (`a3f156f8`, `6a611b89`) arrived against the
superseded synthetic draft `aa6c3438…` after the rework had already replaced it.
Both findings were checked against the current tree rather than waved off:
- missing `readRunManifest` import — resolved by deletion, not addition;
  `grep -c readRunManifest tests/loop/tmux.test.ts` = **0**.
- failed-startup test bypassing `terminalizeFailedStart` — that test is deleted;
  the only remaining `setRunManifestState` in the file is pre-existing (line
  1681, transitioning to "completed").

**Decisive proof for the terminalize path**, exactly as requested: seeding
`tmuxSocket: undefined` **inside** `terminalizeFailedStart`
(`tmux.ts:3253-3290`, at the `clearOwnedTransportFields` line) fails
"runInTmux terminalizes a hook-preparation failure before new-session" **by
name** (102 pass / 1 fail). So the named test genuinely routes through the
production failure path, not through an arbitrary state transition. No test seam
was needed or added.

**Three seeded defects on the producer paths:**
- clearing `tmuxSocket` during binding → both named producer tests fail (101/2);
- deferring the bind past the first startup boundary → five tests fail,
  including both named ones (98/5).
Restored, 103 pass.

Suite total moved 1694 → **1691** because three synthetic tests were deleted and
their coverage folded into two existing producer tests as extra assertions
(528 → 530 expect() calls in that file).

Re-verified: biome clean, documented tsc clean, full suite `EXIT 0`,
**1691 pass, 0 fail**, `loop-fork/runs/` untouched.

`bindPairedSessionIdentity` (`tmux.ts:1360`) is the joint-binding site; it is
called at `:3315` before hooks, persistent transports, charter writes, and tmux
creation. The code comment already *claimed* that ordering — the three new tests
**assert** it. Exposed on the existing `tmuxInternals` seam rather than widening
the public API.

Three tests, all driven through the real production function and real
`writeRunManifest`/`readRunManifest` round trips (no hand-authored fixture):
1. the **first** durable write already carries both `tmuxSocket` and
   `tmuxSession` — a manifest holding one without the other is the split-brain
   state being closed;
2. `clearPaneTargets` clears the seven pane fields but never the socket or
   session;
3. a startup that fails after binding retains both identities, so bounded
   cleanup can still target the run.

**Seeded-defect proof:** adding `tmuxSocket: undefined` to the binding write
fails all three **by name** (103 pass / 3 fail); restored, 106 pass.

**A harness bug of mine worth recording.** The three tests first failed with
`tmuxSocket: undefined`, which read exactly like a product defect in the T-03
write path. It was not: my fake deps omitted `cwd`, the updater writes
`cwd: deps.cwd`, and the resulting manifest failed `readRunManifest`'s required
-field check — so **every** later assertion silently read `undefined` from an
unreadable manifest. I confirmed the product write path was sound by probing
`createRunManifest` → `writeRunManifest` → `readRunManifest` directly before
touching source. An unreadable manifest blanks assertions rather than failing
loudly, which makes this failure mode read as a source bug.

Second-order lesson: my first attempt to add `cwd` **silently no-op'd** because
biome had reformatted the anchor and the replace matched nothing. The rerun
looked identical to the previous failure. Every scripted edit here now asserts
its anchor.

Re-verified: biome clean on all four files, documented tsc clean, full suite
`EXIT 0`, **1694 pass, 0 fail**, `loop-fork/runs/` untouched.

**Next:** T-05 — launch/resume/attach plus shared bounded control, where the 64
`"tmux"` argv literals begin migrating and `tmuxSessionLiveness` must stop
returning `"dead"` for an empty session (verify 10 requires `"unknown"`).

### T-04 early launch binding — phase 1 landed, phase 2 identified

Work requested directly by the harness owner
(`2461d526-cd7c-4b06-8aaa-21917bd4a8e0`).

| Path | SHA-256 | State |
|---|---|---|
| `loop-fork/src/loop/launch-reservation.ts` | `543fc32c1b7e7bef549f8844154bc5e7d2fcb3d2b919fceb5d16159751218a27` | modified |
| `loop-fork/tests/loop/launch-reservation.test.ts` | `865a8c2cd8023d54bf5befe33f79520bd72155e3a7701dc286142072ef567528` | modified |

**Second REVISE consumed** (`4172c354-c0d9-46bf-8b9d-90c192bca54b`) — a second
real ordering hole, in the *corrected* draft. `opts.sessionId` naming a run that
does not exist skips the pre-lock resolution (it looks like a resume request),
`requestedRunId` stays undefined, and control falls through to the **fresh**
branch — where `reserveRunStorage` ran *before* `launchSocket()`. An invalid
socket could therefore leave a reserved run directory behind, against verify 2/4.

Worse than the reservation: `assertNoConflict`
(`launch-reservation.ts:303`) contacts tmux through
`manifestCanStillOwnWorkspace` → `deps.tmuxLiveness`, and that also ran before
resolution on this path. So the named-fresh case violated *both* halves of
"before reservation and before any tmux contact".

**Why my ordering test missed it:** it used `makeOptions()` with no `sessionId`,
so it always took the unnamed path that resolves pre-lock. The named path was
never exercised. Same failure class as the previous REVISE — the test fed only
the input that could not fail.

**Fix:** a `if (!requested) launchSocket();` guard placed after `requested` is
known and **before** `assertNoConflict`, so every fresh path resolves ahead of
both the tmux contact and storage reservation, while a genuine resume still
calls the resolver zero times. The pre-lock eager call is kept for the unnamed
fast fail; the thunk is memoised so the second call is free.

**Three seeded-defect proofs now stand, each failing its test by name:**
unconditional resolution at entry → resume test; resolution after reservation →
unnamed ordering test; removal of the fresh-path guard → named-fresh test.

Re-verified: biome clean, documented tsc clean, full suite `EXIT 0`,
**1691 pass, 0 fail**, `loop-fork/runs/` untouched.

**REVISE consumed** (`03851c8a-1b9b-469f-8cc5-2dc421d0e28c`) — a real defect,
and my own test was blind to it. The first cut resolved the socket
**unconditionally** at `reservePairedLaunch` entry, which made
`resolveTmuxSocket` reachable from the **resume** path, against R6 / verify 5a.
The consequence is worse than an ignored value: with an *invalid* ambient
`LOOP_TMUX_SOCKET`, a legitimate resume would **throw before ever reading
manifest A**.

**Why the original test missed it, recorded because the failure class recurs:**
it used a *valid* hostile B socket. With a valid value, resolution succeeds and
the manifest read still preserves A, so the test could not distinguish "resolver
ignored" from "resolver called and its result discarded". The input could not
discriminate the hypothesis. A passing suite certifies only the inputs it feeds.

**Fix:** resolution is now launch-only and lazy. An unambiguously fresh launch
(no `resumeRunId`, no `sessionId`) resolves **before the lock**; a launch that
names a run never resolves; a named launch that still turns out fresh resolves
at the reservation branch, still before `reserveRunStorage`. `resolveSocket` is
now an injected dep so a test can **count** invocations.

**Tests now discriminate:** the resume test drives three *invalid* ambient values
(empty, relative, over-budget), each in its own fresh workspace — reserving twice
against one manifest trips the live-bootstrap interlock and would mask the
subject — asserts A's socket and session survive each time, and asserts
`resolverCalls === 0`. A **positive control** asserts a fresh launch does call
the resolver exactly once, so a resolver that was simply never wired up could not
satisfy the zero-call assertion.

**Non-vacuity proven both ways:** re-seeding the exact reported defect
(unconditional resolution at entry) fails the resume test **by name**; the
ordering test still fails by name when resolution is moved after reservation.

Re-verified: biome clean, documented tsc clean, full suite `EXIT 0`,
**1690 pass, 0 fail**, `loop-fork/runs/` untouched.

**Phase 1 — socket bound at reservation.** `resolveTmuxSocket` now runs at the
top of `reservePairedLaunch`, **before `acquireLock`** and before
`reserveRunStorage` / `createRunManifest` / `writeRunManifest`, and before any
tmux server is contacted. A throw there has nothing to unwind: no lock is held
and no manifest exists. The resolved socket is written into the reserved
manifest as `tmuxSocket`.

`env` and `uid` are new injected `LaunchReservationDeps` members rather than
direct `process.env` reads, so resolution is testable without mutating the
suite's ambient environment. The existing `reservationDeps` test helper now
pins them, so the pre-existing reservation tests stopped depending on ambient
state as a side effect.

**verify 5 preserved deliberately.** `launchSocket` is referenced at exactly two
lines — its resolution and the fresh-manifest binding. The resume path
(`reserveRequestedLaunch`) still spreads `...requested`, so a persisted
`tmuxSocket` is never overwritten from ambient state. This was the clause most
at risk from the obvious "resolve once at the top for both paths" edit.

**Three regressions added,** and the ordering one is proven non-vacuous by
seeded defect: moving resolution to *after* reservation makes
"an unusable socket fails before any run is reserved on disk" fail **by name**.
That test also asserts the storage root holds no reserved run at all, so it
cannot pass by cleanup-after-the-fact.

**Phase 2, not done, precisely located.** `tmuxSession` is persisted at
`tmux.ts:1369-1394`. The socket is already bound by then, so both identities are
present before the first async startup boundary. Note `clearPaneTargets`
(`tmux.ts:1380-1389`) clears the seven pane fields while re-setting
`tmuxSession` in the same write — coherent today, but it is a hand-listed
second copy of the pane set and should move to
`clearRunManifestTmuxTopology` during T-05.

**Known pre-existing, not mine:** `tests/loop/launch-reservation.test.ts` has a
`TS2353 'copilotModel' does not exist in type 'Options'` error. Confirmed
pre-existing by compiling the HEAD version of the file in place (same error, at
line 35; it reads as 36 in my version because an added import shifted it). It
is outside the documented tsc invocation, which remains clean.

Re-verified: biome clean on all six files; documented tsc clean; full suite
`EXIT 0`, **1689 pass, 0 fail**; `loop-fork/runs/` untouched; `--numstat` and
`--numstat --ignore-all-space` agree.

### R10 ruling received and implemented — 2026-08-08

**Harness-owner ruling** `cc04ed1b-3273-4315-89d7-12749b5ef972` resolved the R10
gap. It also **corrected my routing**: root/Codex owns this harness defect and
its release path, so R10/T-10 and any harness implementation or release decision
must **not** be escalated to the product supervisor. My escalation
`fc0217c3-7f68-4bc5-a9f8-f0ab2da5389b` was misrouted; the ruling supersedes it.
Release path is: native Codex reviews the loop work, root independently reviews
the final exact commit, then root merges, installs, verifies. **No third review.**

**Ruling, implemented:** the sole `OwnedPaneTarget` producer is now
`paneTargetFromManifest(handle, field, index?)`. Scalar field — `index` must be
absent, supplying one fails closed. `tmuxPaneRecon` — `index` required,
non-negative integer, in bounds; every missing / malformed / out-of-range case
yields no target, and the consumer must then emit the structured skip record.
Still exactly one producer; no public socket-only or session-plus-pane seam.

All six mandated cases covered: scalar-with-index, recon-without-index,
negative, fractional, out-of-range, and valid multiple recon panes (plus `NaN`
and `Infinity`). The recon round trip is also asserted end-to-end through the
manifest read path in `run-state.test.ts`.

Ruling recorded in the spec bundle as instructed, which moves three of the four
approved hashes:

| Path | SHA-256 |
|---|---|
| `specs/tmux-socket-normalization/spec.md` | `a7c624da20537b1db754953f2b7d7b25cae3d6ac3395285773c540bc7daa653f` |
| `specs/tmux-socket-normalization/verify.md` | `1ea075a4942083bdde52e95c9494beec529f261fb84016acc6b26f0057ebeca9` |
| `specs/tmux-socket-normalization/tasks.md` | `10d655a6e5db99fd0476613beb1501fd0cd573f2d4713ea921467a1328f693da` |
| `specs/tmux-socket-normalization/plan.md` | `67bfa1ae626409bbc5e40d480d7a4294d0b1a735871e9a266c2fa06e08e8a95d` (unchanged) |

Post-ruling source SHAs: `tmux-socket.ts`
`ed96fa5d61a38a927a497a5558da0faa8cd1fddb5fe054f1adfb485c61e80480`;
`tmux-socket.test.ts`
`7d5ce4776743b19a828eadcfef68c862eb6ec6a60f5310c611f5a23443a43d33`;
`run-state.test.ts`
`546ecf48b755e150b469df2d03db56a30c5ba8821cf70610d7001c3ac76087c3`.
`run-state.ts` unchanged at `88b963e0…`.

Re-verified after the change: biome clean, documented tsc clean, full suite
`EXIT 0`, **1686 pass, 0 fail** (up from 1682 — the four new index cases),
`loop-fork/runs/` still untouched.

### Peer review round 2 on the implementation: **PASS** (current verdict)

Codex re-reviewed at the post-revision SHAs in the table above and returned
**PASS** for revised T-02 + T-03 (`602a94bf-8c05-430a-bec4-bd9909956264`,
replying to `3c98dad7`). Codex independently re-verified all four hashes match.

PASS per check: verify 1; verify 2 (T-02 validation surface, Darwin/Linux/
multibyte, and the empty-value hard fail); verify 3 pane-subordination slice;
verify 5a constructibility slice; verify 12 module-local; verify 13 precedence
half. T-03 PASS in full, including the derived pane-inventory guard.
Decisions 3, 4, and 5 all PASS after the revisions.

Explicitly PENDING and **not claimed**: verify 8 (named per-consumer matrix
awaits migrations); full verify 2 pre-reservation/no-contact integration (T-04);
post-launch reachability of `resolveTmuxSocket` (awaits migration); full verify
12 and 13 consumer/smoke coverage. Codex confirmed "no false claim" on these.

**No merge or release approval implied. T-04 may proceed.**

### Peer review round 1 on the implementation: REVISE, consumed

Codex reviewed T-01/T-02 at the pre-revision SHAs (`3c98dad7-38df-45ed-90f1-c1745120434d`)
and returned **REVISE**. All four actionable findings are fixed; the SHAs above
are post-revision. Reply sent as `e9ac79dd-20f0-452f-8d84-e5b9f887c4b7`.

1. **Real bug, fixed.** `resolveTmuxSocket` guarded
   `override !== undefined && override !== ""`, so an exported-but-**empty**
   `LOOP_TMUX_SOCKET` fell through to the next precedence rule, while R4 and
   verify 2 require a hard fail. `validateTmuxSocket("")` rejecting was
   irrelevant because the resolver never called it — a validator that the path
   does not reach is not a check. Both `LOOP_TMUX_SOCKET` and `TMUX` now hard-fail
   on empty, with a distinct message for empty vs malformed `TMUX`.
2. **`serverArgvForSocket` removed.** A fourth exported socket-only composer,
   against R3's three target-bound composers. T-04 will keep the validated
   socket local to the launch function and bind both identities to the manifest
   before composing, so no socket-only exported composer is needed.
3. **`reconPaneTargetsFromManifest` removed and escalated, not improvised.**
   R10 fixes the sole `OwnedPaneTarget` constructor at arity 2 `(handle, field)`,
   but `tmuxPaneRecon` is `string[]` — verify.md line 38 names it as such. The
   tree now has exactly one producer and conforms to R10 as written. Escalated
   to the supervisor as `fc0217c3-7f68-4bc5-a9f8-f0ab2da5389b` with exact
   requirement id R10. **Blocks T-10, not T-04.** Recommendation: amend R10 to
   `(handle, field, index?)`.
4. **`targetOfPane` removed** (exported, unused, untested); **`manifestHasTarget`
   kept and now tested** across all four handle states.

Carried as PASS: verify 1, the verify 5a constructibility slice, the verify 13
precedence half, verify 12 module-local, verify 2 Darwin boundary.
Carried as **PENDING, not claimed**: verify 8 (needs the named per-consumer
matrix — one generic sink-shape test cannot certify consumers), full verify 2,
full verify 5a, full verify 12, full verify 13.

**T-03 landed.** `tmuxSocket?: string` on `RunManifest` (`run-state.ts:135`) and
`RunManifestInput` (`:229`), on the read path, and on the build path.
`readSocketField` treats a camel/snake disagreement as **explicit unknown
targeting** rather than preferring a key — unlike every other manifest field,
because a socket names the server every consumer will address.
`readRunManifestHandle` is the sole `ManifestHandle` producer and stamps the
SHA-256 of the exact bytes read. `clearRunManifestTmuxTopology` clears socket +
session + all seven pane fields atomically, and
`TMUX_PANE_MANIFEST_FIELDS` names the seven once so the clear and its test read
one list. 10 new tests, including one that **derives** the pane-field set from
the `RunManifest` declaration rather than hand-listing it, so a new pane field
cannot be added without either being cleared or failing.

Still to migrate to the atomic clear (T-05/T-06): `bridge-runtime.ts:1215`,
which clears `tmuxSession` alone today, and `tmux.ts:1384`.

**Proof run, from `loop-fork/`:**
- Documented typecheck (`docs/testing/commands.md`, with `src/cli.ts` and the
  test file added): clean. Note bare `bunx tsc --noEmit` has **216 pre-existing
  baseline errors** and is not the documented invocation.
- `LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/tmux-socket.test.ts`
  — 34 pass, 0 fail, 81 expect() calls.
- `bunx biome check` on both touched files — clean. `bun run fix` deliberately
  NOT used: it rewrites `runs/` evidence.
- Negative type tests proven non-vacuous in a temp tree: stripping the three
  expect-error directives yields `TS2554`, `TS2741` (missing `[targetBrand]`),
  `TS2345`. Tracked source never edited to prove this.
- `bun install --frozen-lockfile` run to populate `node_modules`; `bun.lock` and
  `package.json` confirmed unmodified.
- **Full suite green:** `env -u TMUX -u TMUX_PANE bun run test:ci` — exit code
  `0`, **1682 pass, 0 fail, 84 files**, no tolerated failure and no skip. Run
  after T-03 because `run-state.ts` now imports `tmux-socket.ts` and is consumed
  repo-wide.
- **No product-run mutation (verify 18):** all **1582** files under
  `loop-fork/runs/` re-hashed and `diff`ed against the T-00 baseline inventory —
  byte-identical. `git status --short loop-fork/runs` = 0. Compared by hash, not
  by file count.
- **No unintended reformatting:** `git diff --numstat` and
  `git diff --numstat --ignore-all-space` agree.
- New-test non-vacuity: seeding a break into the atomic-clear assertion makes it
  fail **by name**, proving the 10 new run-state tests execute rather than being
  silently skipped. Restored afterwards and re-verified clean.

**Corrections made mid-run, recorded so they are not re-learned:**
1. `tmux -S <path> start-server` with no session creates the socket file but the
   **server exits immediately**. A certification smoke (T-14) cannot hold a
   server open with `start-server` alone. My first probe recorded no PID for
   that server and I nearly banked it as an instrument gap; the real gap was
   that P2's session-bearing server on the same socket went unrecorded and so
   sat outside the survivor proof. Fixed.
2. Two fail-opens in my own tests: TypeScript parses the expect-error token out
   of *any* comment including explanatory prose, and Biome's formatter re-wraps
   an inline object literal so the suppressed error moves off the directive's
   line. Both silently turn an assertion into an unused directive. Bad values
   are now hoisted to their own line.

**Open question for review** (sent to Codex, `af0aa210-074e-4ab5-a172-6d46730ca7d0`):
three derived decisions not settled by spec text — the extra
`serverArgvForSocket(socket, args)` entry point for the pre-session launch
window; `reconPaneTargetsFromManifest` for the one `string[]` pane field; and
`socketConflict` having to be supplied by the read path since `tmux-socket.ts`
never sees both camel and snake keys.

**Next bounded action: T-04 — early launch binding.** Investigated but **not
started**; no source edited for it. Findings below so the successor does not
re-derive them. Nothing is half-edited: the working tree is exactly T-01+T-02+T-03.

**Where the ordering constraint lands.** `reservePairedLaunch`
(`launch-reservation.ts:241`) is the manifest reservation. Inside it,
`reserveRunStorage` runs at `:282` and `createRunManifest` at `:284`, followed by
`writeRunManifest` at `:301`. Verify 2/4 require socket resolution to **fail
before** that block, so `resolveTmuxSocket` belongs at the top of
`reservePairedLaunch`, before `acquireLock` — a throw there leaves no lock, no
storage, and no durable active-looking run.

**The session identity IS deterministic at reservation time, but only on one
path.** `buildRunName(base, runId)` (`tmux.ts:981`) is a pure function of
`runBase` and the run id, so once `storage.runId` exists the session name is
known without contacting tmux. That is what makes "socket bound *together with*
`tmuxSession`" achievable at the early binding.
**Caveat that must not be missed:** `startAutoSession` (`tmux.ts:3672`) picks its
id by looping candidates `1..MAX_SESSION_ATTEMPTS` and taking the first
`new-session` that succeeds, so on that path the name is *not* known in advance.
The paired reservation path does reserve a concrete `storage.runId` first, so
T-04 should bind from the reserved id and must not assume the auto-loop's
behaviour.

**First tmux server contacts, which resolution must precede:**
`sessionExists` (`tmux.ts:3639`, via `has-session`) and the `new-session` spawns
at `tmux.ts:3653` and `:3693`.

**Never overwrite from ambient state (verify 5).** The resume path
`reserveRequestedLaunch` spreads `...requested` (`launch-reservation.ts:225`),
which already preserves a persisted `tmuxSocket`. T-04 must keep it that way:
resolve only when minting a new manifest, never when a socket-bearing manifest
already exists. This is the clause most likely to be broken by a careless edit,
because the obvious implementation resolves once at the top for both paths.

**`LaunchReservationDeps` (`launch-reservation.ts:27`)** has no `env` or `uid`
member; `resolveTmuxSocket(env, {uid})` needs both, so T-04 adds them as injected
deps rather than reading `process.env` directly — the file currently reads
ambient state nowhere, and it should stay that way for testability.

After T-04: **T-05** (launch/resume/attach + shared bounded control) is the first
task that migrates real consumers and where the 64 `"tmux"` argv literals start
moving.

Verified repo facts for the successor: `loop-fork/src` contains **zero**
occurrences of `-S`, `-L`, or `LOOP_TMUX_SOCKET` — the product never names a
socket, which is the split-brain root cause — and **64** `"tmux"` argv literals
await migration.

---

## Run 12 (historical — how the bundle reached approval)

**Run 12 update.** The three round-2 residual gaps are **closed in the bundle**
and review round 3 has been requested at the round-3 hashes below. Bridge
messages, in order: request `c23f9ccb-0b69-4315-8069-f4b67d074157`; hash
correction `148b6d62-810e-4d84-9619-9de2d0488c6c` (PLAN.md and status.md moved,
both out of review scope); and **final supersede
`e9e919c8-af88-4466-abf6-3f1904ae25c7`**, which is a content change — the 11
anchor-citation fixes below — and carries the authoritative hashes. Round 2 was
`858d32d3-8385-45de-a86d-8fefe5c12dbf`, round 1 `6a4ed303`. Nothing is
half-finished, nothing is committed, HEAD is still `ddf134b9`, and
`git status --short loop-fork | wc -l` is still 0. Human approval of the
legacy-manifest support impact remains **ungiven** and is still the gate before
any implementation. **[As of 2026-08-08 this is DISCHARGED — round 3 returned
PASS and the founder approved. Run 14 is implementing.]**

How each gap was closed — all three took the enforce-by-shape branch rather
than the assert-harder branch:

| Gap | Closure | Anchors |
|---|---|---|
| **A** loose socket-only composer | Socket-only `tmuxArgv` is module-private and unexported; the exported surface is the target-bound trio `targetArgv` / `paneArgv` / `serverArgv`, which supply every target-naming flag and reject a caller-supplied `-S`/`-t`/`-s` | R3, R12; verify 6 |
| **B** unsatisfiable verify-5 promise | `targetFromManifest(handle)` takes **one** parameter, an opaque frozen `ManifestHandle` stamped by the manifest read path with `runId`, pathname, and byte SHA-256 — so the A-manifest/B-socket target is *unconstructible* rather than detected. Verify 5 splits into 5a constructibility, 5b cross-run non-contact, 5c recorded residual | R3, R6; verify 5a/5b/5c; T-03 |
| **C** pane ownership by caller discipline | Opaque `OwnedPaneTarget`, sole constructor `paneTargetFromManifest(handle, field)`, yielding nothing when the handle's socket or session is unknown; `(TmuxTarget, paneId)` and bare `paneId: string` do not compile | R10, R12; verify 3 |

The B closure is deliberately narrower than round 2's wording invited. A
manifest whose *recorded* socket does not match the server its run really lives
on stays outside the mechanism: the manifest is the source of truth by design
(R6), so nothing in-product can separate a legitimate record from an edited one.
Verify 5c records that residual instead of asserting a rejection the product
cannot perform, and asserts the two properties that do bound it — ambient state
cannot rewrite a socket-bearing manifest, and an unusable socket is `unknown`,
never `dead`.

Files changed in run 12: `specs/tmux-socket-normalization/{spec,plan,tasks,verify}.md`,
root `PLAN.md`, this file. Anchors revised: R3, R6, R10, R12; verify 3, 5, 6;
T-02, T-03, T-05, T-10, T-11; the acceptance-criteria mapping table and its
checklist; and the `specs/.../plan.md` sequence and decision table.

### Bundle self-audit after the revision — derived, not eyeballed

Routed as utility audit `7b6b34fc-7b93-4ab4-9096-6fd5e7a5d3e2`; Governess
returned it `protected-scope`, so it ran here. The two numbered lists are the
easiest thing in this bundle to break silently, and the run-12 edits touched
mapping rows 3 and 5, so the property was re-derived by parsing the table rather
than read off it:

- **Anchor bijection intact.** Parsing spec.md's acceptance-criteria table gives
  18 rows; checks 1-18 missing from the table = `[]`; R1-R18 proven by no check
  = `[]`; no out-of-range anchor on either side. Row 3 is now `R1, R10`, row 5 is
  `R3, R6, R7`, row 6 stays `R3, R12`.
- **Task-to-check coverage complete.** Verify checks referenced by no task in
  `tasks.md` = `[]`, across T-00 to T-18.
- **Symbol consistency.** `grep` over the four bundle files plus `PLAN.md`
  returns no occurrence of `targetFromManifest` taking more than one argument
  outside the deliberate `@ts-expect-error` negative tests, and every one of the
  12 `tmuxArgv` mentions describes it as module-private or unexported. No
  mention survives that presents it as public.
- **Citation hygiene — 11 real violations found and fixed.** This is the audit
  property I initially skipped as "hard to derive mechanically", which was
  wrong: naming a limitation is not checking one, and the derivation is two
  greps. `spec.md` requires every anchor be cited as `R<n>` or `verify <n>` and
  never as a bare number, because the two 18-long lists are not index-aligned.
  Eleven citations broke that rule — `spec.md` lines for R3/R10/R5/R13 cited as
  "requirement N", `verify.md`'s UI-checks paragraph and two `spec.md` sites
  citing "check N", and two `tasks.md` **Inputs** lines citing "requirements
  2–5" and "requirement 1". Ten were pre-existing through both prior review
  rounds; **one was mine, and it was inside the very sentence that states the
  rule** ("Check 5 has lettered parts"). All eleven now use proper anchors, and
  the sentence stating the rule now says "this sentence included". Re-derived
  after the fix: both greps return empty across the bundle and `PLAN.md`.

This audit checks internal consistency only. It is not a review verdict and
grants nothing; round 3 is still Codex's call.

### ROUND 3 VERDICT: PASS — received 2026-08-08 01:03Z

Codex verdict `e0b267ee-804b-44a7-ae78-3f8d1e084100`, replying to
`e9e919c8-af88-4466-abf6-3f1904ae25c7`. Accepted at the exact working-tree
hashes, each re-verified here with `shasum -a 256` after the verdict arrived and
each matching: spec `d802f1f9…`, tasks `2bb690f0…`, verify `bc96366b…`, plan
`67bfa1ae…`. Codex independently confirmed HEAD `ddf134b9…` and
`loop-fork` status count 0.

All four attack questions I raised were answered, not deferred:

1. **5a/5b/5c accepted.** The API-shape mechanism makes A-manifest/B-socket
   construction impossible through the public production surface; the frozen,
   uniquely branded `ManifestHandle` plus one-argument `targetFromManifest`
   supply provenance. 5c "does not claim an impossible rejection" and bounds
   enforceable behaviour through ambient non-rewrite plus unknown-on-unusable.
   **The recorded-residual choice was the right call, not a concession.**
2. **R12's target-flag rule adequate as specified.** Stated method + seeded
   independent violation + explicit indirect-coverage limitation is enough;
   AST is required only if full indirect coverage is *claimed*.
3. **`serverArgv` residual rejected as a concern.** It is target-bound and
   server-scoped, derives `-S` from the opaque target, and emits no session
   target, so no cross-run session pairing is possible.
4. **Bijection independently confirmed**, matching my derivation exactly: row
   3 = R1, R10; row 5 = R3, R6, R7; row 6 = R3, R12; R10 covered by verify 3, 8,
   10. No anchor-citation defect remains in the reviewed files.

T-00's first two done-when boxes are now satisfiable: peer review received and
findings incorporated, and both open questions have recorded decisions. The
third — explicit human approval — is the only thing still outstanding.

**T-00 CLEARED 2026-08-08 — both gates now closed.** The founder approved on the
session user channel: `approved — fail closed, no recovery. proceed to T-00`.
All five T-00 done-when boxes are ticked in `tasks.md`, with evidence in
`runs/tmux-socket-normalization/approval.md`.

The approval string closely resembles one this run's delivery-defect log records
as *not* founder input (`approved, legacy manifests fail closed — proceed once
Codex passes`, ghost type-ahead text misread twice in run 11). The resemblance
was surfaced to the founder before proceeding rather than resolved silently. The
two are distinguishable by **channel**, and that is the entire basis for banking
this one: the ghost was scraped from a rendered tmux pane surface, while this
approval arrived on the session user channel, the authoritative input path, with
no pane read to obtain it. Recorded at length in `approval.md` because a future
session finding two near-identical strings — one banked, one not — needs to know
which distinction did the work.

**State is now implementation, not plan.** `runs/tmux-socket-normalization/`
exists with `approval.md`, `task-log.md`, and the `loop-fork/runs/` pre-state
baseline (1582 files, digest `2022557f…`) captured before anything was created.
`git status --short loop-fork | wc -l` = 0, verified before and after.

### Peer block on review round 3 — RESOLVED

Supervisor message `d134bc7f-00e6-4492-9094-5baaef4e5a30` (urgent, 00:44Z):
round-3 review traffic is queued but **Codex is blocked at the Luna rate-limit
modal** after a verified charter bootstrap. Supervisor disposition `cc231708` is
pending. No terminal keys and no modal choice have been injected by anyone,
including me. Acknowledged as `01201944-a915-450e-bb22-78762d7a7e6d`.

**Resolved without intervention.** Codex cleared the modal and returned the
round-3 PASS at 01:03Z, 18 minutes after the supervisor notice. Nothing was
injected by anyone, no alternate reviewer was needed, and disposition `cc231708`
was never exercised. Recorded because the correct handling of a blocked peer is
now evidenced rather than asserted: the block was reported out of band, waited
out, and resolved itself.

Implementation stays held. Gate order is unchanged and now has one step left:
review round 3 **(PASS)**, then human approval, then T-00.

---

Written at the Governess preparation threshold (69 assistant turns, threshold
68). The current atomic step **is complete**: peer review round 2 was sent as
`858d32d3-8385-45de-a86d-8fefe5c12dbf`. Nothing is half-finished. No broad slice
was started. Nothing is committed and no session was compacted.

## Objective

Close defect `adc4bb8a-4b7b-4245-832f-a1995076b6b1`: tmux runs resolve their
server from ambient environment and nothing records which server a run was
created on, so a consumer on a different ambient socket reads a live run as dead
and acts destructively on that verdict. This session is **plan and spec only**.

## Exact changed scope

Only these paths. `git status --short` is exactly
`" M PLAN.md"`, `" M status.md"`, `"?? specs/tmux-socket-normalization/"`.
`git status --short loop-fork | wc -l` = **0**.

**Current — run 12, the revised bundle sent for review round 3:**

| Path | SHA-256 (round 3, current) |
|---|---|
| `specs/tmux-socket-normalization/spec.md` | `d802f1f93a356a1fe63043932b15025290ae0872e2b3643f661f9e5a3cfbe027` |
| `specs/tmux-socket-normalization/plan.md` | `67bfa1ae626409bbc5e40d480d7a4294d0b1a735871e9a266c2fa06e08e8a95d` |
| `specs/tmux-socket-normalization/tasks.md` | `2bb690f01c9f10ce2731d6dcfe2b3337d82042b5c00d137dfc02f9e77d0cd4ff` |
| `specs/tmux-socket-normalization/verify.md` | `bc96366b75a720e0d38ff085e9cee17661e0cd2e202925fb3058fb5bd265be65` |

Values at the moment request `c23f9ccb` was sent, now superseded by the
citation-hygiene fix below: spec `7ac0ec3f…`, tasks `72382b05…`, verify
`1a7dc6a6…`. `plan.md` is unchanged at `67bfa1ae…`.
| `PLAN.md` | `4dd84af4eedd46f734aa9ea572c1d407dd41cde11c943c3aaef52bf9b4a9c075` at send; **now `faad97c1a6aa466bb61cad73949b1a1814af3ecb262065c303e093632b6af93c`** |

**`PLAN.md` moved after the round-3 request was sent, and the four bundle files
did not.** The change is additive and outside what Codex is reviewing: the
drafted-not-presented human-approval package was appended, plus the round-2
findings were wrapped in an archival container and the closure summary written.
No requirement, check, task, or decision changed. The four
`specs/tmux-socket-normalization/*.md` hashes above are byte-stable from the
moment of the request and are the actual review surface. Correction sent to
Codex rather than left for it to discover — the same failure run 11 hit when its
own `PLAN.md` row went stale mid-review.

Superseded — the round-2 bundle, kept so the round-3 diff has a fixed origin:

| Path | SHA-256 (round 2) |
|---|---|
| `specs/tmux-socket-normalization/spec.md` | `aa1f312fe8d82eac4264db0aeec37d8c29117072a05926f1f6c5e3c082467ab6` |
| `specs/tmux-socket-normalization/plan.md` | `cd9de41b9156171a935c47ae9d026c9f4edd46b2dd138a4171581fcf3952a304` |
| `specs/tmux-socket-normalization/tasks.md` | `9040c8fc4abdbb5c84a66a6df67c12d30da79616e8e82f1f3608ffe9cb6a7a98` |
| `specs/tmux-socket-normalization/verify.md` | `0d95ddb85b79f424e1de89bf3c03fd4e080436a9ec56b1215cb6587f47e8d6ee` |
| `PLAN.md` | `4657d39c495c6bfca354586bfadb2516c5a30179899bed68c519d042f39e9285` |

The `PLAN.md` round-2 row above is corrected from the value this file carried at
the run-11 handover threshold (`d7733cbc…`). `PLAN.md` changed once more after
that block was written; `4657d39c…` is the value recorded in run 11's own
`claude.json` handover and the value this worktree actually carried at run-12
start, verified by `shasum -a 256` before any edit. Run 11's other four rows
were verified unchanged at the same time.

Note: `PLAN.md` was `63d7361a…` when review round 2 was sent. It changed twice
after that, for reasons that do not affect what Codex is reviewing: the handover
block was appended, and its consumer-inventory paragraph was corrected to carry
the four identity conventions and the seven persisted pane fields (it previously
listed only the `replacementSession` files, and omitted
`governess-replay.ts:307`). The design and decisions are unchanged; `spec.md`
already carried the corrected inventory when round 2 was sent.

Re-verify these before trusting them; the hashes are from the working tree, not
a commit. HEAD is `ddf134b9200a3fda3cac68dcdd7868f28c94160d`, still equal to
base.

## Checks run, and their results

- `git rev-parse --verify ddf134b9200a3fda3cac68dcdd7868f28c94160d^{commit}` —
  resolved, full SHA printed.
- `shasum -a 256 /Users/amgad/.local/bin/loop` =
  `9ca9f74fa66e1ea0dd2a1a821e0db4e000b64b84aa1903b3db40f820a5fc93f1` — matches
  the pinned assignment value.
- Consumer inventory re-derived: exactly ten files build a tmux argv;
  `grep -rn '"-S"' --include='*.ts' src` returns nothing.
- Four identity conventions found (see "Fourth sweep" below), one of which
  nobody had named.
- Four environment facts **measured**, not cited (see "Measured" below), in an
  isolated scratchpad with `survivors=0`.
- **No build, no test suite, no smoke, no `loop-fork/` change.** Those all live
  behind the approval gate and must not be run as "just checking".

## Blockers

1. **Peer review round 2 returned REVISE** —
   `2323058d-2a99-44f2-92eb-978950fb3d59`. Three residual gaps, recorded in full
   below. **These belong to the successor**, per governed instruction
   `3b527e67`: run 11 does not start another revision slice.
2. **Human approval of the legacy-manifest support impact** — was ungiven at the
   time of writing, and gated behind the round-2 findings: the successor had to
   close them and pass review *before* any human gate or implementation.
   **[DISCHARGED 2026-08-08: round 3 PASS, then founder approval. See the run-14
   section at the top of this file.]**

Implementation may not start until both clear. Governed instructions
`d3032799` and `3b527e67`, plus `CLAUDE.md` operating-loop step 3, all say so.

## ROUND 2 VERDICT: REVISE — three residual gaps [ANSWERED IN RUN 12]

> **AS RAISED in round 2.** Preserved verbatim below as the record of what was
> asked. All three are closed in the bundle at the round-3 hashes above; see the
> run-12 closure table at the top of this handover. Read this section as history,
> not as open work.

Codex verified round-2 hashes (spec `aa1f312f…`, plan `cd9de41b…`, tasks
`9040c8fc…`, verify `0d95ddb8…`, PLAN.md `63d7361a…`) and confirmed **finding 2
is CLOSED** (R8's `TmuxSkipRecord` schema and injected sink; verify 8/10 assert
by field and forbid pane-text/log inference). Panel row states (R9/verify 11),
pane subordinate *design*, legacy disposition, and the Linux labelled inference
are all **closed**. What remains is one theme: **provenance is asserted but not
mechanically enforced by API shape.**

**Gap A — the composer is still socket-bound.** R3 and verify 5 still specify
`tmuxArgv(socket, args)` while only liveness/control APIs must accept a
`TmuxTarget`. If a branded socket is exported or reachable from target
internals, a consumer can call the composer with run B's valid socket and args
naming run A. The opaque target does not constrain the composer.
*Fix direction:* make the production composer target-bound
(`tmuxArgv(target, args)`), or make socket-only composition a **private,
unexported** launch primitive used only by a target method, and add derived
enforcement for that.

**Gap B — verify 5 promises a rejection it has no mechanism for.** It says
supply run A's manifest paired with run B's socket and expect
`targetFromManifest` to reject. But `targetFromManifest(manifest)` reading both
fields from the *same plain object* cannot distinguish a corrupted or synthetic
object containing A's session and B's socket. There is no registry, signature,
or expected socket relation stated. **Do not promise rejection of a same-object
field swap without a mechanism.**
*Fix direction:* either change the assertion to prove the API has **no second
socket argument** — so constructing A-manifest-plus-B-socket is impossible at
compile time — or define a real provenance token / immutable manifest handle
that can reject the pair.

**Gap C — pane ownership is still caller discipline.** R10 and verify 3 say
"same-manifest derivation", but a pane operation shaped as
`(TmuxTarget, paneId)` still lets a caller pair target A with pane ID B.
*Fix direction:* pane operation inputs must be an owning manifest or an opaque
`OwnedPaneTarget`, or cross-manifest pane pairing must be explicitly tested and
rejected. **Same-manifest must be enforced by API shape, not by discipline.**

Scope to revise: R3, R6, R10; verify 3 and 5; T-02, T-05, T-10. Then re-request
Codex review. Optional non-blocking addition Codex offered: a mandatory
non-no-op production sink/default for R8.

## Next bounded action [SUPERSEDED — run 12 executed this]

> Run 12 did exactly this: revised the anchors and requested review round 3.
> The current next bounded action is **consume the round-3 verdict**; on PASS,
> present the human-approval package for the legacy-manifest support impact.
> No implementation before that approval. The run-11 text follows as history.

## Next bounded action (successor, run 12) — as written in run 11

1. Consume the three round-2 gaps above. Remove loose composer and pane inputs;
   make the verify 5 provenance assertion mechanically satisfiable.
2. Re-request Codex review. **No human gate and no implementation until that
   review passes** — governed instruction `3b527e67`.
3. Only then request human approval on the legacy-manifest support impact.
4. First post-approval step is T-00 bookkeeping (update `status.md` to
   implementation state, create `runs/tmux-socket-normalization/`, re-verify
   HEAD and binary SHA), then T-01.

**Do not bank rendered pane text as approval.** Twice this run, type-ahead
suggestion text derived from an agent's own prior output was misread as real
input — once saying `socket-qualify the seven pane fields, don't just clear
them` (the opposite of Codex's actual answer), once saying `approved, legacy
manifests fail closed — proceed once Codex passes`. Neither was founder input.
A one-character probe distinguishes a ghost from real content.

## Risks to carry forward

- **Bridge queue-to-seat non-delivery is active in this run**, in both
  directions. Three messages sat undelivered to me for 40+ minutes while I
  believed a bundle was under review and Codex sat idle having already answered.
  Do not infer a peer's state from silence; pull `receive_messages`.
- **Rendered pane text is not evidence.** Type-ahead suggestion text derived
  from an agent's own prior output was misread as a real instruction by both a
  monitor and a human this run. It said the opposite of Codex's actual answer.
- Smoke shim defeat, panel scope, socket path length, manifest
  forward-compatibility, handover identity drift — all detailed in `PLAN.md`.

---

## State

Plan mode, spec bundle authored and revised once against peer review. No
`loop-fork/` source, test, smoke, script, or docs change; nothing committed.
Blocked on the T-00 approval gate as described above.

## What was done this session

Investigation only, all claims below re-derived in this worktree.

- **Bindings verified, not assumed.**
  `git rev-parse --verify ddf134b9200a3fda3cac68dcdd7868f28c94160d^{commit}`
  printed the full SHA, so the base binding resolves.
  `shasum -a 256 /Users/amgad/.local/bin/loop` =
  `9ca9f74fa66e1ea0dd2a1a821e0db4e000b64b84aa1903b3db40f820a5fc93f1`, matching
  the pinned installed-binary SHA-256 in the assignment.

- **Confirmed the product has no socket identity at all.**
  `grep -rn '"-S"' --include='*.ts' src` in `loop-fork/` returns nothing. The
  only socket isolation anywhere is the test-only PATH shim
  `evals/smoke/fixtures/isolated-tmux.sh`, which injects
  `-L "${LOOP_SMOKE_TMUX_SOCKET}"` ahead of the product's argv.

- **Derived the consumer inventory rather than hand-listing it.**
  `grep -rEn '(\[|\()\s*"tmux"' --include='*.ts' src | sed 's/:[0-9]*:.*//' | sort -u`
  gives exactly ten files: `src/install.ts`, `src/loop/bridge-runtime.ts`,
  `src/loop/claude-config-gc.ts`, `src/loop/governess-pane-liveness.ts`,
  `src/loop/governess-replay.ts`, `src/loop/governess.ts`,
  `src/loop/panel.ts`, `src/loop/run-process-cleanup.ts`,
  `src/loop/tmux-control.ts`, `src/loop/tmux.ts`. Three further files consume
  `manifest.tmuxSession` without spawning tmux: `launch-reservation.ts`,
  `codex-tmux-proxy.ts`, `paired-options.ts`.

- **Escalated the defect from "bad read" to "destructive fail-open", with
  citations.** Three consumers convert a cross-socket miss into a positive
  dead/absent verdict and then act on it:
  `claude-config-gc.ts:72` returns `false` on any nonzero `has-session` exit
  (only a timeout yields `undefined`), so a live run on another socket has its
  Claude config garbage collected; `run-process-cleanup.ts:93` maps
  `no server running` to an **empty session set**, making every live loop run
  look orphaned; `tmux-control.ts:43,64` returns `"dead"` on any nonzero exit,
  which feeds the active-launch interlock (`launch-reservation.ts:99-110,
  202-208`, permitting a second launch against a live workspace) and the Codex
  proxy shutdown (`codex-tmux-proxy.ts:219-248`, `reason: "dead-tmux"`).

- **Found the non-attachable manifest surface named in the defect.**
  `panel.ts:1169`, `tmux.ts:3602`, `tmux.ts:4024` all emit
  `tmux attach -t <session>` with no socket.

- **Identified a migration hazard that must land in the same change.** Once the
  product emits `-S`, the smoke shim's `-L` is superseded and the smokes would
  silently touch a shared server. `PLAN.md` carries both the shim migration
  (smokes move to `LOOP_TMUX_SOCKET`) and a task to verify `-S`/`-L` precedence
  empirically instead of trusting the reading.

## Proof / checks run

Read-only inspection and `grep`/`git rev-parse`/`shasum` only. No build, no
test run, no edits to `loop-fork/`. Product `runs/` untouched; Harvto untouched.

## Open questions

1. **Panel scope.** `tmux list-sessions` is server-scoped, so the dashboard
   cannot span sockets in one call. `PLAN.md` and `spec.md` requirement 9
   enumerate **only** the deduplicated set of valid sockets referenced by run
   manifests, and deliberately **do not** add the ambient default, because that
   would reintroduce guessing and cannot recover a legacy session's identity.
   Needs peer confirmation that no discovery case governance depends on is lost
   by excluding the ambient default.
2. **Legacy manifest disposition.** Fail-closed means an existing run started
   before this change becomes unmanageable by the new binary until it exits.
   Plan treats that as correct (safe direction). Worth an explicit supervisor
   acknowledgement, since it is a visible behaviour change for in-flight runs.

## Risks

- Smoke shim defeat if the `-L` to `LOOP_TMUX_SOCKET` migration is missed —
  mitigated by asserting the product used the socket file the smoke created.
- Socket-path length against the 104-byte Darwin `sun_path` limit under long
  `/private/tmp/...` worktree paths — mitigated by a launch-time budget check.

## Also done this session

- **Authored the spec bundle** from the `specs/_template/` shape and consistent
  with `specs/constitution.md`. `spec.md` requirements and its acceptance list
  map one-to-one onto the **eighteen** numbered checks in `verify.md`.
  `tasks.md` carries T-00 (approval gate) through T-18 (commit and stop at the
  review gate). `verify.md` records web screenshot/DOM as not applicable, with
  the reason: panel rows and attach hints are terminal output with no DOM.

- **Found a seam the hand-derived grep missed.**
  `grep -rln 'tmuxSession\|tmux_session' --include='*.ts' src` returns thirteen
  files, and `governess-handoff.ts` / `governess-exit.ts` are **not** among
  them. They carry `replacementSession: string`
  (`governess-handoff.ts:38,224,244`, `governess-exit.ts:14,60-63,96`), and
  `governess-exit.ts:87` reports `"replacement session was not persisted"` as
  its only failure mode — a persisted *name* is currently treated as sufficient
  identity. This is direct evidence for the derived-check decision: a
  hand-written inventory already missed a real seam once.

- **Re-derived the argv inventory independently.** Same ten files;
  `grep -rn '"-S"' --include='*.ts' src` still returns nothing.

- **Measured four environment facts the design rested on**, in an isolated
  scratchpad temp root, before the approval gate. No repository write, every
  server addressed and killed by explicit socket path, cleanup reported
  `survivors=0`. Producer `tmux 3.7b`, Darwin, ambient `TMUX` unset.
  1. `-S` beats `-L`: `tmux -L <label> -S <path> start-server` created
     `<path>`; the label-derived path was never created. The shim-defeat hazard
     is real, not theoretical.
  2. `$TMUX` layout is `<socket>,<pid>,<session-index>` — three fields, so
     removing the final two recovers the socket.
  3. **Upgraded a design nicety into a requirement.** With socket
     `…/so,ck-c`, parse-from-right returns the full path but the naive
     first-field parse truncates it to `…/so` — itself a creatable socket
     path, so the run would silently target a different server. Parsing from
     the right is required, not stylistic.
  4. Darwin `sun_path` budget measured at the boundary: 103 bytes starts a
     server, 104 fails `error connecting to … (File name too long)`. The
     plan's 103 figure is now an observation with a reproducing command.
  The Linux limit (107) is still **inference** — this host is Darwin.
  Recorded in `spec.md` under "Measured, not assumed"; `PLAN.md` risk 1 and
  spec requirements 4 and 5 updated to cite the measurements.

- **Fourth sweep found a seam nobody had named, and a numbering defect in my
  own bundle.** After noting that a field-name grep had already missed
  `replacementSession`, I swept for identity-shaped string fields generally
  (`grep -rEn '^\s*(readonly )?[a-zA-Z]*([Ss]ession|[Pp]ane)[a-zA-Z]*\??:\s*string'`).
  Results:
  1. `replacementSession` exists at a **third** site,
     `governess-replay.ts:307`, not just handoff and exit.
  2. A third convention is bare positional `session: string` on shared APIs,
     which no field-name grep finds — `tmux-control.ts:44,65`,
     `panel.ts:37,70,756`, `paired-options.ts:64`,
     `governess-pane-liveness.ts:44,50,61,180`, `governess.ts:283`,
     `governess-exit.ts:28`, and ~16 sites in `tmux.ts`.
  3. **New and previously unidentified:** `run-state.ts:124-132` and `217-225`
     persist seven tmux **pane** fields (`tmuxPaneAuPair`,
     `tmuxPaneGoverness`, `tmuxPaneLeft`, `tmuxPaneNanny`, `tmuxPaneRecon`
     (`string[]`), `tmuxPaneRight`, `tmuxPaneUtility`) beside `tmuxSession`. A
     pane target is exactly as socket-dependent as a session name, so a
     topology clear that drops `tmuxSocket` but leaves a pane target is a fresh
     instance of the same defect. Spec R10, verify 3, T-03, and T-10 updated.
  4. Checked and **excluded**: `sessionRef` is documented at
     `governess.ts:213` as the "Session id / thread id used to locate the
     agent's usage transcript" — an LLM transcript reference, not a tmux
     session. Not migrated.
  Four naming conventions, three invisible to a field-name grep. This is now
  the bundle's stated justification for the derived check.

- **Fixed a numbering collision in my own bundle.** `spec.md` had eighteen
  numbered *requirements* and `verify.md` eighteen numbered *checks*, and they
  are different lists — R10 is not verify 10. A reviewer citing "10" would have
  been ambiguous. Requirements are now cited `R1-R18`, checks `verify 1-18`,
  with an explicit mapping table in `spec.md` proving every requirement is
  covered by at least one check and vice versa.

- **Helper-output caveat.** A Nanny inspection packet
  (`8b309a14-1456-47fc-9013-a8677e9d8db9`) reported `specs/_template/` as an
  empty directory. That is false — it contains `plan.md`, `spec.md`,
  `tasks.md`, `verify.md`. The template was read natively instead. Treat that
  packet's output as unusable, not as evidence about the repository.

## Peer review round 1: REVISE, consumed

Codex verdict `6a4ed303-5d2f-4cd2-8b78-b278bc94a4bf` on bundle hashes
spec `e54c6dfa…`, plan `e28cafc2…`, tasks `84931f07…`, verify `690a1f83…`.
Codex verified the hashes in the worktree, confirmed HEAD `ddf134b9` and zero
`loop-fork/` changes, and made no repository writes. Two blocking findings, both
now fixed in the bundle:

1. **Target provenance (blocking).** `TmuxTarget` plus `tmuxArgv` closes
   loose-parameter omission but does **not** stop a caller pairing a *valid*
   socket with the wrong run's session, or sourcing one from hostile ambient
   state. A derived checker cannot prove runtime provenance. Fixed: `TmuxTarget`
   is opaque with **no public constructor**; `targetFromManifest(manifest)` is
   the only production path and validates both fields from the same manifest;
   verify 5 now asserts run A's manifest paired with run B's socket is rejected
   and server B is never contacted; `resolveTmuxSocket` must be unreachable from
   post-launch consumers. R3, R6 and verify 5 rewritten.
2. **Skip records had no schema or sink (blocking).** R8 required a record but
   specified nothing, so "logging" could be untestable and could disappear in
   production — the fail-closed skip would quietly become a fail-open. Fixed:
   `TmuxSkipRecord` with `consumer`, run identity, `session`/`pane` or explicit
   absence, `socketState` (`missing`/`invalid`/`conflicting`/`unknown`),
   `reason`, `effectSkipped`, emitted to an **injected sink**; verify 8 and 10
   assert records by field.

Non-blocking items also applied: verify 6 now states the checker's analysis
method and adds an indirect helper/alias case if it is regex-based, asserts each
seeded case independently, and matches the `install.ts` exception by exact path
**and** argv; verify 16 fixes the positive control to run **before** cleanup and
forbids killing unrelated PIDs; verify 11 and R9 specify the three panel row
states and resolve the "valid sockets only vs legacy rows" wording conflict;
Codex's exact-line fail-closed sweep is recorded in `tasks.md` as a coverage
inventory (explicitly an aid, not the enforcement mechanism).

**My pane-fields uncertainty is resolved, and the answer was conditional.**
Codex: atomic clear is sufficient **only if** every pane operation derives an
opaque target from the same manifest and rejects pane fields when socket or
session is unknown. Pane IDs stay subordinate to `(socket, session)` rather than
becoming standalone socket-qualified strings. That invariant is now explicit in
R10 and verify 3, with mismatch rejection tested. Without it, atomic clear is
the half-measure I suspected.

Both open questions are now **resolved** and recorded in `spec.md`: panel
enumerates valid manifest sockets only; legacy manifests fail closed with an
explicit no-recovery policy and recorded support impact. Codex confirmed no
fifth identity convention exists and that `sessionRef` is correctly excluded.
Linux `sun_path` 107 stays a labelled inference — accepted as non-blocking
because the limit is parameterized, not hard-coded.

## Delivery-defect evidence (separate defect, recorded not fixed)

Supervisor withdrew `f4cb0089` in full. Corrected account, probe-verified:
the composer text `socket-qualify the seven pane fields, don't just clear them`
was **rendered type-ahead suggestion text derived from my own prior output**,
not an injected instruction and not founder approval. A typed character
*replaced* it rather than appending, and it reappeared whenever the composer was
empty. Nothing was stranded on my pane and no supervisor Enter submitted
anything there. I did not bank it as a disposition.

The real run-11 defect is **queue-to-seat non-delivery in both directions**
(Codex earlier, me twice) — three messages undelivered to me, oldest 40+
minutes, while I sat idle believing my bundle was under review and Codex sat
idle having already returned REVISE. Distinct from the harvto
paste-without-submit strands (4 instances), and distinct again from
**monitor-misread-of-ghost-composer-text**, a third failure mode that fooled
both my lane's monitor and the supervisor. The one-character probe distinguishes
it.

Folded into this spec only where it genuinely bears: R8 now forbids inferring a
skip by scraping rendered terminal output, and requires a structured event
emitted at the decision point. The delivery defects themselves are **out of
scope here** and are stated as such in R8.

### Run 12 log

Taxonomy carried forward unchanged, three modes: paste-without-submit (harvto
seats), queue-to-seat non-delivery (both directions, run 11), and
monitor-misread-of-ghost-composer-text (one-character probe is the
discriminator).

- **No new instance through the round-3 request.** Stated as a positive check,
  not as inference from a quiet channel: the run-12 bridge carried no inbound
  message to misdeliver up to this point, and every peer state claim in this
  file comes from a `receive_messages` / `task_status` pull or a `shasum`, never
  from rendered pane text. Nothing was banked from a composer surface.
- Helper routing (Governess → Direct/Nanny) delivered on every packet submitted
  this run; results were read through `get_task_result`, not from a pane.
- **New mode, recorded 2026-08-08 — peer blocked at a provider modal while
  review traffic sits queued.** Round-3 request `c23f9ccb` reached the bridge;
  Codex could not act on it because it was stopped at the Luna rate-limit modal
  after a verified charter bootstrap (supervisor `d134bc7f`, disposition
  `cc231708` pending). This is **not** bridge non-delivery and does not belong
  under the queue-to-seat entry: the transport worked. It is a fourth mode, and
  its discriminator is an out-of-band supervisor report — from inside my lane a
  blocked peer and a slow reviewer are indistinguishable, since both present as
  a quiet channel. The supervisor notice is what prevented the inference; the
  standing rule held, and nothing was banked from silence or from a pane.
- If a new instance appears later in run 12, it gets its own line here with the
  mode, direction, and the probe or pull that identified it.

## Next step

Re-request independent review on the revised bundle (round 2), then obtain
explicit human approval. The only substantive question left for the human is the
recorded legacy-manifest support impact: a run launched before this change keeps
running but is not manageable by the new binary until it exits.
**No implementation of any kind before that approval**, per `CLAUDE.md`
operating-loop step 3, T-00, and the governed instruction `d3032799`.

## Codex round-2 review handoff — 2026-08-07

Codex independently verified final bundle hashes and reviewed revised R3/R6/R8/R9/R10,
verify 3/5/8/10/11, T-02/T-05/T-10, and root `PLAN.md`. R8 skip-record schema
and injected sink are closed. Panel query-vs-render wording, three row states,
legacy disposition, and Linux-limit treatment are acceptable.

Verdict remains **REVISE**. Blocking residuals:

- `tmuxArgv(socket, args)` remains a loose socket composition seam; make the
  production composer target-bound or keep socket-only composition private and
  unexported.
- Verify 5 promises rejecting run A manifest plus run B socket, but
  `targetFromManifest(manifest)` over one plain object has no mechanism to reject
  a synthetic A-session/B-socket object. Make the assertion mechanically
  satisfiable or define an actual provenance token/immutable handle.
- Pane ownership requires API-enforced manifest binding or `OwnedPaneTarget`,
  not caller discipline around `(TmuxTarget, paneId)`.

No loop-fork implementation changes, tests, smokes, scripts, eval, commit, or
deployment work performed by Codex. Next action: Claude revises R3/R6/R10,
verify 3/5, T-02/T-05/T-10 and requests final review. Doorbell delivery defect
was logged separately to supervisor; queue-to-seat non-delivery remains out of
scope for this feature.
