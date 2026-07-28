import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "bun";
import { readBridgeEvents } from "../../src/loop/bridge-store";
import {
  appendDelegationEvent,
  makeDelegationEvent,
} from "../../src/loop/delegation-policy";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import { utilityContextPath } from "../../src/loop/utility-context";
import { readUtilityObservability } from "../../src/loop/utility-observability";
import {
  applyUtilityJobPatch,
  buildUtilityWorkerEnvironment,
  createUtilityReadPlanBroker,
  processPendingUtilityRoutes,
  renderUtilityPane,
  resolveUtilityRuntimeConfig,
  runUtilityWorker,
  utilityBrokerBoundary,
  utilityToolsForExecutionProfile,
} from "../../src/loop/utility-runtime";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";
import { createUtilityToolBroker } from "../../src/loop/utility-tools";

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const visiblePane = (value: string): string => value.replace(ANSI_RE, "");

const completedEditProposal = async (
  repoRoot: string,
  runDir: string,
  jobId: string
): Promise<{
  manifestPath: string;
  manifestSha256: string;
  patchPath: string;
  patchSha256: string;
}> => {
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repoRoot, "src", "sample.ts"), "export const n = 1;\n");
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["propose one guarded patch"],
    authority: {},
    id: jobId,
    kind: "edit",
    objective: "Increment the sample value",
    readScope: ["src/sample.ts"],
    requester: "claude",
    requiredCapabilities: ["inspect", "scoped-edit"],
    risk: "low",
    writeScope: ["src/sample.ts"],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 30);
  transitionUtilityJob(runDir, jobId, "routed-utility", { routeEpoch: 30 });
  claimUtilityJob(runDir, 30, { jobId, workerPid: 6060 });
  transitionUtilityJob(runDir, jobId, "running");
  const broker = await createUtilityToolBroker({
    artifactDir: `.loop/runs/apply/utility/artifacts/${jobId}`,
    commandAllowlist: [],
    readScopes: ["src/sample.ts"],
    repoRoot,
    writeScopes: ["src/sample.ts"],
  });
  const patch = [
    "diff --git a/src/sample.ts b/src/sample.ts",
    "--- a/src/sample.ts",
    "+++ b/src/sample.ts",
    "@@ -1 +1 @@",
    "-export const n = 1;",
    "+export const n = 2;",
    "",
  ].join("\n");
  const proposal = await broker.execute({
    arguments: { patch, summary: "increment sample" },
    name: "propose_patch",
  });
  if (!(proposal.ok && proposal.artifact)) {
    throw new Error("failed to create guarded patch fixture");
  }
  transitionUtilityJob(runDir, jobId, "completed", {
    result: {
      artifactRefs: [
        {
          kind: "diff",
          manifestPath: proposal.artifact.manifestPath,
          manifestSha256: proposal.artifact.manifestSha256,
          path: proposal.artifact.path,
          sha256: proposal.artifact.sha256,
        },
      ],
      checks: [],
      filesChanged: [],
      status: "completed",
      summary: "guarded patch proposed",
    },
  });
  return {
    manifestPath: proposal.artifact.manifestPath ?? "",
    manifestSha256: proposal.artifact.manifestSha256 ?? "",
    patchPath: proposal.artifact.path,
    patchSha256: proposal.artifact.sha256,
  };
};

const routedInspectFixture = (
  name: string
): {
  repoRoot: string;
  request: ReturnType<typeof createUtilityRouteRequest>;
  runDir: string;
} => {
  const repoRoot = mkdtempSync(join(tmpdir(), `loop-utility-${name}-`));
  const runDir = join(repoRoot, ".loop", "runs", name);
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    Array.from(
      { length: 80 },
      (_, index) => `export const n${index + 1} = ${index + 1};`
    ).join("\n") + "\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect with repository evidence"],
    authority: {},
    id: `${name}-job`,
    kind: "inspect",
    objective: "Inspect the sample file",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 77);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 77,
  });
  return { repoRoot, request, runDir };
};

