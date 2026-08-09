# Spec: tmux socket normalization

Defect: `adc4bb8a-4b7b-4245-832f-a1995076b6b1` (confirmed).
Root plan: `PLAN.md` at the repository root.

## Problem

Every tmux invocation in the product resolves its server from ambient
environment (`TMUX_TMPDIR`, `TMUX`, or the platform default
`/tmp/tmux-$(id -u)/default`). Nothing records which server a run was actually
created on. `RunManifest` persists only a session *name* (`tmuxSession`), which
is meaningless without the socket it lives on. A launcher run started under one
ambient socket and a control-plane consumer run under another look at two
different servers, and the consumer concludes the session does not exist.

### The product has no socket identity at all

`grep -rn '"-S"' --include='*.ts' src` in `loop-fork/` returns nothing,
re-derived in this worktree at base `ddf134b9`. The only socket isolation
anywhere in the repository is a test-only PATH shim,
`evals/smoke/fixtures/isolated-tmux.sh`, which injects
`-L "${LOOP_SMOKE_TMUX_SOCKET}"` ahead of the product's own argv. Production
code has no socket concept.

### The ambient split is a destructive fail-open, not just a bad read

Three consumers convert "not on *my* ambient server" into a positive
dead/absent verdict and then act on it:

1. `loop-fork/src/loop/claude-config-gc.ts:72` `defaultTmuxSessionAlive`
   returns `false` — not `undefined` — whenever `tmux has-session` exits
   nonzero. Only a `signalCode` (timeout) yields `undefined`. A live run on
   another socket therefore reads as dead, and its Claude config is garbage
   collected out from under it.
2. `loop-fork/src/loop/run-process-cleanup.ts:93` `defaultListTmuxSessions`
   maps stderr containing `no server running` to an **empty set**, i.e. "there
   are no tmux sessions at all". Every loop run then looks orphaned and its
   processes become eligible for cleanup while the real sessions are alive on
   the other socket.
3. `loop-fork/src/loop/tmux-control.ts:43,64` `tmuxSessionLiveness` /
   `tmuxSessionLivenessAsync` return `"dead"` on any nonzero exit. That feeds
   `launch-reservation.ts:99-110,202-208` (the active-launch interlock, which
   then admits a second concurrent launch against a live workspace) and
   `codex-tmux-proxy.ts:219-248` (which shuts the proxy down with
   `reason: "dead-tmux"` while the workspace is still running).

`panel.ts:848` (`list-sessions`) and `governess-replay.ts:64` (`list-panes`)
have the same blindness in the read-only direction. `panel.ts:1169` and
`tmux.ts:3602,4024` print `tmux attach -t <session>` with no socket, which is
exactly the non-attachable instruction the defect names.

### Consumer inventory (derived, not hand-listed)

`grep -rEn '(\[|\()\s*"tmux"' --include='*.ts' src | sed 's/:[0-9]*:.*//' | sort -u`
yields exactly ten files that build a tmux argv, re-derived in this worktree:

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

The argv inventory is necessary but not sufficient. Files that consume or
publish a bare session identity are also seams.
`grep -rln 'tmuxSession\|tmux_session' --include='*.ts' src` yields thirteen
files — the ten above minus `install.ts`, plus `bridge-store.ts`,
`codex-tmux-proxy.ts`, `launch-reservation.ts`, `paired-options.ts`, and
`run-state.ts`. `BridgeStatus` publishes only `tmuxSession`.

A second, differently named seam does not appear in that grep at all:
`governess-handoff.ts:38,224,244`, `governess-exit.ts:14,60-63,96`, and
`governess-replay.ts:307` carry `replacementSession: string`, a bare replacement
session name with no socket. `governess-exit.ts:87` even reports
`"replacement session was not persisted"` as the only failure mode, so a
*persisted* name is treated as sufficient identity.

A third convention is bare positional `session: string` on shared APIs, which no
field-name grep finds: `tmux-control.ts:44,65`, `panel.ts:37,70,756`,
`paired-options.ts:64`, `governess-pane-liveness.ts:44,50,61,180`,
`governess.ts:283`, `governess-exit.ts:28`, and roughly a dozen sites in
`tmux.ts` (`1070,1088,1112,1127,1140,1364,1405,1663,1696,1795,1831,1884,1895,1936,3123,3916`).
These are the APIs R3 forbids from accepting a bare session.

**Fourth, and not previously identified: pane identity is persisted too, and has
the same defect.** `run-state.ts:124-132` and `217-225` persist
`tmuxPaneAuPair`, `tmuxPaneGoverness`, `tmuxPaneLeft`, `tmuxPaneNanny`,
`tmuxPaneRecon` (a `string[]`), `tmuxPaneRight`, and `tmuxPaneUtility` beside
`tmuxSession`. A pane target is as socket-dependent as a session name, so all
seven fields are in scope for atomic clearing and revalidation (R10).

Deliberately **out** of scope after checking: `sessionRef`
(`governess.ts:214,381,390`, `governess-usage.ts:586,890,917`,
`memory-checkpoint.ts:71`) is documented at `governess.ts:213` as the
"Session id / thread id used to locate the agent's usage transcript" — an LLM
transcript reference, not a tmux session. It is not migrated.

