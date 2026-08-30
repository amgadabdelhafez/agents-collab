import { createHash } from "node:crypto";
import {
  SupervisorMessageCoordinator,
  type SupervisorMessageDeliveryOutcome,
  type SupervisorMessageDeliveryPort,
} from "./supervisor-message-coordinator";
import type {
  SupervisorMessageDeliveryRequest,
  SupervisorMessageInput,
  SupervisorMessageProjection,
} from "./supervisor-message-workflow";
import type {
  JsonObject,
  JsonValue,
  WorkflowExecutionStatus,
  WorkflowInspection,
  WorkflowPort,
} from "./workflow-port";

export type SupervisorMessageReplayStep =
  | { kind: "receive"; requestId: string }
  | { at: string; kind: "set-clock" }
  | { kind: "restart-worker" }
  | { kind: "upgrade-worker"; version: string }
  | { kind: "tick"; requestId: string }
  | { claimant: string; kind: "claim"; requestId: string }
  | { claimant: string; kind: "acknowledge"; requestId: string }
  | { kind: "cancel"; reason: string; requestId: string };

export interface SupervisorMessageReplayExpected extends JsonObject {
  deliveryIdempotencyKeys: string[];
  eventKinds: string[];
  executionStatus: WorkflowExecutionStatus;
  historyLength: number;
  phase: string;
  revision: number;
}

export interface SupervisorMessageReplayFixture extends JsonObject {
  deliveryOutcomes: SupervisorMessageDeliveryOutcome[];
  expected: SupervisorMessageReplayExpected;
  expectedDigest: string;
  id: string;
  input: SupervisorMessageInput;
  steps: SupervisorMessageReplayStep[];
}

export interface SupervisorMessageReplayRuntime {
  deliveries(): readonly SupervisorMessageDeliveryRequest[];
  readonly delivery: SupervisorMessageDeliveryPort;
  restartWorker(): Promise<void> | void;
  setClock(at: string): Promise<void> | void;
  setDeliveryOutcomes(
    outcomes: readonly SupervisorMessageDeliveryOutcome[]
  ): Promise<void> | void;
  upgradeWorker(version: string): Promise<void> | void;
  workflowPort(): WorkflowPort;
}

export interface ReplayDeliveryObservation extends JsonObject {
  artifactRefs: string[];
  idempotencyKey: string;
  messageId: string;
  target: string;
  threadId: string;
}

export interface ReplayStepObservation extends JsonObject {
  created?: boolean;
  kind: SupervisorMessageReplayStep["kind"];
  projection?: SupervisorMessageProjection;
  requestId?: string;
  version?: string;
  workflowId?: string;
}

export interface SupervisorMessageReplayResult extends JsonObject {
  deliveries: ReplayDeliveryObservation[];
  digest: string;
  eventKinds: string[];
  fixtureId: string;
  inspection: WorkflowInspection;
  projection: SupervisorMessageProjection;
  steps: ReplayStepObservation[];
}

export interface SupervisorMessageReplayCorpusResult extends JsonObject {
  aggregateDigest: string;
  cases: SupervisorMessageReplayResult[];
  schema: "supervisor-message-replay-corpus.v1";
}

export class WorkflowReplayMismatchError extends Error {
  readonly fixtureId: string;

  constructor(fixtureId: string, message: string) {
    super(`replay fixture ${fixtureId}: ${message}`);
    this.name = "WorkflowReplayMismatchError";
    this.fixtureId = fixtureId;
  }
}

const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
};

export const canonicalReplayJson = (value: JsonValue): string =>
  JSON.stringify(canonicalize(value));

export const replayStructuralDigest = (value: JsonValue): string =>
  createHash("sha256").update(canonicalReplayJson(value)).digest("hex");

const safeDeliveryObservation = (
  request: SupervisorMessageDeliveryRequest
): ReplayDeliveryObservation => ({
  artifactRefs: [...request.artifactRefs],
  idempotencyKey: request.idempotencyKey,
  messageId: request.messageId,
  target: request.target,
  threadId: request.threadId,
});

const requireEqual = (
  fixtureId: string,
  field: string,
  actual: JsonValue,
  expected: JsonValue
): void => {
  if (canonicalReplayJson(actual) !== canonicalReplayJson(expected)) {
    throw new WorkflowReplayMismatchError(
      fixtureId,
      `${field} mismatch: expected ${canonicalReplayJson(
        expected
      )}, received ${canonicalReplayJson(actual)}`
    );
  }
};