const jsonlRecords = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test("OpenRouter GLM is the default but remains disabled without a credential", () => {
  const config = resolveUtilityRuntimeConfig({
    LOOP_UTILITY_API_KEY_FILE: "",
  });
  expect(config.model).toBe("z-ai/glm-5.2");
  expect(config.endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(config.enabled).toBe(false);
  expect(config.availability.code).toBe("key-file-disabled");
  expect(config.providerSort).toBe("balanced");
  expect(config.harness).toBe("pi-sdk");
  expect(config.maxConcurrentJobs).toBe(4);
  expect(config.nannyMaxConcurrentJobs).toBe(1);
  expect(config).not.toHaveProperty("maxSteps");
  expect(config).not.toHaveProperty("maxTokens");
  expect(config).not.toHaveProperty("maxTotalTokens");
});

test("Au Pair and Nanny role-specific switches override compatibility names", () => {
  const config = resolveUtilityRuntimeConfig({
    LOOP_AU_PAIR_ENABLED: "0",
    LOOP_AU_PAIR_PROVIDER_SORT: "throughput",
    LOOP_NANNY_ENABLED: "0",
    LOOP_UTILITY_ENABLED: "1",
    LOOP_UTILITY_PROVIDER_SORT: "price",
  });
  expect(config.enabled).toBe(false);
  expect(config.nannyEnabled).toBe(false);
  expect(config.providerSort).toBe("throughput");
});

test("worker concurrency is configurable within a bounded range", () => {
  expect(
    resolveUtilityRuntimeConfig({ LOOP_UTILITY_MAX_CONCURRENCY: "4" })
      .maxConcurrentJobs
  ).toBe(4);
  expect(
    resolveUtilityRuntimeConfig({ LOOP_UTILITY_MAX_CONCURRENCY: "0" })
      .maxConcurrentJobs
  ).toBe(4);
  expect(
    resolveUtilityRuntimeConfig({ LOOP_UTILITY_MAX_CONCURRENCY: "9" })
      .maxConcurrentJobs
  ).toBe(4);
});

test("auto execution profiles expose only satisfiable broker tools", () => {
  expect(utilityToolsForExecutionProfile("file-read")).toEqual(["read_file"]);
  expect(utilityToolsForExecutionProfile("search")).toEqual(["search_repo"]);
  expect(utilityToolsForExecutionProfile("git-status")).toEqual(["git_status"]);
  expect(utilityToolsForExecutionProfile("git-diff")).toEqual(["git_diff"]);
  expect(utilityToolsForExecutionProfile("git-inspect")).toEqual([
    "git_inspect",
  ]);
  expect(utilityToolsForExecutionProfile("focused-check")).toEqual([
    "run_check",
  ]);
  expect(utilityToolsForExecutionProfile("file-list")).toEqual(["list_files"]);
  expect(utilityToolsForExecutionProfile("read-plan")).toEqual([]);
  expect(utilityToolsForExecutionProfile("read-plan")).not.toContain(
    "run_check"
  );
  expect(utilityToolsForExecutionProfile("read-plan")).not.toContain(
    "propose_patch"
  );
  expect(utilityToolsForExecutionProfile(undefined)).toBeUndefined();
  expect(utilityToolsForExecutionProfile("future-profile")).toEqual([]);
  expect(utilityToolsForExecutionProfile("__proto__")).toEqual([]);
  expect(utilityToolsForExecutionProfile(null)).toEqual([]);
});

test("structured cat plans cannot invoke Git tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-read-plan-cat-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "sample.ts"), "one\ntwo\n");
    const broker = await createUtilityReadPlanBroker({
      artifactDir: ".utility-artifacts",
      executionPlan: [
        {
          executionProfile: "file-read",
          objective: "Read sample",
          readScope: ["src/sample.ts"],
        },
      ],
      repoRoot: root,
    });
    expect(broker.definitions.map((tool) => tool.function.name)).toEqual([
      "read_file",
    ]);
    expect(
      await broker.execute({
        arguments: { action: "show-stat", ref: "HEAD" },
        name: "git_inspect",
      })
    ).toMatchObject({ error: { code: "tool_denied" }, ok: false });
    expect(
      await broker.execute({
        arguments: { path: "src/sample.ts" },
        name: "read_file",
      })
    ).toMatchObject({ data: { content: "one\ntwo" }, ok: true });
    expect(() => broker.assertComplete?.()).not.toThrow();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("structured Git metadata rejects forged narrow file scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-read-plan-git-scope-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "sample.ts"), "sample\n");
    await expect(
      createUtilityReadPlanBroker({
        artifactDir: ".utility-artifacts",
        executionPlan: [
          {
            executionProfile: "git-inspect",
            objective: "Inspect Git metadata",
            readScope: ["src/sample.ts"],
          },
        ],
        repoRoot: root,
      })
    ).rejects.toThrow("requires explicit repository scope");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("structured multi-directory plans cannot read content or cross stages", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-read-plan-list-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "src", "sample.ts"), "source\n");
    writeFileSync(join(root, "tests", "sample.test.ts"), "test\n");
    const broker = await createUtilityReadPlanBroker({
      artifactDir: ".utility-artifacts",
      executionPlan: [
        {
          executionProfile: "file-list",
          objective: "List source",
          readScope: ["src"],
        },
        {
          executionProfile: "file-list",
          objective: "List tests",
          readScope: ["tests"],
        },
      ],
      repoRoot: root,
    });
    expect(
      await broker.execute({
        arguments: { path: "src/sample.ts" },
        name: "read_file",
      })
    ).toMatchObject({ error: { code: "tool_denied" }, ok: false });
    expect(
      await broker.execute({ arguments: { path: "src" }, name: "list_files" })
    ).toMatchObject({ ok: true });
    expect(() => broker.assertComplete?.()).toThrow("step 2 of 2");
    expect(
      await broker.execute({ arguments: { path: "src" }, name: "list_files" })
    ).toMatchObject({ error: { code: "scope_denied" }, ok: false });
    expect(
      await broker.execute({
        arguments: { path: "tests" },
        name: "list_files",
      })
    ).toMatchObject({ ok: true });
    expect(() => broker.assertComplete?.()).not.toThrow();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("structured mixed plans retain exact slices and output filters", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-read-plan-mixed-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "src", "sample.ts"), "one\ntwo\nthree\n");
    writeFileSync(join(root, "tests", "sample.test.ts"), "needle\n");
    const broker = await createUtilityReadPlanBroker({
      artifactDir: ".utility-artifacts",
      executionPlan: [
        {
          executionOutput: { lineLimit: 1, position: "head" },
          executionProfile: "file-read",
          executionRead: {
            endLine: 3,
            path: "src/sample.ts",
            startLine: 1,
          },
          objective: "Read exact sample slice",
          readScope: ["src/sample.ts"],
        },
        {
          executionProfile: "search",
          objective: "Search tests",
          readScope: ["tests"],
        },
      ],
      repoRoot: root,
    });
    expect(
      await broker.execute({
        arguments: { endLine: 2, path: "src/sample.ts", startLine: 1 },
        name: "read_file",
      })
    ).toMatchObject({ error: { code: "command_denied" }, ok: false });
    expect(
      await broker.execute({
        arguments: { endLine: 3, path: "src/sample.ts", startLine: 1 },
        name: "read_file",
      })
    ).toMatchObject({
      data: { content: "one", endLine: 1, startLine: 1 },
      ok: true,
    });
    expect(
      await broker.execute({
        arguments: { path: "src/sample.ts" },
        name: "read_file",
      })
    ).toMatchObject({ error: { code: "tool_denied" }, ok: false });
    expect(
      await broker.execute({
        arguments: { paths: ["tests"], query: "needle" },
        name: "search_repo",
      })
    ).toMatchObject({ ok: true });
    expect(() => broker.assertComplete?.()).not.toThrow();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("structured focused-check stages expose only their exact run_check boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-read-plan-check-"));
  try {
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests", "sample.test.ts"), "test\n");
    const broker = await createUtilityReadPlanBroker({
      artifactDir: ".utility-artifacts",
      executionPlan: [
        {
          executionArgv: ["bun", "test", "tests/sample.test.ts"],
          executionCwd: ".",
          executionProfile: "focused-check",
          objective: "Run exact focused test",
          readScope: [".", "tests/sample.test.ts"],
        },
      ],
      repoRoot: root,
    });
    expect(broker.definitions.map((tool) => tool.function.name)).toEqual([
      "run_check",
    ]);
    expect(
      await broker.execute({ arguments: {}, name: "git_status" })
    ).toMatchObject({ error: { code: "tool_denied" }, ok: false });
    expect(
      await broker.execute({
        arguments: {
          argv: ["bun", "test", "tests/other.test.ts"],
          cwd: ".",
        },
        name: "run_check",
      })
    ).toMatchObject({ error: { code: "command_denied" }, ok: false });
    expect(
      await broker.execute({
        arguments: {
          argv: ["bun", "test", "tests/sample.test.ts"],
          cwd: ".",
        },
        name: "run_check",
      })
    ).toMatchObject({ ok: true });
    expect(() => broker.assertComplete?.()).not.toThrow();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("file-read runtime carries an exact broker range and fails closed without one", () => {
  const exactRequest = createUtilityRouteRequest({
    acceptanceCriteria: ["return the exact slice"],
    authority: {},
    executionOutput: { lineLimit: 5, position: "tail" },
    executionProfile: "file-read",
    executionRead: { endLine: 20, path: "src/example.ts", startLine: 1 },
    kind: "inspect",
    objective: "Inspect an exact source slice",
    readScope: ["src/example.ts"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  expect(
    utilityBrokerBoundary(exactRequest, exactRequest.readScope, [])
  ).toEqual({
    exactRead: { endLine: 20, path: "src/example.ts", startLine: 1 },
    outputBoundary: { lineLimit: 5, position: "tail" },
    readScopes: ["src/example.ts"],
  });
  expect(
    utilityBrokerBoundary(
      { ...exactRequest, executionRead: undefined },
      exactRequest.readScope,
      []
    )
  ).toEqual({
    exactRead: null,
    outputBoundary: { lineLimit: 5, position: "tail" },
    readScopes: ["src/example.ts"],
  });
});

test("a mode-0600 key file enables the tier without exporting the secret", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-utility-key-"));
  const keyFile = join(root, "openrouter.key");
  writeFileSync(keyFile, "test-secret\n", { mode: 0o600 });
  try {
    expect(
      resolveUtilityRuntimeConfig({ LOOP_UTILITY_API_KEY_FILE: keyFile })
    ).toMatchObject({
      apiKey: "test-secret",
      availability: { code: "ready-key-file" },
      enabled: true,
    });
    chmodSync(keyFile, 0o644);
    expect(
      resolveUtilityRuntimeConfig({ LOOP_UTILITY_API_KEY_FILE: keyFile })
    ).toMatchObject({
      availability: {
        code: "key-file-permissions",
        message: expect.stringContaining("chmod 600"),
      },
      enabled: false,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("detached utility worker environment is allowlist-built, not inherited", () => {
  expect(
    buildUtilityWorkerEnvironment({
      HOME: "/Users/example",
      LOOP_UTILITY_API_KEY: "direct-secret",
      LOOP_UTILITY_API_KEY_FILE: "/safe/openrouter.key",
      LOOP_UTILITY_MODEL: "local-model",
      OPENROUTER_API_KEY: "openrouter-secret",
      PATH: "/bin",
      RANDOM_TOKEN: "unrelated-secret",
    })
  ).toEqual({
    CI: "1",
    HOME: "/Users/example",
    LOOP_UTILITY_API_KEY_FILE: "/safe/openrouter.key",
    LOOP_UTILITY_MODEL: "local-model",
    NO_COLOR: "1",
    PATH: "/bin",
  });
});

test("governess passes only the minimal key-file worker environment", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-worker-env-"));
  const runDir = join(repoRoot, ".loop", "runs", "worker-env-run");
  const keyFile = join(repoRoot, "openrouter.key");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(keyFile, "file-secret\n", { mode: 0o600 });
  appendUtilityRouteRequest(
    runDir,
    createUtilityRouteRequest({
      acceptanceCriteria: ["inspect"],
      authority: {},
      id: "worker-env-job",
      kind: "inspect",
      objective: "Inspect one file",
      readScope: ["src"],
      requester: "claude",
      requiredCapabilities: ["inspect", "focused-verify"],
      risk: "low",
      writeScope: [],
    })
  );
  let childEnv: NodeJS.ProcessEnv | undefined;
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 15,
        peer: "codex",
        repoRoot,
        runDir,
      },
      {
        HOME: "/Users/example",
        LOOP_UTILITY_API_KEY: "direct-secret",
        LOOP_UTILITY_API_KEY_FILE: keyFile,
        LOOP_UTILITY_MODEL: "z-ai/glm-5.2",
        OPENROUTER_API_KEY: "openrouter-secret",
        PATH: "/bin",
        RANDOM_TOKEN: "unrelated-secret",
      },
      {
        spawnWorker: (input) => {
          childEnv = input.env;
          return true;
        },
      }
    );
    expect(childEnv).toEqual({
      CI: "1",
      HOME: "/Users/example",
      LOOP_UTILITY_API_KEY_FILE: keyFile,
      LOOP_UTILITY_MODEL: "z-ai/glm-5.2",
      NO_COLOR: "1",
      PATH: "/bin",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("governess route processing dispatches eligible work without provider I/O", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-route-"));
  const runDir = join(repoRoot, ".loop", "runs", "route-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["locate one file"],
    authority: {},
    id: "route-job",
    kind: "inspect",
    objective: "Locate a file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  const spawned: string[] = [];
  try {
    const count = await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 11,
        peer: "codex",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        spawnWorker: ({ jobId }) => {
          spawned.push(jobId);
          return true;
        },
      }
    );
    expect(count).toBe(1);
    expect(spawned).toEqual([request.id]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      decision: { target: "utility", tierId: "utility-nanny" },
      state: "routed-utility",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("worker routing ignores cost estimates", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-run-budget-"));
  const runDir = join(repoRoot, ".loop", "runs", "budget-run");
  mkdirSync(runDir, { recursive: true });
  for (const id of ["budget-a", "budget-b", "budget-c"]) {
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["inspect one scope"],
        authority: {},
        id,
        kind: "inspect",
        estimatedCostUsd: 10_000,
        objective: `Inspect ${id}`,
        readScope: ["src"],
        requester: "claude",
        requiredCapabilities: ["inspect", "focused-verify"],
        risk: "low",
        writeScope: [],
      })
    );
  }
  const spawned: string[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 18,
        peer: "codex",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_MAX_CONCURRENCY: "3",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        spawnWorker: ({ jobId }) => {
          spawned.push(jobId);
          return true;
        },
      }
    );

    expect(spawned).toEqual(["budget-a", "budget-b", "budget-c"]);
    expect(readUtilityJob(runDir, "budget-c")).toMatchObject({
      decision: { reason: "utility-eligible", target: "utility" },
      state: "routed-utility",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the default worker pool runs four jobs and leaves a fifth pending", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-pool-"));
  const runDir = join(repoRoot, ".loop", "runs", "pool-run");
  mkdirSync(runDir, { recursive: true });
  for (const id of ["pool-a", "pool-b", "pool-c", "pool-d", "pool-e"]) {
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["inspect one scope"],
        authority: {},
        id,
        kind: "inspect",
        objective: `Inspect ${id}`,
        readScope: ["src"],
        requester: "claude",
        requiredCapabilities: ["inspect", "focused-verify"],
        risk: "low",
        writeScope: [],
      })
    );
  }
  const spawned: string[] = [];
  const context = {
    currentDriver: "claude" as const,
    epoch: 19,
    peer: "codex" as const,
    repoRoot,
    runDir,
  };
  const env = {
    LOOP_UTILITY_ENABLED: "1",
    LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
  };
  const deps = {
    spawnWorker: ({ jobId }: { jobId: string }) => {
      spawned.push(jobId);
      return true;
    },
  };
  try {
    await processPendingUtilityRoutes(context, env, deps);
    expect(spawned).toEqual(["pool-a", "pool-b", "pool-c", "pool-d"]);
    expect(readUtilityJob(runDir, "pool-e")?.state).toBe("pending-route");

    claimUtilityJob(runDir, 19, { jobId: "pool-a", workerPid: process.pid });
    transitionUtilityJob(runDir, "pool-a", "running");
    transitionUtilityJob(runDir, "pool-a", "completed", {
      result: {
        artifactRefs: [],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary: "done",
      },
    });

    await processPendingUtilityRoutes(context, env, deps);
    expect(spawned).toEqual(["pool-a", "pool-b", "pool-c", "pool-d", "pool-e"]);
    expect(readUtilityJob(runDir, "pool-e")?.state).toBe("routed-utility");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("unprofiled bounded inspections persist Nanny ownership without spilling to Au Pair", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-nanny-capacity-"));
  const runDir = join(repoRoot, ".loop", "runs", "nanny-capacity");
  mkdirSync(runDir, { recursive: true });
  for (const id of ["nanny-a", "nanny-b"]) {
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["return one search result"],
        authority: {},
        id,
        kind: "inspect",
        objective: `Inspect the bounded source file for ${id}`,
        readScope: ["src/sample.ts"],
        requester: "claude",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      })
    );
  }
  const spawned: string[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 21,
        peer: "codex",
        repoRoot,
        runDir,
      },
      {
        LOOP_AU_PAIR_ENABLED: "1",
        LOOP_AU_PAIR_URL: "http://127.0.0.1:9998/v1/chat/completions",
        LOOP_NANNY_ENABLED: "1",
        LOOP_NANNY_MAX_CONCURRENCY: "1",
        LOOP_NANNY_URL: "http://127.0.0.1:9999/v1/chat/completions",
      },
      {
        spawnWorker: ({ jobId }) => {
          spawned.push(jobId);
          return true;
        },
      }
    );
    expect(spawned).toEqual(["nanny-a"]);
    expect(readUtilityJob(runDir, "nanny-a")).toMatchObject({
      decision: { tierId: "utility-nanny" },
      state: "routed-utility",
    });
    expect(readUtilityJob(runDir, "nanny-b")).toMatchObject({
      decision: { tierId: "utility-nanny" },
      state: "pending-route",
    });
    expect(readUtilityObservability(runDir, "utility-nanny").jobsTotal).toBe(2);
    expect(readUtilityObservability(runDir, "utility-au-pair").jobsTotal).toBe(
      0
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("unprofiled bounded inspections fail closed when Nanny is unavailable", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-nanny-unavailable-"));
  const runDir = join(repoRoot, ".loop", "runs", "nanny-unavailable");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return bounded file evidence"],
    authority: {},
    id: "nanny-unavailable-job",
    kind: "inspect",
    objective: "Inspect the bounded source file",
    readScope: ["src/sample.ts"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  const spawned: string[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 22,
        peer: "codex",
        repoRoot,
        runDir,
      },
      {
        LOOP_AU_PAIR_ENABLED: "1",
        LOOP_AU_PAIR_URL: "http://127.0.0.1:9998/v1/chat/completions",
        LOOP_NANNY_ENABLED: "0",
      },
      {
        spawnWorker: ({ jobId }) => {
          spawned.push(jobId);
          return true;
        },
      }
    );
    expect(spawned).toEqual([]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      decision: {
        detail: "disabled by LOOP_NANNY_ENABLED=0",
        reason: "utility-unavailable",
        target: "driver",
      },
      state: "routed-driver",
    });
    expect(readUtilityObservability(runDir, "utility-au-pair").jobsTotal).toBe(
      0
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("peer-routed reviews preserve the requester and ask the peer to act", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-peer-review-"));
  const runDir = join(repoRoot, ".loop", "runs", "peer-review-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return a verdict"],
    authority: {},
    id: "peer-review-job",
    kind: "review",
    objective:
      "Review docs-only commit abc123 and decide whether it is banked.",
    readScope: ["docs/result.md"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 20,
        peer: "claude",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_API_KEY_FILE: "" }
    );

    const message = readBridgeEvents(runDir).find(
      (event) => event.kind === "message"
    );
    expect(message).toMatchObject({
      source: "codex",
      target: "claude",
      taskId: request.id,
      type: "review_request",
    });
    expect(message?.message).toContain("Peer review requested by codex");
    expect(message?.message).toContain("Action: perform the review");
    expect(message?.message).toContain("explicit verdict to codex");
    expect(message?.message).not.toContain("Worker route");
    expect(message?.message).not.toContain("informational routing notice");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("safe key diagnostics persist in routing observability, not the output-only worker pane", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-diagnostic-"));
  const runDir = join(repoRoot, ".loop", "runs", "diagnostic-run");
  const keyFile = join(repoRoot, "openrouter.key");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(keyFile, "never-render-this-secret\n", { mode: 0o644 });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect one scope"],
    authority: {},
    id: "diagnostic-job",
    kind: "inspect",
    objective: "Inspect configuration",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect", "focused-verify"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 19,
        peer: "claude",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_API_KEY_FILE: keyFile }
    );

    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      decision: {
        detail: expect.stringContaining("chmod 600"),
        reason: "utility-unavailable",
        target: "driver",
      },
      state: "routed-driver",
    });
    const pane = renderUtilityPane(runDir, {
      LOOP_UTILITY_API_KEY_FILE: keyFile,
    });
    expect(pane).toContain("waiting for first request");
    expect(pane).not.toContain("driver/utility-unavailable");
    expect(pane).not.toContain("chmod 600");
    expect(pane).not.toContain("never-render-this-secret");
    expect(readUtilityObservability(runDir).routing).toMatchObject({
      considered: 1,
      reasons: { "utility-unavailable": 1 },
      routed: 0,
      skipped: 1,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("spawn failure terminates the job instead of stranding routed utility work", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-spawn-"));
  const runDir = join(repoRoot, ".loop", "runs", "spawn-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "spawn-job",
    kind: "inspect",
    objective: "Inspect a file",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 12,
        peer: "claude",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      { spawnWorker: () => false }
    );
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "Nanny process failed to start",
        status: "failed",
      },
      state: "failed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an unclaimed routed job fails closed after its claim deadline", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-unclaimed-"));
  const runDir = join(repoRoot, ".loop", "runs", "unclaimed-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "unclaimed-job",
    kind: "inspect",
    objective: "Inspect a file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 14);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    at: "2020-01-01T00:00:00.000Z",
    routeEpoch: 14,
  });
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 14,
        peer: "codex",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_MAX_CLAIM_WAIT_MS: "1" }
    );
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "Au Pair did not claim the routed job",
        status: "failed",
      },
      state: "failed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a dead claimed worker fails immediately and releases its write scope", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-dead-worker-"));
  const runDir = join(repoRoot, ".loop", "runs", "dead-worker-run");
  mkdirSync(runDir, { recursive: true });
  for (const id of ["dead-edit", "replacement-edit"]) {
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["propose patch"],
        authority: {},
        id,
        kind: "edit",
        objective: `Edit ${id}`,
        readScope: ["src/shared.ts"],
        requester: "codex",
        requiredCapabilities: ["scoped-edit"],
        risk: "low",
        writeScope: ["src/shared.ts"],
      })
    );
  }
  activateUtilityEpoch(runDir, 20);
  transitionUtilityJob(runDir, "dead-edit", "routed-utility", {
    routeEpoch: 20,
  });
  claimUtilityJob(runDir, 20, {
    jobId: "dead-edit",
    workerId: "utility-4242",
    workerPid: 4242,
  });
  transitionUtilityJob(runDir, "dead-edit", "running");
  const spawned: string[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 20,
        peer: "claude",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        isWorkerAlive: () => false,
        spawnWorker: ({ jobId }) => {
          spawned.push(jobId);
          return true;
        },
      }
    );
    expect(readUtilityJob(runDir, "dead-edit")).toMatchObject({
      result: {
        blocker: "Au Pair process is no longer alive",
        status: "failed",
      },
      state: "failed",
    });
    expect(readUtilityJob(runDir, "replacement-edit")?.state).toBe(
      "routed-utility"
    );
    expect(spawned).toEqual(["replacement-edit"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a live worker remains claimed before its external runtime deadline", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-live-worker-"));
  const runDir = join(repoRoot, ".loop", "runs", "live-worker-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "live-worker",
    kind: "inspect",
    objective: "Inspect one file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 21);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 21,
  });
  claimUtilityJob(runDir, 21, {
    at: "2026-07-26T16:00:00.000Z",
    jobId: request.id,
    workerPid: 4343,
  });
  transitionUtilityJob(runDir, request.id, "running", {
    at: "2026-07-26T16:00:01.000Z",
  });
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 21,
        peer: "codex",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_MAX_RUNTIME_MS: "10000" },
      {
        isWorkerAlive: () => true,
        now: () => Date.parse("2026-07-26T16:00:05.000Z"),
      }
    );
    expect(readUtilityJob(runDir, request.id)?.state).toBe("running");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("governess externally terminates a live worker past its runtime", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-runtime-kill-"));
  const runDir = join(repoRoot, ".loop", "runs", "runtime-kill-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "timed-out-worker",
    kind: "inspect",
    objective: "Inspect one file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 22);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 22,
  });
  claimUtilityJob(runDir, 22, {
    at: "2026-07-26T16:00:00.000Z",
    jobId: request.id,
    workerPid: 4444,
  });
  transitionUtilityJob(runDir, request.id, "running", {
    at: "2026-07-26T16:00:01.000Z",
  });
  const terminated: number[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 22,
        peer: "codex",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_MAX_RUNTIME_MS: "1000" },
      {
        isWorkerAlive: () => true,
        now: () => Date.parse("2026-07-26T16:00:05.000Z"),
        terminateWorker: (pid) => {
          terminated.push(pid);
          return true;
        },
      }
    );
    expect(terminated).toEqual([4444]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "Au Pair job exceeded its runtime limit and was terminated",
      },
      state: "failed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("terminal completion racing the reaper is preserved", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-reaper-race-"));
  const runDir = join(repoRoot, ".loop", "runs", "reaper-race-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "racing-worker",
    kind: "inspect",
    objective: "Inspect one file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 23);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 23,
  });
  claimUtilityJob(runDir, 23, {
    at: "2026-07-26T16:00:00.000Z",
    jobId: request.id,
    workerPid: 4545,
  });
  transitionUtilityJob(runDir, request.id, "running", {
    at: "2026-07-26T16:00:01.000Z",
  });
  let completed = false;
  const terminated: number[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 23,
        peer: "codex",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_MAX_RUNTIME_MS: "1000" },
      {
        isWorkerAlive: () => {
          if (!completed) {
            completed = true;
            transitionUtilityJob(runDir, request.id, "completed", {
              result: {
                artifactRefs: [],
                checks: [],
                filesChanged: [],
                status: "completed",
                summary: "completed during reaper probe",
              },
            });
          }
          return true;
        },
        now: () => Date.parse("2026-07-26T16:00:05.000Z"),
        terminateWorker: (pid) => {
          terminated.push(pid);
          return true;
        },
      }
    );
    expect(terminated).toEqual([]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: { summary: "completed during reaper probe" },
      state: "completed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("overlapping utility writes are not dispatched concurrently", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-conflict-"));
  const runDir = join(repoRoot, ".loop", "runs", "conflict-run");
  mkdirSync(runDir, { recursive: true });
  for (const id of ["edit-a", "edit-b"]) {
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["propose patch"],
        authority: {},
        id,
        kind: "edit",
        objective: `Edit ${id}`,
        readScope: ["src/shared.ts"],
        requester: "codex",
        requiredCapabilities: ["scoped-edit"],
        risk: "low",
        writeScope: ["src/shared.ts"],
      })
    );
  }
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 13,
        peer: "claude",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      { spawnWorker: () => true }
    );
    expect(readUtilityJob(runDir, "edit-a")?.state).toBe("routed-utility");
    expect(readUtilityJob(runDir, "edit-b")).toMatchObject({
      decision: { reason: "write-conflict", target: "driver" },
      state: "routed-driver",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("worker pane is a colored output-only request, tool, and response stream", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-pane-"));
  try {
    expect(renderUtilityPane(runDir, {})).toContain(
      "waiting for first request"
    );
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["locate the config"],
        authority: {},
        createdAt: "2026-07-25T11:59:59.000Z",
        id: "inspect-config",
        kind: "inspect",
        objective:
          "Inspect src/loop/utility-runtime.ts for the requested bounded source slice (1221-1290) and return concise relevant evidence.\u001b[31m",
        readScope: ["src"],
        requester: "codex",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      })
    );
    activateUtilityEpoch(runDir, 1);
    transitionUtilityJob(runDir, "inspect-config", "routed-utility", {
      at: "2026-07-25T11:59:59.100Z",
      decision: {
        reason: "utility-eligible",
        target: "utility",
        tierId: "openrouter-glm",
      },
      routeEpoch: 1,
    });
    claimUtilityJob(runDir, 1, {
      at: "2026-07-25T11:59:59.200Z",
      jobId: "inspect-config",
      workerId: "test-worker",
      workerPid: process.pid,
    });
    transitionUtilityJob(runDir, "inspect-config", "running", {
      at: "2026-07-25T11:59:59.300Z",
    });
    writeFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      `${JSON.stringify({
        at: "2026-07-25T12:00:00.000Z",
        durationMs: 12,
        jobId: "inspect-config",
        ok: true,
        tool: "search_repo",
      })}\n`
    );
    appendDelegationEvent(
      runDir,
      makeDelegationEvent({
        agent: "claude",
        disposition: "auto-routed",
        fingerprint: "a".repeat(64),
        operation: "git-status",
        reason: "git-status",
        source: "claude-hook",
        taskId: "inspect-config",
      })
    );
    appendDelegationEvent(
      runDir,
      makeDelegationEvent({
        agent: "codex",
        disposition: "missed-candidate",
        fingerprint: "b".repeat(64),
        operation: "scoped-search",
        reason: "codex-tool-hook-unavailable",
        source: "codex-app-server",
      })
    );
    writeFileSync(
      join(runDir, "utility", "usage.jsonl"),
      `${JSON.stringify({
        at: "2026-07-25T12:00:01.000Z",
        durationMs: 11_000,
        jobId: "inspect-config",
        model: "z-ai/glm-5.2",
        modelCalls: 2,
        status: "completed",
        toolCalls: 1,
        usage: {
          cachedInputTokens: 500,
          cost: 0.004_416,
          inputTokens: 900,
          outputTokens: 334,
          totalTokens: 1234,
        },
      })}\n`
    );
    transitionUtilityJob(runDir, "inspect-config", "completed", {
      at: "2026-07-25T12:00:02.000Z",
      result: {
        artifactRefs: [],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary:
          "**Outcome:** Inspected the requested lines. **Evidence (src/loop/utility-runtime.ts):** Found the active configuration; no secret values were read.",
      },
    });

    const pane = renderUtilityPane(
      runDir,
      { LOOP_UTILITY_API_KEY_FILE: "" },
      { columns: 120, rows: 20 }
    );
    expect(pane).toContain("\u001b[36m");
    expect(pane).toContain("\u001b[34m");
    expect(pane).toContain("\u001b[32m");
    expect(pane).toContain("AU PAIR TOOL inspect-");
    expect(pane).toContain("search_repo ok 12ms");
    expect(pane).toContain("CODEX→AU PAIR inspect-");
    expect(pane).toContain("read utility-runtime.ts lines 1221–1290");
    expect(pane).toContain("AU PAIR OK inspect-");
    expect(pane).toContain("Inspected the requested lines");
    expect(pane).toContain("Found the active configuration");
    expect(pane).not.toContain("USAGE");
    expect(pane).not.toContain("TOKENS");
    expect(pane).not.toContain("ROUTE");
    expect(pane).not.toContain("1,234 tok");

    const timestampOnly = renderUtilityPane(
      runDir,
      { LOOP_UTILITY_API_KEY_FILE: "" },
      { columns: 58, rows: 3 }
    )
      .split("\n")
      .map(visiblePane);
    expect(timestampOnly).toHaveLength(3);
    expect(
      timestampOnly.every((line) => /^\d{2}:\d{2}:\d{2} /.test(line))
    ).toBe(true);

    const compact = renderUtilityPane(
      runDir,
      { LOOP_UTILITY_API_KEY_FILE: "" },
      { columns: 58, rows: 10 }
    );
    expect(compact.split("\n").length).toBeGreaterThanOrEqual(5);
    expect(compact.split("\n").length).toBeLessThanOrEqual(10);
    expect(
      compact.split("\n").every((line) => visiblePane(line).length <= 58)
    ).toBe(true);
    expect(compact).toContain("CODEX→AU PAIR inspect-");
    expect(compact).toContain("AU PAIR TOOL inspect-");
    expect(compact).toContain("search_repo ok 12ms");
    expect(compact).toContain("AU PAIR OK inspect-");
    expect(visiblePane(compact).replaceAll(/\s+/g, " ")).toContain(
      "Found the active configuration"
    );

    appendFileSync(join(runDir, "utility", "jobs.jsonl"), "{torn\n");
    expect(() =>
      renderUtilityPane(
        runDir,
        { LOOP_UTILITY_API_KEY_FILE: "" },
        { columns: 58, rows: 20 }
      )
    ).not.toThrow();
    expect(
      visiblePane(
        renderUtilityPane(
          runDir,
          { LOOP_UTILITY_API_KEY_FILE: "" },
          { columns: 58, rows: 20 }
        )
      ).replaceAll(/\s+/g, " ")
    ).toContain("Found the active configuration");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("utility pane keeps a failed worker response visible within its viewport", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-pane-failure-"));
  try {
    const request = createUtilityRouteRequest({
      acceptanceCriteria: ["return a bounded result"],
      authority: {},
      createdAt: "2026-07-25T13:00:00.000Z",
      id: "failed-pane-job",
      kind: "inspect",
      objective: "Inspect one source slice without widening scope",
      readScope: ["src"],
      requester: "claude",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, request);
    transitionUtilityJob(runDir, request.id, "routed-utility", {
      at: "2026-07-25T13:00:00.100Z",
      decision: { reason: "utility-eligible", target: "utility" },
      routeEpoch: 1,
    });
    transitionUtilityJob(runDir, request.id, "failed", {
      at: "2026-07-25T13:00:01.000Z",
      result: {
        artifactRefs: [],
        blocker:
          "Worker token cap exceeded before a source-backed response could be produced.",
        checks: [],
        filesChanged: [],
        status: "failed",
        summary: "Worker failed closed.",
      },
    });

    const pane = renderUtilityPane(
      runDir,
      { LOOP_UTILITY_API_KEY_FILE: "" },
      { columns: 52, rows: 12 }
    );
    const lines = pane.split("\n");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.every((line) => visiblePane(line).length <= 52)).toBe(true);
    expect(pane).toContain("AU PAIR FAIL failed-p");
    expect(pane).toContain("Worker token cap exceeded");

    const tiny = renderUtilityPane(
      runDir,
      { LOOP_UTILITY_API_KEY_FILE: "" },
      { columns: 20, rows: 5 }
    ).split("\n");
    expect(tiny).toHaveLength(5);
    expect(tiny.every((line) => visiblePane(line).length <= 20)).toBe(true);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("Nanny and Au Pair panes show only their own tier", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-helper-pane-filter-"));
  const runDir = join(repoRoot, ".loop", "runs", "pane-filter");
  mkdirSync(runDir, { recursive: true });
  try {
    activateUtilityEpoch(runDir, 3);
    for (const [id, tierId, objective] of [
      ["nanny-job", "utility-nanny", "NANNY-ONLY-OBJECTIVE"],
      ["au-pair-job", "utility-au-pair", "AU-PAIR-ONLY-OBJECTIVE"],
    ] as const) {
      const request = createUtilityRouteRequest({
        acceptanceCriteria: ["return evidence"],
        authority: {},
        id,
        kind: "inspect",
        objective,
        readScope: ["src"],
        requester: "claude",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      });
      appendUtilityRouteRequest(runDir, request);
      transitionUtilityJob(runDir, id, "routed-utility", {
        decision: {
          reason: "utility-eligible",
          target: "utility",
          tierId,
        },
        routeEpoch: 3,
      });
      claimUtilityJob(runDir, 3, {
        jobId: id,
        workerId: `pane-${id}`,
        workerPid: id === "nanny-job" ? 3001 : 3002,
      });
      transitionUtilityJob(runDir, id, "running");
      transitionUtilityJob(runDir, id, "completed", {
        result: {
          artifactRefs: [],
          checks: [],
          filesChanged: [],
          status: "completed",
          summary: `${objective} complete`,
        },
      });
    }
    const nanny = visiblePane(
      renderUtilityPane(runDir, {}, { tierId: "utility-nanny" })
    );
    const auPair = visiblePane(
      renderUtilityPane(runDir, {}, { tierId: "utility-au-pair" })
    );
    expect(nanny).toContain("NANNY-ONLY-OBJECTIVE");
    expect(nanny).not.toContain("AU-PAIR-ONLY-OBJECTIVE");
    expect(auPair).toContain("AU-PAIR-ONLY-OBJECTIVE");
    expect(auPair).not.toContain("NANNY-ONLY-OBJECTIVE");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Nanny pane includes local Qwen governess advisory usage", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-nanny-pane-governess-"));
  try {
    writeFileSync(
      join(runDir, "governess-state.json"),
      JSON.stringify({
        llmUsage: { calls: 7, totalTokens: 4321 },
        summary: "Reviewed pair progress and kept the current driver.",
      })
    );

    const nanny = visiblePane(
      renderUtilityPane(
        runDir,
        {},
        {
          columns: 100,
          rows: 6,
          tierId: "utility-nanny",
        }
      )
    );
    const auPair = visiblePane(
      renderUtilityPane(
        runDir,
        {},
        {
          columns: 100,
          rows: 6,
          tierId: "utility-au-pair",
        }
      )
    );

    expect(nanny).toContain("NANNY QWEN");
    expect(nanny).toContain("governess advisory · 7 calls · 4321 tok");
    expect(nanny).toContain("Reviewed pair progress");
    expect(auPair).not.toContain("governess advisory");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a new governess epoch fences an orphaned utility claim", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-fence-"));
  const runDir = join(repoRoot, ".loop", "runs", "fence-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["finish"],
    authority: {},
    id: "fenced-job",
    kind: "inspect",
    objective: "Inspect one scope",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 4);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 4,
  });
  claimUtilityJob(runDir, 4, { jobId: request.id, workerPid: 4646 });
  const terminated: number[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 5,
        peer: "claude",
        repoRoot,
        runDir,
      },
      {},
      {
        isWorkerAlive: () => true,
        terminateWorker: (pid) => {
          terminated.push(pid);
          return true;
        },
      }
    );
    expect(terminated).toEqual([4646]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "Au Pair claim belongs to a stale Governess epoch",
        status: "failed",
      },
      state: "failed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("peer routing is relative to the requester, not the current driver", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-peer-"));
  const runDir = join(repoRoot, ".loop", "runs", "peer-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["review it"],
    authority: {},
    id: "review-job",
    kind: "review",
    objective: "Review a bounded proposal",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: [],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes({
      currentDriver: "codex",
      epoch: 5,
      peer: "claude",
      repoRoot,
      runDir,
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      decision: {
        reason: "review-stays-with-requester",
        target: "requester",
      },
      state: "routed-requester",
    });
    expect(readBridgeEvents(runDir)).toEqual([]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a full agent applies a completed utility patch with pre/postimage journal proof", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-guarded-apply-"));
  const runDir = join(repoRoot, ".loop", "runs", "apply");
  try {
    const proposal = await completedEditProposal(
      repoRoot,
      runDir,
      "guarded-edit"
    );
    const applied = await applyUtilityJobPatch(
      runDir,
      "guarded-edit",
      proposal.patchSha256,
      "codex"
    );
    expect(applied.status).toBe("applied");
    expect(readFileSync(join(repoRoot, "src", "sample.ts"), "utf8")).toBe(
      "export const n = 2;\n"
    );
    const expectedPostimage = createHash("sha256")
      .update("export const n = 2;\n")
      .digest("hex");
    expect(readUtilityJob(runDir, "guarded-edit")?.application).toMatchObject({
      appliedBy: "codex",
      patchSha256: proposal.patchSha256,
      postimages: [{ path: "src/sample.ts", sha256: expectedPostimage }],
    });

    const repeated = await applyUtilityJobPatch(
      runDir,
      "guarded-edit",
      proposal.patchSha256,
      "claude"
    );
    expect(repeated.status).toBe("already-applied");

    writeFileSync(join(repoRoot, "src", "sample.ts"), "later drift\n");
    await expect(
      applyUtilityJobPatch(
        runDir,
        "guarded-edit",
        proposal.patchSha256,
        "claude"
      )
    ).rejects.toThrow("postimage drift detected");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("guarded patch application refuses wrong hashes and proposal-time drift", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-guarded-drift-"));
  const runDir = join(repoRoot, ".loop", "runs", "apply");
  try {
    const proposal = await completedEditProposal(
      repoRoot,
      runDir,
      "drifted-edit"
    );
    await expect(
      applyUtilityJobPatch(runDir, "drifted-edit", "0".repeat(64), "codex")
    ).rejects.toThrow("missing or ambiguous");

    const originalManifest = readFileSync(proposal.manifestPath, "utf8");
    writeFileSync(proposal.manifestPath, `${originalManifest} `);
    await expect(
      applyUtilityJobPatch(
        runDir,
        "drifted-edit",
        proposal.patchSha256,
        "codex"
      )
    ).rejects.toThrow("manifest hash does not match");
    writeFileSync(proposal.manifestPath, originalManifest);

    writeFileSync(join(repoRoot, "src", "sample.ts"), "concurrent edit\n");
    await expect(
      applyUtilityJobPatch(
        runDir,
        "drifted-edit",
        proposal.patchSha256,
        "codex"
      )
    ).rejects.toThrow("preimage drift detected");
    expect(readUtilityJob(runDir, "drifted-edit")?.application).toBeUndefined();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("utility worker completes against an OpenAI-compatible local endpoint", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-runtime-"));
  const runDir = join(repoRoot, ".loop", "runs", "test-run");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "UTILITY.instructions.md"),
    "stable-project-context"
  );
  writeFileSync(join(repoRoot, "docs", "guide.md"), "selected-task-context");
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    "export const ok = true;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["report completion"],
    authority: {},
    contextRefs: ["docs/guide.md"],
    id: "job-1",
    kind: "inspect",
    objective: "Confirm the sample file exists",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 7);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-default",
    },
    routeEpoch: 7,
  });
  let providerCalls = 0;
  const providerBodies: Array<Record<string, unknown>> = [];
  const server = serve({
    fetch: async (incoming) => {
      providerCalls += 1;
      providerBodies.push((await incoming.json()) as Record<string, unknown>);
      return Response.json({
        choices: [
          {
            finish_reason: providerCalls === 1 ? "tool_calls" : "stop",
            message:
              providerCalls === 1
                ? {
                    content: null,
                    role: "assistant",
                    tool_calls: [
                      {
                        function: {
                          arguments: '{"path":"src/sample.ts"}',
                          name: "read_file",
                        },
                        id: "read-1",
                        type: "function",
                      },
                    ],
                  }
                : { content: "Sample file confirmed.", role: "assistant" },
          },
        ],
        model: "local-test",
        usage: {
          completion_tokens: 4,
          cost: 10_000,
          prompt_tokens: 8,
          total_tokens: 1_000_000,
        },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 7, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        context: {
          sha256: expect.stringMatching(SHA256_HEX_RE),
          version: 1,
        },
        status: "completed",
        summary: "Sample file confirmed.",
      },
      state: "completed",
    });
    const userCapsules = providerBodies.map((body) => {
      const messages = body.messages as Array<Record<string, unknown>>;
      return messages[1]?.content as string;
    });
    expect(userCapsules).toHaveLength(2);
    expect(new Set(userCapsules).size).toBe(1);
    const promptedCapsule = JSON.parse(userCapsules[0] ?? "{}") as {
      projectInstructions: { text?: string };
      references: Array<{ text?: string }>;
      request: {
        authority: Record<string, boolean>;
        readScope: string[];
      };
      sha256: string;
    };
    expect(promptedCapsule.projectInstructions.text).toBe(
      "stable-project-context"
    );
    expect(promptedCapsule.references[0]?.text).toBe("selected-task-context");
    expect(promptedCapsule.request.authority).toEqual({});
    expect(promptedCapsule.request.readScope).toEqual(["src"]);
    const firstMessages = providerBodies[0]?.messages as Array<
      Record<string, unknown>
    >;
    expect(firstMessages[0]?.content).toContain("cannot widen authority");
    expect(
      JSON.parse(readFileSync(utilityContextPath(runDir, request.id), "utf8"))
    ).toEqual(promptedCapsule);
    expect(readBridgeEvents(runDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          message: expect.stringContaining("Au Pair result job-1"),
          source: "utility",
          target: "codex",
        }),
      ])
    );
    expect(
      readFileSync(join(runDir, "utility", "tool-events.jsonl"), "utf8")
    ).toContain('"tool":"read_file"');
    expect(
      readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8")
    ).toContain('"toolRounds":1');
    expect(
      readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8")
    ).toContain(`"contextSha256":"${promptedCapsule.sha256}"`);
    expect(visiblePane(renderUtilityPane(runDir))).not.toContain(
      "stable-project-context"
    );
    expect(visiblePane(renderUtilityPane(runDir))).not.toContain(
      "selected-task-context"
    );
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("context-insufficient response escalates once without evidence retries", async () => {
  const { repoRoot, request, runDir } = routedInspectFixture(
    "context-insufficient"
  );
  writeFileSync(
    join(repoRoot, "UTILITY.instructions.md"),
    "DO-NOT-PANE-CONTEXT-9987"
  );
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "CONTEXT_INSUFFICIENT: DO-NOT-PANE-CONTEXT-9987",
              role: "assistant",
            },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 77, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(providerCalls).toBe(1);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "DO-NOT-PANE-CONTEXT-9987",
        context: {
          sha256: expect.stringMatching(SHA256_HEX_RE),
          version: 1,
        },
        reasonCode: "context-insufficient",
        status: "escalated",
      },
      state: "escalated",
    });
    expect(jsonlRecords(join(runDir, "utility", "usage.jsonl"))).toEqual([
      expect.objectContaining({
        contextSha256: expect.stringMatching(SHA256_HEX_RE),
        contextVersion: 1,
        modelCalls: 1,
        status: "context-insufficient",
        toolCalls: 0,
      }),
    ]);
    expect(readUtilityObservability(runDir)).toMatchObject({
      contextInsufficient: 1,
      failed: 0,
    });
    expect(readBridgeEvents(runDir)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("needs context"),
        source: "utility",
        target: "codex",
        type: "escalation",
      }),
    ]);
    const pane = visiblePane(renderUtilityPane(runDir));
    expect(pane).toContain("AU PAIR CONTEXT");
    expect(pane).toContain("Context insufficient; requester notified.");
    expect(pane).not.toContain("DO-NOT-PANE-CONTEXT-9987");
    expect(pane).not.toContain("CONTEXT_INSUFFICIENT");
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("worker tools cannot read their persisted context capsule", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-context-guard-"));
  const runDir = join(repoRoot, ".loop", "runs", "context-guard");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "UTILITY.instructions.md"),
    "must-never-return-through-a-tool"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["report safe evidence"],
    authority: {},
    id: "context-guard-job",
    kind: "inspect",
    objective: "Inspect the repository without reading control context",
    readScope: ["."],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 78);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 78,
  });
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      return Response.json({
        choices: [
          {
            finish_reason: providerCalls === 1 ? "tool_calls" : "stop",
            message:
              providerCalls === 1
                ? {
                    content: null,
                    role: "assistant",
                    tool_calls: [
                      {
                        function: {
                          arguments: JSON.stringify({
                            path: ".loop/runs/context-guard/utility/contexts/context-guard-job.json",
                          }),
                          name: "read_file",
                        },
                        id: "read-context",
                        type: "function",
                      },
                    ],
                  }
                : {
                    content:
                      "CONTEXT_INSUFFICIENT: protected context is not repository evidence",
                    role: "assistant",
                  },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 78, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(providerCalls).toBe(2);
    const toolEvents = readFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      "utf8"
    );
    expect(toolEvents).toContain('"code":"path_denied"');
    expect(toolEvents).not.toContain("must-never-return-through-a-tool");
    expect(visiblePane(renderUtilityPane(runDir))).not.toContain(
      "must-never-return-through-a-tool"
    );
  } finally {
    server.stop(true);
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("utility worker stops after three consecutive broker rejections", async () => {
  const { repoRoot, request, runDir } = routedInspectFixture("denial-breaker");
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      return Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({
                      path: `outside-${providerCalls}.ts`,
                    }),
                    name: "read_file",
                  },
                  id: `denied-${providerCalls}`,
                  type: "function",
                },
              ],
            },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 77, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(providerCalls).toBe(3);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: expect.stringContaining(
          "3 consecutive broker rejections without progress"
        ),
        status: "failed",
      },
      state: "failed",
    });
    const toolEvents = jsonlRecords(
      join(runDir, "utility", "tool-events.jsonl")
    );
    expect(toolEvents).toHaveLength(3);
    expect(toolEvents.every((event) => event.ok === false)).toBe(true);
    expect(JSON.stringify(toolEvents.at(-1))).toContain("scope_denied");
    expect(readBridgeEvents(runDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          message: expect.stringContaining(
            "3 consecutive broker rejections without progress"
          ),
          source: "utility",
          target: "codex",
        }),
      ])
    );
    expect(
      jsonlRecords(join(runDir, "utility", "usage.jsonl")).at(-1)
    ).toMatchObject({
      modelCalls: 3,
      status: "failed",
      toolCalls: 3,
      toolRounds: 3,
    });
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a successful broker call resets the consecutive rejection breaker", async () => {
  const { repoRoot, request, runDir } = routedInspectFixture("denial-reset");
  const toolArguments = [
    '{"path":"outside-1.ts"}',
    '{"path":"src/sample.ts","startLine":1,"endLine":1}',
    '{"path":"outside-2.ts"}',
    '{"path":"outside-3.ts"}',
  ];
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      const argumentsJson = toolArguments[providerCalls - 1];
      return Response.json({
        choices: [
          {
            finish_reason: argumentsJson ? "tool_calls" : "stop",
            message: argumentsJson
              ? {
                  content: null,
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: argumentsJson,
                        name: "read_file",
                      },
                      id: `reset-${providerCalls}`,
                      type: "function",
                    },
                  ],
                }
              : { content: "Inspection complete.", role: "assistant" },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 77, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(providerCalls).toBe(5);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: { status: "completed", summary: "Inspection complete." },
      state: "completed",
    });
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("utility worker refuses to execute a third identical tool call", async () => {
  const { repoRoot, request, runDir } = routedInspectFixture("repeat-breaker");
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      return Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments:
                      '{"path":"src/sample.ts","startLine":1,"endLine":1}',
                    name: "read_file",
                  },
                  id: `repeat-${providerCalls}`,
                  type: "function",
                },
              ],
            },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 77, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(providerCalls).toBe(3);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: expect.stringContaining(
          "before third consecutive identical tool call: read_file"
        ),
        status: "failed",
      },
      state: "failed",
    });
    expect(
      jsonlRecords(join(runDir, "utility", "tool-events.jsonl"))
    ).toHaveLength(2);
    expect(
      jsonlRecords(join(runDir, "utility", "usage.jsonl")).at(-1)
    ).toMatchObject({ modelCalls: 3, status: "failed", toolCalls: 2 });
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("utility worker stops before a sixty-fifth model call", async () => {
  const { repoRoot, request, runDir } =
    routedInspectFixture("emergency-ceiling");
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      return Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({
                      endLine: providerCalls,
                      path: "src/sample.ts",
                      startLine: providerCalls,
                    }),
                    name: "read_file",
                  },
                  id: `ceiling-${providerCalls}`,
                  type: "function",
                },
              ],
            },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 77, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(providerCalls).toBe(64);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: expect.stringContaining(
          "emergency 64-model-call ceiling without completion"
        ),
        status: "failed",
      },
      state: "failed",
    });
    expect(
      jsonlRecords(join(runDir, "utility", "tool-events.jsonl"))
    ).toHaveLength(64);
    expect(
      jsonlRecords(join(runDir, "utility", "usage.jsonl")).at(-1)
    ).toMatchObject({ modelCalls: 64, status: "failed", toolCalls: 64 });
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("utility worker rejects prose-only completion without repository evidence", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-no-evidence-"));
  const runDir = join(repoRoot, ".loop", "runs", "no-evidence");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repoRoot, "src", "sample.ts"), "export {};\n");
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect with evidence"],
    authority: {},
    id: "no-evidence-job",
    kind: "inspect",
    objective: "Inspect the sample",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 8);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 8,
  });
  const server = serve({
    fetch: () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Trust me, it exists.", role: "assistant" },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
      }),
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 8, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "Au Pair task completed without repository tool evidence",
        status: "failed",
      },
      state: "failed",
    });
    expect(
      readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8")
    ).toContain('"status":"failed"');
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a failing focused check cannot satisfy command completion evidence", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-check-fail-"));
  const runDir = join(repoRoot, ".loop", "runs", "check-fail");
  mkdirSync(join(repoRoot, "tests"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "tests", "fail.test.ts"),
    'import { expect, test } from "bun:test";\ntest("fails", () => expect(1).toBe(2));\n'
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["focused check passes"],
    authority: {},
    executionArgv: ["bun", "test", "tests/fail.test.ts"],
    executionCwd: "tests",
    executionProfile: "focused-check",
    id: "failing-check-job",
    kind: "command",
    objective: "Run the focused check",
    readScope: ["tests", "tests/fail.test.ts"],
    requester: "claude",
    requiredCapabilities: ["focused-verify"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 9);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 9,
  });
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      return Response.json({
        choices: [
          {
            finish_reason: providerCalls === 1 ? "tool_calls" : "stop",
            message:
              providerCalls === 1
                ? {
                    content: null,
                    role: "assistant",
                    tool_calls: [
                      {
                        function: {
                          arguments:
                            '{"argv":["bun","test","tests/fail.test.ts"],"cwd":"tests"}',
                          name: "run_check",
                        },
                        id: "check-1",
                        type: "function",
                      },
                    ],
                  }
                : { content: "The check ran.", role: "assistant" },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 9, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "Direct run_check failed: focused check exited 1",
        status: "failed",
      },
      state: "failed",
    });
    expect(
      readFileSync(join(runDir, "utility", "tool-events.jsonl"), "utf8")
    ).toContain('"exitCode":1');
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
