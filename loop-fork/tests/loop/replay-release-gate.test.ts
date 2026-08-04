import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateReplayReleaseGate,
  sha256Bytes,
} from "../../src/loop/replay-release-gate";

const hash = (character: string): string => character.repeat(64);
const gitSha = (character: string): string => character.repeat(40);

const baseRegistration = () => ({
  baselineHarnessSha: gitSha("a"),
  bindings: {
    metricsExtractorSha256: hash("1"),
    model: "gpt-5.6-sol",
    promptSha256: hash("2"),
    reasoningEffort: "ultra",
    replayCorpusSha256: hash("3"),
    toolConfigSha256: hash("4"),
  },
  candidateHarnessSha: gitSha("b"),
  cases: [
    { id: "inspect-1", inputSha256: hash("5") },
    { id: "edit-1", inputSha256: hash("6") },
  ],
  gates: {
    maxAmbiguousVerdictsPerArm: 0,
    maxCorrectionChurnUpperDelta: 0,
    maxLatencyRatio: 1.1,
    maxNewFailures: 0,
    maxSuccessRateDrop: 0,
    maxTokenRatio: 1.1,
    maxToolCallRatio: 1.1,
    minCandidateSuccessRate: 1,
  },
  registeredAt: "2026-08-04T10:00:00.000Z",
  registeredBy: "driver",
  registrationId: "org-chart-wave-2",
  schemaVersion: 1,
});

const quality = (changes = 0, upperBound = changes) => ({
  overclaimsRetracted: {
    driverSelfRetractions: { count: 0 },
    reviewerDisproofs: { count: 0 },
  },
  reviewerChangesRoundsBeforeFinalApprove: { count: changes, upperBound },
});

const baseObservations = () => {
  const registration = baseRegistration();
  const cases = registration.cases.map((item, index) => ({
    ...item,
    latencyMs: 100 + index * 10,
    quality: quality(index),
    success: true,
    tokens: 100 + index * 10,
    toolCalls: 2 + index,
  }));
  return {
    arms: {
      baseline: {
        cases,
        harnessSha: registration.baselineHarnessSha,
      },
      candidate: {
        cases: cases.map((item) => ({
          ...item,
          latencyMs: item.latencyMs - 10,
          quality: structuredClone(item.quality),
          tokens: item.tokens - 10,
        })),
        harnessSha: registration.candidateHarnessSha,
      },
    },
    bindings: { ...registration.bindings },
    completedAt: "2026-08-04T10:20:00.000Z",
    registrationId: registration.registrationId,
    schemaVersion: 1,
    startedAt: "2026-08-04T10:11:00.000Z",
  };
};

const run = (
  registration = baseRegistration(),
  observations = baseObservations(),
  stampOverrides: Record<string, unknown> = {},
  provenanceOverrides: {
    committedRegistrationBytes?: Uint8Array;
    registrationCommittedAt?: string;
  } = {}
) => {
  const registrationBytes = Buffer.from(JSON.stringify(registration));
  const stamp = {
    registrationCommitSha: gitSha("c"),
    registrationPath: "registration.json",
    registrationSha256: sha256Bytes(registrationBytes),
    reviewedAt: "2026-08-04T10:10:00.000Z",
    reviewer: "independent-reviewer",
    schemaVersion: 1,
    verdict: "CONCUR",
    ...stampOverrides,
  };
  return evaluateReplayReleaseGate({
    committedRegistrationBytes:
      provenanceOverrides.committedRegistrationBytes ?? registrationBytes,
    observations,
    registration,
    registrationBytes,
    registrationCommittedAt:
      provenanceOverrides.registrationCommittedAt ?? "2026-08-04T10:05:00.000Z",
    stamp,
  });
};

test("derives exact replay metrics and passes every preregistered gate", () => {
  const result = run();
  expect(result).toMatchObject({
    failures: [],
    metrics: {
      baseline: {
        correctionChurnUpperBound: 1,
        successCount: 2,
        tokens: 210,
        toolCalls: 5,
        totalCases: 2,
      },
      candidate: {
        correctionChurnUpperBound: 1,
        successCount: 2,
        tokens: 190,
      },
      deltas: { correctionChurnUpper: 0, newFailures: [] },
    },
    ok: true,
  });
});

test("requires a CONCUR stamp bound to the exact registration bytes", () => {
  expect(run(undefined, undefined, { verdict: "DISSENT" }).failures).toContain(
    "stamp.verdict must equal CONCUR"
  );
  expect(
    run(undefined, undefined, { registrationSha256: hash("f") }).failures
  ).toContain("review stamp does not bind the exact registration bytes");
  expect(run(undefined, undefined, { reviewer: "driver" }).failures).toContain(
    "reviewer must differ from the registration author"
  );
  expect(
    run(undefined, undefined, { registrationPath: "../registration.json" })
      .failures
  ).toContain("stamp.registrationPath must be a safe repository-relative path");
});

