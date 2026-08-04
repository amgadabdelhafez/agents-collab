import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SAFE_REPO_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

type JsonRecord = Record<string, unknown>;

interface ExecutionBindings {
  metricsExtractorSha256: string;
  model: string;
  promptSha256: string;
  reasoningEffort: string;
  replayCorpusSha256: string;
  toolConfigSha256: string;
}

interface RegisteredCase {
  id: string;
  inputSha256: string;
}

interface GateThresholds {
  maxAmbiguousVerdictsPerArm: number;
  maxCorrectionChurnUpperDelta: number;
  maxLatencyRatio: number;
  maxNewFailures: number;
  maxSuccessRateDrop: number;
  maxTokenRatio: number;
  maxToolCallRatio: number;
  minCandidateSuccessRate: number;
}

interface ReplayRegistration {
  baselineHarnessSha: string;
  bindings: ExecutionBindings;
  candidateHarnessSha: string;
  cases: RegisteredCase[];
  gates: GateThresholds;
  registeredAt: string;
  registeredBy: string;
  registrationId: string;
  schemaVersion: 1;
}

interface ReviewStamp {
  registrationCommitSha: string;
  registrationPath: string;
  registrationSha256: string;
  reviewedAt: string;
  reviewer: string;
  schemaVersion: 1;
  verdict: "CONCUR";
}

interface QualityObservation {
  overclaimsRetracted: {
    driverSelfRetractions: { count: number };
    reviewerDisproofs: { count: number };
  };
  reviewerChangesRoundsBeforeFinalApprove: {
    count: number;
    upperBound: number;
  };
}

interface CaseObservation extends RegisteredCase {
  latencyMs: number;
  quality: QualityObservation;
  success: boolean;
  tokens: number;
  toolCalls: number;
}

interface ReplayArm {
  cases: CaseObservation[];
  harnessSha: string;
}

interface ReplayObservations {
  arms: { baseline: ReplayArm; candidate: ReplayArm };
  bindings: ExecutionBindings;
  completedAt: string;
  registrationId: string;
  schemaVersion: 1;
  startedAt: string;
}

export interface ReplayArmMetrics {
  ambiguousVerdicts: number;
  correctionChurnCount: number;
  correctionChurnUpperBound: number;
  latencyMs: number;
  successCount: number;
  successRate: number;
  tokens: number;
  toolCalls: number;
  totalCases: number;
}

export interface ReplayReleaseGateResult {
  failures: string[];
  metrics?: {
    baseline: ReplayArmMetrics;
    candidate: ReplayArmMetrics;
    deltas: {
      correctionChurnUpper: number;
      latencyRatio: number | null;
      newFailures: string[];
      successRate: number;
      tokenRatio: number | null;
      toolCallRatio: number | null;
    };
  };
  ok: boolean;
  registrationSha256: string;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;

const nonNegativeInteger = (value: unknown): value is number =>
  finiteNonNegative(value) && Number.isSafeInteger(value);

const validDate = (value: unknown): value is string =>
  nonEmptyString(value) && Number.isFinite(Date.parse(value));

const readBindings = (
  value: unknown,
  path: string,
  failures: string[]
): ExecutionBindings | undefined => {
  if (!isRecord(value)) {
    failures.push(`${path} must be an object`);
    return;
  }
  const keys: (keyof ExecutionBindings)[] = [
    "model",
    "reasoningEffort",
    "promptSha256",
    "toolConfigSha256",
    "replayCorpusSha256",
    "metricsExtractorSha256",
  ];
  for (const key of keys) {
    if (!nonEmptyString(value[key])) {
      failures.push(`${path}.${key} must be a non-empty string`);
    }
  }
  for (const key of keys.slice(2)) {
    const candidate = value[key];
    if (nonEmptyString(candidate) && !SHA256_RE.test(candidate)) {
      failures.push(`${path}.${key} must be a lowercase SHA-256`);
    }
  }
  if (failures.some((failure) => failure.startsWith(`${path}.`))) {
    return;
  }
  return value as unknown as ExecutionBindings;
};

const readRegisteredCases = (
  value: unknown,
  path: string,
  failures: string[]
): RegisteredCase[] | undefined => {
  if (!(Array.isArray(value) && value.length > 0)) {
    failures.push(`${path} must be a non-empty array`);
    return;
  }
  const seen = new Set<string>();
  const cases: RegisteredCase[] = [];
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      failures.push(`${itemPath} must be an object`);
      continue;
    }
    if (!nonEmptyString(item.id)) {
      failures.push(`${itemPath}.id must be a non-empty string`);
      continue;
    }
    if (seen.has(item.id)) {
      failures.push(`${path} contains duplicate id ${item.id}`);
    }
    seen.add(item.id);
    if (
      !(nonEmptyString(item.inputSha256) && SHA256_RE.test(item.inputSha256))
    ) {
      failures.push(`${itemPath}.inputSha256 must be a lowercase SHA-256`);
      continue;
    }
    cases.push({ id: item.id, inputSha256: item.inputSha256 });
  }
  return cases.length === value.length ? cases : undefined;
};