Four naming conventions, three of which a field-name grep misses, and one seam
(the seven persisted pane fields) that was not identified until a fourth sweep.
That is the argument for the design below: the migration is enforced by a
**derived** check that reads the source, never by any of these lists.

### Measured, not assumed

Four claims this spec depends on were measured in an isolated temporary root
before approval, rather than cited from documentation. Producer: `tmux 3.7b` on
Darwin, ambient `TMUX` unset, every server addressed by an explicit socket path
and killed by that same path; cleanup reported zero survivors.

| Claim | Command | Observed |
|---|---|---|
| `-S` beats `-L` | `tmux -L <label> -S <path> start-server` | `<path>` created; the label-derived path was never created at all. **The shim-defeat hazard is real.** |
| `$TMUX` layout | read `$TMUX` inside a session on a known socket | `<socket>,<pid>,<session-index>` — exactly three fields, so removing the final two recovers the socket |
| Comma in socket pathname | same, with socket `…/so,ck-c` | four fields; parse-from-right returns `…/so,ck-c`, while taking the **first** field truncates it to `…/so` |
| Darwin `sun_path` budget | `tmux -S <path> start-server` at increasing byte lengths | 103 bytes succeeds; 104 fails with `error connecting to … (File name too long)` |

Two consequences are load-bearing rather than cosmetic. First, parsing `$TMUX`
from the right is **required**, not merely tidy: the naive first-field parse was
observed to silently truncate a legal socket pathname, which would send the run
to a different — and creatable — socket. Second, the 103-byte Darwin figure in
R5 is now an observation with a reproducing command, not a citation.

The Linux `sun_path` limit (107) remains **unmeasured** here; this host is
Darwin. R5 keeps it as a platform constant and verify 2 covers it by
construction, but it is labelled inference until a Linux run confirms it.
Peer review accepted this as a labelled inference at the approval gate, on the
grounds that the Darwin measurement is real and the platform limit is
parameterized rather than hard-coded: the Linux figure is carried as an explicit
platform-override unit-test fact, and a host probe is added when a Linux host is
available. It does not block the gate.

### What this is not

- Not the `install.ts` symlink-output defect, which is separately assigned.
- Not a change to how the smoke harness isolates itself for convenience: the
  shim migration is in scope only because emitting `-S` **defeats** the
  existing `-L` shim, which would silently point the smokes at the operator's
  real tmux server.

## Goal

A run's tmux server is an explicit, validated, persisted absolute socket path
resolved once at launch. Every later consumer targets that recorded socket
instead of re-deriving one from its own environment, and a target that cannot
be identified is `unknown` and blocks destructive action rather than being
treated as dead.

## Requirements

1. **Persisted socket identity.** `RunManifest` / `RunManifestInput` gain
   `tmuxSocket?: string`, an absolute filesystem path passed as
   `tmux -S <path>`. Reads accept `tmuxSocket` and `tmux_socket`; writes are
   canonical `tmuxSocket`. Empty, relative, NUL-containing, over-budget, or
   conflicting camel/snake values are unusable identity and enter the same
   observable unknown path as a missing legacy value. They are never resolved
   relative to a consumer's cwd.

2. **Absolute `-S` path, never `-L` label.** `-L` is re-resolved against
   `TMUX_TMPDIR` at every invocation, so a label remains ambient-dependent and
   does not close the defect. `-S` is the only fully explicit form.

