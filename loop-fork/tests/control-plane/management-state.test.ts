import { expect, test } from "bun:test";
import type { ShiftId, WorkItemId } from "../../src/control-plane/contracts";
import {
  acknowledgeShiftHandoff,
  DEFAULT_PORTFOLIO_TIMEZONE,
  evaluateDeadline,
  evaluateTransition,
  resolveShiftWindow,
  type ShiftHandoffRecord,
  validateShiftHandoff,
} from "../../src/control-plane/management-state";

const workItemId = "work-item/WI-42" as WorkItemId;

test("legal transitions pass and policy failures reject with stable reasons", () => {
  expect(
    evaluateTransition({
      aggregate: "work-item",
      dependencies: [],
      from: "draft",
      to: "ready",
    })
  ).toEqual({
    ok: true,
    value: { aggregate: "work-item", from: "draft", to: "ready" },
  });

  const illegal = evaluateTransition({
    aggregate: "work-item",
    from: "draft",
    to: "completed",
  });
  expect(illegal.ok).toBe(false);
  if (illegal.ok) {
    throw new Error("illegal transition unexpectedly passed");
  }
  expect(illegal.rejections[0]?.code).toBe("ILLEGAL_TRANSITION");

  const dependencyBlocked = evaluateTransition({
    aggregate: "work-item",
    dependencies: [
      {
        state: "in-progress",
        workItemId: "work-item/WI-41" as WorkItemId,
      },
    ],
    from: "draft",
    to: "ready",
  });
  expect(dependencyBlocked.ok).toBe(false);
  if (dependencyBlocked.ok) {
    throw new Error("blocked dependency unexpectedly passed");
  }
  expect(dependencyBlocked.rejections[0]?.code).toBe("DEPENDENCY_BLOCKED");

  const wipBlocked = evaluateTransition({
    aggregate: "work-item",
    dependencies: [],
    from: "ready",
    to: "admitted",
    wip: {
      activeWorkItemIds: ["work-item/WI-40" as WorkItemId],
      limit: 1,
    },
    workItemId,
  });
  expect(wipBlocked.ok).toBe(false);
  if (wipBlocked.ok) {
    throw new Error("full WIP admission unexpectedly passed");
  }
  expect(wipBlocked.rejections[0]?.code).toBe("WIP_LIMIT_REACHED");

  const release = evaluateTransition({
    aggregate: "release",
    from: "candidate",
    to: "approved",
  });
  expect(release.ok).toBe(false);
  if (release.ok) {
    throw new Error("unapproved release unexpectedly passed");
  }
  expect(release.rejections[0]?.code).toBe("APPROVAL_REQUIRED");

  expect(
    evaluateTransition(
      {
        aggregate: "release",
        approvalDecisionId: "approval/release-42",
        from: "candidate",
        to: "approved",
      },
      {
        approvalResolver: {
          resolveApprovalDecision: (decisionId) => ({
            actorId: "founder/amgad",
            authority: "approve-release",
            decidedAt: "2026-08-08T20:00:00Z",
            decisionId,
            evidenceSha256: "a".repeat(64),
            outcome: "approved",
          }),
        },
      }
    )
  ).toEqual({
    ok: true,
    value: { aggregate: "release", from: "candidate", to: "approved" },
  });

  const invalidApprovalTime = evaluateTransition(
    {
      aggregate: "release",
      approvalDecisionId: "approval/release-invalid-time",
      from: "candidate",
      to: "approved",
    },
    {
      approvalResolver: {
        resolveApprovalDecision: (decisionId) => ({
          actorId: "founder/amgad",
          authority: "approve-release",
          decidedAt: "2026-02-30T20:00:00Z",
          decisionId,
          evidenceSha256: "a".repeat(64),
          outcome: "approved",
        }),
      },
    }
  );
  expect(invalidApprovalTime.ok).toBe(false);
  if (invalidApprovalTime.ok) {
    throw new Error("calendar-invalid approval decision unexpectedly passed");
  }
  expect(invalidApprovalTime.rejections[0]?.code).toBe("APPROVAL_REQUIRED");
});

