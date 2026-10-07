import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeStatus } from "../../src/loop/bridge-store";
import {
  type A2AV2Config,
  type A2AV2EnrollmentOutcome,
  A2AV2SeatUnavailableError,
  ConfiguredA2AV2SessionEnrollment,
  configuredA2AV2RebindAuthority,
  createLoopOrchestrationFetchHandler,
  createOrchestrationSweep,
  enrollConfiguredA2AV2Session,
  parseLoopOrchestrationConfig,
  requireA2AV2Enrollment,
  resultGraphKeyFingerprintsForConfig,
  resultGraphWorkflowIdForConfig,
  runLoopOrchestrationServer,
} from "../../src/loop/loop-orchestration-server";
import {
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  SupervisorResultGraphKey,
} from "../../src/loop/supervisor-message-v2-contract";
import type { SupervisorSessionDescriptorV2 } from "../../src/loop/supervisor-session-v2";

const config = () => ({
  address: "127.0.0.1:7233",
  buildId: "loop-orchestration.v1",
  grants: [
    {
      from: "supervisor:harvto",
      operations: ["receive"],
      principal: "principal:harvto",
      to: "supervisor:harness",
    },
  ],
  hostname: "127.0.0.1",
  identity: "loop-orchestration@local",
  namespace: "default",
  port: 7321,
  schema: "loop-orchestration-server.v1",
  stateDir: "/private/tmp/loop-orchestration-state",
  supervisors: [
    {
      manifestPath: "/Users/example/.loop/runs/harness/1/manifest.json",
      principal: "principal:harness",
      supervisorId: "supervisor:harness",
      tokenEnv: "LOOP_HARNESS_ORCHESTRATION_TOKEN",
    },
  ],
  taskQueue: "loop-orchestration",
});

test("orchestration config binds loopback routes, grants, and secret environment names", () => {
  expect(parseLoopOrchestrationConfig(config())).toMatchObject({
    hostname: "127.0.0.1",
    supervisors: [
      {
        supervisorId: "supervisor:harness",
        tokenEnv: "LOOP_HARNESS_ORCHESTRATION_TOKEN",
      },
    ],
  });
});

test("orchestration config rejects inline secrets, remote listeners, and unknown grants", () => {
  expect(() =>
    parseLoopOrchestrationConfig({ ...config(), secret: "must-not-persist" })
  ).toThrow("invalid fields");
  expect(() =>
    parseLoopOrchestrationConfig({ ...config(), hostname: "0.0.0.0" })
  ).toThrow("hostname is invalid");
  const invalid = config();
  const [grant] = invalid.grants;
  if (!grant) {
    throw new Error("test fixture grant is missing");
  }
  grant.operations = ["delete"];
  expect(() => parseLoopOrchestrationConfig(invalid)).toThrow(
    "grant operations are invalid"
  );
});

const a2aV2 = (
  resultArtifacts: unknown[],
  extra: Record<string, unknown> = {
    resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
  }
) => ({
  ...config(),
  a2aV2: {
    ...extra,
    databaseUrlEnv: "LOOP_A2A_V2_DATABASE_URL",
    endpointRef: "endpoint:local-a2a",
    policy: {
      claimTimeoutMs: 60_000,
      escalationTimeoutMs: 120_000,
      maxDeliveryAttempts: 3,
      retryDelayMs: 1000,
    },
    principal: "principal:harness",
    recipient: "supervisor:harness",
    resultArtifacts,
    routePath: "/a2a",
    sessionTtlMs: 3_600_000,
    tenant: "tenant:local",
  },
});
const artifact = {
  artifactRef: `artifact://sha256/${"a".repeat(64)}`,
  commit: "b".repeat(40),
  path: "results/accepted.md",
  repositoryRoot: "/Users/example/repo",
};

test("orchestration config refuses a result artifact in the retired shape with the exact migration", () => {
  expect(() => parseLoopOrchestrationConfig(a2aV2([artifact]))).toThrow(
    "orchestration a2aV2 resultArtifacts[0] uses the retired shape {artifactRef, commit, path, repositoryRoot}: add graphWorkflowId and graphTaskId"
  );
});

test("orchestration config refuses a result artifact for a graph no message result can bind to", () => {
  expect(() =>
    parseLoopOrchestrationConfig(
      a2aV2([
        {
          ...artifact,
          graphTaskId: "result-node",
          graphWorkflowId: "task-graph:chosen-by-operator",
        },
      ])
    )
  ).toThrow(
    "orchestration a2aV2 resultArtifacts[0] graphWorkflowId is not a message-derived result graph (supervisor-result-graph:v3:<hmac-sha256>, from `loop orchestration result-graph-id`)"
  );
});

test("orchestration config accepts a result artifact bound to a keyed graph task, and to an unkeyed v2 graph recorded before the key", () => {
  for (const graphWorkflowId of [
    `supervisor-result-graph:v3:${"c".repeat(64)}`,
    `supervisor-result-graph:v2:${"c".repeat(64)}`,
  ]) {
    const parsed = parseLoopOrchestrationConfig(
      a2aV2([{ ...artifact, graphTaskId: "result-node", graphWorkflowId }])
    ).a2aV2;
    expect(parsed?.resultArtifacts).toEqual([
      { ...artifact, graphTaskId: "result-node", graphWorkflowId },
    ]);
    expect(parsed?.resultGraphKeyEnv).toBe("LOOP_A2A_V2_RESULT_GRAPH_KEY");
  }
});

/** The startup refusal's procedure: it must never tell an operator to
 * recompute an id a binding is already recorded under. */
const RESULT_GRAPH_KEY_REQUIRED =
  "orchestration a2aV2 resultArtifacts requires resultGraphKeyEnv: name the environment variable holding the host's result graph HMAC key (at least 32 bytes). Keep every existing resultArtifacts graphWorkflowId as it is: a recorded binding keeps the graph it was bound to, and a recomputed id would stop it publishing. Run `loop orchestration result-graph-id <config-path> <message-workflow-id>` only for a message that is not bound yet. To change the key later, first bind every result graph started under the old key (a graph started but not bound when its key becomes a previous key can never be bound, and must be started again under the new key), then move the old key's variable name to previousResultGraphKeyEnvs instead of replacing it";