3. **One chokepoint, and composition is target-bound.** New module
   `loop-fork/src/loop/tmux-socket.ts` owns: `resolveTmuxSocket(env)`; a branded
   validated absolute socket value; an **opaque** `TmuxTarget` identity carrying
   `{ socket, session }`; the three exported composition functions below;
   `tmuxAttachCommand(target)` as the only attach-hint formatter, shell-escaping
   both socket and session; and `TmuxSocketUnknownError` as the fail-closed
   signal.

   **Socket-only composition is private, because a valid socket is not a bound
   one.** A helper of the shape `tmuxArgv(socket, args)` is a loose seam: the
   socket brand proves the path is well-formed, not that it belongs to the run
   whose session appears in `args`. `tmuxArgv(socketB, ["has-session", "-t",
   sessionA])` type-checks and crosses servers. That helper therefore survives
   only as a module-private implementation detail and is **not exported from the
   production entrypoint**. The exported composition surface is target-bound and
   supplies every target-naming flag itself, so no caller ever writes one:

   | Exported form | Emits | Caller supplies |
   |---|---|---|
   | `targetArgv(target, verb, args?)` | `["tmux", "-S", target.socket, verb, "-t", target.session, ...args]` | verb and non-target flags only |
   | `paneArgv(ownedPane, verb, args?)` | the same, with the `-t` value taken from the pane's owning handle (R10) | verb and non-target flags only |
   | `serverArgv(target, verb, args?)` | `["tmux", "-S", target.socket, verb, ...args]`, for server-scoped verbs that name no session | verb and non-target flags only |

   Each rejects an `args` array containing `-S`, `-t`, `-s`, or their
   `=`-joined forms, at runtime and by the derived check (R12), so a second
   target cannot be smuggled past the composition boundary. Each returns an
   argv splittable into Node `spawn` command/args without dropping `-S`. Every
   server-contacting invocation routes through one of these three. Shared
   liveness/control APIs accept only a `TmuxTarget` or an `OwnedPaneTarget`,
   never a bare session, never a loose socket plus session pair, and never a
   socket plus a caller-supplied `-t`.

   **A validated socket is not a provenance guarantee, so provenance is carried
   by a handle rather than promised in prose.** Pairing a *valid* socket brand
   with the wrong run's session, or with a socket sourced from hostile ambient
   state, still crosses servers and is caught by neither branding nor the
   derived checker — a static check cannot prove runtime provenance. So
   `TmuxTarget` has **no public constructor**, and its only production
   constructor is `targetFromManifest(handle)`, which takes exactly one
   argument: an opaque `ManifestHandle`.

   `ManifestHandle` is produced only by the manifest read path in
   `run-state.ts`, which stamps it at read time with a module-private brand
   carrying the `runId`, the manifest pathname, and the SHA-256 of the bytes
   actually read. The handle is frozen. A hand-assembled plain object carries no
   brand, so it is a compile-time error (the brand is a unique symbol that is
   not exported) and a runtime `TmuxTargetProvenanceError`. Because
   `targetFromManifest` has exactly one parameter, and no socket parameter
   exists anywhere in the public surface, a target combining run A's session
   with run B's socket is **not constructible through the API at all**. That
   unconstructibility, not a runtime comparison, is the mechanism that makes
   verify 5's wrong-run assertion satisfiable rather than aspirational. A
   test-only constructor, if it exists, is not exported from the production
   entrypoint.

   Stated plainly and deliberately not promised: a manifest whose *recorded*
   socket does not match the server its run actually lives on is outside this
   mechanism's reach. The manifest is the source of truth by design (R6), so no
   in-product check can distinguish a legitimately recorded socket from an
   edited one without a second source of truth this defect does not create.
   What is enforced instead, and asserted: ambient state can never rewrite an
   existing socket-bearing manifest (R6), and a manifest whose socket is
   unusable is `unknown`, never `dead` (R7). Verify 5 asserts the
   constructibility bound and the cross-run non-contact behaviour, and records
   this residual rather than claiming a rejection the product cannot perform.

   `install.ts`'s bounded `tmux -V` is not a server consumer and is the sole
   audited direct-invocation exception, matched by exact path **and** exact
   argv, not by filename alone.

4. **Launch-time resolution precedence.** Resolved once per run, then
   persisted: (a) `LOOP_TMUX_SOCKET`, which must be absolute — a relative value
   is a hard launch error, never silently resolved; (b) `$TMUX` when set, whose
   socket path is parsed by removing the final two comma-delimited tmux
   metadata fields. Parsing from the right is **required, and measured**: with a
   socket pathname containing a legal comma, the first-field parse was observed
   to truncate `…/so,ck-c` to `…/so`, which is itself a creatable socket path,
   so the run would silently target a different server. A malformed, relative,
   or empty parse is a hard launch error rather than permission to fall back to
   another server; (c) otherwise
   `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/default`, then resolved to an absolute
   path. Rule (c) preserves an operator's intentional `TMUX_TMPDIR` export: the
   choice is honoured, then frozen and recorded instead of re-read by every
   later consumer.

5. **Bounded socket pathname.** Socket paths are bounded by platform
   `sun_path`: 103 usable pathname bytes on Darwin (**measured**: 103 starts a
   server, 104 fails `File name too long`), 107 on Linux (**inference**, not
   measured on this host), after the terminating NUL. Validation uses UTF-8 byte
   length, not JavaScript character
   count, rejects embedded NUL, and reports byte length with the platform
   limit. Resolution fails before manifest reservation or tmux creation, so no
   durable active-looking run is created with an unusable socket.

6. **Resolve once, never re-derive; after launch the manifest is the only
   source of a target.** Fresh launches resolve before the early manifest
   binding and persist the socket together with the deterministic session
   identity. Resume/reattach and every hidden control-plane command obtain their
   target **only** through `targetFromManifest(handle)` (R3), applied to a
   `ManifestHandle` the manifest read path produced, and ignore later
   `LOOP_TMUX_SOCKET`, `TMUX`, and `TMUX_TMPDIR`. Because the handle is the only
   admissible input, a post-launch consumer has no way to name a socket at all:
   it cannot supply one, so it cannot re-derive one. `resolveTmuxSocket` is a
   launch-time function and must not be reachable from any post-launch consumer
   path. An existing socket-bearing manifest is never overwritten from current
   ambient state.

7. **Fail closed on ambiguous legacy targeting.** A manifest with `tmuxSession`
   but no usable `tmuxSocket` is ambiguous, not implicitly ambient. Liveness
   readers return `"unknown"`, never `"dead"`. `claude-config-gc` and
   `run-process-cleanup` treat `undefined`/`unknown` as do-not-touch and skip.
   `launch-reservation` refuses the launch. Bridge delivery stays durably
   queued and issues no tmux command. Governess does not respawn, send, replay,
   tear down, or accept a handover from session-only evidence. The proxy
   receives the manifest target and is preserved on unknown. This covers reads
   and effects alike: `has-session`, `list-panes`, `capture-pane`, `send-keys`,
   buffer operations, pane respawn, session kill, attach, proxy shutdown,
   stale-state clearing, and handover/replacement probes.

