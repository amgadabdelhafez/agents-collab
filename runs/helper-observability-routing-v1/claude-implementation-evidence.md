# Helper usage and routing: implementation evidence (Claude, Run43)

Date: 2026-10-05 (UTC). Driver: Claude Opus 5.5. Peer reviewer: Codex.
Worktree `/private/tmp/helper-observability-routing-v1`, branch
`codex/helper-observability-routing-v1`.

## Source identity

- Base: `51bf72003caeb7d366ba730906abf09221867d14` (root checkpoint).
- Implementation commit: `d266333620f2eb7943ec7ecec765882ecc4d4b3f`
  (`git diff 51bf7200 d2663336`: 10 files, +1483/-36, all under `loop-fork/`).
- Root startup repair on top: `82be6ca5` (supervisor-owned `tmux.ts`; Codex PASS e8a1c552).
- Review fixes for Codex REQUEST_CHANGES 27ef4da7: `b2a608168575f95457add61e17c3fcf651e6dbee`
  and `2ac6e3ef0a1da8f4a57848fd6afe3037957f00e6`
  (`git diff 82be6ca5 2ac6e3ef`: loop-fork only).
  - Deadline: Pi setup counts against the budget, and no request is sent once the
    budget is spent. The retry rejects an expired deadline after each backoff.
  - Live-size panes (Au Pair 68x3, Nanny 68x13): a two-line header keeps state, cost,
    counts, calls/tools, tokens and model. Full header and per-job usage wrap instead
    of being clipped. Pi-catalog money is marked "est". Context-insufficient jobs are
    counted.
  - `wrapPaneText` hard-breaks a long path at the pane width. The old code broke at
    index 1, which printed one character per row.
  - Governess spend cell keeps "+?" within 7 columns (`$.003+?`).
- Focused at `2ac6e3ef` content:

  | Suite | Result |
  |---|---|
  | utility-observability | 8 pass, 0 fail |
  | utility-runtime | 58 pass, 0 fail |
  | utility-admission-retry | 9 pass, 0 fail |
  | utility-pi-harness | 13 pass, 0 fail |
  | governess | 83 pass, 0 fail |

  biome is clean. The tsc error set is identical to base (275 lines).
- Each new test fails against the old behavior:
  - oversleep (post-sleep check removed);
  - slow setup (d2663336 timer with no pre-prompt guard);
  - path wrap (old break).
- The candidates below were built from `d2663336`. They are superseded diagnostics,
  not for activation. Root owns one replacement build.
- Not in the commit: `specs/helper-observability-routing-v1/status.md` and
  `runs/helper-observability-routing-v1/release-acceptance.md` (root-owned).
- Candidate binary (not installed): `loop-fork/loop.candidate-d2663336`,
  SHA-256 `e9c3f265efa869400e1cbc959650e19bb984f7baa6744c37cc5cf6a73d111606`,
  `loop v1.0.38`, built with `LOOP_BUILD_OUTFILE=loop.candidate-d2663336 bun run build`.
  The running Run43 Governess (pid 57075) executes `loop-fork/loop`
  (SHA-256 `b06d0e63c04bde2f7f02209a807531777fc002eb2b11ba9e4f8fe506ffae9864`), and
  utility workers inherit that path through `buildLaunchArgv`.
  Marker strings in the candidate: "governess proxy busy: one judgment in flight",
  "judge model", "local-zero-rate", "is past the end of the file", "Patch does not apply".
  None of them are in the current `loop`.

## Findings (observed)

1. **Judge traffic was counted as Nanny work.** `governess.ts renderUtilityAgentRow`
   added `sumLocalLlmUsageByJudge(meta.llmUsageByJudge)` to the Nanny row's tokens
   and calls. The judge usage line was also labelled "nanny model".
2. **An unknown price was shown as $0.** Pi registers loopback helpers
   (`loop-nanny`, `loop-au-pair`) at zero rates (`pi-runtime.ts`), so `usage.cost`
   was always 0 for a Switchyard Au Pair. `finiteNumber()` then summed that 0 as
   money. Per-job Switchyard price is unknown at job level:
   `governess-cost.ts` derives cost per run only ("utility-job breakdown unavailable").
   That run-level pricing is unchanged.
