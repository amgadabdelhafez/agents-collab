import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { sleep } from "bun";
import { parseLoopOrchestrationConfig as parseCurrentConfig } from "../../src/loop/loop-orchestration-server";
import {
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2Input,
  SupervisorResultGraphKey,
  type TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import { temporalWorkflowBundleBase64 } from "../../src/loop/temporal-workflow-bundle.generated";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";

/**
 * Rolling the A2A V2 line back to the builds that are actually deployed, not
 * to an earlier branch of the V2 line itself. Three orchestration sources
 * matter (identified 2026-10-07; see the runbook):
 *
 * - 455ccc32: the source of `loop-ed33f43f`, the binary the live
 *   orchestration service runs (`loop orchestration serve`). Not an ancestor
 *   of this line, which forked from 4439b2e7.
 * - 4439b2e7 = ea968d82: the installed launcher lineage. 4439b2e7 built the
 *   retained 678e2fde binary and ea968d82 is recorded as the source of the
 *   installed ba3671b6. Both hold the same blob for every file vendored here
 *   and for the generated workflow bundle (cebd34d4), so one fixture stands
 *   for both.
 * - dde60215: origin/main. Its dispatcher has no governess beat.
 *
 * Each fixture file is the deployed build's own source, vendored unmodified
 * and pinned to its git blob id, so these tests run the code a rollback runs.
 * Only the orchestration server's runtime-only imports, which config parsing
 * never reaches, are replaced (see `runtimeImports`).
 */

setDefaultTimeout(120_000);

const FIXTURES = join(import.meta.dir, "../fixtures");

/** Blob ids shared by every fixture whose dispatcher has the governess beat. */
const BEAT_ERA_WORKFLOW_BLOBS = {
  "governess-beat-workflow.ts": "db4e4804363a08e0f70bb3829c23793243a1de70",
  "governess-journal-core.ts": "d37d93a3cc4f8d9fab6857f2e9a3a52c2472be35",
  "governess-policy.ts": "4ded20d76ed9631d80d46f4a140a20c5258c922f",
  "supervisor-message-workflow.ts": "5b47b5b8a92d3308c924c48b7de08013cbb12ec4",
  "task-graph-workflow.ts": "ebe88141fa3cb14269c14380dbd9b8eb31e14f46",
  "temporal-workflow.ts": "ce2a515fac0d12eadfb7003f15faf6315af702e7",
  "workflow-port.ts": "01e26f882b86881223029860236897766bdf8d2c",
} as const;

/**
 * The deployed server module's imports that only `runLoopOrchestrationServer`
 * uses. They pull in the bridge, tmux, mailbox and run-state code (about
 * forty files) and a 2.8 MB workflow bundle, none of which config parsing
 * touches. Each export is replaced by one that throws if anything calls it.
 */
const SHARED_RUNTIME_IMPORTS = {
  "bridge-supervisor-message-delivery": ["BridgeSupervisorMessageDeliveryPort"],
  "loop-supervisor-directory": ["LoopSupervisorDirectory"],
  "supervisor-bridge-consumption": ["SupervisorBridgeConsumptionReconciler"],
  "supervisor-message-governance": ["JsonlSupervisorMessageReceiptPort"],
  "supervisor-thread-store": ["JsonlSupervisorThreadStore"],
  "temporal-supervisor-runtime": ["TemporalSupervisorRuntimeHost"],
} as const;

interface DeployedTarget {
  /** The vendored files and their blob ids at `commit`. */
  blobs: Record<string, string>;
  commit: string;
  dir: string;
  /** What this line added that the target's config parser refuses. */
  refuses: {
    /** A supervisor with a mailbox and no manifestPath. */
    mailboxOnlySupervisor: boolean;
    supervisorKeys: readonly string[];
    topLevelKeys: readonly string[];
  };
  runtimeImports: Record<string, readonly string[]>;
  /** Another target whose workflow bundle this one's is, blob for blob. */
  sameWorkflowBundleAs?: string;
  /** What the deployed server's own workflow type list says, if it has one. */
  workflowTypes?: readonly string[];
}

const BEAT_ERA_WORKFLOW_TYPES = [
  "governess-beat.v1",
  "supervisor-message.v1",
  "task-graph.v1",
];

const SERVICE: DeployedTarget = {
  blobs: {
    ...BEAT_ERA_WORKFLOW_BLOBS,
    "loop-orchestration-server.ts": "3856642a64df05107d32c2d5045a5cf2525d2855",
  },
  commit: "455ccc32 (live orchestration service, loop-ed33f43f)",
  dir: join(FIXTURES, "deployed-455ccc32"),
  refuses: {
    mailboxOnlySupervisor: false,
    supervisorKeys: ["seat", "wakeSession"],
    topLevelKeys: ["a2aV2", "wake"],
  },
  runtimeImports: {
    ...SHARED_RUNTIME_IMPORTS,
    "supervisor-deadline-driver": ["SupervisorDeadlineDriver"],
    "supervisor-mailbox-consumption": [
      "SupervisorMailboxConsumptionReconciler",
    ],
    "supervisor-mailbox-delivery": [
      "FirstAvailableDeliveryPort",
      "MailboxSupervisorMessageDeliveryPort",
    ],
  },
  sameWorkflowBundleAs: "deployed-4439b2e7",
  workflowTypes: BEAT_ERA_WORKFLOW_TYPES,
};

const LAUNCHER: DeployedTarget = {
  blobs: {
    ...BEAT_ERA_WORKFLOW_BLOBS,
    "loop-orchestration-server.ts": "0790131dce20921d7d43ba653ecf79a4036c2025",
  },
  commit: "4439b2e7 = ea968d82 (installed launcher lineage)",
  dir: join(FIXTURES, "deployed-4439b2e7"),
  refuses: {
    mailboxOnlySupervisor: true,
    supervisorKeys: ["mailbox", "seat", "wakeSession"],
    topLevelKeys: ["a2aV2", "deadlines", "wake"],
  },
  runtimeImports: SHARED_RUNTIME_IMPORTS,
  workflowTypes: BEAT_ERA_WORKFLOW_TYPES,
};

const MAIN: DeployedTarget = {
  blobs: {
    "loop-orchestration-server.ts": "263e94d168f582304133738b7d3c6b7008867287",
    "supervisor-message-workflow.ts":
      "5b47b5b8a92d3308c924c48b7de08013cbb12ec4",
    "task-graph-workflow.ts": "ebe88141fa3cb14269c14380dbd9b8eb31e14f46",
    "temporal-workflow.ts": "7db50f881bbb1259a955459d3ac5c2f13e84fb01",
    "workflow-port.ts": "01e26f882b86881223029860236897766bdf8d2c",
  },
  commit: "dde60215 (origin/main)",
  dir: join(FIXTURES, "deployed-dde60215"),
  refuses: LAUNCHER.refuses,
  runtimeImports: SHARED_RUNTIME_IMPORTS,
};

const TARGETS: readonly DeployedTarget[] = [SERVICE, LAUNCHER, MAIN];

const notVendored = (name: string) =>
  function notVendoredRuntimeImport() {
    throw new Error(`${name} is not vendored: config parsing never uses it`);
  };

for (const target of TARGETS) {
  // Bun matches a mocked module by the specifier, resolved from this file.
  const specifier = (module: string) =>
    `../fixtures/${basename(target.dir)}/${module}`;
  for (const [module, exported] of Object.entries(target.runtimeImports)) {
    mock.module(specifier(module), () =>
      Object.fromEntries(exported.map((name) => [name, notVendored(name)]))
    );
  }
  mock.module(specifier("temporal-workflow-bundle.generated"), () => ({
    temporalWorkflowBundleBase64: "",
  }));
}

type ConfigParser = (value: unknown) => unknown;

const deployedServers = new Map<
  DeployedTarget,
  { parse: ConfigParser; workflowTypes?: readonly string[] }
>();
for (const target of TARGETS) {
  const server = await import(join(target.dir, "loop-orchestration-server.ts"));
  deployedServers.set(target, {
    parse: server.parseLoopOrchestrationConfig,
    workflowTypes: server.LOOP_ORCHESTRATION_WORKFLOW_TYPES,
  });
}
const deployedServer = (target: DeployedTarget) => {
  const server = deployedServers.get(target);
  if (!server) {
    throw new Error(`no deployed server for ${target.commit}`);
  }
  return server;
};

/** `git hash-object` of a file's bytes. */
const gitBlobId = (bytes: Buffer): string =>
  createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");

const refusalOf = (parse: ConfigParser, value: unknown): string => {
  try {
    parse(value);
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

type Config = Record<string, unknown> & {
  supervisors: Record<string, unknown>[];
};

const A2A_V2 = {
  databaseUrlEnv: "LOOP_A2A_DATABASE_URL",
  endpointRef: "endpoint:codex-app-server",
  notEnrolledBoundMs: 900_000,
  policy: {
    claimTimeoutMs: 60_000,
    escalationTimeoutMs: 120_000,
    maxDeliveryAttempts: 3,
    retryDelayMs: 1000,
  },
  principal: "principal:harness",
  readinessOutageBoundMs: 900_000,
  recipient: "supervisor:harness",
  resultArtifacts: [],
  resultGraphKeyEnv: "LOOP_A2A_RESULT_GRAPH_KEY",
  routePath: "/a2a/v2",
  sessionTtlMs: 60_000,
  tenant: "tenant:harness",
  workflowIdFormat: "legacy",
};

const BASE = {
  address: "127.0.0.1:7233",
  buildId: "loop-orchestration.v2",
  grants: [
    {
      from: "supervisor:peer",
      operations: ["acknowledge", "claim", "receive"],
      principal: "principal:peer",
      to: "supervisor:harness",
    },
    {
      from: "supervisor:inbox",
      operations: ["receive"],
      principal: "principal:inbox",
      to: "supervisor:harness",
    },
  ],
  hostname: "127.0.0.1",
  identity: "loop-orchestration",
  namespace: "harness",
  port: 7350,
  schema: "loop-orchestration-server.v1",
  stateDir: "/var/lib/loop-orchestration",
  taskQueue: "loop-orchestration",
};

const HARNESS = {
  manifestPath: "/var/lib/loop/runs/1/manifest.json",
  principal: "principal:harness",
  supervisorId: "supervisor:harness",
  tokenEnv: "LOOP_HARNESS_TOKEN",
};
const PEER = {
  manifestPath: "/var/lib/loop/runs/2/manifest.json",
  principal: "principal:peer",
  supervisorId: "supervisor:peer",
  tokenEnv: "LOOP_PEER_TOKEN",
};
const INBOX = {
  mailbox: "/var/lib/loop/mailboxes/inbox",
  principal: "principal:inbox",
  supervisorId: "supervisor:inbox",
  tokenEnv: "LOOP_INBOX_TOKEN",
};

/**
 * A config this build accepts that uses every key it holds beyond
 * dde60215's: the full `a2aV2` object with every round-3 and round-4 key,
 * `deadlines`, `wake`, and per-supervisor `seat`, `wakeSession` and
 * `mailbox`, including a mailbox-only supervisor (no `manifestPath`).
 */
const currentHostConfig = (): Config => ({
  ...structuredClone(BASE),
  a2aV2: structuredClone(A2A_V2),
  deadlines: { intervalMs: 5000 },
  supervisors: [
    { ...HARNESS, seat: "codex", wakeSession: "harness" },
    { ...PEER, mailbox: "/var/lib/loop/mailboxes/peer" },
    { ...INBOX },
  ],
  wake: { intervalMs: 5000 },
});

/**
 * The shape the live service's config has (key structure read 2026-10-07,
 * values never printed): `deadlines`, and every supervisor mailbox-only.
 */
const liveServiceShapeConfig = (): Config => ({
  ...structuredClone(BASE),
  deadlines: { intervalMs: 60_000 },
  supervisors: [
    { ...INBOX },
    {
      mailbox: "/var/lib/loop/mailboxes/peer",
      principal: "principal:peer",
      supervisorId: "supervisor:peer",
      tokenEnv: "LOOP_PEER_TOKEN",
    },
  ],
});

/** The steps the runbook's rollback procedure applies to a config. */
const rollbackSteps = (target: DeployedTarget) => ({
  /** 1. Remove the top-level keys the target does not know. */
  removeTopLevelKeys: (config: Config) => {
    for (const key of target.refuses.topLevelKeys) {
      delete config[key];
    }
  },
  /** 2. Remove each supervisor's keys the target does not know. */
  removeSupervisorKeys: (config: Config) => {
    for (const supervisor of config.supervisors) {
      for (const key of target.refuses.supervisorKeys) {
        delete supervisor[key];
      }
    }
  },
  /** 3. Remove each mailbox-only supervisor, if the target has no mailboxes. */
  ...(target.refuses.mailboxOnlySupervisor
    ? {
        removeMailboxOnlySupervisors: (config: Config) => {
          config.supervisors = config.supervisors.filter(
            (supervisor) => supervisor.manifestPath !== undefined
          );
        },
      }
    : {}),
});

const rolledBack = (
  target: DeployedTarget,
  config: Config,
  skip?: string
): Config => {
  const copy = structuredClone(config);
  for (const [name, step] of Object.entries(rollbackSteps(target))) {
    if (name !== skip) {
      step(copy);
    }
  }
  return copy;
};

describe("rollback to the deployed builds: vendored code", () => {
  for (const target of TARGETS) {
    test(`the vendored files are byte-identical to ${target.commit}`, () => {
      for (const [file, blob] of Object.entries(target.blobs)) {
        expect({
          blob: gitBlobId(readFileSync(join(target.dir, file))),
          file,
        }).toEqual({ blob, file });
      }
    });
  }

  test("the vendored deployed server modules are the deployed ones", () => {
    expect(
      TARGETS.map((target) => deployedServer(target).workflowTypes)
    ).toEqual(TARGETS.map((target) => target.workflowTypes));
  });

  test("the live service's workflow dispatcher is the launcher lineage's, file for file", () => {
    const dispatcher = (target: DeployedTarget) =>
      Object.fromEntries(
        Object.keys(BEAT_ERA_WORKFLOW_BLOBS).map((file) => [
          file,
          target.blobs[file],
        ])
      );
    expect(SERVICE.sameWorkflowBundleAs).toBe(basename(LAUNCHER.dir));
    expect(dispatcher(SERVICE)).toEqual(dispatcher(LAUNCHER));
  });
});

describe("rollback to the deployed builds: orchestration config", () => {
  test("this build accepts the full V2 host config a rollback starts from", () => {
    expect(refusalOf(parseCurrentConfig, currentHostConfig())).toBe("accepted");
  });

  for (const target of TARGETS) {
    const { parse } = deployedServer(target);
    const rolledBackConfig = () => rolledBack(target, currentHostConfig());

    test(`${target.commit} refuses to start on each key this line added that it does not know, and only those`, () => {
      const full = currentHostConfig();
      expect(refusalOf(parse, full)).toBe(
        "orchestration config has invalid fields"
      );
      const refusals: Record<string, string> = {};
      for (const key of ["a2aV2", "deadlines", "wake"]) {
        const only = rolledBackConfig();
        only[key] = full[key];
        refusals[key] = refusalOf(parse, only);
      }
      const supervisorValues: Record<string, string> = {
        mailbox: "/var/lib/loop/mailboxes/harness",
        seat: "codex",
        wakeSession: "harness",
      };
      for (const [key, value] of Object.entries(supervisorValues)) {
        const only = rolledBackConfig();
        const [first] = only.supervisors;
        if (!first) {
          throw new Error("the rolled-back config lost every supervisor");
        }
        first[key] = value;
        refusals[`supervisor.${key}`] = refusalOf(parse, only);
      }
      const expected: Record<string, string> = {};
      for (const key of ["a2aV2", "deadlines", "wake"]) {
        expected[key] = target.refuses.topLevelKeys.includes(key)
          ? "orchestration config has invalid fields"
          : "accepted";
      }
      for (const key of ["mailbox", "seat", "wakeSession"]) {
        expected[`supervisor.${key}`] = target.refuses.supervisorKeys.includes(
          key
        )
          ? "orchestration supervisor has invalid fields"
          : "accepted";
      }
      expect(refusals).toEqual(expected);
    });

    test(`each rollback step is needed by ${target.commit}`, () => {
      const steps = Object.keys(rollbackSteps(target));
      expect(
        steps.map((skip) => ({
          refusal: refusalOf(
            parse,
            rolledBack(target, currentHostConfig(), skip)
          ),
          skip,
        }))
      ).toEqual(
        steps.map((skip) => ({
          refusal:
            skip === "removeTopLevelKeys"
              ? "orchestration config has invalid fields"
              : "orchestration supervisor has invalid fields",
          skip,
        }))
      );
    });

    test(`${target.commit} starts on the rolled-back config, which this build reads the same way`, () => {
      const config = rolledBackConfig();
      const deployed = parse(config);
      // The same file serves a later roll forward: this build accepts it and
      // reads every field the deployed build reads to the same value.
      expect(parseCurrentConfig(config)).toEqual(deployed as never);
      const { schema: _schema, ...base } = BASE;
      expect(deployed).toEqual(
        target.refuses.mailboxOnlySupervisor
          ? { ...base, supervisors: [HARNESS, PEER] }
          : {
              ...base,
              deadlines: { intervalMs: 5000 },
              supervisors: [
                HARNESS,
                { ...PEER, mailbox: "/var/lib/loop/mailboxes/peer" },
                INBOX,
              ],
            }
      );
    });
  }

  test("the live service's config shape needs no change to upgrade, and this build reads it as the service does", () => {
    const config = liveServiceShapeConfig();
    const service = deployedServer(SERVICE).parse(config);
    expect(parseCurrentConfig(config)).toEqual(service as never);
  });

  test("the launcher lineage and origin/main cannot run the live service's config at all", () => {
    for (const target of [LAUNCHER, MAIN]) {
      expect({
        commit: target.commit,
        refusal: refusalOf(
          deployedServer(target).parse,
          liveServiceShapeConfig()
        ),
      }).toEqual({
        commit: target.commit,
        refusal: "orchestration config has invalid fields",
      });
    }
  });

  test("a2aV2 on the live service's config shape is refused: its recipient must be a Loop pane binding", () => {
    const config = liveServiceShapeConfig();
    config.a2aV2 = {
      ...structuredClone(A2A_V2),
      principal: "principal:inbox",
      recipient: "supervisor:inbox",
    };
    expect(refusalOf(parseCurrentConfig, config)).toBe(
      "orchestration a2aV2 recipient is not a Loop binding"
    );
  });
});

/*
 * Temporal: what a deployed build's worker does with the executions this
 * build left on the same task queue, and what this build then finds when it
 * is rolled forward again. Real local Temporal dev server.
 *
 * This build's worker runs the committed generated bundle, exactly as the
 * server does. A deployed build's worker runs a bundle built here from its
 * vendored dispatcher. Built that way on 2026-10-07, both bundles equal the
 * deployed builds' committed generated bundles (blob cebd34d4 at 4439b2e7,
 * ea968d82 and 455ccc32; blob 17cd45cd at dde60215) after normalising module
 * path strings and the inline source map, which are all that differ. The
 * live service (455ccc32) commits the launcher lineage's bundle blob, so the
 * launcher lineage's run below stands for it.
 */

/** Targets whose workflow bundle is not another target's, blob for blob. */
const TEMPORAL_TARGETS = TARGETS.filter(
  (target) => target.sameWorkflowBundleAs === undefined
);

const v2Fixture = structuredClone(supervisorMessageV2ReplayFixtures[0]);
if (!v2Fixture) {
  throw new Error("missing V2 fixture");
}
const SCOPE: TrustedSupervisorMessageV2Scope = v2Fixture.expectedScope;

const v2InputFor = (label: string): SupervisorMessageV2Input => {
  const dedupeKey = `rollback-${label}-${randomUUID()}`;
  return {
    ...structuredClone(v2Fixture.input),
    dedupeKey,
    messageId: `message-${dedupeKey}`,
    policy: {
      claimTimeoutMs: 600_000,
      escalationTimeoutMs: 600_000,
      maxDeliveryAttempts: 3,
      retryDelayMs: 600_000,
    },
    principal: SCOPE.principal,
    tenantId: SCOPE.tenantId,
    threadId: `thread-${dedupeKey}`,
  };
};

const resultGraphInput = {
  graphId: "rollback-result-graph",
  nodes: [
    {
      acceptanceChecks: [{ checkId: "artifact", kind: "artifact" }],
      authorityGates: [],
      dependencies: [],
      ownerRepository: "agents-collab",
      readScopes: ["src"],
      specArtifactRef: `artifact://sha256/${"a".repeat(64)}`,
      taskId: "node",
      writeScopes: [],
    },
  ],
  schema: "task-graph.v1",
};

const CURRENT_BUNDLE = {
  code: Buffer.from(temporalWorkflowBundleBase64, "base64").toString("utf8"),
};

let environment: TestWorkflowEnvironment;
const deployedBundles = new Map<DeployedTarget, { code: string }>();

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
  for (const target of TEMPORAL_TARGETS) {
    deployedBundles.set(
      target,
      await bundleWorkflowCode({
        workflowsPath: join(target.dir, "temporal-workflow.ts"),
      })
    );
  }
}, 180_000);

afterAll(async () => {
  await environment?.teardown();
});

/** One host's worker on `taskQueue`, as the server composes it. */
const startWorker = async (
  taskQueue: string,
  workflowBundle: { code: string },
  identity: string
) => {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    identity,
    namespace: environment.namespace,
    taskQueue,
    workflowBundle,
  });
  const running = worker.run();
  for (let attempt = 0; worker.getState() !== "RUNNING"; attempt += 1) {
    if (attempt > 500) {
      throw new Error(`worker ${identity} did not start`);
    }
    await sleep(10);
  }
  return async () => {
    worker.shutdown();
    await running;
  };
};