test("verifies committed registration bytes and commit chronology", () => {
  expect(
    run(undefined, undefined, undefined, {
      committedRegistrationBytes: Buffer.from("different"),
    }).failures
  ).toContain(
    "stamped git commit does not contain the exact registration bytes"
  );
  expect(
    run(undefined, undefined, undefined, {
      registrationCommittedAt: "2026-08-04T10:10:01.000Z",
    }).failures
  ).toContain("review stamp predates the registration commit");
});

test("requires review after registration and measurement after review", () => {
  expect(
    run(undefined, undefined, { reviewedAt: "2026-08-04T09:59:00.000Z" })
      .failures
  ).toContain("review stamp predates registration");
  const observations = baseObservations();
  observations.startedAt = "2026-08-04T10:10:00.000Z";
  expect(run(undefined, observations).failures).toContain(
    "measurement must start after the reviewer stamp"
  );
  observations.startedAt = "2026-08-04T10:21:00.000Z";
  expect(run(undefined, observations).failures).toContain(
    "measurement completedAt predates startedAt"
  );
});

test("rejects drift in every shared execution binding", () => {
  for (const key of Object.keys(baseRegistration().bindings)) {
    const observations = baseObservations();
    observations.bindings[key as keyof typeof observations.bindings] =
      key === "model" || key === "reasoningEffort" ? "drift" : hash("f");
    expect(run(undefined, observations).failures).toContain(
      `observation binding ${key} does not match registration`
    );
  }
});

test("rejects baseline and candidate harness SHA drift", () => {
  const observations = baseObservations();
  observations.arms.baseline.harnessSha = gitSha("c");
  observations.arms.candidate.harnessSha = gitSha("d");
  expect(run(undefined, observations).failures).toEqual(
    expect.arrayContaining([
      "baseline harness SHA does not match registration",
      "candidate harness SHA does not match registration",
    ])
  );
});

test("fails closed on missing, extra, duplicate, or hash-swapped cases", () => {
  const missing = baseObservations();
  missing.arms.candidate.cases.pop();
  expect(run(undefined, missing).failures).toContain(
    "candidate is missing registered case edit-1"
  );

  const extra = baseObservations();
  extra.arms.candidate.cases.push({
    ...extra.arms.candidate.cases[0],
    id: "unregistered",
  });
  expect(run(undefined, extra).failures).toContain(
    "candidate contains unregistered case unregistered"
  );

  const duplicate = baseObservations();
  duplicate.arms.candidate.cases.push({
    ...duplicate.arms.candidate.cases[0],
  });
  expect(run(undefined, duplicate).failures).toContain(
    "observations.arms.candidate.cases contains duplicate id inspect-1"
  );

  const swapped = baseObservations();
  swapped.arms.candidate.cases[0].inputSha256 = hash("6");
  expect(run(undefined, swapped).failures).toContain(
    "candidate case inspect-1 input hash does not match registration"
  );
});

test("catches a green-by-count failure identity swap", () => {
  const observations = baseObservations();
  observations.arms.baseline.cases[1].success = false;
  observations.arms.candidate.cases[0].success = false;
  observations.arms.candidate.cases[1].success = true;
  const registration = baseRegistration();
  registration.gates.minCandidateSuccessRate = 0.5;
  registration.gates.maxSuccessRateDrop = 0;
  const result = run(registration, observations);
  expect(result.metrics?.baseline.successCount).toBe(1);
  expect(result.metrics?.candidate.successCount).toBe(1);
  expect(result.failures).toContain(
    "candidate has 1 newly failing case(s) (inspect-1), exceeding preregistered maximum 0"
  );
});

test("rejects token, tool-call, and latency regressions despite full success", () => {
  const observations = baseObservations();
  for (const item of observations.arms.candidate.cases) {
    item.tokens *= 2;
    item.toolCalls *= 2;
    item.latencyMs *= 2;
  }
  expect(run(undefined, observations).failures).toEqual(
    expect.arrayContaining([
      expect.stringContaining("token use ratio"),
      expect.stringContaining("tool calls ratio"),
      expect.stringContaining("latency ratio"),
    ])
  );
});

test("zero baseline denominators fail closed on positive candidate use", () => {
  const observations = baseObservations();
  for (const item of observations.arms.baseline.cases) {
    item.tokens = 0;
    item.toolCalls = 0;
    item.latencyMs = 0;
  }
  expect(run(undefined, observations).failures).toEqual(
    expect.arrayContaining([
      "token use has positive candidate total with zero baseline denominator",
      "tool calls has positive candidate total with zero baseline denominator",
      "latency has positive candidate total with zero baseline denominator",
    ])
  );
});