3. **Harvto285 Nanny job `237793d9-bec2-4d6e-818d-1bc9e1c13c08`** (metadata only).
   - Timeline: routed 00:38:33.066Z, running 00:38:33.755Z, failed 00:38:34.158Z.
   - It made 1 model call (352 ms, 0 tokens) and was refused with
     `503: {"message":"governess proxy busy: one judgment in flight"}`.
   - Cause: Nanny's default endpoint `127.0.0.1:8082` is the installed
     `~/.loop/bin/governess-proxy.py`. That proxy admits one POST at a time
     (`Semaphore(1)`, non-blocking) and returns this 503 to any concurrent POST.
   - Pi retry is disabled for helpers (`pi-runtime.ts`), so the job failed on the
     first refusal.
   - The proxy and Harvto's runtime were not changed.
4. **Helper failures in this run caused by the broker.**
   - Nanny `2a5a34d8-1ce8-4d0c-ab61-cc2cb23c7560` was stopped after 3 rejections of
     `read_file` "startLine exceeds endLine". `endLine` is clamped to `lineCount`
     before the check, so a `startLine` past the end of the file got the same
     message as an inverted range, and the message gave no file length.
   - Au Pair `f5c6d624-530c-4da6-b050-4688ed28b3b5` (5 rejections) and
     `4c8ec452-38e5-4b99-900d-d392bda1dc1d` (3) got `patch_conflict`
     "Patch no longer applies cleanly". The target files were unchanged.
     The broker discards `git apply --check` stderr. Reproduced locally: a patch
     missing its final newline, or a hunk with wrong line counts, both produce
     `error: corrupt patch at <file>:N`.
   - Nanny `b08dc010-b52d-4e2f-9123-8f9332d0c42c` returned context-insufficient
     because `loop-fork/node_modules` is a symlink to `/private/tmp/run37-installed-stats`,
     outside the repo. The `path_denied` was correct enforcement; the packet's
     scope was unreachable.

## Changes

- Nanny row: worker task counters only. The judge line is now "judge model".
- Cost cells: "?" for unknown price, "$x+?" for partial, "local" for local zero-rate.
- Usage rows now carry `costSource`, `servedModel` (Pi `responseModel`, set only when
  the served model differs from the requested one) and `admissionRetries`.
  An unknown cost is dropped from the row.
  - Readers trust the label when present.
  - Rows written before this change are classified by provider and tier.
  - An unlabeled numeric cost on a row with no provider and no tier stays
    "recorded-unlabeled".
- Dedicated helper panes:
  - header lines show state (idle/queued/running/completed/failed), job counts,
    calls/tools, input/cache/output tokens, labelled cost, and the requested and
    served model;
  - each result line shows the same provenance per job.
- Nanny admission retry fires only when all of these hold:
  - the tier is `utility-nanny`;
  - the `nannyEndpoint` is loopback;
  - the error matches the exact proxy 503 text;
  - the refused attempt executed 0 tools.

  It retries at most 2 times (1.5 s, then 3.75 s; `LOOP_UTILITY_ADMISSION_RETRY_BASE_MS`),
  inside one original deadline, and checks cancellation after each wait.
  Counters accumulate across attempts. Au Pair never retries.
- `read_file` gives precise range errors, from guarded-applied Au Pair proposal (below).
- `propose_patch` returns git's sanitized reason plus a hint for corrupt patches. The
  proposal check says "Patch does not apply"; the apply-time check keeps
  "no longer applies cleanly".

## Live helper routing (Run43 bridge)

| Job | Tier | Outcome | Usage row |
|---|---|---|---|
| 2a5a34d8 | Nanny | failed: 3 invalid read_file ranges | 8 calls, 10 tools, 57,829 tok (48,006 cached), cost 0 |
| b08dc010 | Nanny | context-insufficient (symlinked node_modules) | 2 calls, 2 tools, 4,729 tok (3,183 cached), cost 0 |
| f5c6d624 | Au Pair (openrouter z-ai/glm-5.2) | failed: patch_conflict x5 | 17 calls, 27 tools, 236,592 tok (158,016 cached), $0.10567 Pi catalog |
| 4c8ec452 | Au Pair (openrouter z-ai/glm-5.2) | failed: patch_conflict x3 | 21 calls, 26 tools, 263,567 tok (177,216 cached), $0.11161 Pi catalog |
| 53052bc0 | Au Pair (openrouter z-ai/glm-5.2) | completed, validated patch | 14 calls, 19 tools, 149,964 tok (97,536 cached), $0.06252 Pi catalog |

All rows above were written by the installed worker code at the time, which records
`cost 0` for Nanny with no source label. Under this commit's reader those rows are
classified `local-zero-rate` (Nanny) and `pi-catalog-rates` (OpenRouter Au Pair).

