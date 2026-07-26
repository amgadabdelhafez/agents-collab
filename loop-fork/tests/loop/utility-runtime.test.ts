import { expect, test } from "bun:test";
import {
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
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  processPendingUtilityRoutes,
  renderUtilityPane,
  resolveUtilityRuntimeConfig,
  runUtilityWorker,
} from "../../src/loop/utility-runtime";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

test("OpenRouter GLM is the default but remains disabled without a credential", () => {
  const config = resolveUtilityRuntimeConfig({
    LOOP_UTILITY_API_KEY_FILE: "",
  });
  expect(config.model).toBe("z-ai/glm-5.2");
  expect(config.endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(config.enabled).toBe(false);
  expect(config.providerSort).toBe("balanced");
});

test("a mode-0600 key file enables the tier without exporting the secret", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-utility-key-"));
  const keyFile = join(root, "openrouter.key");
  writeFileSync(keyFile, "test-secret\n", { mode: 0o600 });
  try {
    expect(
      resolveUtilityRuntimeConfig({ LOOP_UTILITY_API_KEY_FILE: keyFile })
    ).toMatchObject({ apiKey: "test-secret", enabled: true });
    chmodSync(keyFile, 0o644);
    expect(
      resolveUtilityRuntimeConfig({ LOOP_UTILITY_API_KEY_FILE: keyFile })
    ).toMatchObject({ enabled: false });
  } finally {
    rmSync(root, { force: true, recursive: true });
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
      decision: { target: "utility", tierId: "utility-default" },
      state: "routed-utility",
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
        blocker: "utility worker process failed to start",
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
        blocker: "utility worker did not claim the routed job",
        status: "failed",
      },
      state: "failed",
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

test("utility pane reports current work, tool activity, usage, and idle state", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-pane-"));
  try {
    expect(renderUtilityPane(runDir, {})).toContain("No utility jobs yet.");
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["locate the config"],
        authority: {},
        id: "inspect-config",
        kind: "inspect",
        objective: "Locate the active lower-agent configuration",
        readScope: ["src"],
        requester: "codex",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      })
    );
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
    writeFileSync(
      join(runDir, "utility", "usage.jsonl"),
      `${JSON.stringify({
        at: "2026-07-25T12:00:01.000Z",
        jobId: "inspect-config",
        status: "completed",
        usage: { cost: 0.004_416, totalTokens: 1234 },
      })}\n`
    );

    const pane = renderUtilityPane(runDir, {
      LOOP_UTILITY_API_KEY_FILE: "",
    });
    expect(pane).toContain("STATUS  active=0 queued=1 done=0 failed=0");
    expect(pane).toContain("NOW  inspect- pending-route");
    expect(pane).toContain("TOOL  search_repo  ok  12ms");
    expect(pane).toContain("LAST  completed  1,234 tok  $0.0044");
    expect(pane).toContain("governess routes; observer pane is read-only");
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
  claimUtilityJob(runDir, 4, { jobId: request.id });
  try {
    await processPendingUtilityRoutes({
      currentDriver: "codex",
      epoch: 5,
      peer: "claude",
      repoRoot,
      runDir,
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "utility claim belongs to a stale governess epoch",
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
    expect(readBridgeEvents(runDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "utility",
          target: "codex",
          taskId: request.id,
        }),
      ])
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("utility worker completes against an OpenAI-compatible local endpoint", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-runtime-"));
  const runDir = join(repoRoot, ".loop", "runs", "test-run");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
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
        usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
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
      result: { status: "completed", summary: "Sample file confirmed." },
      state: "completed",
    });
    expect(readBridgeEvents(runDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          message: expect.stringContaining("Utility result job-1"),
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
        blocker: "utility task completed without repository tool evidence",
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
    id: "failing-check-job",
    kind: "command",
    objective: "Run the focused check",
    readScope: ["tests"],
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
        blocker: "utility command completed without a successful focused check",
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