test("orchestration config refuses result artifacts without a result graph key environment, with the exact migration", () => {
  const graphWorkflowId = `supervisor-result-graph:v3:${"c".repeat(64)}`;
  expect(() =>
    parseLoopOrchestrationConfig(
      a2aV2([{ ...artifact, graphTaskId: "result-node", graphWorkflowId }], {})
    )
  ).toThrow(RESULT_GRAPH_KEY_REQUIRED);
  // A V2 route that binds no results needs no key.
  expect(
    parseLoopOrchestrationConfig(a2aV2([], {})).a2aV2?.resultGraphKeyEnv
  ).toBeUndefined();
});

test("orchestration config names the result graph key by environment variable only", () => {
  for (const resultGraphKeyEnv of [
    "an-inline-secret-value-that-must-not-be-configured",
    "",
    42,
  ]) {
    expect(() =>
      parseLoopOrchestrationConfig(a2aV2([], { resultGraphKeyEnv }))
    ).toThrow("orchestration a2aV2 resultGraphKeyEnv is invalid");
  }
});

/** A config file on disk, as the server and the CLI tool read it. */
const configFile = (value: unknown) => {
  const root = mkdtempSync(join(tmpdir(), "loop-orch-config-"));
  const path = join(root, "orchestration.json");
  writeFileSync(path, JSON.stringify(value));
  return { path, remove: () => rmSync(root, { force: true, recursive: true }) };
};

test("result-graph-id computes the keyed id the server derives, from the configured key environment", () => {
  const file = configFile(a2aV2([]));
  const secret = randomBytes(32).toString("hex");
  try {
    const scope = { principal: "principal:harness", tenantId: "tenant:local" };
    const message = deriveSupervisorMessageV2WorkflowId(
      scope,
      "cli-proof",
      "loop-orchestration"
    );
    const computed = resultGraphWorkflowIdForConfig(file.path, message, {
      LOOP_A2A_V2_RESULT_GRAPH_KEY: secret,
    });
    expect(computed).toBe(
      deriveSupervisorMessageV2ResultGraphWorkflowId(
        SupervisorResultGraphKey.fromSecret(secret),
        scope,
        message
      )
    );
    expect(computed).not.toContain(secret);
    expect(() =>
      resultGraphWorkflowIdForConfig(file.path, message, {})
    ).toThrow(
      "missing orchestration A2A V2 result graph key environment LOOP_A2A_V2_RESULT_GRAPH_KEY"
    );
    try {
      resultGraphWorkflowIdForConfig(file.path, message, {
        LOOP_A2A_V2_RESULT_GRAPH_KEY: "short-throwaway",
      });
      throw new Error("a short key was accepted");
    } catch (error) {
      expect(String(error)).toContain(
        "orchestration A2A V2 result graph key environment LOOP_A2A_V2_RESULT_GRAPH_KEY must hold at least 32 bytes"
      );
      expect(String(error)).not.toContain("short-throwaway");
    }
    expect(() =>
      resultGraphWorkflowIdForConfig(file.path, "task-graph:any", {
        LOOP_A2A_V2_RESULT_GRAPH_KEY: secret,
      })
    ).toThrow();
  } finally {
    file.remove();
  }
  const keyless = configFile(a2aV2([], {}));
  try {
    expect(() =>
      resultGraphWorkflowIdForConfig(
        keyless.path,
        deriveSupervisorMessageV2WorkflowId(
          { principal: "principal:harness", tenantId: "tenant:local" },
          "cli-proof",
          "loop-orchestration"
        ),
        {}
      )
    ).toThrow("orchestration a2aV2 has no resultGraphKeyEnv");
  } finally {
    keyless.remove();
  }
  const v1Only = configFile(config());
  try {
    expect(() =>
      resultGraphWorkflowIdForConfig(
        v1Only.path,
        deriveSupervisorMessageV2WorkflowId(
          { principal: "principal:harness", tenantId: "tenant:local" },
          "cli-proof",
          "loop-orchestration"
        ),
        {}
      )
    ).toThrow("orchestration config has no a2aV2 route");
  } finally {
    v1Only.remove();
  }
});

test("the server refuses to start when the configured result graph key environment is absent or short, naming only the variable", async () => {
  // A port nothing listens on: the refusal must come before any connection.
  const file = configFile({ ...a2aV2([]), address: "127.0.0.1:9" });
  const env = {
    LOOP_A2A_V2_DATABASE_URL: "postgres://unused.invalid/none",
    LOOP_HARNESS_ORCHESTRATION_TOKEN: randomBytes(16).toString("hex"),
  };
  try {
    await expect(runLoopOrchestrationServer(file.path, env)).rejects.toThrow(
      "missing orchestration A2A V2 result graph key environment LOOP_A2A_V2_RESULT_GRAPH_KEY"
    );
    const short = "short-throwaway-key";
    const failure = await runLoopOrchestrationServer(file.path, {
      ...env,
      LOOP_A2A_V2_RESULT_GRAPH_KEY: short,
    }).then(
      () => "started",
      (error: unknown) => String(error)
    );
    expect(failure).toContain(
      "orchestration A2A V2 result graph key environment LOOP_A2A_V2_RESULT_GRAPH_KEY must hold at least 32 bytes"
    );
    expect(failure).not.toContain(short);
  } finally {
    file.remove();
  }
});