/** A read's value, or the message it failed with. */
interface Read<T> {
  error?: string;
  value?: T;
}

const settle = <T>(work: Promise<T>): Promise<Read<T>> =>
  work.then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message })
  );

/** Poll `read` until it yields a value or `ms` pass. */
const eventually = async <T>(
  read: () => Promise<T | undefined>,
  ms = 30_000
): Promise<T | undefined> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  return undefined;
};

/** The dispatcher's command outcome query, the same in every build here. */
interface CommandOutcome {
  error?: { code: string; message: string };
  receipt?: { status: string };
}

/** The dispatcher's inspection query, the same in every build here. */
interface Inspection {
  history: { kind: string; name: string }[];
  status: string;
  workflowType: string;
}

const commandOutcome = (handle: WorkflowHandle, key: string) =>
  handle.query<CommandOutcome | undefined, [string]>(
    "workflow-port-command-outcome",
    key
  );

const inspection = (handle: WorkflowHandle) =>
  handle.query<Inspection>("workflow-port-inspection");

const cancelCommand = (requestId: string) => ({
  at: new Date().toISOString(),
  kind: "cancel",
  reason: "rollback-probe",
  requestId,
});

/** Workflow task failure messages and whether the execution itself failed. */
const failuresOf = async (handle: WorkflowHandle) => {
  const history = await handle.fetchHistory();
  const events = history.events ?? [];
  return {
    executionFailed: events.some(
      (event) => event.workflowExecutionFailedEventAttributes
    ),
    taskFailures: events
      .map(
        (event) =>
          event.workflowTaskFailedEventAttributes?.failure?.message ?? undefined
      )
      .filter((message): message is string => message !== undefined),
  };
};