Guarded apply of `53052bc0-701c-4243-ae36-131d54d05f43`:

- Patch SHA-256 `d6f772aecda16f84185c05d391a7f275d4ca51866c4066aa4a2ba32504a21a71`.
- Preimages, recorded before routing and unchanged at review:
  - `utility-tools.ts` `5a99bb88183322757a5e5f04e8c269e617c8a745405f1bf83b4e31ee1e8e2c95`
  - `utility-tools.test.ts` `565f7a30c0e35480732faa7a3671079357a95d5793108485e60eba79fcbfd570`
- The driver reviewed the hunks, then ran `apply_task_patch`, applied at 2026-10-05T01:23:10.494Z.
- Postimages: `6708203e9cf7f0018265f6254be42b1e4a07a2299a7f9b8f6aebaec506e97a98` and
  `27c495da6a13744065e332ca74a28fe36b767ab6d05d01d4debafaa162cfde1a`.
- Manifest `0d3efb324499157807cb56b75a3f20d2d73a74ef3f2a78171ff7c1dd6a3ee1bb`.

## Live proof on the corrected candidate (2026-10-05)

The root switched only `loop-fork/loop`, the path Governess spawns workers from.
It went from `b06d0e63` to `2c086adb0946f074162f2c36414b86f78b0ae80fa3257cc6c22d421d300a0bb5`,
built from `2ac6e3ef` with tree `4c1b1460…`. The loaded pair and control processes
were not restarted. The global install is still `d359`.

**Direct `c391c8a4-848a-4f8d-a2bb-2634192283d6`** (exact file-read packet; Governess chose Direct):

- Claimed by `utility-18190` at 01:47:11.731Z and completed at 01:47:11.751Z.
- ps: pid 18190, ppid 57075 (Run43 Governess), command
  `/private/tmp/helper-observability-routing-v1/loop-fork/loop __utility-worker … c391c8a4…`,
  started after the switch.
- Usage row: `costSource:"not-applicable"`, modelCalls 0, toolCalls 1. `costSource` is a
  new field the old binary never wrote, so this row shows the new worker code ran.

**Nanny `03078905-f36c-4767-9d7b-a2a642692b11`** (judgment packet; Governess chose Nanny):

- Routed 01:47:39.902Z. Claimed by `utility-21392` (pid 21392, ppid 57075, same
  `loop-fork/loop __utility-worker` command) at 01:47:40.338Z. Completed 01:48:02.818Z.
- Usage row:
  - harness pi-sdk, provider loop-nanny, 5 model calls, 4 tool calls;
  - 21,332 tokens (20,898 input, 16,466 cached, 434 output);
  - `costSource:"local-zero-rate"`;
  - requested `model` `mlx-community/Qwen3.6-35B-A3B-4bit`, but
    **`servedModel` `mlx-community/Qwen3-4B-Instruct-2507-4bit`**.
- The served-model field shows the Nanny endpoint served a different, smaller local
  model than requested. Observed only; not changed here. The endpoint owner should check
  which server `127.0.0.1:8082` routes to.
- Tool events: read_file ok, read_json invalid_arguments twice (wrong tool for a .ts
  file), search_repo ok.
- Result verdict "SAFE" is correct, verified by the driver against source.
- It identified every gate correctly: tier+loopback, exact 503 text (line 129,
  correct), zero tool calls, retry limit, pre-sleep deadline, and post-sleep deadline
  check.
- Its other line citations are off by 4–17 lines:
  - tier+loopback cited as 2186–2188 (actual 2190);
  - tool-call gate and retry limit cited as 2240–2241 (actual 2257–2258);
  - pre-sleep deadline cited as 2250–2251 (actual 2259);
  - post-sleep check cited as 2258–2259 (actual 2270).

  So the summary is useful, but its line numbers are not reliable without driver review.

**Driver acceptance of `03078905`.** Accepted as useful concept extraction only. It is
not an independent safety approval.

- The "SAFE" label is the helper's own judgment, made from a read-only, partial read.
- The authority for the retry guard's correctness is Codex PASS `2b2e180f` on source
  plus the focused tests above. Nanny is not part of that authority.
- The regex citation (line 129) falls outside the asked range 2186–2280. The packet
  asked to cite only lines in that range. Line 129 was found by `search_repo` over the
  in-scope file, so the cited text is real, but the range instruction was not followed.
- Corrected citations, verified against `2ac6e3ef` source:

  | Item | Line |
  |---|---|
  | tier + loopback gate | 2190 |
  | rejection conditions (exact 503 text, zero tool calls, retry limit, pre-sleep deadline) | 2253–2259 |
  | post-sleep deadline check | 2270 |
  | refusal regex | 128–129 |