const readGates = (
  value: unknown,
  failures: string[]
): GateThresholds | undefined => {
  if (!isRecord(value)) {
    failures.push("registration.gates must be an object");
    return;
  }
  const ratioKeys = [
    "maxTokenRatio",
    "maxToolCallRatio",
    "maxLatencyRatio",
  ] as const;
  for (const key of ratioKeys) {
    if (!(finiteNonNegative(value[key]) && value[key] > 0)) {
      failures.push(
        `registration.gates.${key} must be finite and greater than zero`
      );
    }
  }
  for (const key of [
    "minCandidateSuccessRate",
    "maxSuccessRateDrop",
  ] as const) {
    if (!(finiteNonNegative(value[key]) && value[key] <= 1)) {
      failures.push(`registration.gates.${key} must be between zero and one`);
    }
  }
  for (const key of [
    "maxCorrectionChurnUpperDelta",
    "maxAmbiguousVerdictsPerArm",
    "maxNewFailures",
  ] as const) {
    if (!nonNegativeInteger(value[key])) {
      failures.push(`registration.gates.${key} must be a non-negative integer`);
    }
  }
  if (failures.some((failure) => failure.startsWith("registration.gates."))) {
    return;
  }
  return value as unknown as GateThresholds;
};

const readRegistration = (
  value: unknown,
  failures: string[]
): ReplayRegistration | undefined => {
  if (!isRecord(value)) {
    failures.push("registration must be an object");
    return;
  }
  if (value.schemaVersion !== 1) {
    failures.push("registration.schemaVersion must equal 1");
  }
  for (const key of ["registrationId", "registeredBy"] as const) {
    if (!nonEmptyString(value[key])) {
      failures.push(`registration.${key} must be a non-empty string`);
    }
  }
  if (!validDate(value.registeredAt)) {
    failures.push("registration.registeredAt must be an ISO timestamp");
  }
  for (const key of ["baselineHarnessSha", "candidateHarnessSha"] as const) {
    if (!(nonEmptyString(value[key]) && GIT_SHA_RE.test(value[key]))) {
      failures.push(`registration.${key} must be a full lowercase git SHA`);
    }
  }
  if (
    nonEmptyString(value.baselineHarnessSha) &&
    value.baselineHarnessSha === value.candidateHarnessSha
  ) {
    failures.push("baseline and candidate harness SHAs must differ");
  }
  const bindings = readBindings(
    value.bindings,
    "registration.bindings",
    failures
  );
  const cases = readRegisteredCases(
    value.cases,
    "registration.cases",
    failures
  );
  const gates = readGates(value.gates, failures);
  if (!(bindings && cases && gates) || failures.length > 0) {
    return;
  }
  return {
    ...(value as unknown as ReplayRegistration),
    bindings,
    cases,
    gates,
  };
};

const readStamp = (
  value: unknown,
  failures: string[]
): ReviewStamp | undefined => {
  if (!isRecord(value)) {
    failures.push("stamp must be an object");
    return;
  }
  if (value.schemaVersion !== 1) {
    failures.push("stamp.schemaVersion must equal 1");
  }
  if (value.verdict !== "CONCUR") {
    failures.push("stamp.verdict must equal CONCUR");
  }
  if (
    !(
      nonEmptyString(value.registrationSha256) &&
      SHA256_RE.test(value.registrationSha256)
    )
  ) {
    failures.push("stamp.registrationSha256 must be a lowercase SHA-256");
  }
  if (
    !(
      nonEmptyString(value.registrationCommitSha) &&
      GIT_SHA_RE.test(value.registrationCommitSha)
    )
  ) {
    failures.push(
      "stamp.registrationCommitSha must be a full lowercase git SHA"
    );
  }
  if (
    !(
      nonEmptyString(value.registrationPath) &&
      SAFE_REPO_PATH_RE.test(value.registrationPath)
    )
  ) {
    failures.push(
      "stamp.registrationPath must be a safe repository-relative path"
    );
  }
  if (!nonEmptyString(value.reviewer)) {
    failures.push("stamp.reviewer must be a non-empty string");
  }
  if (!validDate(value.reviewedAt)) {
    failures.push("stamp.reviewedAt must be an ISO timestamp");
  }
  return failures.some((failure) => failure.startsWith("stamp."))
    ? undefined
    : (value as unknown as ReviewStamp);
};

