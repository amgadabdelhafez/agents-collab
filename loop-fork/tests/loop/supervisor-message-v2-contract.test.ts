import { describe, expect, test } from "bun:test";
import {
  deriveSupervisorMessageV2BoardItemId,
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2Identity,
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2ReceiptId,
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  parseSupervisorMessageV2BoardItem,
  parseSupervisorMessageV2DeliveryEnvelope,
  parseSupervisorMessageV2GovernanceReceipt,
  parseSupervisorMessageV2GovernanceRequest,
  parseSupervisorMessageV2Input,
  parseSupervisorMessageV2Projection,
  parseSupervisorMessageV2ReplayFixture,
  parseSupervisorMessageV2State,
  SUPERVISOR_MESSAGE_V2_RESULT_GRAPH_WORKFLOW_ID_RE,
  type SupervisorMessageV2Projection,
  type SupervisorMessageV2State,
} from "../../src/loop/supervisor-message-v2-contract";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import { parseSupervisorMessageInput } from "../../src/loop/supervisor-message-workflow";

const fixture = structuredClone(supervisorMessageV2ReplayFixtures[0]);

if (!fixture) {
  throw new Error("missing V2 tenant-scope fixture");
}

/** The deployment discriminator (a host's Temporal task queue). */
const DEPLOYMENT = "contract-test-queue";

const historicalV1Input = {
  artifactRefs: [`artifact://sha256/${"d".repeat(64)}`],
  body: "Historical V1 input stays V1 until an explicit migration.",
  dedupeKey: "historical-v1",
  from: "supervisor:source",
  messageId: "message-historical-v1",
  policy: {
    claimTimeoutMs: 1000,
    escalationTimeoutMs: 2000,
    maxDeliveryAttempts: 2,
    retryDelayMs: 500,
  },
  receivedAt: "2026-09-20T05:00:00.000Z",
  threadId: "thread-historical-v1",
  to: "supervisor:target",
};

const projection = (): SupervisorMessageV2Projection => ({
  acknowledgedAt: null,
  actionRequired: "claim",
  artifactRefs: [...fixture.input.artifactRefs],
  claimedAt: null,
  claimedBy: null,
  deadLetteredAt: null,
  deliveredAt: fixture.input.receivedAt,
  deliveryAttempts: 1,
  escalatedAt: null,
  from: fixture.input.from,
  messageId: fixture.input.messageId,
  nextRetryAt: null,
  phase: "routed",
  principal: fixture.input.principal,
  receivedAt: fixture.input.receivedAt,
  schema: "supervisor-message-status.v2",
  tenantId: fixture.input.tenantId,
  threadId: fixture.input.threadId,
  to: fixture.input.to,
});

const state = (): SupervisorMessageV2State => ({
  acknowledgedAt: null,
  artifactRefs: [...fixture.input.artifactRefs],
  body: fixture.input.body,
  canceledAt: null,
  claimBy: "2026-09-20T03:40:01.000Z",
  claimedAt: null,
  claimedBy: null,
  deadLetteredAt: null,
  dedupeKey: fixture.input.dedupeKey,
  deliveredAt: fixture.input.receivedAt,
  deliveryAttempts: 1,
  deliveryStatus: "accepted",
  escalatedAt: null,
  escalationDeadline: null,
  events: [
    { at: fixture.input.receivedAt, kind: "received" },
    { at: fixture.input.receivedAt, kind: "persisted" },
    { at: fixture.input.receivedAt, kind: "routed" },
    { at: fixture.input.receivedAt, kind: "delivery-accepted" },
  ],
  from: fixture.input.from,
  lastFailure: null,
  messageId: fixture.input.messageId,
  nextRetryAt: null,
  phase: "routed",
  policy: { ...fixture.input.policy },
  principal: fixture.input.principal,
  receivedAt: fixture.input.receivedAt,
  schema: "supervisor-message-state.v2",
  tenantId: fixture.input.tenantId,
  threadId: fixture.input.threadId,
  to: fixture.input.to,
});

const workflowId = (): string =>
  deriveSupervisorMessageV2WorkflowId(
    fixture.expectedScope,
    fixture.input.dedupeKey,
    DEPLOYMENT
  );