test("orchestration config names previous result graph keys by environment variable only, and only beside a primary key", () => {
  const rotated = parseLoopOrchestrationConfig(
    a2aV2([], {
      resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
      previousResultGraphKeyEnvs: [
        "LOOP_A2A_V2_RESULT_GRAPH_KEY_2026_09",
        "LOOP_A2A_V2_RESULT_GRAPH_KEY_2026_08",
      ],
    })
  ).a2aV2;
  expect(rotated?.resultGraphKeyEnv).toBe("LOOP_A2A_V2_RESULT_GRAPH_KEY");
  expect(rotated?.previousResultGraphKeyEnvs).toEqual([
    "LOOP_A2A_V2_RESULT_GRAPH_KEY_2026_09",
    "LOOP_A2A_V2_RESULT_GRAPH_KEY_2026_08",
  ]);
  // Absent, the field stays absent.
  expect(
    Object.keys(parseLoopOrchestrationConfig(a2aV2([])).a2aV2 ?? {})
  ).not.toContain("previousResultGraphKeyEnvs");
  expect(() =>
    parseLoopOrchestrationConfig(
      a2aV2([], {
        previousResultGraphKeyEnvs: ["LOOP_A2A_V2_RESULT_GRAPH_KEY_2026_09"],
      })
    )
  ).toThrow(
    "orchestration a2aV2 previousResultGraphKeyEnvs requires resultGraphKeyEnv"
  );
  for (const previousResultGraphKeyEnvs of [
    "LOOP_A2A_V2_RESULT_GRAPH_KEY_2026_09",
    [],
    ["an-inline-secret-value-that-must-not-be-configured"],
    [42],
    [
      "LOOP_A2A_V2_RESULT_GRAPH_KEY_2026_09",
      "LOOP_A2A_V2_RESULT_GRAPH_KEY_2026_09",
    ],
    ["LOOP_A2A_V2_RESULT_GRAPH_KEY"],
  ]) {
    expect(() =>
      parseLoopOrchestrationConfig(
        a2aV2([], {
          resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
          previousResultGraphKeyEnvs,
        })
      )
    ).toThrow("orchestration a2aV2 previousResultGraphKeyEnvs is invalid");
  }
});

test("orchestration config holds at most eight previous result graph keys", () => {
  const names = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `LOOP_A2A_V2_RESULT_GRAPH_KEY_PREVIOUS_${index}`
    );
  expect(
    parseLoopOrchestrationConfig(
      a2aV2([], {
        resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
        previousResultGraphKeyEnvs: names(8),
      })
    ).a2aV2?.previousResultGraphKeyEnvs
  ).toEqual(names(8));
  expect(() =>
    parseLoopOrchestrationConfig(
      a2aV2([], {
        resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
        previousResultGraphKeyEnvs: names(9),
      })
    )
  ).toThrow("orchestration a2aV2 previousResultGraphKeyEnvs is invalid");
});

test("the server refuses to start when a previous result graph key is absent, short, or the same key as another, naming only variables and fingerprints", async () => {
  const value = a2aV2([], {
    resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
    previousResultGraphKeyEnvs: ["LOOP_A2A_V2_RESULT_GRAPH_KEY_OLD"],
  });
  const file = configFile({ ...value, address: "127.0.0.1:9" });
  const primary = randomBytes(32).toString("hex");
  const env = {
    LOOP_A2A_V2_DATABASE_URL: "postgres://unused.invalid/none",
    LOOP_HARNESS_ORCHESTRATION_TOKEN: randomBytes(16).toString("hex"),
    LOOP_A2A_V2_RESULT_GRAPH_KEY: primary,
  };
  const failureOf = (extra: Record<string, string>) =>
    runLoopOrchestrationServer(file.path, { ...env, ...extra }).then(
      () => "started",
      (error: unknown) => String(error)
    );
  try {
    expect(await failureOf({})).toContain(
      "missing orchestration A2A V2 result graph key environment LOOP_A2A_V2_RESULT_GRAPH_KEY_OLD"
    );
    const short = "short-throwaway-key";
    const shortFailure = await failureOf({
      LOOP_A2A_V2_RESULT_GRAPH_KEY_OLD: short,
    });
    expect(shortFailure).toContain(
      "orchestration A2A V2 result graph key environment LOOP_A2A_V2_RESULT_GRAPH_KEY_OLD must hold at least 32 bytes"
    );
    expect(shortFailure).not.toContain(short);
    const duplicate = await failureOf({
      LOOP_A2A_V2_RESULT_GRAPH_KEY_OLD: primary,
    });
    expect(duplicate).toContain(
      `orchestration A2A V2 result graph key environments LOOP_A2A_V2_RESULT_GRAPH_KEY and LOOP_A2A_V2_RESULT_GRAPH_KEY_OLD hold the same key (${SupervisorResultGraphKey.fromSecret(primary).fingerprint})`
    );
    expect(duplicate).not.toContain(primary);
  } finally {
    file.remove();
  }
});