8. **Every fail-closed skip is observable, through a specified schema and an
   injected sink.** A skip is a fail-open unless it is recorded, and an
   unstructured log line is not a record: it is untestable and can vanish in
   production without any check noticing. Each skip emits a structured
   `TmuxSkipRecord` with at least:

   | Field | Meaning |
   |---|---|
   | `consumer` | Which consumer skipped, as a stable identifier |
   | `runId` / manifest identity | Which run was not touched |
   | `session`, `pane` | If known; explicitly absent otherwise |
   | `socketState` | `missing`, `invalid`, `conflicting`, or `unknown` |
   | `reason` | Why the target could not be identified |
   | `effectSkipped` | The concrete effect that did **not** happen |

   Records go to an **injected recorder/event sink**, not to ambient logging, so
   every consumer's records are observable in test without reading stdout.
   Verify 8 and verify 10 assert the exact records per consumer, by field, not
   merely that "something was logged".

   **Why the sink must not be rendered pane text.** Observed during this run and
   supplied by the supervisor as defect evidence: rendered composer text was
   read as a real pending instruction by both an automated monitor and a human,
   when it was in fact type-ahead *suggestion* text derived from an agent's own
   earlier output. A typed character replaced it rather than appending, and it
   reappeared whenever the composer was empty. A one-character probe
   distinguishes a ghost suggestion from real content; reading the rendered
   surface alone does not. The transferable rule for this spec is narrow and
   binding: **a skip record must be a structured event emitted at the decision
   point, never a state inferred by scraping rendered terminal output.** Any
   verification that reads a pane to decide whether a skip happened is invalid
   under R8.

   Scope boundary, stated so this does not creep: the bridge queue-to-seat
   non-delivery and injection-submit strand defects that produced this evidence
   are **separate defects and are not fixed here**. They are cited only for the
   observability constraint above.

9. **Server-scoped enumeration.** `run-process-cleanup` no longer compares
   every manifest against one ambient server-wide set of session names. It
   groups valid manifests by socket (or probes each `TmuxTarget`), keys results
   by `(socket, session)`, treats a command failure as unknown for the affected
   targets only, and preserves every missing/invalid-socket manifest with an
   observable reason. The same session name on two sockets is not a collision.
   Panel enumeration uses only the deduplicated set of valid socket paths found
   in run manifests; it does not add an ambient default, because that would
   reintroduce guessing and cannot recover a legacy session's identity. One
   failed socket query does not erase rows from other known sockets and is
   surfaced as partial/unknown evidence.

   **Rows are manifest-backed, always.** "Legacy row" means a row backed by a
   manifest that has no usable socket, rendered unknown and non-attachable. It
   never means a row discovered by querying an unknown server — no such query is
   ever issued, which is why valid-socket-only enumeration and legacy rows do
   not conflict. The enumeration set and the row set are derived from different
   things: the set of *sockets to query* is the valid sockets only, while the
   set of *rows to render* is every manifest, including those with no usable
   socket.

   Three row states, stated so none is left to implementation choice:

   | Manifest state | Server says | Row |
   |---|---|---|
   | Valid socket | Session present | Live, with a qualified attach command |
   | Valid socket | Session **absent** | **Retained** and rendered `dead`. The socket was known and the query succeeded, so absence is real evidence, not ambiguity. The row is never omitted, because silently dropping it hides a run that ended |
   | No usable socket | Not queried | Retained and rendered `unknown`, non-attachable |

   A failed query against a valid socket yields `unknown` for that socket's rows
   only, never `dead`, and never affects another socket's rows.

10. **Secondary identity seams migrate too.** `BridgeStatus` carries
    `tmuxSocket`/known-target state alongside `tmuxSession`. Governess handover
    state and replay carry or resolve the replacement target's socket rather
    than persisting/probing a bare replacement session name, at all three sites
    (`governess-handoff.ts`, `governess-exit.ts`, `governess-replay.ts:307`).
    Pane ownership revalidation includes socket as well as session and pane.
    Clearing stale tmux topology clears `tmuxSocket` **atomically** with
    `tmuxSession` and with all seven persisted pane fields —
    `tmuxPaneAuPair`, `tmuxPaneGoverness`, `tmuxPaneLeft`, `tmuxPaneNanny`,
    `tmuxPaneRecon`, `tmuxPaneRight`, `tmuxPaneUtility` — on both the
    `RunManifest` and `RunManifestInput` declarations. A partial clear that
    leaves a pane target bound to a cleared socket is a new instance of this
    same defect and must fail the check.

    **Pane subordination is enforced by type, not by caller discipline.** The
    persisted pane fields deliberately do *not* become standalone
    socket-qualified strings. A pane ID is meaningful only within a
    `(socket, session)`, so it is subordinate to that pair rather than a third
    independent identity. But stating that "every pane operation derives its
    target from the same manifest" is caller discipline, and caller discipline
    is not enforcement: a signature of the shape
    `(target: TmuxTarget, paneId: string)` still permits pairing target A with
    pane B, which is the same cross-run defect one level down.

    So pane identity gets its own opaque handle. `OwnedPaneTarget` has **no
    public constructor**. Its only production constructor is
    `paneTargetFromManifest(handle, field)` in `tmux-socket.ts`, which reads the
    named pane field from the *same* `ManifestHandle` that yields the
    `TmuxTarget` (R3), and which yields nothing when that handle's socket or
    session is unknown — so a pane field cannot be reached without its owning
    target, and a cleared socket makes every pane field on that manifest
    unreachable by construction. Every pane-effecting API — pane respawn,
    `send-keys`, `capture-pane`, buffer operations, pane liveness, and pane kill
    — accepts only an `OwnedPaneTarget`. A bare `paneId: string`, or a
    `(TmuxTarget, paneId)` pair, on any pane-effecting signature is a
    compile-time impossibility and a derived-check violation (R12). Pane
    composition goes through `paneArgv` (R3), which supplies the pane's `-t`
    value from the handle, so no caller writes a pane target flag either.

