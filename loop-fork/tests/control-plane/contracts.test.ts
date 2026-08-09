import { expect, test } from "bun:test";
import {
  AGENT_OPERATIONS_SCHEMA_VERSION,
  CLOUD_EVENTS_SPEC_VERSION,
  validateEnvelope,
  validateManagementRecord,
} from "../../src/control-plane/contracts";

const provenance = {
  producer: "supervisor/ai-cur",
  recordedAt: "2026-08-08T20:15:00Z",
  sha256: "a".repeat(64),
  source: "bridge/run-47/message-12",
};

const validEvent = {
  actor_id: "supervisor/ai-cur",
  authority: "report-incident",
  causation_id: "command/01J4ZP4FY7QPG8W7Q2SC2X1R8N",
  correlation_id: "work-item/WI-2026-0042",
  data: { reason: "assignment-timeout" },
  datacontenttype: "application/json",
  id: "01J4ZP6B3X1DMN7H0Q4JY8W2KT",
  idempotency_key: "incident/WI-2026-0042/assignment-timeout/1",
  kind: "event",
  lane_id: "product",
  project_id: "ai-cur",
  provenance,
  role_id: "project-supervisor@1",
  schema_version: AGENT_OPERATIONS_SCHEMA_VERSION,
  shift_id: "2026-08-08T16:00:00-07:00",
  source: "agentops://portfolio/main/project/ai-cur/supervisor",
  specversion: CLOUD_EVENTS_SPEC_VERSION,
  subject: "work-item/WI-2026-0042",
  time: "2026-08-08T20:15:00Z",
  type: "com.agentscollab.work-item.blocked.v1",
  workflow_id: "work-item/WI-2026-0042",
};

test("valid records and envelopes survive a JSON round-trip", () => {
  const project = {
    createdAt: "2026-08-08T19:00:00Z",
    id: "ai-cur",
    kind: "project",
    laneId: "product",
    name: "AI Curator",
    portfolioId: "main",
    provenance,
    schemaVersion: AGENT_OPERATIONS_SCHEMA_VERSION,
  };

  const projectResult = validateManagementRecord(
    JSON.parse(JSON.stringify(project))
  );
  expect(projectResult.ok).toBe(true);
  if (!projectResult.ok) {
    throw new Error("valid project record was rejected");
  }
  expect(JSON.stringify(projectResult.value)).toBe(JSON.stringify(project));

  const roundTripped = JSON.parse(JSON.stringify(validEvent));
  const envelopeResult = validateEnvelope(roundTripped, {
    laneId: "product",
    projectId: "ai-cur",
  });
  expect(envelopeResult.ok).toBe(true);
  if (!envelopeResult.ok) {
    throw new Error("valid event envelope was rejected");
  }
  expect(JSON.stringify(envelopeResult.value)).toBe(JSON.stringify(validEvent));
});

test("cross-lane envelopes are rejected fail closed", () => {
  const result = validateEnvelope(
    { ...validEvent, lane_id: "shared-harness" },
    { laneId: "product", projectId: "ai-cur" }
  );

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("cross-lane envelope unexpectedly validated");
  }
  expect(result.rejections).toContainEqual({
    actual: "shared-harness",
    code: "LANE_MISMATCH",
    expected: "product",
    message: "lane_id does not match declared lane",
    path: "lane_id",
  });
});

test("untrusted malformed input returns stable rejections without throwing", () => {
  expect(() =>
    validateEnvelope({
      kind: "event",
      schema_version: "agentops/v99",
      specversion: "0.3",
      time: "not-a-time",
    })
  ).not.toThrow();

  const result = validateEnvelope({
    kind: "event",
    schema_version: "agentops/v99",
    specversion: "0.3",
    time: "not-a-time",
  });
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("malformed envelope unexpectedly validated");
  }
  expect(result.rejections.map(({ code, path }) => ({ code, path }))).toEqual(
    expect.arrayContaining([
      { code: "UNSUPPORTED_SCHEMA_VERSION", path: "schema_version" },
      { code: "UNSUPPORTED_SPEC_VERSION", path: "specversion" },
      { code: "MISSING_IDENTITY", path: "id" },
      { code: "MALFORMED_TIMESTAMP", path: "time" },
      { code: "MISSING_IDENTITY", path: "project_id" },
      { code: "MISSING_IDENTITY", path: "lane_id" },
    ])
  );
});

test("timestamp validation rejects calendar rollover and accepts a real leap day", () => {
  const invalid = validateEnvelope({
    ...validEvent,
    time: "2026-02-30T00:00:00Z",
  });
  expect(invalid.ok).toBe(false);
  if (invalid.ok) {
    throw new Error("calendar-invalid timestamp unexpectedly validated");
  }
  expect(invalid.rejections).toContainEqual({
    actual: "2026-02-30T00:00:00Z",
    code: "MALFORMED_TIMESTAMP",
    message: "time must be an ISO 8601 timestamp with a timezone",
    path: "time",
  });

  const leapDay = validateEnvelope({
    ...validEvent,
    time: "2024-02-29T00:00:00Z",
  });
  expect(leapDay.ok).toBe(true);
});