test("result-graph-key-fingerprints names each configured key's fingerprint by variable and role, never the key", () => {
  const file = configFile(
    a2aV2([], {
      resultGraphKeyEnv: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
      previousResultGraphKeyEnvs: ["LOOP_A2A_V2_RESULT_GRAPH_KEY_OLD"],
    })
  );
  const primary = randomBytes(32).toString("hex");
  const previous = randomBytes(32).toString("hex");
  try {
    const listed = resultGraphKeyFingerprintsForConfig(file.path, {
      LOOP_A2A_V2_RESULT_GRAPH_KEY: primary,
      LOOP_A2A_V2_RESULT_GRAPH_KEY_OLD: previous,
    });
    expect(listed).toEqual([
      {
        env: "LOOP_A2A_V2_RESULT_GRAPH_KEY",
        fingerprint: SupervisorResultGraphKey.fromSecret(primary).fingerprint,
        role: "primary",
      },
      {
        env: "LOOP_A2A_V2_RESULT_GRAPH_KEY_OLD",
        fingerprint: SupervisorResultGraphKey.fromSecret(previous).fingerprint,
        role: "previous",
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(primary);
    expect(JSON.stringify(listed)).not.toContain(previous);
  } finally {
    file.remove();
  }
  const keyless = configFile(a2aV2([], {}));
  try {
    expect(() => resultGraphKeyFingerprintsForConfig(keyless.path, {})).toThrow(
      "orchestration a2aV2 has no resultGraphKeyEnv"
    );
  } finally {
    keyless.remove();
  }
});

test("orchestration config takes an optional readiness outage bound within one second to one day", () => {
  const withBound = (readinessOutageBoundMs: unknown) => {
    const value = a2aV2([]);
    return {
      ...value,
      a2aV2: { ...value.a2aV2, readinessOutageBoundMs },
    };
  };
  expect(
    parseLoopOrchestrationConfig(withBound(120_000)).a2aV2
      ?.readinessOutageBoundMs
  ).toBe(120_000);
  expect(
    parseLoopOrchestrationConfig(withBound(1000)).a2aV2?.readinessOutageBoundMs
  ).toBe(1000);
  expect(
    parseLoopOrchestrationConfig(withBound(86_400_000)).a2aV2
      ?.readinessOutageBoundMs
  ).toBe(86_400_000);
  // Absent, the key stays absent and the runtime default applies.
  expect(
    Object.keys(parseLoopOrchestrationConfig(a2aV2([])).a2aV2 ?? {})
  ).not.toContain("readinessOutageBoundMs");
  for (const invalid of [999, 86_400_001, 1500.5, "120000", null]) {
    expect(() => parseLoopOrchestrationConfig(withBound(invalid))).toThrow(
      "orchestration a2aV2 readinessOutageBoundMs is invalid"
    );
  }
});

test("orchestration config takes an optional V2 workflow id format, legacy or deployment, and omits it when absent", () => {
  const withFormat = (workflowIdFormat: unknown) => {
    const value = a2aV2([]);
    return { ...value, a2aV2: { ...value.a2aV2, workflowIdFormat } };
  };
  for (const format of ["legacy", "deployment"] as const) {
    expect(
      parseLoopOrchestrationConfig(withFormat(format)).a2aV2?.workflowIdFormat
    ).toBe(format);
  }
  // Absent, the ledger keeps the format its database records (else legacy).
  expect(
    Object.keys(parseLoopOrchestrationConfig(a2aV2([])).a2aV2 ?? {})
  ).not.toContain("workflowIdFormat");
  for (const invalid of ["Deployment", "tenant", "", null, 1]) {
    expect(() => parseLoopOrchestrationConfig(withFormat(invalid))).toThrow(
      'orchestration a2aV2 workflowIdFormat must be "legacy" or "deployment"'
    );
  }
});

test("orchestration config takes an optional not-enrolled deferral bound within one second to one day", () => {
  const withBound = (notEnrolledBoundMs: unknown) => {
    const value = a2aV2([]);
    return {
      ...value,
      a2aV2: { ...value.a2aV2, notEnrolledBoundMs },
    };
  };
  for (const boundMs of [1000, 120_000, 86_400_000]) {
    expect(
      parseLoopOrchestrationConfig(withBound(boundMs)).a2aV2?.notEnrolledBoundMs
    ).toBe(boundMs);
  }
  // Absent, the key stays absent and the runtime default applies.
  expect(
    Object.keys(parseLoopOrchestrationConfig(a2aV2([])).a2aV2 ?? {})
  ).not.toContain("notEnrolledBoundMs");
  for (const invalid of [999, 86_400_001, 1500.5, "120000", null]) {
    expect(() => parseLoopOrchestrationConfig(withBound(invalid))).toThrow(
      "orchestration a2aV2 notEnrolledBoundMs is invalid"
    );
  }
});

test("/healthz reports the V2 readiness-outage counters as counts only, without changing its state", async () => {
  const snapshot = {
    boundMs: 60_000,
    deferredDeliveries: 7,
    outageFailures: 2,
    recipientsDeferred: 1,
  };
  const health = async (
    a2aV2Service?: Parameters<
      typeof createLoopOrchestrationFetchHandler
    >[0]["a2aV2Service"]
  ) => {
    const handler = createLoopOrchestrationFetchHandler({
      a2aV2Service,
      authenticator: { authenticate: () => undefined } as never,
      host: {
        httpHandler: () => () => Promise.resolve(new Response(null)),
        workerState: () => "RUNNING",
      } as never,
      reconciliationHealthy: () => true,
    });
    return (await handler(new Request("http://127.0.0.1/healthz"))).json();
  };
  const notEnrolledSnapshot = {
    boundMs: 120_000,
    deferredDeliveries: 3,
    notEnrolledFailures: 1,
    recipientsDeferred: 1,
  };
  expect(
    await health({
      httpHandler: () => Promise.resolve(new Response(null)),
      notEnrolledDeferral: () => notEnrolledSnapshot,
      pathname: "/a2a",
      readinessOutage: () => snapshot,
    })
  ).toEqual({
    a2aV2NotEnrolledDeferral: notEnrolledSnapshot,
    a2aV2ReadinessOutage: snapshot,
    schema: "loop-orchestration-health.v1",
    state: "ready",
  });
  // Without V2 the body is exactly what it was.
  expect(await health()).toEqual({
    schema: "loop-orchestration-health.v1",
    state: "ready",
  });
});

test("unauthenticated /healthz names no seat or recipient while seats are not enrolled and deliveries wait", async () => {
  const handler = createLoopOrchestrationFetchHandler({
    a2aV2Service: {
      httpHandler: () => Promise.resolve(new Response(null)),
      notEnrolledDeferral: () => ({
        boundMs: 900_000,
        deferredDeliveries: 4,
        notEnrolledFailures: 0,
        recipientsDeferred: 1,
      }),
      pathname: "/a2a",
      readinessOutage: () => ({
        boundMs: 900_000,
        deferredDeliveries: 2,
        outageFailures: 0,
        recipientsDeferred: 1,
      }),
    },
    // Nobody is authenticated: this is what any caller can read.
    authenticator: { authenticate: () => undefined } as never,
    host: {
      httpHandler: () => () => Promise.resolve(new Response(null)),
      workerState: () => "RUNNING",
    } as never,
    notEnrolledSeats: () => ["supervisor:harness-peer", "supervisor:harness"],
    reconciliationHealthy: () => true,
  });
  const text = await (
    await handler(new Request("http://127.0.0.1/healthz"))
  ).text();
  expect(text).not.toContain("supervisor:");
  expect(text).not.toContain("harness");
  expect(JSON.parse(text)).toMatchObject({
    notEnrolledCount: 2,
    state: "ready",
  });
});

const a2aConfig = (): A2AV2Config => ({
  databaseUrlEnv: "LOOP_A2A_DATABASE_URL",
  endpointRef: "endpoint:codex-app-server",
  policy: {
    claimTimeoutMs: 60_000,
    escalationTimeoutMs: 60_000,
    maxDeliveryAttempts: 3,
    retryDelayMs: 1000,
  },
  principal: "principal:harness",
  recipient: "supervisor:harness",
  routePath: "/a2a/v2",
  sessionTtlMs: 60_000,
  tenant: "tenant:local",
});

const START = Date.parse("2026-10-05T00:00:00.000Z");
const at = (offsetMs: number) => () => new Date(START + offsetMs).toISOString();

const canonical = (value: unknown): string =>
  JSON.stringify(value, Object.keys(value as object).sort());

const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The Postgres session store's contract, in memory: register is insert-or-match,
 * rebind is authority-gated compare-and-set on the revision read. Each call
 * yields between its read and its write so two callers interleave the way two
 * server processes do against one database.
 */
const sessionStore = (config: A2AV2Config) => {
  const rows = new Map<string, SupervisorSessionDescriptorV2>();
  const calls = { current: 0, rebind: 0, register: 0 };
  const authority = configuredA2AV2RebindAuthority(config);
  return {
    calls,
    rows,
    async currentSession(_scope: unknown, recipient: string) {
      calls.current += 1;
      await yieldTurn();
      return rows.get(recipient);
    },
    async registerSession(
      _scope: unknown,
      next: SupervisorSessionDescriptorV2
    ) {
      calls.register += 1;
      await yieldTurn();
      if (!rows.has(next.recipient)) {
        rows.set(next.recipient, next);
      }
      const current = rows.get(next.recipient);
      if (!current || canonical(current) !== canonical(next)) {
        throw new Error(
          "session descriptor conflicts with the current registration"
        );
      }
      return current;
    },
    async rebindSession(
      scope: { principal: string; tenantId: string },
      next: SupervisorSessionDescriptorV2
    ) {
      calls.rebind += 1;
      const current = rows.get(next.recipient);
      if (!current || current.descriptorId !== next.descriptorId) {
        throw new Error("session descriptor is not registered");
      }
      if (next.revision !== current.revision + 1) {
        throw new Error("session rebind revision is stale");
      }
      const decision = authority.decide({ current, next, trustedScope: scope });
      if (!decision.allowed) {
        throw new Error(`session rebind denied: ${decision.reasonCode}`);
      }
      await yieldTurn();
      if (rows.get(next.recipient)?.revision !== current.revision) {
        throw new Error("session rebind lost the current revision");
      }
      rows.set(next.recipient, next);
      return { descriptor: next, receipt: {} as never };
    },
  };
};

const codexSeat = (thread: { id: string }) => ({
  directory: {
    resolve: () => ({ runDir: "/run/harness", target: "codex" as const }),
  },
  status: () =>
    ({
      claudeChannelServer: "",
      claudeSessionId: "",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: thread.id,
    }) as BridgeStatus,
});

test("A2A V2 enrollment renews a live session before it expires", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const seat = codexSeat({ id: "thread-a" });
  const enroll = (offsetMs: number) =>
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(offsetMs),
      service: store,
    });
  await enroll(0);
  await enroll(10_000);
  expect(store.rows.get(config.recipient)?.revision).toBe(1);
  // Inside the last half of its lifetime: renewed now, not refused later.
  await enroll(40_000);
  expect(store.rows.get(config.recipient)).toMatchObject({
    expiresAt: new Date(START + 100_000).toISOString(),
    revision: 2,
    sessionRef: "session:thread-a",
  });
});