const readQuality = (
  value: unknown,
  path: string,
  failures: string[]
): QualityObservation | undefined => {
  if (!isRecord(value)) {
    failures.push(`${path} must be an object`);
    return;
  }
  const changes = value.reviewerChangesRoundsBeforeFinalApprove;
  const retracted = value.overclaimsRetracted;
  if (!isRecord(changes)) {
    failures.push(
      `${path}.reviewerChangesRoundsBeforeFinalApprove must be an object`
    );
  }
  if (!isRecord(retracted)) {
    failures.push(`${path}.overclaimsRetracted must be an object`);
  }
  const driver = isRecord(retracted)
    ? retracted.driverSelfRetractions
    : undefined;
  const reviewer = isRecord(retracted)
    ? retracted.reviewerDisproofs
    : undefined;
  if (!isRecord(driver)) {
    failures.push(
      `${path}.overclaimsRetracted.driverSelfRetractions must be an object`
    );
  }
  if (!isRecord(reviewer)) {
    failures.push(
      `${path}.overclaimsRetracted.reviewerDisproofs must be an object`
    );
  }
  const values = {
    changes: isRecord(changes) ? changes.count : undefined,
    upper: isRecord(changes) ? changes.upperBound : undefined,
    driver: isRecord(driver) ? driver.count : undefined,
    reviewer: isRecord(reviewer) ? reviewer.count : undefined,
  };
  for (const [key, count] of Object.entries(values)) {
    if (!nonNegativeInteger(count)) {
      failures.push(`${path}.${key} must be a non-negative integer`);
    }
  }
  if (
    nonNegativeInteger(values.changes) &&
    nonNegativeInteger(values.upper) &&
    values.upper < values.changes
  ) {
    failures.push(`${path} CHANGES upperBound cannot be below count`);
  }
  return failures.some((failure) => failure.startsWith(path))
    ? undefined
    : (value as unknown as QualityObservation);
};

const readObservedCases = (
  value: unknown,
  path: string,
  failures: string[]
): CaseObservation[] | undefined => {
  if (!Array.isArray(value)) {
    failures.push(`${path} must be an array`);
    return;
  }
  const seen = new Set<string>();
  const cases: CaseObservation[] = [];
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      failures.push(`${itemPath} must be an object`);
      continue;
    }
    if (!nonEmptyString(item.id)) {
      failures.push(`${itemPath}.id must be a non-empty string`);
    } else if (seen.has(item.id)) {
      failures.push(`${path} contains duplicate id ${item.id}`);
    } else {
      seen.add(item.id);
    }
    if (
      !(nonEmptyString(item.inputSha256) && SHA256_RE.test(item.inputSha256))
    ) {
      failures.push(`${itemPath}.inputSha256 must be a lowercase SHA-256`);
    }
    if (typeof item.success !== "boolean") {
      failures.push(`${itemPath}.success must be boolean`);
    }
    for (const key of ["tokens", "toolCalls"] as const) {
      if (!nonNegativeInteger(item[key])) {
        failures.push(`${itemPath}.${key} must be a non-negative integer`);
      }
    }
    if (!finiteNonNegative(item.latencyMs)) {
      failures.push(`${itemPath}.latencyMs must be finite and non-negative`);
    }
    const quality = readQuality(item.quality, `${itemPath}.quality`, failures);
    if (
      quality &&
      nonEmptyString(item.id) &&
      nonEmptyString(item.inputSha256)
    ) {
      cases.push({ ...(item as unknown as CaseObservation), quality });
    }
  }
  return failures.some((failure) => failure.startsWith(path))
    ? undefined
    : cases;
};