> **HARNESS-OWNER RULING, 2026-08-08 (run 14, bridge message
> `cc04ed1b-3273-4315-89d7-12749b5ef972`).** The sole constructor takes an
> optional index: **`paneTargetFromManifest(handle, field, index?)`**. For a
> scalar pane field `index` must be **absent**, and supplying one fails closed.
> For the one array-valued field `tmuxPaneRecon`, `index` is **required** and
> must be a non-negative integer in bounds; any missing, malformed, or
> out-of-range case yields no target plus the required structured skip evidence
> at the consumer. The returned opaque target stays bound to the same
> `ManifestHandle`-derived socket, session, and pane. There is still exactly one
> producer, and no public socket-only or session-plus-pane composition seam.
> This resolves the gap that R10's two-parameter shape could not address the
> Nth recon pane. Decided by the harness owner, who owns this defect and its
> release path; it is not a product-supervisor decision.

    Atomic clearing above remains required, but it is now the second line of
    defence rather than the only one. Under the old prose invariant it was a
    half-measure that left the defect reachable through the pane path whenever a
    caller failed to follow it; under `OwnedPaneTarget` that caller does not
    compile.

11. **Attach hints are qualified or absent.** All attach hints and interactive
    attach argv include shell-safe `-S <socket> -t <session>`. Spaces and shell
    metacharacters round trip as data. A legacy manifest prints an explicit
    unknown-socket line and no attach command, rather than a command that
    silently targets the wrong server.

12. **Derived migration enforcement.** `scripts/` gains a check that catches
    Bun-array (`["tmux", ...]`) and Node command/args (`spawn("tmux", [...])`)
    direct invocations, bare-session calls to the shared liveness API, and
    unqualified attach formatters. Three further rules enforce the API shapes
    R3 and R10 introduce, because an unexported symbol and an opaque handle are
    only as good as the boundary that keeps them that way:

    | Rule | Fails on |
    |---|---|
    | Private composition stays private | any import or re-export of the module-private socket-only `tmuxArgv` outside `tmux-socket.ts`, including a barrel re-export |
    | No caller-written target flags | a `-S`, `-t`, `-s`, or `=`-joined target flag appearing in an argv array literal anywhere outside `tmux-socket.ts` |
    | No unowned pane identity | a pane-effecting signature that accepts a bare `string` pane id, or a `(TmuxTarget, paneId)` pair, instead of an `OwnedPaneTarget` |

    Each of the three is proven non-vacuous by its own seeded violation, on the
    same terms as the rules below. It is wired into `scripts/verify.sh`. The
    exact bounded `install.ts` `tmux -V` probe is the only accepted exception,
    and a second direct invocation in `install.ts` must still fail the check.
    Non-vacuity is proven by seeding each violation form in a temporary source
    tree, never by editing tracked source.

13. **Smoke shim migration lands in the same change.** Once the product emits
    `-S`, tmux receives both `-S` and `-L` and resolves `-S`, so the existing
    shim is silently defeated and the smokes would touch a shared server. All
    smoke call sites move from label-valued `LOOP_SMOKE_TMUX_SOCKET` / the `-L`
    shim to setting product `LOOP_TMUX_SOCKET` to an absolute socket path and
    using real `tmux -S` for inspection and cleanup. The `-S`-over-`-L`
    precedence is verified empirically, not assumed from documentation.

14. **Producer-backed two-server regression.** A single-server test cannot
    observe this defect at all — that is precisely why it shipped. Certification
    creates two real tmux servers A and B with a same-named decoy session on B,
    launches the real run on A with the compiled product, and drives the
    consumer matrix under hostile B ambient state.

15. **Fixture provenance.** New-path integration evidence comes from the
    compiled product producer and records binary SHA-256, tmux version, capture
    command, UTC time, environment, and manifest SHA-256. Legacy fixtures are
    generated deterministically by removing only `tmuxSocket` from producer
    output and record source and derived hashes. Hand-authored fixtures cannot
    certify this seam.