test("A2A V2 enrollment rebinds a restarted seat through the governed path", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const thread = { id: "thread-a" };
  const seat = codexSeat(thread);
  await enrollConfiguredA2AV2Session({
    ...seat,
    config,
    now: at(0),
    service: store,
  });
  thread.id = "thread-b";
  await enrollConfiguredA2AV2Session({
    ...seat,
    config,
    now: at(1000),
    service: store,
  });
  expect(store.calls.rebind).toBe(1);
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 2,
    sessionRef: "session:thread-b",
  });
});

test("A2A V2 enrollment losing a rebind race converges instead of failing", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const seat = codexSeat({ id: "thread-a" });
  await enrollConfiguredA2AV2Session({
    ...seat,
    config,
    now: at(0),
    service: store,
  });
  // Two server instances start together after the session expired.
  await Promise.all([
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(61_000),
      service: store,
    }),
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(61_001),
      service: store,
    }),
  ]);
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 2,
    sessionRef: "session:thread-a",
  });
});

test("A2A V2 enrollment losing a first-registration race converges instead of failing", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const seat = codexSeat({ id: "thread-a" });
  await Promise.all([
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(0),
      service: store,
    }),
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(1),
      service: store,
    }),
  ]);
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 1,
    sessionRef: "session:thread-a",
  });
});

test("A2A V2 enrollment still fails on a governed rebind denial", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const seat = codexSeat({ id: "thread-a" });
  await enrollConfiguredA2AV2Session({
    ...seat,
    config,
    now: at(0),
    service: store,
  });
  // A different endpoint reference is outside the configured rebind grant.
  await expect(
    enrollConfiguredA2AV2Session({
      ...seat,
      config: { ...config, endpointRef: "endpoint:elsewhere" },
      now: at(1000),
      service: store,
    })
  ).rejects.toThrow("session rebind denied");
  expect(store.rows.get(config.recipient)?.revision).toBe(1);
});

test("A2A V2 enrollment sweep renews before expiry and rebinds a restarted seat", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const thread = { id: "thread-a" };
  const clock = { offsetMs: 0 };
  const enrollment = new ConfiguredA2AV2SessionEnrollment({
    ...codexSeat(thread),
    config,
    now: () => at(clock.offsetMs)(),
    recipients: [config.recipient],
    service: store,
  });
  await enrollment.maintain();
  expect(store.rows.get(config.recipient)?.revision).toBe(1);
  // A quiet sweep reads the seat's bridge status, not the store.
  const reads = store.calls.current;
  clock.offsetMs = 10_000;
  await enrollment.maintain();
  expect(store.calls.current).toBe(reads);
  // The Codex thread restarted: the next sweep rebinds instead of leaving
  // readiness to refuse every delivery as "identity changed".
  thread.id = "thread-b";
  clock.offsetMs = 11_000;
  await enrollment.maintain();
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 2,
    sessionRef: "session:thread-b",
  });
  // Past half its lifetime: renewed before it expires.
  clock.offsetMs = 42_000;
  await enrollment.maintain();
  expect(store.rows.get(config.recipient)).toMatchObject({
    expiresAt: new Date(START + 102_000).toISOString(),
    revision: 3,
    sessionRef: "session:thread-b",
  });
});

