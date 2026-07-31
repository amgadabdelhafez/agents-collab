# Tasks: Lower-Agent Observability

- [x] T-01: Implement durable utility observability snapshot and safe text
      compaction.
- [x] T-02: Render cumulative metrics and recent request/tool/result transcript
      in the lower-agent pane.
- [x] T-03: Remove the structured summary block and render a compact lower-agent
      metrics row in the governess pane.
- [x] T-04: Add focused tests for totals, failures, malformed events, secrecy,
      width, and height.
- [x] T-05: Run full verification and independent evaluation.
- [x] T-06: Integrate locally and safely refresh display-only panes.
- [ ] T-07: Reconcile Governess helper counters with durable per-tier activity.
      Investigate loop 108, where Governess displayed Nanny `1` and Au Pair `0`
      even though Au Pair appeared to be doing real work. Compare the rendered
      counters against route, claim, tool, result, and completion journals;
      identify whether work is omitted, attributed to the wrong tier, or lost
      during snapshot refresh. Add regression coverage proving each Nanny and
      Au Pair job is counted consistently without double-counting retries.

      **Supervisor diagnosis (2026-07-31 ~20:35 UTC, loop 108 live; evidence-grounded,
      root cause hypothesized at file:line, fix NOT implemented - engineer to execute):**
      - Ground truth from `~/.loop/runs/harvto-b1e274e66299/108/utility/jobs.jsonl`
        (latest record per jobId): 35 `routed-requester` (review-stays-with-requester
        returns - correctly not helper work), **5 `completed` + 3 `failed` executed
        jobs**. Board at the same time: `nanny 0/0` + `au pair 1/0` OK/FAIL, while the
        `helpers` summary line says `5/5 success` and the `nanny model` line admits
        91 calls. Three lines, three different populations, one ledger.
      - Mechanism (read at deployed commit `a93f7e4e`, `loop-fork/src/loop/`):
        per-helper rows come from `readUtilityObservability(runDir, tierId)`
        (`utility-observability.ts:722`), which filters through `workerJobs()`
        (`:366`) - a job counts only if `decision?.target === "utility"` OR
        `claim !== undefined` OR it sits in an in-flight routing state - and then
        through `jobTier()` (`:595`), which reads `decision?.tierId` and **silently
        defaults missing tier to AU-PAIR**. Terminal jobs whose records lack
        `decision.target`/`claim`/`tierId` (the direct-lane read_file class that
        returned 45 `Direct result` payloads over the bridge this run) fall out of
        the per-helper OK/FAIL rows entirely, while still being counted by other
        aggregates. Both filters are fail-open for attribution: an unattributable
        executed job should surface as `unattributed`, never vanish or default-bin.
      - Fix shape: (1) make tier attribution fail-closed - explicit
        `unattributed` bucket rendered on the board when `decision.tierId` is
        absent, no silent au-pair default; (2) reconcile the three board lines to
        one population definition (per-helper rows + helpers summary + model-call
        lines must partition the same terminal-job set); (3) the regression tests
        this task already requires, plus one asserting SUM(per-helper OK) ==
        helpers-summary successes on a synthetic ledger containing a
        missing-tier terminal job.
      - Note: nanny `91 calls` with `0/0` jobs is routing/judging model usage, not
        lost jobs - if that is by design, label the column so the founder can tell
        model-calls from executed jobs; the current rendering reads as an undercount.

      **Implementation (supervisor, 2026-07-31 ~21:05 UTC, branch
      `supervisor/t07-helper-counters`; code complete, engineer review + deploy
      pending):**
      - `utility-observability.ts`: `jobTier()` is now fail-closed — returns a
        tier only for the three known tier ids, `undefined` otherwise (no more
        silent au-pair default); transcript labels use a new `attributionName()`
        (`Unattributed` for unknown/missing tiers). Runtime `utilityRoleName`
        untouched.
      - `governess.ts`: the board now renders a third `direct` helper row
        (model cell `tools`), and the `helpers ·` summary line appends
        `· unattrib N` whenever terminal jobs exist that no rendered tier row
        claims (N computed from the same snapshots, so the invariant is
        rows + unattrib == untiered).
      - Tests: new partition regression (direct/nanny/au-pair/unknown-tier/
        requester-returned fixture; asserts per-tier counts, untiered totals,
        remainder == 1, `UNATTRIBUTED` labels); three legacy fixtures updated to
        carry the `tierId` the real producer writes (run-108 evidence: every
        executed job carried one). Full suite 1,375 pass / 0 fail.