test("malformed dependency and WIP snapshots reject without throwing", () => {
  const malformedDependencies = {
    aggregate: "work-item",
    dependencies: null,
    from: "draft",
    to: "ready",
  } as never;
  expect(() => evaluateTransition(malformedDependencies)).not.toThrow();
  const dependencyResult = evaluateTransition(malformedDependencies);
  expect(dependencyResult.ok).toBe(false);
  if (dependencyResult.ok) {
    throw new Error("malformed dependency policy unexpectedly passed");
  }
  expect(dependencyResult.rejections[0]?.code).toBe("POLICY_REQUIRED");

  const malformedWip = {
    aggregate: "work-item",
    dependencies: [],
    from: "ready",
    to: "admitted",
    wip: { limit: 1 },
    workItemId,
  } as never;
  expect(() => evaluateTransition(malformedWip)).not.toThrow();
  const wipResult = evaluateTransition(malformedWip);
  expect(wipResult.ok).toBe(false);
  if (wipResult.ok) {
    throw new Error("malformed WIP policy unexpectedly passed");
  }
  expect(wipResult.rejections[0]?.code).toBe("INVALID_POLICY");

  const malformedIds = evaluateTransition({
    aggregate: "work-item",
    dependencies: [{ state: "completed", workItemId: "" }],
    from: "draft",
    to: "ready",
  });
  expect(malformedIds.ok).toBe(false);
  if (malformedIds.ok) {
    throw new Error("malformed dependency ID unexpectedly passed");
  }
  expect(malformedIds.rejections[0]?.code).toBe("INVALID_POLICY");

  const malformedAggregate = {
    aggregate: "bogus",
    from: "draft",
    to: "ready",
  };
  expect(() => evaluateTransition(malformedAggregate)).not.toThrow();
  const aggregateResult = evaluateTransition(malformedAggregate);
  expect(aggregateResult.ok).toBe(false);
  if (aggregateResult.ok) {
    throw new Error("malformed aggregate unexpectedly passed");
  }
  expect(aggregateResult.rejections[0]?.code).toBe("ILLEGAL_TRANSITION");
});

test("deadline escalation is deterministic and fail closed", () => {
  const policy = {
    dueAt: "2026-08-08T20:00:00Z",
    escalateAt: "2026-08-08T19:30:00Z",
    warnAt: "2026-08-08T19:00:00Z",
  };
  expect(evaluateDeadline("2026-08-08T18:59:59Z", policy)).toEqual({
    ok: true,
    value: "scheduled",
  });
  expect(evaluateDeadline("2026-08-08T19:45:00Z", policy)).toEqual({
    ok: true,
    value: "escalated",
  });
  expect(evaluateDeadline("2026-08-08T20:00:00Z", policy)).toEqual({
    ok: true,
    value: "due",
  });
  expect(evaluateDeadline("2026-08-08T20:00:00.001Z", policy)).toEqual({
    ok: true,
    value: "overdue",
  });

  const invalid = evaluateDeadline("2026-08-08T19:00:00Z", {
    ...policy,
    warnAt: "2026-08-08T19:45:00Z",
  });
  expect(invalid.ok).toBe(false);
  if (invalid.ok) {
    throw new Error("misordered deadline policy unexpectedly passed");
  }
  expect(invalid.rejections[0]?.code).toBe("INVALID_POLICY");

  const impossible = evaluateDeadline("2026-02-30T19:00:00Z", policy);
  expect(impossible.ok).toBe(false);
  if (impossible.ok) {
    throw new Error("calendar-invalid deadline instant unexpectedly passed");
  }
  expect(impossible.rejections[0]?.code).toBe("INVALID_TIMESTAMP");
});

test("portfolio-local shifts preserve 00/08/16 boundaries across offsets", () => {
  expect(DEFAULT_PORTFOLIO_TIMEZONE).toBe("America/Los_Angeles");

  const winter = resolveShiftWindow("2026-01-15T10:00:00Z");
  expect(winter.ok).toBe(true);
  if (!winter.ok) {
    throw new Error("winter shift did not resolve");
  }
  expect(winter.value).toMatchObject({
    boundaryHour: 0,
    endsAt: "2026-01-15T16:00:00.000Z",
    startsAt: "2026-01-15T08:00:00.000Z",
    timezone: "America/Los_Angeles",
  });

  const summer = resolveShiftWindow("2026-07-15T10:00:00Z");
  expect(summer.ok).toBe(true);
  if (!summer.ok) {
    throw new Error("summer shift did not resolve");
  }
  expect(summer.value).toMatchObject({
    boundaryHour: 0,
    endsAt: "2026-07-15T15:00:00.000Z",
    startsAt: "2026-07-15T07:00:00.000Z",
    timezone: "America/Los_Angeles",
  });

  const invalidZone = resolveShiftWindow(
    "2026-07-15T10:00:00Z",
    "Not/A_Real_Zone"
  );
  expect(invalidZone.ok).toBe(false);
  if (invalidZone.ok) {
    throw new Error("invalid timezone unexpectedly passed");
  }
  expect(invalidZone.rejections[0]?.code).toBe("INVALID_TIMEZONE");

  const impossible = resolveShiftWindow("2026-02-30T10:00:00Z");
  expect(impossible.ok).toBe(false);
  if (impossible.ok) {
    throw new Error("calendar-invalid shift instant unexpectedly passed");
  }
  expect(impossible.rejections[0]?.code).toBe("INVALID_TIMESTAMP");
});

test("shift boundaries expose DST gap and fold disambiguation", () => {
  const gap = resolveShiftWindow("2026-03-08T05:30:00Z", "America/Havana");
  expect(gap.ok).toBe(true);
  if (!gap.ok) {
    throw new Error("DST gap shift did not resolve");
  }
  expect(gap.value).toMatchObject({
    requestedStartsAtLocal: "2026-03-08T00:00:00[America/Havana]",
    startDisambiguation: "shifted-forward",
    startsAtLocal: "2026-03-08T01:00:00[America/Havana]",
  });

  const fold = resolveShiftWindow("2026-11-01T05:30:00Z", "America/Havana");
  expect(fold.ok).toBe(true);
  if (!fold.ok) {
    throw new Error("DST fold shift did not resolve");
  }
  expect(fold.value).toMatchObject({
    requestedStartsAtLocal: "2026-11-01T00:00:00[America/Havana]",
    startDisambiguation: "earlier-fold",
    startsAt: "2026-11-01T04:00:00.000Z",
    startsAtLocal: "2026-11-01T00:00:00[America/Havana]",
  });
});

