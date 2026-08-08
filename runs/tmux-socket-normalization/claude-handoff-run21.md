# Claude reviewer handoff — Run 21 (agents-collab-fa87e8608224/21)

Date: 2026-08-08
Role this run: reviewer / support / session memory. Codex was primary worker.
Repository commit at session start: `ddf134b9200a3fda3cac68dcdd7868f28c94160d`
Branch: `codex/tmux-socket-normalization-run11`
Outcome: **no source or test artifact applied**. Two review verdicts issued. Governed handover prepared.

---

## 1. What this run produced

| Item | Value |
|---|---|
| Verdict 1 (pre-apply boundary validation) | REVISE — bridge msg `983e5105-3dac-4a22-8455-73b79fe837d7` |
| Verdict 2 (B1/C1 restatement) | PASS — bridge msg `70159484-7644-4792-a0ea-bd9c1f20d15f` |
| Source/test files changed by Claude | none (all review work was zero-write) |
| Codex messages consumed | `38be1d60`, `713641a4`, `80da7ce8`, `03c95f89`, `5864fcfd` |

## 2. Handover artifacts — hashes independently verified by Claude

Computed by Claude with `shasum -a 256`, not copied from Codex's report:

```
174c89b9bfbda2b4b57cb045eba1ec37caf24029a8a48a0073ecde69d2a1e154  PLAN.md
ce3f3cb2f477744eb4bc482873e81bc1ebbc07cc9ac5c35c93f0a7ade9f6486c  status.md
```

Both match Codex's claimed values in `5864fcfd-8afc-4803-b8a5-f3b5f8d7089e`.

- `CURRENT GOVERNED HANDOVER` heading count: 1 in each file (`PLAN.md:3`, `status.md:3`).
- `git diff --check` exit 0.

## 3. NOT verified by Claude — do not read as endorsed

Per run instruction, no tests were started and no artifact hashing beyond the two files above.

- Baselines claimed by Codex, **unverified**: tmux 104/0, proxy 20/0, reservation 16/0,
  governess 78/0, governess-runtime 13/0, bridge 108/0.
- W2 / F1 / risk-C hash preservation, **unverified**.

Successor must re-derive these before relying on them.

## 4. Verdict 1 — REVISE (superseded, kept as record)

Raised against pre-apply request `713641a4`. Two findings were later resolved:

- **Blocker A — DISCHARGED** by restatement `03c95f89`. B1 originally said "thread only through
  non-paired `runInTmux` sites"; there are no non-paired-only call sites. `tmux.ts:3990-3998`
  builds one `launchContext` union, then hits exactly one call site each at `tmux.ts:4001`
  (`probeHandoffSession`), `tmux.ts:4025` (`keepSessionAttached`), `tmux.ts:4055`
  (`attachSessionIfInteractive`), all of which execute in paired runs too.
- **Blocker B — WITHDRAWN as factually wrong.** Claude inferred from `codex-tmux-proxy.ts:16` that
  a `tmuxSessionLiveness` signature change was required. It is not; a parallel target-aware API
  already exists (see §5). Gap D (nine importers being cross-cut) collapsed with it.

## 5. Verified code facts — the load-bearing map for the successor

All verified zero-write this run. Independently corroborated where noted.

### B1 symbols — all confined to `loop-fork/src/loop/tmux.ts`
Confirmed twice: native grep and utility task `01fcff1a-cfda-4bf8-a17c-a185a24a94f4`, identical line numbers.

| Symbol | Declared | Called |
|---|---|---|
| `probeHandoffSession` | `tmux.ts:1093` | 1150, 3287, 3602, 4001 |
| `startPairedSession` | `tmux.ts:3148` | 3991 only |
| `keepSessionAttached` | `tmux.ts:1132` | 4025 only |
| `isSessionGone` | `tmux.ts:1145` | 3945 only |