test("uses registered CHANGES, retraction, and disproof fields for churn", () => {
  const observations = baseObservations();
  const candidateQuality = observations.arms.candidate.cases[0].quality;
  candidateQuality.reviewerChangesRoundsBeforeFinalApprove = {
    count: 1,
    upperBound: 2,
  };
  candidateQuality.overclaimsRetracted.driverSelfRetractions.count = 1;
  candidateQuality.overclaimsRetracted.reviewerDisproofs.count = 1;
  const result = run(undefined, observations);
  expect(result.metrics?.candidate).toMatchObject({
    ambiguousVerdicts: 1,
    correctionChurnCount: 4,
    correctionChurnUpperBound: 5,
  });
  expect(result.failures).toEqual(
    expect.arrayContaining([
      expect.stringContaining("correction-churn upper-bound delta"),
      expect.stringContaining("candidate ambiguous verdicts"),
    ])
  );
});

test("rejects malformed or non-finite measurements", () => {
  const observations = baseObservations();
  observations.arms.candidate.cases[0].latencyMs = Number.NaN;
  observations.arms.candidate.cases[0].tokens = -1;
  observations.arms.candidate.cases[0].quality.reviewerChangesRoundsBeforeFinalApprove.upperBound =
    -1;
  expect(run(undefined, observations).failures).toEqual(
    expect.arrayContaining([
      "observations.arms.candidate.cases[0].latencyMs must be finite and non-negative",
      "observations.arms.candidate.cases[0].tokens must be a non-negative integer",
      "observations.arms.candidate.cases[0].quality.upper must be a non-negative integer",
    ])
  );
});

test("fails closed when derived totals exceed the safe numeric range", () => {
  const observations = baseObservations();
  for (const item of observations.arms.candidate.cases) {
    item.tokens = Number.MAX_SAFE_INTEGER;
  }
  expect(run(undefined, observations).failures).toContain(
    "candidate derived tokens exceeds the safe numeric range"
  );
});

test("public CLI prints derived JSON and exits nonzero when a gate fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "replay-release-gate-"));
  const registration = baseRegistration();
  const registrationBytes = Buffer.from(JSON.stringify(registration, null, 2));
  const observations = baseObservations();
  const registrationFile = join(directory, "registration.json");
  const stampFile = join(directory, "stamp.json");
  const observationsFile = join(directory, "observations.json");
  writeFileSync(registrationFile, registrationBytes);
  expect(spawnSync("git", ["init"], { cwd: directory }).status).toBe(0);
  expect(
    spawnSync("git", ["add", "registration.json"], { cwd: directory }).status
  ).toBe(0);
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-08-04T10:05:00.000Z",
    GIT_COMMITTER_DATE: "2026-08-04T10:05:00.000Z",
  };
  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Replay Gate Test",
        "-c",
        "user.email=replay-gate@example.invalid",
        "commit",
        "-m",
        "register replay gate",
      ],
      { cwd: directory, env: commitEnv }
    ).status
  ).toBe(0);
  const registrationCommitSha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).stdout.trim();
  const stamp = {
    registrationCommitSha,
    registrationPath: "registration.json",
    registrationSha256: sha256Bytes(registrationBytes),
    reviewedAt: "2026-08-04T10:10:00.000Z",
    reviewer: "independent-reviewer",
    schemaVersion: 1,
    verdict: "CONCUR",
  };
  writeFileSync(stampFile, JSON.stringify(stamp));
  writeFileSync(observationsFile, JSON.stringify(observations));

  const cli = join(import.meta.dir, "../../src/cli.ts");
  const pass = spawnSync(
    process.execPath,
    [
      cli,
      "release-gate",
      "verify",
      registrationFile,
      stampFile,
      observationsFile,
    ],
    { cwd: directory }
  );
  expect(pass.status).toBe(0);
  expect(JSON.parse(pass.stdout.toString())).toMatchObject({ ok: true });

  observations.arms.candidate.cases[0].tokens *= 10;
  writeFileSync(observationsFile, JSON.stringify(observations));
  const fail = spawnSync(
    process.execPath,
    [
      cli,
      "release-gate",
      "verify",
      registrationFile,
      stampFile,
      observationsFile,
    ],
    { cwd: directory }
  );
  expect(fail.status).toBe(1);
  expect(JSON.parse(fail.stdout.toString())).toMatchObject({
    failures: [expect.stringContaining("token use ratio")],
    ok: false,
  });
});