16. **Trap-safe cleanup with a non-vacuous zero-survivor proof.** The cleanup
    trap is installed before any server or process is created and runs on
    success, assertion failure, and signal. Recorded PIDs are polled with a
    bounded deadline after teardown. The proof fails when nothing was recorded,
    and a positive control demonstrates survivor detection before real cleanup.

17. **Bounded-control timeout semantics are preserved.** Timeout and error
    remain `unknown`, interactive attach alone remains unbounded, and every
    non-interactive tmux command keeps a finite kill-on-timeout bound.

18. **No collateral change.** `install.ts` output and symlink behavior are
    byte-for-byte unchanged outside the patch. Product `loop-fork/runs/` is not
    modified and has pre/post no-mutation evidence. Harvto is not inspected,
    addressed, signalled, or mutated.

## Acceptance criteria

> **Two numbered lists exist in this bundle and they are not the same list.**
> The requirements above are cited as **R1–R18**. The checks in `verify.md` are
> cited as **1–18**. They are the same *count* by coincidence of scope, not by
> index: R10 (secondary identity seams) is proven by verify 3, verify 8, and
> verify 10, while verify 10 (legacy targeting is `unknown`) proves R7 and R8.
> Always cite an anchor as `R<n>` or `verify <n>`, never a bare number — this
> sentence included. Verify 5 has lettered parts 5a/5b/5c; cite the letter when
> the part matters.

Every requirement is proven by at least one check, and every check proves at
least one requirement:

| Acceptance criterion (verify check) | Proves |
|---|---|
| 1 — Resolution precedence; comma-preserving `$TMUX` parse | R4 |
| 2 — Invalid/over-budget values fail before reservation or tmux creation | R5, R4 |
| 3 — Manifest round trip preserves canonical `tmuxSocket`; pane subordination is enforced by type | R1, R10 |
| 4 — Producer-backed launch writes the exact socket A path, bound early | R6 |
| 5 — Resume uses the persisted socket; legacy blocks resume and duplicate; wrong-run pairing is unconstructible | R3, R6, R7 |
| 6 — Derived migration checks pass and are proven non-vacuous | R3, R12 |
| 7 — Two-server regression: consumers reach only A under hostile B state | R14 |
| 8 — Per-consumer matrix assertions, not one shared-helper assertion | R3, R10 |
| 9 — Destructive direction: no A-side effect from B-derived evidence | R7 |
| 10 — Legacy/invalid targeting is `unknown` everywhere, with skip records | R7, R8 |
| 11 — Enumeration keys by `(socket, session)` | R9 |
| 12 — Attach hints qualified and shell-safe; legacy prints unknown | R11 |
| 13 — `-S` over `-L` precedence verified; smoke call sites migrated | R2, R13 |
| 14 — Fixture provenance recorded; legacy fixtures derived, not authored | R15 |
| 15 — Trap-safe cleanup records and kills everything it created | R16 |
| 16 — Zero-survivor proof is non-vacuous with a positive control | R16 |
| 17 — Bounded-control timeout semantics unchanged | R17 |
| 18 — `install.ts` byte-identical outside the patch; no run mutation | R18 |

Checklist form for the evaluator:

- [ ] 1 — Resolution precedence and comma-preserving `$TMUX` parsing.
- [ ] 2 — Invalid/over-budget values fail before reservation or tmux creation.
- [ ] 3 — Manifest round trip; pane subordination enforced by `OwnedPaneTarget`.
- [ ] 4 — Producer-backed launch writes the exact socket A path, bound early.
- [ ] 5 — Resume uses the persisted socket; legacy blocks resume and duplicate;
      5a unconstructible wrong-run pairing, 5b cross-run non-contact,
      5c residual recorded.
- [ ] 6 — Derived migration checks pass and are proven non-vacuous.
- [ ] 7 — Two-server regression: consumers reach only A under hostile B state.
- [ ] 8 — Per-consumer matrix assertions, not one shared-helper assertion.
- [ ] 9 — Destructive direction: no A-side effect from B-derived evidence.
- [ ] 10 — Legacy/invalid targeting is `unknown` everywhere, with skip records.
- [ ] 11 — Enumeration keys by `(socket, session)`.
- [ ] 12 — Attach hints qualified and shell-safe; legacy prints unknown.
- [ ] 13 — `-S` over `-L` precedence verified; smoke call sites migrated.
- [ ] 14 — Fixture provenance recorded; legacy fixtures derived, not authored.
- [ ] 15 — Trap-safe cleanup records and kills everything it created.
- [ ] 16 — Zero-survivor proof is non-vacuous with a positive control.
- [ ] 17 — Bounded-control timeout semantics unchanged.
- [ ] 18 — `install.ts` byte-identical outside the patch; no run mutation.

Screenshot/DOM assertions are **not applicable**: panel rows and attach hints
are terminal output with no DOM, and `scripts/capture-ui.sh` cannot capture
them. Verification uses exact render assertions plus `tmux capture-pane`
evidence, consistent with existing terminal-pane verify contracts in this
repository.

## Scope