/** A supervisor-message.v1 input, the deployed builds' own message type. */
const v1InputFor = (label: string) => {
  const dedupeKey = `rollback-v1-${label}-${randomUUID()}`;
  return {
    artifactRefs: [`artifact://sha256/${"b".repeat(64)}`],
    body: "rollback probe",
    dedupeKey,
    from: "supervisor:source",
    messageId: `message-${dedupeKey}`,
    policy: {
      claimTimeoutMs: 600_000,
      escalationTimeoutMs: 600_000,
      maxDeliveryAttempts: 2,
      retryDelayMs: 600_000,
    },
    receivedAt: new Date().toISOString(),
    threadId: `thread-${dedupeKey}`,
    to: "supervisor:target",
  };
};

/** Run `phase` with one host's worker on the queue, then stop that worker. */
const withWorker = async <T>(
  taskQueue: string,
  workflowBundle: { code: string },
  identity: string,
  phase: () => Promise<T>
): Promise<T> => {
  const stop = await startWorker(taskQueue, workflowBundle, identity);
  try {
    return await phase();
  } finally {
    await stop();
  }
};

describe("rollback to the deployed builds: Temporal executions on the same task queue", () => {
  for (const target of TEMPORAL_TARGETS) {
    test(`${target.commit}: V2 message executions are held, not failed, and resume on roll forward; shared workflow types run on both builds`, async () => {
      const deployedBundle = deployedBundles.get(target);
      if (!deployedBundle) {
        throw new Error(`no deployed bundle for ${target.commit}`);
      }
      const taskQueue = `rollback-${randomUUID()}`;
      const port = new TemporalWorkflowPort(environment.client.workflow, {
        taskQueue,
      });
      const handle = (id: string) => environment.client.workflow.getHandle(id);
      const legacy = v2InputFor("legacy");
      const deployment = v2InputFor("deployment");
      const messages = [
        {
          input: legacy,
          workflowId: deriveSupervisorMessageV2LegacyWorkflowId(
            SCOPE,
            legacy.dedupeKey
          ),
        },
        {
          input: deployment,
          workflowId: deriveSupervisorMessageV2WorkflowId(
            SCOPE,
            deployment.dedupeKey,
            taskQueue
          ),
        },
      ];
      const v1 = v1InputFor("shared");
      // Workflow types both builds register, with an unchanged definition.
      const shared = [
        {
          input: resultGraphInput,
          workflowId: deriveSupervisorMessageV2ResultGraphWorkflowId(
            SupervisorResultGraphKey.fromSecret(
              randomBytes(32).toString("hex")
            ),
            SCOPE,
            messages[0]?.workflowId as string
          ),
          workflowType: "task-graph.v1",
        },
        {
          input: v1,
          workflowId: `supervisor-message:${createHash("sha256")
            .update(v1.dedupeKey)
            .digest("hex")}`,
          workflowType: "supervisor-message.v1",
        },
      ];

      // This build: a V2 message under each id format, a result graph and a
      // V1 message, all on one task queue.
      const sharedBefore = await withWorker(
        taskQueue,
        CURRENT_BUNDLE,
        "current-build",
        async () => {
          for (const message of messages) {
            await port.start({
              input: { input: message.input, trustedScope: SCOPE } as never,
              requestId: `start-${message.workflowId}`,
              workflowId: message.workflowId,
              workflowType: "supervisor-message.v2",
            });
          }
          for (const execution of shared) {
            await port.start({
              input: execution.input as never,
              requestId: `start-${execution.workflowId}`,
              workflowId: execution.workflowId,
              workflowType: execution.workflowType,
            });
          }
          return Promise.all(
            shared.map((execution) => inspection(handle(execution.workflowId)))
          );
        }
      );

      // The deployed build, alone on the same task queue. Every command is
      // sent as the port sends it; the deployed build has no V2 code of its
      // own that would send one, so this probes the worst case.
      const deployed = await withWorker(
        taskQueue,
        deployedBundle,
        "deployed-build",
        async () => {
          const sharedReads: Read<Inspection>[] = [];
          const sharedCancels: (CommandOutcome | undefined)[] = [];
          for (const execution of shared) {
            sharedReads.push(
              await settle(inspection(handle(execution.workflowId)))
            );
            await handle(execution.workflowId).signal(
              "workflow-port-command",
              cancelCommand("deployed-cancel")
            );
            sharedCancels.push(
              await eventually(async () => {
                const outcome = await commandOutcome(
                  handle(execution.workflowId),
                  "cancel:deployed-cancel"
                );
                return outcome?.receipt ? outcome : undefined;
              })
            );
          }
          const messageReads: Read<Inspection>[] = [];
          for (const message of messages) {
            messageReads.push(
              await settle(inspection(handle(message.workflowId)))
            );
            await handle(message.workflowId).signal(
              "workflow-port-command",
              cancelCommand("held-cancel")
            );
          }
          const messageFailures = await Promise.all(
            messages.map((message) =>
              eventually(async () => {
                const failures = await failuresOf(handle(message.workflowId));
                return failures.taskFailures.length > 0 ? failures : undefined;
              })
            )
          );
          const messageStatus = await Promise.all(
            messages.map(
              async (message) =>
                (await handle(message.workflowId).describe()).status.name
            )
          );
          return {
            messageFailures,
            messageReads,
            messageStatus,
            sharedCancels,
            sharedReads,
          };
        }
      );

      expect(deployed.sharedReads).toEqual(
        sharedBefore.map((value) => ({ value }))
      );
      expect(
        deployed.sharedCancels.map((outcome) => outcome?.receipt?.status)
      ).toEqual(["canceled", "canceled"]);
      expect(deployed.messageReads).toEqual([
        { error: "unknown workflow type supervisor-message.v2" },
        { error: "unknown workflow type supervisor-message.v2" },
      ]);
      expect(deployed.messageFailures).toEqual([
        {
          executionFailed: false,
          taskFailures: ["unknown workflow type supervisor-message.v2"],
        },
        {
          executionFailed: false,
          taskFailures: ["unknown workflow type supervisor-message.v2"],
        },
      ]);
      expect(deployed.messageStatus).toEqual(["RUNNING", "RUNNING"]);

      // Roll forward: this build replays what the deployed build wrote and
      // applies the command the deployed build could not.
      const rolledForward = await withWorker(
        taskQueue,
        CURRENT_BUNDLE,
        "rolled-forward",
        async () => ({
          messageCancels: await Promise.all(
            messages.map((message) =>
              eventually(async () => {
                const outcome = await commandOutcome(
                  handle(message.workflowId),
                  "cancel:held-cancel"
                );
                return outcome?.receipt || outcome?.error ? outcome : undefined;
              })
            )
          ),
          messageFailures: await Promise.all(
            messages.map((message) => failuresOf(handle(message.workflowId)))
          ),
          sharedReads: await Promise.all(
            shared.map((execution) =>
              settle(inspection(handle(execution.workflowId)))
            )
          ),
        })
      );

      expect(
        rolledForward.messageCancels.map((outcome) => outcome?.receipt?.status)
      ).toEqual(["canceled", "canceled"]);
      expect(
        rolledForward.messageFailures.map(
          (failures) => failures.executionFailed
        )
      ).toEqual([false, false]);
      expect(
        rolledForward.sharedReads.map((read) => read.value?.status)
      ).toEqual(["canceled", "canceled"]);
    });
  }
});