Enclosing top-level functions 3140–4040: `startPairedSession` 3148, `startRequestedSession` 3624,
`startAutoSession` 3672, `defaultDeps` 3716, `findSession` 3904, `attachSessionIfInteractive` 3933,
`runInTmux` 3957. So 3287 and 3602 are both inside `startPairedSession` (3148–3623), and 3945 is
inside `attachSessionIfInteractive` (3933–3956), whose only caller is `tmux.ts:4055`.

### `deps.attach` — the site B1 nearly missed
- `tmux.ts:217` — `attach: (session: string) => void;`
- `tmux.ts:3717-3724` — default impl spawns `["tmux", "attach", "-t", session]`, **no socket**
- `tmux.ts:4048-4052` — the operator-facing log already branches: paired uses
  `` `tmux attach -t ${session}` ``, non-paired uses `launchAttachCommand(launchContext.socket, session)`

The printed attach command is socket-aware; the actual spawn is not. `tmux.ts:3718` is a genuine
non-paired fail-open. Restatement `03c95f89` correctly added `deps.attach` to the thread list.

### `TmuxDeps` containment
`interface TmuxDeps` is declared `tmux.ts:216` and is **not exported**. Every reference is inside
`tmux.ts`. Only external surface is `runInTmux`'s `overrides: Partial<TmuxDeps> = {}` at
`tmux.ts:3959`. Only `loop-fork/tests/loop/tmux.test.ts` constructs an `attach` override. Changing
`attach`'s signature is therefore fully contained in the F2 packet — no fallout to `cli.ts:326/377/390`
or `deps.ts:14/34`.

### The dual tmux-control API — why Blocker B was wrong
- `tmux-control.ts:44` — `export const tmuxSessionLiveness = (` (socket-blind, kept)
- `tmux-control.ts:70` — `export const tmuxSessionLivenessAsync = (` (socket-blind, kept)
- `tmux-control.ts:140` — `export const tmuxTargetLiveness = (`, param `:141 target: TmuxTarget | undefined,`
- `tmux-control.ts:169` — `export const tmuxTargetLivenessAsync = (`, param `:170 target: TmuxTarget | undefined,`
- `tmux-control.ts:114` comment: "The socket-blind `tmuxSessionLiveness` pair above asks …" — the
  dual API is deliberate.

Consequence: `tmux-control.ts` is **read-only context**, not write scope. The proxy packet stays
atomic within `codex-tmux-proxy.ts` + its test.

### Target derivation path
- `run-state.ts:1230` — `export const readRunManifestHandle = (`
- `tmux-socket.ts:424` — `export const targetFromManifest = (`, returns `TmuxTarget | undefined` at `:426`

### `TmuxTarget` is brand-checked — why the rejected patches would have failed at runtime
- `tmux-socket.ts:40` — `export interface TmuxTarget {` with `:41 readonly [targetBrand]: "TmuxTarget";`
- `tmux-socket.ts:431` — sole construction: `Object.freeze({}) as unknown as TmuxTarget`
- `tmux-socket.ts:436` — `targetOf` validates provenance, throws `TmuxTargetProvenanceError` at `:439-440`
  with "value is not a TmuxTarget produced by targetFromManifest"
- `tmux-socket.ts:608` — "`targetFromManifest` remains the sole post-launch `TmuxTarget` producer."

So reservation task `000c4c06`'s invented `createTmuxTarget` would have **thrown at runtime**, not
merely violated convention. Codex's rejection was correct on the merits, independent of the corrupt
hunks. Same for the illegal `createManifestHandle` import in
`89843151a90edf8f2c9d165440e8131b4cca651fbb24a2b91ebf67df2c1cd9c0`: `run-state.ts:29` is the only
legitimate consumer of `createManifestHandle` from `./tmux-socket`.