- `loop-fork/src/loop/tmux-socket.ts` (new), and the migration of the ten
  argv-building files plus the identity-seam files listed above.
- `loop-fork/src/loop/run-state.ts` manifest schema, read, and write paths.
- `loop-fork/tests/` focused and consumer regressions.
- `evals/smoke/tmux-socket-normalization.sh` (new) and migration of existing
  smoke isolation call sites.
- New derived migration-check script under `scripts/`, wired into
  `scripts/verify.sh`.
- `docs/dependency-map.md` refresh.
- `specs/tmux-socket-normalization/` and `runs/tmux-socket-normalization/`.

## Non-goals

- The `install.ts` symlink-output defect. Assigned to a future governed loop.
- Any change to install output, alias, symlink, or copy behavior.
- Recovering the socket identity of a run that was launched before this change.
  Such runs are deliberately unmanageable by the new binary until they exit;
  that is the safe direction and is a visible behaviour change (see Open
  questions).
- Modifying product `loop-fork/runs/`. Root `runs/tmux-socket-normalization/`
  is task evidence required by governance.
- Harvto. Not inspected, addressed, signalled, or mutated.

## Out-of-scope risks

- **Smoke shim defeat (highest).** If R13 is missed, the smokes
  silently start using the operator's real tmux server. Mitigated by asserting
  the socket file the smoke created is the one the product actually used.
- **Panel under-scoping.** Enumerating only manifest sockets could hide a run
  whose manifest is unreadable; adding ambient scope would guess and can merge
  same-name sessions. Same-name A/B tests cover both errors.
- **Socket path length.** Long `/private/tmp/...` worktree paths plus a socket
  suffix approach the Darwin limit; R5 fails early rather than at
  first connect.
- **Manifest forward-compatibility.** The installed v1.0.38 binary observed on
  2026-08-09 (SHA-256 `88dcfe2d…`) successfully read a copied non-product
  manifest containing `tmuxSocket`: `governess doctor 1` exited zero, reported
  `checks.manifest: true`, and preserved the fixture byte-for-byte. The check
  used isolated HOME and tmux roots; it did not read or contact a live run.
- **Handover identity drift.** Replacement sessions currently persist only a
  name; if launch and observer sockets differ, replay can accept or kill the
  wrong server.

## Resolved questions

Both questions that were open at authoring are now answered by peer review.
Recorded here rather than deleted, so the decision and its reasoning survive.

- [x] **Panel scope — RESOLVED: enumerate only valid manifest sockets, never the
      ambient default.** Peer review agreed: adding the ambient default would
      reintroduce guessing and can merge same-name sessions. The apparent
      conflict between "valid sockets only" and "legacy rows" was a wording
      defect, not a design one, and is resolved in R9: the set of sockets to
      *query* is the valid sockets, while the set of rows to *render* is every
      manifest. Row behaviour for a known manifest whose session is absent is
      now specified (retain, render `dead`) rather than left to implementation.

- [x] **Legacy manifest disposition — RESOLVED: fail closed, no recovery.**
      Peer review agreed with the direction and confirmed supervisor/human
      approval is a sufficient gate. Recorded policy:
      - A run launched before this change is **not recoverable** by the new
        binary. There is no ambient-socket inference for resume, attach, GC,
        cleanup, bridge delivery, proxy liveness, or handover.
      - **Support impact:** such a run continues executing normally — nothing
        kills it — but the new binary will not manage it. The operator's path is
        to let it exit, or to attach manually using a socket they identify
        themselves. This is a visible behaviour change for in-flight runs and
        requires explicit human acknowledgement at the approval gate.
      - This is the safe direction precisely because the alternative — guessing
        an ambient socket — is the defect being fixed.

## Open questions

- [ ] **Human approval of the recorded legacy-manifest support impact above.**
      Peer review is satisfied; this needs the founder/supervisor sign-off that
      the in-flight-run behaviour change is acceptable.


## Harness-owner rulings during implementation (run 14)