test("A2A V2 enrollment sweep reports an unavailable seat and retries it later", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const thread = { id: "" };
  const clock = { offsetMs: 0 };
  const enrollment = new ConfiguredA2AV2SessionEnrollment({
    ...codexSeat(thread),
    config,
    now: () => at(clock.offsetMs)(),
    recipients: [config.recipient],
    service: store,
  });
  const [failed] = await enrollment.maintain();
  expect(failed).toMatchObject({
    recipient: config.recipient,
    state: "failed",
  });
  expect(failed?.state === "failed" && failureText(failed.error)).toBe(
    "configured A2A V2 recipient session is unavailable"
  );
  expect(() =>
    requireA2AV2Enrollment(failed ? [failed] : [], config.recipient)
  ).toThrow("configured A2A V2 recipient session is unavailable");
  thread.id = "thread-a";
  clock.offsetMs = 1000;
  // Inside the retry delay the seat is not re-attempted, and says so.
  expect(await enrollment.maintain()).toEqual([
    { recipient: config.recipient, state: "deferred" },
  ]);
  expect(store.rows.get(config.recipient)).toBeUndefined();
  clock.offsetMs = 5000;
  expect(await enrollment.maintain()).toEqual([
    { recipient: config.recipient, state: "enrolled" },
  ]);
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 1,
    sessionRef: "session:thread-a",
  });
  clock.offsetMs = 6000;
  expect(await enrollment.maintain()).toEqual([
    { recipient: config.recipient, state: "unchanged" },
  ]);
});

const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sweepProbe = (
  enrollment?: () => Promise<A2AV2EnrollmentOutcome[]>,
  reconcile: () => Promise<void> = () => Promise.resolve()
) => {
  const calls = { maintain: 0, reconcile: 0 };
  const healthy: boolean[] = [];
  const logs: string[] = [];
  const sweep = createOrchestrationSweep({
    enrollment: enrollment
      ? {
          maintain: () => {
            calls.maintain += 1;
            return enrollment();
          },
        }
      : undefined,
    log: (line) => logs.push(line),
    reconcilers: [
      {
        reconcile: () => {
          calls.reconcile += 1;
          return reconcile();
        },
      },
    ],
    setHealthy: (value) => healthy.push(value),
  });
  return { calls, healthy, logs, sweep };
};

test("orchestration sweep drives enrollment without holding bridge reconciliation behind it", async () => {
  // A hung Postgres call inside enrollment must not stop bridge and mailbox
  // ACK reconciliation, nor be re-entered by the next tick.
  const probe = sweepProbe(
    () => new Promise<A2AV2EnrollmentOutcome[]>(() => undefined)
  );
  await probe.sweep();
  await probe.sweep();
  await probe.sweep();
  expect(probe.calls).toEqual({ maintain: 1, reconcile: 3 });
  expect(probe.healthy).toEqual([true, true, true]);
  expect(probe.logs).toEqual([]);
});

test("orchestration sweep retries enrollment every tick and reports each changed failure once", async () => {
  const seat = "supervisor:harness";
  const peer = "supervisor:harness-peer";
  const down = (recipient: string): A2AV2EnrollmentOutcome => ({
    error: new Error("seat unavailable"),
    recipient,
    state: "failed",
  });
  const passes: A2AV2EnrollmentOutcome[][] = [
    [down(seat), { recipient: peer, state: "enrolled" }],
    [down(seat), { recipient: peer, state: "unchanged" }],
    [
      { recipient: seat, state: "enrolled" },
      { recipient: peer, state: "unchanged" },
    ],
    [down(seat), down(peer)],
    // An unexpected rejection of the pass itself is reported, once.
    [],
  ];
  const probe = sweepProbe(() => {
    const pass = passes.shift();
    return pass ? Promise.resolve(pass) : Promise.reject(new Error("defect"));
  });
  for (let tick = 0; tick < 6; tick += 1) {
    await probe.sweep();
    await yieldTurn();
  }
  expect(probe.calls.maintain).toBe(6);
  expect(probe.logs).toEqual([
    `orchestration A2A V2 session enrollment failed for ${seat}: seat unavailable`,
    `orchestration A2A V2 session enrollment recovered for ${seat}`,
    `orchestration A2A V2 session enrollment failed for ${seat}: seat unavailable`,
    `orchestration A2A V2 session enrollment failed for ${peer}: seat unavailable`,
    "orchestration A2A V2 session enrollment pass failed: defect",
  ]);
  // Enrollment has its own verdict; it does not mark reconciliation down.
  expect(probe.healthy).toEqual([true, true, true, true, true, true]);
});

test("orchestration sweep marks reconciliation down on its own failure and still drives enrollment", async () => {
  const probe = sweepProbe(
    () => Promise.resolve([]),
    () => Promise.reject(new Error("bridge unreadable"))
  );
  await probe.sweep();
  expect(probe.calls).toEqual({ maintain: 1, reconcile: 1 });
  expect(probe.healthy).toEqual([false]);
  expect(probe.logs).toEqual([
    "orchestration bridge reconciliation failed: bridge unreadable",
  ]);
});

test("orchestration sweep reports recovery only after a real enrollment, not while the seat waits out its retry delay", async () => {
  // A stopped seat sits in retry backoff between attempts. A sweep that
  // skips it has not recovered it, so it must not log a recovery and reset
  // the dedupe key (which made a down seat log a false recovery every ~5s).
  const config = a2aConfig();
  const store = sessionStore(config);
  const thread = { id: "" };
  const clock = { offsetMs: 0 };
  const enrollment = new ConfiguredA2AV2SessionEnrollment({
    ...codexSeat(thread),
    config,
    now: () => at(clock.offsetMs)(),
    recipients: [config.recipient],
    service: store,
  });
  let pending: Promise<unknown> = Promise.resolve();
  const logs: string[] = [];
  const sweep = createOrchestrationSweep({
    enrollment: {
      maintain: () => {
        const run = enrollment.maintain();
        pending = run;
        return run;
      },
    } as Pick<ConfiguredA2AV2SessionEnrollment, "maintain">,
    log: (line) => logs.push(line),
    reconcilers: [],
    setHealthy: () => undefined,
  });
  const tick = async (offsetMs: number) => {
    clock.offsetMs = offsetMs;
    await sweep();
    await pending.catch(() => undefined);
    await yieldTurn();
  };
  const failed =
    "orchestration A2A V2 session enrollment failed for supervisor:harness: configured A2A V2 recipient session is unavailable";
  await tick(0);
  // Still down, then back up, but both inside the retry delay: not attempted.
  await tick(1000);
  thread.id = "thread-a";
  await tick(2000);
  expect(store.rows.get(config.recipient)).toBeUndefined();
  expect(logs).toEqual([failed]);
  await tick(5000);
  expect(store.rows.get(config.recipient)?.sessionRef).toBe("session:thread-a");
  await tick(6000);
  expect(logs).toEqual([
    failed,
    "orchestration A2A V2 session enrollment recovered for supervisor:harness",
  ]);
});