const validateResult = (
  fixture: SupervisorMessageReplayFixture,
  result: SupervisorMessageReplayResult
): void => {
  const expected = fixture.expected;
  requireEqual(
    fixture.id,
    "delivery idempotency keys",
    result.deliveries.map((delivery) => delivery.idempotencyKey),
    expected.deliveryIdempotencyKeys
  );
  requireEqual(
    fixture.id,
    "event kinds",
    result.eventKinds,
    expected.eventKinds
  );
  requireEqual(
    fixture.id,
    "execution status",
    result.inspection.status,
    expected.executionStatus
  );
  requireEqual(
    fixture.id,
    "history length",
    result.inspection.history.length,
    expected.historyLength
  );
  requireEqual(fixture.id, "phase", result.projection.phase, expected.phase);
  requireEqual(
    fixture.id,
    "revision",
    result.inspection.revision,
    expected.revision
  );
  if (fixture.expectedDigest) {
    requireEqual(
      fixture.id,
      "structural digest",
      result.digest,
      fixture.expectedDigest
    );
  }
};

export const runSupervisorMessageReplayFixture = async (
  fixture: SupervisorMessageReplayFixture,
  runtime: SupervisorMessageReplayRuntime
): Promise<SupervisorMessageReplayResult> => {
  await runtime.setDeliveryOutcomes(fixture.deliveryOutcomes);
  let coordinator = new SupervisorMessageCoordinator(
    runtime.workflowPort(),
    runtime.delivery
  );
  let workflowId: string | undefined;
  const observations: ReplayStepObservation[] = [];

  for (const step of fixture.steps) {
    if (step.kind === "set-clock") {
      await runtime.setClock(step.at);
      observations.push({ kind: step.kind });
      continue;
    }
    if (step.kind === "restart-worker") {
      await runtime.restartWorker();
      coordinator = new SupervisorMessageCoordinator(
        runtime.workflowPort(),
        runtime.delivery
      );
      observations.push({ kind: step.kind });
      continue;
    }
    if (step.kind === "upgrade-worker") {
      await runtime.upgradeWorker(step.version);
      coordinator = new SupervisorMessageCoordinator(
        runtime.workflowPort(),
        runtime.delivery
      );
      observations.push({ kind: step.kind, version: step.version });
      continue;
    }
    if (step.kind === "receive") {
      const received = await coordinator.receive(fixture.input, step.requestId);
      workflowId = received.workflowId;
      observations.push({
        created: received.created,
        kind: step.kind,
        projection: received.projection,
        requestId: step.requestId,
        workflowId,
      });
      continue;
    }
    if (!workflowId) {
      throw new WorkflowReplayMismatchError(
        fixture.id,
        `${step.kind} occurred before receive`
      );
    }
    let projection: SupervisorMessageProjection;
    if (step.kind === "tick") {
      projection = await coordinator.tick(workflowId, step.requestId);
    } else if (step.kind === "claim") {
      projection = await coordinator.claim(
        workflowId,
        step.claimant,
        step.requestId
      );
    } else if (step.kind === "acknowledge") {
      projection = await coordinator.acknowledge(
        workflowId,
        step.claimant,
        step.requestId
      );
    } else {
      projection = await coordinator.cancel(
        workflowId,
        step.reason,
        step.requestId
      );
    }
    observations.push({
      kind: step.kind,
      projection,
      requestId: step.requestId,
      workflowId,
    });
  }

  if (!workflowId) {
    throw new WorkflowReplayMismatchError(fixture.id, "fixture never received");
  }
  const workflows = runtime.workflowPort();
  const inspection = await workflows.inspect(workflowId);
  const projection = (await workflows.query({ name: "status", workflowId }))
    .value as SupervisorMessageProjection;
  const eventKinds = (
    await workflows.query({ name: "event_kinds", workflowId })
  ).value as string[];
  const resultWithoutDigest = {
    deliveries: runtime.deliveries().map(safeDeliveryObservation),
    eventKinds,
    fixtureId: fixture.id,
    inspection,
    projection,
    steps: observations,
  };
  const result: SupervisorMessageReplayResult = {
    ...resultWithoutDigest,
    digest: replayStructuralDigest(resultWithoutDigest),
  };
  validateResult(fixture, result);
  return result;
};

export const runSupervisorMessageReplayCorpus = async (
  fixtures: readonly SupervisorMessageReplayFixture[],
  runtimeFactory: (
    fixture: SupervisorMessageReplayFixture
  ) => Promise<SupervisorMessageReplayRuntime> | SupervisorMessageReplayRuntime
): Promise<SupervisorMessageReplayCorpusResult> => {
  const cases: SupervisorMessageReplayResult[] = [];
  for (const fixture of fixtures) {
    cases.push(
      await runSupervisorMessageReplayFixture(
        fixture,
        await runtimeFactory(fixture)
      )
    );
  }
  return {
    aggregateDigest: replayStructuralDigest(
      cases.map(({ digest, fixtureId }) => ({ digest, fixtureId }))
    ),
    cases,
    schema: "supervisor-message-replay-corpus.v1",
  };
};