const delivery = () => {
  const workflow = workflowId();
  const deliveryId = deriveSupervisorMessageV2DeliveryId(
    fixture.expectedScope,
    workflow,
    1
  );
  return {
    artifactRefs: [...fixture.input.artifactRefs],
    body: fixture.input.body,
    deliveryAttempt: 1,
    deliveryId,
    idempotencyKey: deliveryId,
    messageId: fixture.input.messageId,
    principal: fixture.input.principal,
    schema: "supervisor-message-delivery.v2" as const,
    target: fixture.input.to,
    tenantId: fixture.input.tenantId,
    threadId: fixture.input.threadId,
    workflowId: workflow,
  };
};

const governanceRequest = () => ({
  claimant: fixture.input.to,
  from: fixture.input.from,
  operation: "claim" as const,
  principal: fixture.input.principal,
  schema: "supervisor-message-governance-request.v2" as const,
  tenantId: fixture.input.tenantId,
  threadId: fixture.input.threadId,
  to: fixture.input.to,
  workflowId: workflowId(),
});

const governanceReceipt = () => {
  const request = governanceRequest();
  const authorityRef = "authority:allow";
  return {
    at: fixture.input.receivedAt,
    authorityRef,
    claimant: request.claimant,
    decision: "allowed" as const,
    from: request.from,
    operation: request.operation,
    principal: request.principal,
    reasonCode: "authorized",
    receiptId: deriveSupervisorMessageV2ReceiptId(
      fixture.expectedScope,
      request.workflowId,
      request.operation,
      authorityRef,
      request.claimant
    ),
    schema: "supervisor-message-governance-receipt.v2" as const,
    tenantId: request.tenantId,
    threadId: request.threadId,
    to: request.to,
    workflowId: request.workflowId,
  };
};

const boardItem = () => {
  const item = projection();
  const workflow = workflowId();
  return {
    ...item,
    boardItemId: deriveSupervisorMessageV2BoardItemId(
      fixture.expectedScope,
      workflow
    ),
    schema: "supervisor-message-board-item.v2" as const,
    workflowId: workflow,
  };
};