const readObservations = (
  value: unknown,
  failures: string[]
): ReplayObservations | undefined => {
  if (!isRecord(value)) {
    failures.push("observations must be an object");
    return;
  }
  if (value.schemaVersion !== 1) {
    failures.push("observations.schemaVersion must equal 1");
  }
  if (!nonEmptyString(value.registrationId)) {
    failures.push("observations.registrationId must be a non-empty string");
  }
  for (const key of ["startedAt", "completedAt"] as const) {
    if (!validDate(value[key])) {
      failures.push(`observations.${key} must be an ISO timestamp`);
    }
  }
  const bindings = readBindings(
    value.bindings,
    "observations.bindings",
    failures
  );
  if (!isRecord(value.arms)) {
    failures.push("observations.arms must be an object");
    return;
  }
  const arms: Partial<ReplayObservations["arms"]> = {};
  for (const name of ["baseline", "candidate"] as const) {
    const rawArm = value.arms[name];
    const armPath = `observations.arms.${name}`;
    if (!isRecord(rawArm)) {
      failures.push(`${armPath} must be an object`);
      continue;
    }
    if (
      !(nonEmptyString(rawArm.harnessSha) && GIT_SHA_RE.test(rawArm.harnessSha))
    ) {
      failures.push(`${armPath}.harnessSha must be a full lowercase git SHA`);
    }
    const cases = readObservedCases(rawArm.cases, `${armPath}.cases`, failures);
    if (cases && nonEmptyString(rawArm.harnessSha)) {
      arms[name] = { cases, harnessSha: rawArm.harnessSha };
    }
  }
  if (!(bindings && arms.baseline && arms.candidate) || failures.length > 0) {
    return;
  }
  return {
    ...(value as unknown as ReplayObservations),
    arms: arms as ReplayObservations["arms"],
    bindings,
  };
};

const sameBindings = (
  left: ExecutionBindings,
  right: ExecutionBindings
): string[] =>
  (Object.keys(left) as (keyof ExecutionBindings)[]).filter(
    (key) => left[key] !== right[key]
  );

const validateCaseSet = (
  registration: ReplayRegistration,
  arm: ReplayArm,
  name: "baseline" | "candidate",
  failures: string[]
): void => {
  const registered = new Map(
    registration.cases.map((item) => [item.id, item.inputSha256])
  );
  const observed = new Map(
    arm.cases.map((item) => [item.id, item.inputSha256])
  );
  for (const [id, hash] of registered) {
    if (!observed.has(id)) {
      failures.push(`${name} is missing registered case ${id}`);
    } else if (observed.get(id) !== hash) {
      failures.push(
        `${name} case ${id} input hash does not match registration`
      );
    }
  }
  for (const id of observed.keys()) {
    if (!registered.has(id)) {
      failures.push(`${name} contains unregistered case ${id}`);
    }
  }
};

const deriveArmMetrics = (arm: ReplayArm): ReplayArmMetrics => {
  const totalCases = arm.cases.length;
  let successCount = 0;
  let tokens = 0;
  let toolCalls = 0;
  let latencyMs = 0;
  let changesCount = 0;
  let changesUpper = 0;
  let driverRetractions = 0;
  let reviewerDisproofs = 0;
  for (const item of arm.cases) {
    successCount += item.success ? 1 : 0;
    tokens += item.tokens;
    toolCalls += item.toolCalls;
    latencyMs += item.latencyMs;
    const quality = item.quality;
    changesCount += quality.reviewerChangesRoundsBeforeFinalApprove.count;
    changesUpper += quality.reviewerChangesRoundsBeforeFinalApprove.upperBound;
    driverRetractions +=
      quality.overclaimsRetracted.driverSelfRetractions.count;
    reviewerDisproofs += quality.overclaimsRetracted.reviewerDisproofs.count;
  }
  return {
    ambiguousVerdicts: changesUpper - changesCount,
    correctionChurnCount: changesCount + driverRetractions + reviewerDisproofs,
    correctionChurnUpperBound:
      changesUpper + driverRetractions + reviewerDisproofs,
    latencyMs,
    successCount,
    successRate: totalCases === 0 ? 0 : successCount / totalCases,
    tokens,
    toolCalls,
    totalCases,
  };
};

const validateDerivedMetrics = (
  name: "baseline" | "candidate",
  metrics: ReplayArmMetrics,
  failures: string[]
): void => {
  for (const key of [
    "tokens",
    "toolCalls",
    "latencyMs",
    "correctionChurnCount",
    "correctionChurnUpperBound",
  ] as const) {
    if (!finiteNonNegative(metrics[key])) {
      failures.push(`${name} derived ${key} exceeds the safe numeric range`);
    }
  }
};