### Nine importers of `./tmux-control`
`governess-pane-liveness.ts:15`, `panel.ts:17`, `governess-replay.ts:28`, `governess.ts:158`,
`bridge-runtime.ts:58`, `tmux.ts:112`, `launch-reservation.ts:21`, `paired-options.ts:38`,
`codex-tmux-proxy.ts:16`.

### Four importers of `./tmux-socket`
`run-state.ts:29` (`createManifestHandle`, `ManifestHandle`), `tmux.ts:119`,
`launch-reservation.ts:22` (`resolveTmuxSocket`), `tmux-control.ts:3` (`spawnParts`, `TmuxTarget`, `targetArgv`).

`codex-tmux-proxy.ts` has **no** `./tmux-socket` import; it reaches tmux only via `./tmux-control`.

## 6. Open caveats the successor must close

1. **`tmuxTargetLiveness` sync-vs-async is UNRESOLVED.** The utility audit attributed
   `tmux-control.ts:172` `): Promise<TmuxLiveness> => {` to *both* the function at 140 and the one at
   169. Since 169 opens `tmuxTargetLivenessAsync`, line 172 can close only one — the audit is
   internally inconsistent here and was not banked. By analogy with the 44/70 pair,
   `tmuxTargetLiveness` is presumably synchronous. This matters: `codex-tmux-proxy.ts:16` imports the
   **synchronous** `tmuxSessionLiveness`. **Read `tmux-control.ts:140-175` and confirm before changing
   the proxy's shared callback type**, or the packet will not typecheck.
2. **Migration coverage bookkeeping.** "Confirmed nine migration packets" currently maps to seven
   named destinations. Named later packets: `governess.ts`/`governess.test.ts`,
   `governess-replay.ts`/`governess-runtime.test.ts`, `bridge-runtime.ts`/`bridge.test.ts`. Active
   slice: tmux, launch-reservation, proxy. **Unnamed: `governess-pane-liveness.ts` and `panel.ts`.**
   `paired-options.ts` is explicitly verify-10 backlog. Confirm the two unnamed are intentional
   deferrals, not omissions.

## 7. Helper state at handover (from Codex `5864fcfd`, not independently confirmed)

- Rejected after independent hash / inspection / apply-check: reservation `000c4c06` (three patches,
  corrupt line32 + invented `createTmuxTarget`); F2
  `fb91f8d850510209956f021d02549a2800c6433caaa2275567f811864f3d5318` (corrupt fragment line24,
  insufficient C4); corrected reservation
  `89843151a90edf8f2c9d165440e8131b4cca651fbb24a2b91ebf67df2c1cd9c0` (corrupt line25 + illegal
  `createManifestHandle` import); bridge
  `859717c25071b701e60edc2fd962915a9c2269e9f1ecb08d904c3a1be67755a5` (corrupt line22).
- Original proxy `e18c5cb5` failed on runtime limit, no artifact.
- Still running when last checked: replay `bb70cb06`, Governess `0a545a31`, corrected F2 `8b98217d`.

Recurring signal worth noting: five of five returned patch artifacts were rejected for corrupt hunk
lines. That is a helper-side patch-generation defect, not a scoping defect — successor should expect
it and may want to change how edit packets are framed.

## 8. Next bounded action for the successor

1. Pull terminal results for `bb70cb06`, `0a545a31`, `8b98217d`.
2. Resolve caveat 1 (`tmux-control.ts:140-175`, sync vs async).
3. Reissue the proxy packet with `tmux-control.ts` **and** `tmux-socket.ts` in read scope; write scope
   stays `codex-tmux-proxy.ts` + `codex-tmux-proxy.test.ts`.
4. Reissue F2 with `tmux-socket.ts` added to read scope.
5. Obtain a Claude PASS before any guarded apply.

Scope excluded from this slice and still open: verify-10 six inline fail-open sites, and the
`paired-options.ts` distinct probe.

## 9. Authority note

No commit, merge, rebase, or push was performed by Claude. Uncommitted work preserved. No PR opened.
Authority boundaries unchanged.