- The served model for this job was `mlx-community/Qwen3-4B-Instruct-2507-4bit`. The
  requested model was `mlx-community/Qwen3.6-35B-A3B-4bit`. That model gap is a likely
  cause of the citation errors and the tool misuse. The proxy config is unchanged.

## Verification (at d2663336)

Command form: `env -u TMUX -u TMUX_PANE bun run test:file -- tests/loop/<file>.test.ts`.

| Suite | Result |
|---|---|
| utility-observability | 8 pass, 0 fail |
| utility-admission-retry (new) | 8 pass, 0 fail |
| utility-pi-harness | 12 pass, 0 fail |
| utility-runtime | 56 pass, 0 fail |
| utility-tools | 51 pass, 0 fail |
| governess | 82 pass, 0 fail |
| recon-pane | 1 pass, 0 fail |
| utility-readiness | 5 pass, 0 fail |
| pi-runtime | 6 pass, 0 fail |
| utility-composed-release | 1 pass, 0 fail |

- **Pi integration test.** A real Pi session against a fake server returns the proxy's
  exact 503, then succeeds. Result: 3 requests; the row records `admissionRetries` 1,
  `modelCalls` 3, `costSource` local-zero-rate and `servedModel`.
- **Negative tests:**
  - Au Pair with the same text;
  - a non-loopback Nanny endpoint;
  - a refusal after a tool call;
  - other 503 text or a runtime-limit error;
  - a deadline shorter than the backoff;
  - cancellation after the wait.
- **Mutations.** Each was restored with `git checkout`, and each made at least one test fail:
  - M1: judge calls folded back into the Nanny row (governess, 1 fail);
  - M2: retry binding removed (admission-retry, 2 fail);
  - M3: unknown cost counted as known (observability, 1 fail);
  - M4: git reason hidden (tools, 1 fail);
  - M5: retry disabled (pi-harness, 1 fail).
- **Lint.** `bunx biome check` on the 10 touched files is clean.
- **Typecheck.** `tsc --noEmit` gives an identical 275-line error set (positions
  stripped) at base and head. Those errors are pre-existing; no clean-typecheck claim.

## Limits and open items

- The root accepted the source handoff and the Nanny usefulness on 2026-10-05
  (supervisor message `d91ec839`). The driver makes no further source writes.
- The root owns these follow-ups:
  - **Transcript selection.** In `renderUtilityTranscript`, a newest job group that is
    too big for the remaining rows is skipped in favor of an older group that fits.
    Observed natively on the 68x13 Nanny pane: it showed context job `b08dc010` instead
    of the new `03078905` completion. Fix: pick the newest job first, in compact form.
  - **Large-cost marker.** The Codex P3 large-cost "+?" edge.
  - Focused regressions for both, then one final rebuild.
- The root committed both fixes as `5eeaa48538a9e154b00649dd3898dc5bebbd42c1`.
  Codex gave a bounded PASS (`0a4fb80d`).
  - Spend of $9999.50 or more renders as `$>9k+?`.
  - An oversized newest job group renders in compact form instead of being replaced by
    an older group.
  - That diff is display-only. The live Nanny evidence (`03078905`) was produced by the
    earlier compiled `2c086adb`, not by a rebuild of `5eeaa485`. Worker, retry and
    broker logic did not change between them.

- Codex verdict `2b2e180f`: bounded source-level PASS for `82be6ca5..2ac6e3ef`.
- Historical limitation, superseded by final display-only commit `5eeaa485`:
  `partialUsdCell` renders `$10000+?` (8 chars) for helper-tier spend at or above
  $9999.50. The 7-column cell can then clip "+?". Follow-up: scaled formatting with a
  9999.5/10000 test.
- The slow-setup test uses a 1 ms budget, so it depends on real Pi setup time. A
  deterministic setup delay would make it stronger.

- Historical pre-live checkpoint, superseded by live job03078905 and final install:
  The candidate is built but not yet bound to a live worker. A live Nanny on the
  candidate needs the candidate at the path the governess spawns workers from.
  Root owns that step and any global install or rollback.
- The judge proxy still refuses concurrent POSTs. A Nanny job can still fail after
  2 retries if judge calls keep the slot busy. The usage row then shows every
  refused call.
- Old usage rows have no `servedModel`. Requested-model labels on them are unchanged.
- The full suite (`test:ci`) has not been run. Only the focused suites above were run.