test("start-time enrollment refuses the configured recipient's failure and degrades a peer's", () => {
  const recipient = "supervisor:harness";
  const peer = "supervisor:harness-peer";
  const down = (seat: string): A2AV2EnrollmentOutcome => ({
    error: new A2AV2SeatUnavailableError(`${seat} unavailable`),
    recipient: seat,
    state: "failed",
  });
  // A stopped peer does not refuse start: it is left to the sweep.
  expect(() =>
    requireA2AV2Enrollment(
      [{ recipient, state: "enrolled" }, down(peer)],
      recipient
    )
  ).not.toThrow();
  // The configured recipient itself still refuses start, with its own cause.
  expect(() =>
    requireA2AV2Enrollment(
      [down(recipient), { recipient: peer, state: "enrolled" }],
      recipient
    )
  ).toThrow(`${recipient} unavailable`);
});

test("start-time enrollment degrades a peer only when its seat is not running; any other peer failure refuses start", () => {
  const recipient = "supervisor:harness";
  const peer = "supervisor:harness-peer";
  const peerFails = (error: unknown) => () =>
    requireA2AV2Enrollment(
      [
        { recipient, state: "enrolled" },
        { error, recipient: peer, state: "failed" },
      ],
      recipient
    );
  expect(
    peerFails(
      new A2AV2SeatUnavailableError(
        "configured A2A V2 recipient session is unavailable"
      )
    )
  ).not.toThrow();
  // An authority denial, an identity or registration conflict, a store
  // failure, or anything unclassified is not a stopped seat: start refuses
  // with the peer's own cause.
  for (const message of [
    "session rebind denied: no-configured-session-rebind",
    "supervisor run manifest identity changed",
    "session descriptor conflicts with the current registration",
    "configured A2A V2 recipient has no supported provider route",
    "connect ECONNREFUSED",
  ]) {
    expect(peerFails(new Error(message))).toThrow(message);
  }
  expect(peerFails("not an error")).toThrow();
});

test("A2A V2 enrollment classifies only a seat that is not running as unavailable", async () => {
  const config = a2aConfig();
  const failureOf = async (
    input: Partial<Parameters<typeof enrollConfiguredA2AV2Session>[0]>
  ) =>
    enrollConfiguredA2AV2Session({
      ...codexSeat({ id: "thread-a" }),
      config,
      now: at(0),
      service: sessionStore(config),
      ...input,
    }).then(
      () => undefined,
      (error: unknown) => error
    );
  // No Codex thread in the run: the seat's session is not running.
  const noSession = await failureOf(codexSeat({ id: "" }));
  expect(noSession).toBeInstanceOf(A2AV2SeatUnavailableError);
  expect(failureText(noSession)).toBe(
    "configured A2A V2 recipient session is unavailable"
  );
  // The seat's run is stopped: the directory has no route for it.
  const stopped = await failureOf({ directory: { resolve: () => undefined } });
  expect(stopped).toBeInstanceOf(A2AV2SeatUnavailableError);
  expect(failureText(stopped)).toBe(
    "configured A2A V2 recipient seat is not running"
  );
  // A route to a provider this server cannot enroll is a configuration
  // error, not a stopped seat.
  const unsupported = await failureOf({
    directory: {
      resolve: () => ({ runDir: "/run/harness", target: "gemini" as never }),
    },
  });
  expect(failureText(unsupported)).toBe(
    "configured A2A V2 recipient has no supported provider route"
  );
  expect(unsupported).not.toBeInstanceOf(A2AV2SeatUnavailableError);
  // An identity conflict reading the seat's run is not a stopped seat.
  const identity = await failureOf({
    directory: {
      resolve: () => {
        throw new Error("supervisor run manifest identity changed");
      },
    },
  });
  expect(failureText(identity)).toBe(
    "supervisor run manifest identity changed"
  );
  expect(identity).not.toBeInstanceOf(A2AV2SeatUnavailableError);
  // A governed rebind denial is an authority refusal.
  const store = sessionStore(config);
  await enrollConfiguredA2AV2Session({
    ...codexSeat({ id: "thread-a" }),
    config,
    now: at(0),
    service: store,
  });
  const denied = await failureOf({
    config: { ...config, endpointRef: "endpoint:elsewhere" },
    now: at(1000),
    service: store,
  });
  expect(failureText(denied)).toContain("session rebind denied");
  expect(denied).not.toBeInstanceOf(A2AV2SeatUnavailableError);
});