const ratio = (candidate: number, baseline: number): number | null => {
  if (baseline === 0) {
    return candidate === 0 ? 1 : null;
  }
  return candidate / baseline;
};

const checkRatio = (
  label: string,
  candidate: number,
  baseline: number,
  maximum: number,
  failures: string[]
): number | null => {
  const value = ratio(candidate, baseline);
  if (value === null) {
    failures.push(
      `${label} has positive candidate total with zero baseline denominator`
    );
  } else if (value > maximum) {
    failures.push(
      `${label} ratio ${value} exceeds preregistered maximum ${maximum}`
    );
  }
  return value;
};

export const sha256Bytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const validateRegistrationProvenance = (
  input: {
    committedRegistrationBytes?: Uint8Array;
    registrationBytes: Uint8Array;
    registrationCommittedAt?: string;
  },
  registration: ReplayRegistration,
  stamp: ReviewStamp,
  registrationSha256: string,
  failures: string[]
): void => {
  if (stamp.registrationSha256 !== registrationSha256) {
    failures.push("review stamp does not bind the exact registration bytes");
  }
  if (!input.committedRegistrationBytes) {
    failures.push(
      "registered bytes could not be verified from the stamped git commit"
    );
  } else if (
    !Buffer.from(input.committedRegistrationBytes).equals(
      Buffer.from(input.registrationBytes)
    )
  ) {
    failures.push(
      "stamped git commit does not contain the exact registration bytes"
    );
  }
  if (!validDate(input.registrationCommittedAt)) {
    failures.push("registration commit timestamp could not be verified");
  } else if (
    Date.parse(stamp.reviewedAt) < Date.parse(input.registrationCommittedAt)
  ) {
    failures.push("review stamp predates the registration commit");
  }
  if (stamp.reviewer === registration.registeredBy) {
    failures.push("reviewer must differ from the registration author");
  }
  if (Date.parse(stamp.reviewedAt) < Date.parse(registration.registeredAt)) {
    failures.push("review stamp predates registration");
  }
};

const validateObservationProvenance = (
  registration: ReplayRegistration,
  stamp: ReviewStamp,
  observations: ReplayObservations,
  failures: string[]
): void => {
  if (Date.parse(observations.startedAt) <= Date.parse(stamp.reviewedAt)) {
    failures.push("measurement must start after the reviewer stamp");
  }
  if (
    Date.parse(observations.completedAt) < Date.parse(observations.startedAt)
  ) {
    failures.push("measurement completedAt predates startedAt");
  }
  if (observations.registrationId !== registration.registrationId) {
    failures.push("observation registrationId does not match registration");
  }
  for (const key of sameBindings(
    registration.bindings,
    observations.bindings
  )) {
    failures.push(`observation binding ${key} does not match registration`);
  }
  if (
    observations.arms.baseline.harnessSha !== registration.baselineHarnessSha
  ) {
    failures.push("baseline harness SHA does not match registration");
  }
  if (
    observations.arms.candidate.harnessSha !== registration.candidateHarnessSha
  ) {
    failures.push("candidate harness SHA does not match registration");
  }
  validateCaseSet(
    registration,
    observations.arms.baseline,
    "baseline",
    failures
  );
  validateCaseSet(
    registration,
    observations.arms.candidate,
    "candidate",
    failures
  );
};