describe("SupervisorMessage V2 tenant contract", () => {
  test("accepts an exact V2 fixture only when its trusted scope matches", () => {
    expect(parseSupervisorMessageV2ReplayFixture(fixture)).toEqual(fixture);
  });

  test("rejects missing, mismatched, and unknown tenant scope before V1 parsing", () => {
    const { tenantId: _omittedTenant, ...missingTenant } = structuredClone(
      fixture.input
    );
    expect(() =>
      parseSupervisorMessageV2Input(missingTenant, fixture.expectedScope)
    ).toThrow("fields do not match");

    const mismatchedTenant = structuredClone(fixture.input);
    mismatchedTenant.tenantId = "tenant:other";
    expect(() =>
      parseSupervisorMessageV2Input(mismatchedTenant, fixture.expectedScope)
    ).toThrow("scope does not match");

    const mismatchedPrincipal = structuredClone(fixture.input);
    mismatchedPrincipal.principal = "principal:other";
    expect(() =>
      parseSupervisorMessageV2Input(mismatchedPrincipal, fixture.expectedScope)
    ).toThrow("scope does not match");

    expect(() =>
      parseSupervisorMessageV2Input(
        { ...fixture.input, unrecognized: true },
        fixture.expectedScope
      )
    ).toThrow("fields do not match");

    expect(() =>
      parseSupervisorMessageV2ReplayFixture({
        ...fixture,
        expectedScope: { ...fixture.expectedScope, unrecognized: true },
      })
    ).toThrow("expected scope fields are invalid");
  });

  test("does not infer tenant ownership for a V1 record", () => {
    const original = structuredClone(historicalV1Input);
    expect(parseSupervisorMessageInput(original)).toEqual(original);
    expect(() =>
      parseSupervisorMessageV2Input(original, fixture.expectedScope)
    ).toThrow("fields do not match");
    expect(parseSupervisorMessageInput(historicalV1Input)).toEqual(original);
  });

  test("parses an exact, body-free V2 projection under its trusted scope", () => {
    const input = projection();
    const parsed = parseSupervisorMessageV2Projection(
      input,
      fixture.expectedScope
    );

    expect(parsed).toEqual(input);
    parsed.artifactRefs.push(`artifact://sha256/${"e".repeat(64)}`);
    expect(input.artifactRefs).toEqual(fixture.input.artifactRefs);
  });

  test("refuses missing, unknown, and internally conflicting V2 projection fields", () => {
    const { phase: _phase, ...missingPhase } = projection();
    expect(() =>
      parseSupervisorMessageV2Projection(missingPhase, fixture.expectedScope)
    ).toThrow("fields do not match");

    expect(() =>
      parseSupervisorMessageV2Projection(
        { ...projection(), body: "V2 projections must remain body-free" },
        fixture.expectedScope
      )
    ).toThrow("fields do not match");

    expect(() =>
      parseSupervisorMessageV2Projection(
        { ...projection(), actionRequired: "none" },
        fixture.expectedScope
      )
    ).toThrow("actionRequired conflicts with phase");
  });

  test("refuses cross-tenant and cross-principal V2 projections", () => {
    const wrongTenant = projection();
    wrongTenant.tenantId = "tenant:other";
    expect(() =>
      parseSupervisorMessageV2Projection(wrongTenant, fixture.expectedScope)
    ).toThrow("scope does not match");

    const wrongPrincipal = projection();
    wrongPrincipal.principal = "principal:other";
    expect(() =>
      parseSupervisorMessageV2Projection(wrongPrincipal, fixture.expectedScope)
    ).toThrow("scope does not match");
  });

  test("parses only a scope-bound V2 state reachable from delivery lifecycle", () => {
    const input = state();
    const parsed = parseSupervisorMessageV2State(input, fixture.expectedScope);

    expect(parsed).toEqual(input);
    parsed.artifactRefs.push(`artifact://sha256/${"d".repeat(64)}`);
    expect(input.artifactRefs).toEqual(fixture.input.artifactRefs);
    parsed.events.push({ at: fixture.input.receivedAt, kind: "test-event" });
    expect(input.events).toHaveLength(4);
  });

  test("refuses impossible V2 state transitions and foreign state scope", () => {
    expect(() =>
      parseSupervisorMessageV2State(
        {
          ...state(),
          claimedAt: fixture.input.receivedAt,
          claimedBy: fixture.input.to,
          deliveredAt: null,
          deliveryStatus: "pending",
          phase: "claimed",
        },
        fixture.expectedScope
      )
    ).toThrow("claimed state is inconsistent");

    expect(() =>
      parseSupervisorMessageV2State(
        {
          ...state(),
          deliveryStatus: "retry-scheduled",
          nextRetryAt: null,
        },
        fixture.expectedScope
      )
    ).toThrow("retry state is inconsistent");

    expect(() =>
      parseSupervisorMessageV2State(
        {
          ...state(),
          events: [
            { at: fixture.input.receivedAt, kind: "received" },
            { at: fixture.input.receivedAt, kind: "persisted" },
            { at: fixture.input.receivedAt, kind: "routed" },
            { at: "2026-09-20T03:39:59.999Z", kind: "delivery-accepted" },
          ],
        },
        fixture.expectedScope
      )
    ).toThrow("events are not chronological");

    expect(() =>
      parseSupervisorMessageV2State(
        { ...state(), principal: "principal:foreign" },
        fixture.expectedScope
      )
    ).toThrow("scope does not match");
  });

  test("derives disjoint V2 identities for the same raw key in each scope", () => {
    const local = deriveSupervisorMessageV2Identity(
      fixture.expectedScope,
      fixture.input.dedupeKey,
      1,
      "claim",
      "authority:allow",
      fixture.input.to,
      DEPLOYMENT
    );
    const otherTenant = deriveSupervisorMessageV2Identity(
      { ...fixture.expectedScope, tenantId: "tenant:other" },
      fixture.input.dedupeKey,
      1,
      "claim",
      "authority:allow",
      fixture.input.to,
      DEPLOYMENT
    );
    const otherPrincipal = deriveSupervisorMessageV2Identity(
      { ...fixture.expectedScope, principal: "principal:other" },
      fixture.input.dedupeKey,
      1,
      "claim",
      "authority:allow",
      fixture.input.to,
      DEPLOYMENT
    );
    const otherClaimant = deriveSupervisorMessageV2Identity(
      fixture.expectedScope,
      fixture.input.dedupeKey,
      1,
      "claim",
      "authority:allow",
      "supervisor:other-claimant",
      DEPLOYMENT
    );

    expect(local.workflowId).not.toBe(otherTenant.workflowId);
    expect(local.workflowId).not.toBe(otherPrincipal.workflowId);
    expect(local.deliveryId).not.toBe(otherTenant.deliveryId);
    expect(local.receiptId).not.toBe(otherPrincipal.receiptId);
    expect(local.receiptId).not.toBe(otherClaimant.receiptId);
    expect(local.boardItemId).toMatch(/^supervisor-message-board-item:v2:/);
  });

  test("pins the legacy workflow id byte for byte, as rows and executions before the discriminator carry it", () => {
    // The value every pre-discriminator host derived for this fixture. A
    // change here would orphan in-flight executions and ledger rows.
    expect(
      deriveSupervisorMessageV2LegacyWorkflowId(
        fixture.expectedScope,
        fixture.input.dedupeKey
      )
    ).toBe(
      "supervisor-message-workflow:v2:7f52fd713e6acb1e3cbb1c20b2b86ce2eb3ca96c2c9eb7ce857798afff31e0af"
    );
  });

  test("derives a distinct workflow id per deployment, never the legacy id", () => {
    const scope = fixture.expectedScope;
    const key = fixture.input.dedupeKey;
    const here = deriveSupervisorMessageV2WorkflowId(scope, key, DEPLOYMENT);
    const there = deriveSupervisorMessageV2WorkflowId(
      scope,
      key,
      "another-deployment-queue"
    );
    expect(here).toMatch(
      /^supervisor-message-workflow:v2:deployment:[a-f0-9]{64}$/
    );
    expect(here).not.toBe(there);
    expect(here).not.toBe(
      deriveSupervisorMessageV2LegacyWorkflowId(scope, key)
    );
    // Stable: every host of one deployment derives the same id.
    expect(deriveSupervisorMessageV2WorkflowId(scope, key, DEPLOYMENT)).toBe(
      here
    );
    for (const deployment of ["", " queue", "queue/../x", undefined]) {
      expect(() =>
        deriveSupervisorMessageV2WorkflowId(
          scope,
          key,
          deployment as unknown as string
        )
      ).toThrow("SupervisorMessage V2 deployment is invalid");
    }
  });

  test("derives delivery, receipt, board and graph ids from either workflow id format", () => {
    const scope = fixture.expectedScope;
    const legacy = deriveSupervisorMessageV2LegacyWorkflowId(
      scope,
      fixture.input.dedupeKey
    );
    const current = workflowId();
    for (const id of [legacy, current]) {
      expect(deriveSupervisorMessageV2DeliveryId(scope, id, 1)).toMatch(
        /^supervisor-message-delivery:v2:[a-f0-9]{64}$/
      );
      expect(deriveSupervisorMessageV2BoardItemId(scope, id)).toMatch(
        /^supervisor-message-board-item:v2:/
      );
      expect(deriveSupervisorMessageV2ResultGraphWorkflowId(scope, id)).toMatch(
        SUPERVISOR_MESSAGE_V2_RESULT_GRAPH_WORKFLOW_ID_RE
      );
      expect(
        deriveSupervisorMessageV2ReceiptId(
          scope,
          id,
          "claim",
          "authority:allow",
          null
        )
      ).toMatch(/^supervisor-message-receipt:v2:/);
    }
    expect(deriveSupervisorMessageV2DeliveryId(scope, legacy, 1)).not.toBe(
      deriveSupervisorMessageV2DeliveryId(scope, current, 1)
    );
    // A legacy in-flight delivery envelope still parses.
    expect(
      parseSupervisorMessageV2DeliveryEnvelope(
        {
          ...delivery(),
          deliveryId: deriveSupervisorMessageV2DeliveryId(scope, legacy, 1),
          idempotencyKey: deriveSupervisorMessageV2DeliveryId(scope, legacy, 1),
          workflowId: legacy,
        },
        scope
      ).workflowId
    ).toBe(legacy);
    expect(() =>
      deriveSupervisorMessageV2DeliveryId(
        scope,
        `supervisor-message-workflow:v2:other:${"a".repeat(64)}`,
        1
      )
    ).toThrow("workflowId is invalid");
  });

  test("derives a message's result graph from its scoped identity alone", () => {
    const scope = fixture.expectedScope;
    const workflowId = deriveSupervisorMessageV2WorkflowId(
      scope,
      fixture.input.dedupeKey,
      DEPLOYMENT
    );
    const graph = deriveSupervisorMessageV2ResultGraphWorkflowId(
      scope,
      workflowId
    );
    expect(graph).toMatch(SUPERVISOR_MESSAGE_V2_RESULT_GRAPH_WORKFLOW_ID_RE);
    // Stable across calls: every host derives the same graph for a message.
    expect(
      deriveSupervisorMessageV2ResultGraphWorkflowId(scope, workflowId)
    ).toBe(graph);
    const otherMessage = deriveSupervisorMessageV2WorkflowId(
      scope,
      "other-key",
      DEPLOYMENT
    );
    for (const other of [
      deriveSupervisorMessageV2ResultGraphWorkflowId(
        { ...scope, tenantId: "tenant:other" },
        workflowId
      ),
      deriveSupervisorMessageV2ResultGraphWorkflowId(
        { ...scope, principal: "principal:other" },
        workflowId
      ),
      deriveSupervisorMessageV2ResultGraphWorkflowId(scope, otherMessage),
    ]) {
      expect(other).not.toBe(graph);
    }
    // Only a V2 message workflow id has a result graph.
    expect(() =>
      deriveSupervisorMessageV2ResultGraphWorkflowId(scope, "task-graph:any")
    ).toThrow();
  });

  test("parses only scope-bound V2 delivery, governance, receipt, and board contracts", () => {
    const parsedDelivery = parseSupervisorMessageV2DeliveryEnvelope(
      delivery(),
      fixture.expectedScope
    );
    expect(parsedDelivery).toEqual(delivery());

    const request = governanceRequest();
    const parsedRequest = parseSupervisorMessageV2GovernanceRequest(
      request,
      fixture.expectedScope
    );
    expect(parsedRequest).toEqual(request);
    expect(
      parseSupervisorMessageV2GovernanceReceipt(
        governanceReceipt(),
        fixture.expectedScope,
        parsedRequest
      )
    ).toEqual(governanceReceipt());
    expect(
      parseSupervisorMessageV2BoardItem(boardItem(), fixture.expectedScope)
    ).toEqual(boardItem());
  });

  test("refuses cross-scope and mismatched V2 delivery, receipt, and board identities", () => {
    expect(() =>
      parseSupervisorMessageV2DeliveryEnvelope(
        { ...delivery(), idempotencyKey: "different-key" },
        fixture.expectedScope
      )
    ).toThrow("delivery identity is inconsistent");

    expect(() =>
      parseSupervisorMessageV2DeliveryEnvelope(
        { ...delivery(), tenantId: "tenant:other" },
        fixture.expectedScope
      )
    ).toThrow("scope does not match");

    expect(() =>
      parseSupervisorMessageV2GovernanceReceipt(
        { ...governanceReceipt(), operation: "cancel" },
        fixture.expectedScope,
        governanceRequest()
      )
    ).toThrow("does not correlate");

    expect(() =>
      parseSupervisorMessageV2GovernanceReceipt(
        { ...governanceReceipt(), claimant: "supervisor:other-claimant" },
        fixture.expectedScope,
        governanceRequest()
      )
    ).toThrow("does not correlate");

    expect(() =>
      parseSupervisorMessageV2BoardItem(
        {
          ...boardItem(),
          boardItemId: deriveSupervisorMessageV2BoardItemId(
            { ...fixture.expectedScope, principal: "principal:other" },
            workflowId()
          ),
        },
        fixture.expectedScope
      )
    ).toThrow("board item identity is inconsistent");
  });
});
