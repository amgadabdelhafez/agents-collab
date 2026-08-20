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

      **Corrected diagnosis (2026-07-31, loop 108):**
      - Raw `jobs.jsonl` lines are deltas, not complete job snapshots. Selecting
        only the last raw line per `jobId` drops earlier routing and claim fields
        and is not a valid attribution instrument.
      - Replaying the journal through the checked-in
        `readUtilityJobsForObservability` fold reconstructs eight executed jobs:
        Direct `4 OK / 3 FAIL`, Au Pair `1 OK / 0 FAIL`, and Nanny `0 / 0`.
        The founder's observation was valid: Au Pair had completed work that the
        deployed Governess did not report.
      - Nanny model calls are routing and judging activity, not necessarily
        executed Nanny jobs. The UI must distinguish model calls from executed
        jobs instead of presenting the two populations as comparable counters.
      - The corrective branch must render Direct work, retain fail-closed
        unknown-tier attribution, and prove the partition using the production
        fold. A release fixture must be captured from producer output and bound
        to its source SHA; a synthetic-only fixture does not satisfy that gate.
      - Constrained-height layouts must keep the Direct row visible. A fix that
        appends Direct after Nanny and Au Pair but slices it off at the common
        five-row viewport does not resolve the founder-visible symptom.