test("handoff requires every acknowledgement and preserves workers", () => {
  const handoff: ShiftHandoffRecord = {
    acknowledgements: [],
    fromShiftId: "shift/2026-08-08T08:00" as ShiftId,
    openWorkItemIds: [workItemId],
    preparedAt: "2026-08-08T15:55:00-07:00",
    requiredAcknowledgers: ["supervisor/next", "operator/portfolio"],
    retrospective: {
      failures: [],
      improvements: ["retain exact failure identity"],
      outcomes: ["Phase 0B remained shadow-only"],
    },
    risks: ["open work remains owned by its durable workflow"],
    status: "ready",
    summary: "Transfer management attention without restarting workers.",
    toShiftId: "shift/2026-08-08T16:00" as ShiftId,
    workerContinuity: "preserve",
  };

  const partial = acknowledgeShiftHandoff(
    handoff,
    "supervisor/next",
    "2026-08-08T15:58:00-07:00"
  );
  expect(partial.ok).toBe(true);
  if (!partial.ok) {
    throw new Error("first acknowledgement failed");
  }
  expect(partial.value.status).toBe("ready");
  expect(partial.value.workerContinuity).toBe("preserve");

  const complete = acknowledgeShiftHandoff(
    partial.value,
    "operator/portfolio",
    "2026-08-08T16:01:00-07:00"
  );
  expect(complete.ok).toBe(true);
  if (!complete.ok) {
    throw new Error("final acknowledgement failed");
  }
  expect(complete.value.status).toBe("acknowledged");
  expect(complete.value.acknowledgements).toHaveLength(2);
  expect(complete.value.workerContinuity).toBe("preserve");
});

test("handoff rejects malformed runtime status and actor identity", () => {
  const malformed = {
    acknowledgements: [],
    fromShiftId: "",
    openWorkItemIds: [""],
    preparedAt: "2026-08-08T15:55:00-07:00",
    requiredAcknowledgers: ["not an actor"],
    retrospective: { failures: [], improvements: [], outcomes: [] },
    risks: [],
    status: "silently-complete",
    summary: "Invalid runtime record",
    toShiftId: "shift/to",
    workerContinuity: "preserve",
  };
  expect(() => validateShiftHandoff(malformed)).not.toThrow();
  const result = validateShiftHandoff(malformed);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("malformed handoff unexpectedly passed");
  }
  expect(result.rejections.map((item) => item.path)).toEqual(
    expect.arrayContaining([
      "fromShiftId",
      "openWorkItemIds[0]",
      "status",
      "requiredAcknowledgers[0]",
    ])
  );

  const invalidPreparedAt = validateShiftHandoff({
    ...malformed,
    preparedAt: "2026-02-30T15:55:00-07:00",
    requiredAcknowledgers: ["supervisor/next"],
    status: "ready",
  });
  expect(invalidPreparedAt.ok).toBe(false);
  if (invalidPreparedAt.ok) {
    throw new Error("calendar-invalid preparedAt unexpectedly passed");
  }
  expect(invalidPreparedAt.rejections.map((item) => item.path)).toContain(
    "preparedAt"
  );
});

test("handoff acknowledgement rejects a calendar-invalid timestamp", () => {
  const handoff: ShiftHandoffRecord = {
    acknowledgements: [],
    fromShiftId: "shift/from" as ShiftId,
    openWorkItemIds: [],
    preparedAt: "2026-02-28T15:55:00Z",
    requiredAcknowledgers: ["supervisor/next"],
    retrospective: { failures: [], improvements: [], outcomes: [] },
    risks: [],
    status: "ready",
    summary: "Await acknowledgement.",
    toShiftId: "shift/to" as ShiftId,
    workerContinuity: "preserve",
  };
  const result = acknowledgeShiftHandoff(
    handoff,
    "supervisor/next",
    "2026-02-30T16:00:00Z"
  );
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("calendar-invalid acknowledgement unexpectedly passed");
  }
  expect(result.rejections[0]?.code).toBe("INVALID_TIMESTAMP");

  const persisted = validateShiftHandoff({
    ...handoff,
    acknowledgements: [
      {
        acknowledgedAt: "2026-02-30T16:00:00Z",
        actorId: "supervisor/next",
      },
    ],
    status: "acknowledged",
  });
  expect(persisted.ok).toBe(false);
  if (persisted.ok) {
    throw new Error("persisted calendar-invalid acknowledgement passed");
  }
  expect(persisted.rejections.map((item) => item.path)).toContain(
    "acknowledgements[0].acknowledgedAt"
  );
});
