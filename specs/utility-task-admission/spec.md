# Spec: Utility Task Admission

## Problem

The utility router currently treats a bounded, low-risk request as sufficient
evidence for delegation. Bounded scope does not establish that work can be
separated from the primary agent's current sequence. This permits a caller to
fan out sequential work even though the governess is meant to own topology and
the primary agent is meant to remain the single execution locus by default.

## Goal

Make work shape a durable, fail-closed routing fact so only explicitly
separable bounded work can enter a utility tier.

## Non-goals

- Automatically infer semantic decomposability from natural language.
- Change utility tier selection, concurrency, provider choice, or tool policy.
- Route the original human task or promote a utility worker to a peer role.
- Deploy a binary or mutate a live run.

## Background

`specs/lower-agent-router/spec.md` already makes governess the only scheduler
and requires ambiguous work to remain with the driver. This slice closes the
gap between boundedness and separability without weakening any existing risk,
authority, scope, health, epoch, or conflict gate.

## User journeys

1. A main agent submits a bounded repository inspection marked `separable`; if
   all existing gates pass, governess may route it to a utility tier.
2. A main agent submits sequential or unknown-shape work; governess keeps it
   with the current driver and records `work-not-separable`.
3. A bridge caller omits work shape; the bridge rejects the request before it
   can enter the durable job journal.
4. The trusted mechanical delegation hook emits `separable` for its already
   proven standalone read/search/status operations.

## Acceptance criteria

- [ ] Durable utility requests contain `workShape` with one of `separable`,
      `sequential`, or `unknown`.
- [ ] `route_task` requires `work_shape` and rejects missing or invalid values.
- [ ] Only `separable` work can receive `utility-eligible`; `sequential`,
      `unknown`, missing legacy values, and malformed values stay with the
      driver as `work-not-separable`.
- [ ] Existing review, authority, epoch, boundedness, risk, protected-scope,
      conflict, capability, and health behavior does not regress.
- [ ] Automatic mechanical delegation records `separable` explicitly.
- [ ] Agent guidance explains that separability is required and must not be
      asserted for ambiguous or sequence-dependent work.
- [ ] Focused tests, the full named test suite, check, and build pass, with any
      unrelated baseline failures reported by exact test name.
- [ ] An independent evaluator records `runs/utility-task-admission/eval.json`.

## Out-of-scope risks

Agent testimony can still misclassify semantic dependencies. A later admission
slice may add structured dependency evidence and replay-calibrated
classification, but this slice must not pretend natural-language inference is
deterministic proof.

## Open questions

None for this bounded slice.