export const evaluateReplayReleaseGate = (input: {
  committedRegistrationBytes?: Uint8Array;
  observations: unknown;
  registration: unknown;
  registrationBytes: Uint8Array;
  registrationCommittedAt?: string;
  stamp: unknown;
}): ReplayReleaseGateResult => {
  const failures: string[] = [];
  const registrationSha256 = sha256Bytes(input.registrationBytes);
  const registration = readRegistration(input.registration, failures);
  const stamp = readStamp(input.stamp, failures);
  const observations = readObservations(input.observations, failures);
  if (!(registration && stamp && observations)) {
    return { failures, ok: false, registrationSha256 };
  }

  validateRegistrationProvenance(
    input,
    registration,
    stamp,
    registrationSha256,
    failures
  );
  validateObservationProvenance(registration, stamp, observations, failures);

  const baseline = deriveArmMetrics(observations.arms.baseline);
  const candidate = deriveArmMetrics(observations.arms.candidate);
  validateDerivedMetrics("baseline", baseline, failures);
  validateDerivedMetrics("candidate", candidate, failures);
  const successRateDelta = candidate.successRate - baseline.successRate;
  if (candidate.successRate < registration.gates.minCandidateSuccessRate) {
    failures.push(
      `candidate success rate ${candidate.successRate} is below preregistered minimum ${registration.gates.minCandidateSuccessRate}`
    );
  }
  if (
    baseline.successRate - candidate.successRate >
    registration.gates.maxSuccessRateDrop
  ) {
    failures.push(
      `candidate success-rate drop ${baseline.successRate - candidate.successRate} exceeds preregistered maximum ${registration.gates.maxSuccessRateDrop}`
    );
  }
  const tokenRatio = checkRatio(
    "token use",
    candidate.tokens,
    baseline.tokens,
    registration.gates.maxTokenRatio,
    failures
  );
  const toolCallRatio = checkRatio(
    "tool calls",
    candidate.toolCalls,
    baseline.toolCalls,
    registration.gates.maxToolCallRatio,
    failures
  );
  const latencyRatio = checkRatio(
    "latency",
    candidate.latencyMs,
    baseline.latencyMs,
    registration.gates.maxLatencyRatio,
    failures
  );
  const churnDelta =
    candidate.correctionChurnUpperBound - baseline.correctionChurnUpperBound;
  if (churnDelta > registration.gates.maxCorrectionChurnUpperDelta) {
    failures.push(
      `candidate correction-churn upper-bound delta ${churnDelta} exceeds preregistered maximum ${registration.gates.maxCorrectionChurnUpperDelta}`
    );
  }
  const baselineById = new Map(
    observations.arms.baseline.cases.map((item) => [item.id, item])
  );
  const newFailures = observations.arms.candidate.cases
    .filter((item) => baselineById.get(item.id)?.success && !item.success)
    .map((item) => item.id)
    .sort();
  if (newFailures.length > registration.gates.maxNewFailures) {
    failures.push(
      `candidate has ${newFailures.length} newly failing case(s) (${newFailures.join(", ")}), exceeding preregistered maximum ${registration.gates.maxNewFailures}`
    );
  }
  for (const [name, metrics] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    if (
      metrics.ambiguousVerdicts > registration.gates.maxAmbiguousVerdictsPerArm
    ) {
      failures.push(
        `${name} ambiguous verdicts ${metrics.ambiguousVerdicts} exceed preregistered maximum ${registration.gates.maxAmbiguousVerdictsPerArm}`
      );
    }
  }

  return {
    failures,
    metrics: {
      baseline,
      candidate,
      deltas: {
        correctionChurnUpper: churnDelta,
        latencyRatio,
        newFailures,
        successRate: successRateDelta,
        tokenRatio,
        toolCallRatio,
      },
    },
    ok: failures.length === 0,
    registrationSha256,
  };
};

const readJson = (file: string): { bytes: Uint8Array; value: unknown } => {
  const bytes = readFileSync(file);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
};

const readStampedCommit = (
  stamp: unknown
): { bytes?: Uint8Array; committedAt?: string } => {
  if (!isRecord(stamp)) {
    return {};
  }
  const commit = stamp.registrationCommitSha;
  const path = stamp.registrationPath;
  if (
    !(
      nonEmptyString(commit) &&
      GIT_SHA_RE.test(commit) &&
      nonEmptyString(path) &&
      SAFE_REPO_PATH_RE.test(path)
    )
  ) {
    return {};
  }
  try {
    const bytes = execFileSync("git", ["show", `${commit}:${path}`], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const committedAt = execFileSync(
      "git",
      ["show", "-s", "--format=%cI", commit],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return { bytes, committedAt };
  } catch {
    return {};
  }
};

export const runReplayReleaseGateCommand = (argv: string[]): boolean => {
  if (argv[0] !== "release-gate") {
    return false;
  }
  if (argv[1] !== "verify" || argv.length !== 5) {
    throw new Error(
      "Usage: loop release-gate verify <registration.json> <review-stamp.json> <observations.json>"
    );
  }
  const registration = readJson(argv[2] as string);
  const stamp = readJson(argv[3] as string);
  const observations = readJson(argv[4] as string);
  const committed = readStampedCommit(stamp.value);
  const result = evaluateReplayReleaseGate({
    committedRegistrationBytes: committed.bytes,
    observations: observations.value,
    registration: registration.value,
    registrationBytes: registration.bytes,
    registrationCommittedAt: committed.committedAt,
    stamp: stamp.value,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
  return true;
};