> **HARNESS-OWNER RULING, 2026-08-08 (run 14, bridge messages
> `7be19de0-8312-4976-a984-1c24d7ce3e75`, superseded by
> `6ab87ddc-605a-49bc-a7da-aee51aea6bb6`, `414232c9-aee3-4351-8084-e860ddc27796`,
> and `1b3caebf-a9fe-4a62-a892-c0296b732e23`).** Central `tmux-control.ts` now
> returns `"unknown"` for an absent session, but consumers reproduce the defect
> inline, so the central fix does **not** close verify 10.
>
> **No automated rule is added.** A literal `: "dead"` source pattern is a
> blacklist and is explicitly withdrawn: it misses `liveness = "dead"` and
> `? "dead"`, which is exactly how this inventory was first mis-derived as five
> sites instead of six. A value-flow rule must **not** be claimed either, because
> the current checker surface is not an AST/type-flow analyzer and cannot prove
> `TmuxLiveness` production or confirmed-missing evidence. Letting either form
> certify six-site completeness would be coverage that does not exist.
>
> **Recorded limitation.** The derived check does **not** provide full semantic
> coverage for arbitrary `TmuxLiveness` value production. This limitation is
> recorded here, in verify 6, and in the eval notes.
>
> **The honest alternative, which is what is required:** an explicit per-band
> checklist with **named per-site tests**. Each site below must be migrated to
> `"unknown"` and asserted by its own named test in its own band:
>
> | Site | Band |
> |---|---|
> | `governess-replay.ts:326` | T-10 |
> | `bridge-runtime.ts:1105` | T-06 |
> | `launch-reservation.ts:121` | T-08 |
> | `launch-reservation.ts:224` | T-08 |
> | `codex-tmux-proxy.ts:908` | T-08 |
> | `paired-options.ts:75` | T-08 |
>
> Six sites, confirmed. Any shorter file list in an earlier message was
> illustrative, not exhaustive. `paired-options.ts:75` is included and needs a
> different fix from the other five: it is already guarded against the
> absent-name case and already throws on `"unknown"`, so what remains is that
> `sessionProbe` is socket-blind and a `false` result can mean "found nothing on
> the wrong server".
>
> **`tmux.ts:1102` is excluded and is the positive model.** Its
> `isConfirmedMissingTmuxSession(stderr, …) ? "dead" : "unknown"` predicate is
> the required shape: a confirmed-missing session read from real server output
> is evidence; an absent session *name* is not. `"dead"` grants cleanup
> authority, so only confirmed evidence may produce it.
>
> **If** T-11 later introduces a real AST/type-flow analyzer, it must state its
> method, catch assignment / ternary / alias forms, include independently
> seeded indirect cases, and be reviewed separately before any completeness
> claim rests on it.
>
> Verify 10 remains **open** pending the per-consumer fixes and their skip
> records across T-06, T-08, and T-10.


> **HARNESS-OWNER RULING, 2026-08-08 (run 14, bridge message
> `c3385227-657c-4f03-b2d5-4ad825ab2801`) — T-05 SCOPE EXTENSION: non-paired
> `--tmux` launches.** A `--tmux` launch without `--paired` creates a tmux
> session but has **no run manifest**, so it has no recorded socket and no
> target. Leaving its attach hint unqualified violates verify 12 and R3, and
> emitting the legacy unknown-socket line for it would be **false** — nothing
> was "recorded before socket normalization"; that path never had a manifest.
> Inventing a third hint state is also rejected.
>
> **Required behaviour.** The non-paired launch resolves its socket **once**,
> **before** the session is created or any tmux server is contacted, and carries
> that launch-time socket identity forward. It need **not** invent a manifest;
> the existing non-paired lifecycle is preserved.
>
> **Acceptance criteria.**
> 1. Resolution happens exactly once, before session creation/contact.
> 2. The **same** `-S <socket>` is used for session creation and for the
>    emitted attach hint — one resolved value, not two derivations.
> 3. Hostile ambient state (`LOOP_TMUX_SOCKET`, `TMUX`, `TMUX_TMPDIR`) cannot
>    change the identity after resolution.
> 4. Resolution failure and unknown remain **explicit** — never a silent bare
>    hint, and never the legacy-manifest wording.
> 5. Producer-path tests, including the existing non-paired launch test and a
>    **hostile-ambient decoy** assertion proving the hint still carries the
>    resolved socket.


> **HARNESS-OWNER RULING, 2026-08-08 (run 14, bridge message
> `5a7e6cd3-1216-487c-84f3-ddbcfd371a11`) — LAUNCH-WINDOW COMPOSER, narrow
> exception to R3.** Implementing the non-paired option-A ruling exposed a
> contradiction: the non-paired path holds a resolved socket but has **no
> manifest**, therefore no `TmuxTarget`, while every exported composer is
> target-bound and an inline `-S` argv literal is barred by R12. As written,
> R3/verify 5a forbid both escapes. This amendment authorises exactly one.
>
> **Authorised (A2, narrowed).** A **dedicated launch-only composer** — not a
> generic socket-only seam — accepting the already validated and resolved
> `TmuxSocket` plus the non-paired session identity. It may be used **only
> before a manifest-backed target exists**.
>
> **Rejected (A1).** Minting a `TmuxTarget` outside the manifest read path is
> rejected: it would weaken provenance and create a third target producer,
> contradicting verify 5a's constructibility bound.
>
> **Invariants preserved, explicitly.**
> - `targetFromManifest` remains the **sole** post-launch `TmuxTarget` producer.
> - `targetArgv`, `paneArgv`, and `serverArgv` all remain target-bound.
> - No caller-written target flags; the composer supplies them.
> - No ambient re-resolution: the socket is resolved once and reused.
>
> **Acceptance criteria.**
> 1. Non-paired session creation **and** its attach hint are composed from the
>    **same** resolved value — one resolution, two consumers, not two
>    derivations.
> 2. The composer is unreachable from, and unimported by, every post-launch
>    consumer.
> 3. A derived/import-scope assertion, or an explicit named restriction, proves
>    the launch-only composer is not used after a manifest-backed launch.
> 4. Hostile ambient state cannot change the identity after resolution.
> 5. Resolution failure and unknown remain explicit — never a silent bare hint,
>    never the legacy-manifest wording.
>
> Bundle amended **before** any source change, per the ruling.