test("A2A V2 enrollment says since when each seat has not been enrolled, until a pass enrolls it", async () => {
  const config = a2aConfig();
  const peer = "supervisor:harness-peer";
  const store = sessionStore(config);
  const thread = { id: "" };
  const clock = { offsetMs: 0 };
  const enrollment = new ConfiguredA2AV2SessionEnrollment({
    ...codexSeat(thread),
    config,
    now: () => at(clock.offsetMs)(),
    recipients: [config.recipient],
    service: store,
  });
  // Before any pass nothing is known to be down.
  expect(enrollment.notEnrolled()).toEqual([]);
  expect(enrollment.notEnrolledSince(config.recipient)).toBeUndefined();
  await enrollment.maintain();
  expect(enrollment.notEnrolled()).toEqual([config.recipient]);
  expect(enrollment.notEnrolledSince(config.recipient)).toBe(START);
  // A seat this enrollment does not manage is never reported.
  expect(enrollment.notEnrolledSince(peer)).toBeUndefined();
  // Waiting out the retry delay, and failing again, keep the first instant.
  clock.offsetMs = 1000;
  await enrollment.maintain();
  clock.offsetMs = 5000;
  await enrollment.maintain();
  expect(enrollment.notEnrolledSince(config.recipient)).toBe(START);
  thread.id = "thread-a";
  clock.offsetMs = 10_000;
  expect(await enrollment.maintain()).toEqual([
    { recipient: config.recipient, state: "enrolled" },
  ]);
  expect(enrollment.notEnrolled()).toEqual([]);
  expect(enrollment.notEnrolledSince(config.recipient)).toBeUndefined();
  // A later failure starts a new spell at its own instant.
  thread.id = "";
  clock.offsetMs = 20_000;
  await enrollment.maintain();
  expect(enrollment.notEnrolledSince(config.recipient)).toBe(START + 20_000);
});

test("orchestration sweep reports a peer that failed start-time enrollment as not enrolled, then its recovery", async () => {
  const peer = "supervisor:harness-peer";
  const passes: A2AV2EnrollmentOutcome[][] = [
    [{ recipient: peer, state: "deferred" }],
    [{ recipient: peer, state: "enrolled" }],
  ];
  const logs: string[] = [];
  const sweep = createOrchestrationSweep({
    enrollment: {
      maintain: () => Promise.resolve(passes.shift() ?? []),
    },
    log: (line) => logs.push(line),
    reconcilers: [],
    setHealthy: () => undefined,
    startOutcomes: [
      {
        error: new Error("configured A2A V2 recipient session is unavailable"),
        recipient: peer,
        state: "failed",
      },
    ],
  });
  const failed = `orchestration A2A V2 session enrollment failed for ${peer}: configured A2A V2 recipient session is unavailable`;
  // Reported before the first tick, so a degraded start is never silent.
  expect(logs).toEqual([failed]);
  await sweep();
  await yieldTurn();
  expect(logs).toEqual([failed]);
  await sweep();
  await yieldTurn();
  expect(logs).toEqual([
    failed,
    `orchestration A2A V2 session enrollment recovered for ${peer}`,
  ]);
});

test("orchestration sweep exposes which seats are not enrolled, from start until each one is enrolled", async () => {
  const recipient = "supervisor:harness";
  const peer = "supervisor:harness-peer";
  const down = (seat: string): A2AV2EnrollmentOutcome => ({
    error: new Error(`${seat} unavailable`),
    recipient: seat,
    state: "failed",
  });
  const passes: A2AV2EnrollmentOutcome[][] = [
    // A seat waiting out its retry delay is still not enrolled.
    [down(recipient), { recipient: peer, state: "deferred" }],
    [
      { recipient, state: "enrolled" },
      { recipient: peer, state: "enrolled" },
    ],
  ];
  const states: string[][] = [];
  const sweep = createOrchestrationSweep({
    enrollment: {
      maintain: () => Promise.resolve(passes.shift() ?? []),
    },
    log: () => undefined,
    reconcilers: [],
    setHealthy: () => undefined,
    setNotEnrolled: (seats) => states.push([...seats]),
    startOutcomes: [{ recipient, state: "enrolled" }, down(peer)],
  });
  // Known before the first tick, so /healthz shows a degraded start at once.
  expect(states).toEqual([[peer]]);
  await sweep();
  await yieldTurn();
  expect(states.at(-1)).toEqual([recipient, peer].sort());
  await sweep();
  await yieldTurn();
  expect(states.at(-1)).toEqual([]);
});

test("the V1 surface is given the mounted A2A V2 result-graph route so a reserved-id refusal can name it", () => {
  const passed: unknown[] = [];
  const host = {
    httpHandler: (_authenticator: unknown, options: unknown) => {
      passed.push(options);
      return () => Promise.resolve(new Response(null));
    },
    workerState: () => "RUNNING" as const,
  };
  createLoopOrchestrationFetchHandler({
    a2aV2Service: {
      httpHandler: () => Promise.resolve(new Response(null)),
      pathname: "/a2a/v2",
      readinessOutage: () => ({
        boundMs: 60_000,
        deferredDeliveries: 0,
        outageFailures: 0,
        recipientsDeferred: 0,
      }),
      resultGraphRoute: {
        httpHandler: () => Promise.resolve(new Response(null)),
        pathname: "/a2a/v2/result-graph",
      },
    } as never,
    authenticator: {} as never,
    host: host as never,
    reconciliationHealthy: () => true,
  });
  // Without A2A V2 there is no route to name.
  createLoopOrchestrationFetchHandler({
    authenticator: {} as never,
    host: host as never,
    reconciliationHealthy: () => true,
  });
  expect(passed).toEqual([
    { resultGraphRoutePath: "/a2a/v2/result-graph" },
    { resultGraphRoutePath: undefined },
  ]);
});

test("/healthz counts the seats that are not enrolled beside an unchanged ready state", async () => {
  let notEnrolled: readonly string[] = ["supervisor:harness-peer"];
  const host = {
    httpHandler: () => () => Promise.resolve(new Response(null)),
    workerState: () => "RUNNING" as const,
  };
  const handler = createLoopOrchestrationFetchHandler({
    authenticator: {} as never,
    host: host as never,
    notEnrolledSeats: () => notEnrolled,
    reconciliationHealthy: () => true,
  });
  const health = async (fetchHandler: typeof handler) =>
    (await fetchHandler(new Request("http://127.0.0.1/healthz"))).json();
  expect(await health(handler)).toEqual({
    notEnrolledCount: 1,
    schema: "loop-orchestration-health.v1",
    state: "ready",
  });
  notEnrolled = [];
  expect(await health(handler)).toEqual({
    notEnrolledCount: 0,
    schema: "loop-orchestration-health.v1",
    state: "ready",
  });
  // A server without A2A V2 enrollment has no seats to report.
  const plain = createLoopOrchestrationFetchHandler({
    authenticator: {} as never,
    host: host as never,
    reconciliationHealthy: () => true,
  });
  expect(await health(plain)).toEqual({
    schema: "loop-orchestration-health.v1",
    state: "ready",
  });
});
