import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readUtilityObservability,
  sanitizeUtilityPaneText,
} from "../../src/loop/utility-observability";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

test("utility observability safely handles absent and malformed journals", () => {
  const runDir = mkdtempSync(join(tmpdir(), "utility-observability-bad-"));
  try {
    expect(readUtilityObservability()).toMatchObject({
      available: false,
      jobsTotal: 0,
      transcript: [],
    });
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["report one result"],
        authority: {},
        id: "durable-before-torn-tail",
        kind: "inspect",
        objective: "Inspect one bounded source file",
        readScope: ["src"],
        requester: "claude",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      })
    );
    appendFileSync(join(runDir, "utility", "jobs.jsonl"), "{truncated\n");
    writeFileSync(
      join(runDir, "utility", "usage.jsonl"),
      [
        "not-json",
        JSON.stringify({
          jobId: "orphan",
          model: "z-ai/glm-5.2",
          modelCalls: 1,
          toolCalls: 0,
          usage: { totalTokens: 12 },
        }),
      ].join("\n")
    );

    expect(() => readUtilityObservability(runDir)).not.toThrow();
    expect(readUtilityObservability(runDir)).toMatchObject({
      available: true,
      jobsTotal: 1,
      model: "z-ai/glm-5.2",
      usage: { modelCalls: 1, totalTokens: 12 },
    });
    expect(
      sanitizeUtilityPaneText(
        "use ghp_1234567890abcdefghijklmnop and AKIAABCDEFGHIJKLMNOP"
      )
    ).toBe("use [REDACTED] and [REDACTED]");
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("utility observability totals worker usage and builds a safe transcript", () => {
  const runDir = mkdtempSync(join(tmpdir(), "utility-observability-"));
  try {
    const completed = createUtilityRouteRequest({
      acceptanceCriteria: ["report evidence"],
      authority: {},
      createdAt: "2026-07-26T01:00:00.000Z",
      id: "completed-job",
      kind: "inspect",
      objective:
        "Inspect src/config.ts\u001b[31m and report the active value; token=secret-value",
      readScope: ["src/config.ts"],
      requester: "claude",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, completed);
    activateUtilityEpoch(runDir, 7);
    transitionUtilityJob(runDir, completed.id, "routed-utility", {
      at: "2026-07-26T01:00:00.100Z",
      decision: {
        reason: "utility-eligible",
        target: "utility",
        tierId: "openrouter-glm",
      },
      routeEpoch: 7,
    });
    claimUtilityJob(runDir, 7, {
      at: "2026-07-26T01:00:00.200Z",
      jobId: completed.id,
      workerId: "test",
      workerPid: process.pid,
    });
    transitionUtilityJob(runDir, completed.id, "running", {
      at: "2026-07-26T01:00:00.300Z",
    });
    transitionUtilityJob(runDir, completed.id, "completed", {
      at: "2026-07-26T01:00:02.000Z",
      result: {
        artifactRefs: [],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary: "The active value is safe and source-backed.\u0007",
      },
    });

    const failed = createUtilityRouteRequest({
      acceptanceCriteria: ["report evidence"],
      authority: {},
      createdAt: "2026-07-26T01:01:00.000Z",
      id: "failed-job",
      kind: "inspect",
      objective: "Inspect a bounded source slice",
      readScope: ["src"],
      requester: "codex",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, failed);
    transitionUtilityJob(runDir, failed.id, "routed-utility", {
      at: "2026-07-26T01:01:00.100Z",
      decision: { reason: "utility-eligible", target: "utility" },
      routeEpoch: 7,
    });
    transitionUtilityJob(runDir, failed.id, "failed", {
      at: "2026-07-26T01:01:01.000Z",
      result: {
        artifactRefs: [],
        blocker: "worker token cap exceeded",
        checks: [],
        filesChanged: [],
        status: "failed",
        summary: "Utility worker failed closed.",
      },
    });

    writeFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      `${JSON.stringify({
        at: "2026-07-26T01:00:01.000Z",
        durationMs: 9,
        jobId: completed.id,
        ok: true,
        output: "raw tool output must never be rendered",
        tool: "read_file",
      })}\n`
    );
    writeFileSync(
      join(runDir, "utility", "usage.jsonl"),
      [
        JSON.stringify({
          at: "2026-07-26T01:00:02.000Z",
          durationMs: 12_000,
          jobId: completed.id,
          model: "z-ai/glm-5.2",
          modelCalls: 2,
          status: "completed",
          toolCalls: 1,
          usage: {
            cachedInputTokens: 400,
            cost: 0.003,
            inputTokens: 1000,
            outputTokens: 250,
            reasoningTokens: 50,
            totalTokens: 1250,
          },
        }),
        JSON.stringify({
          at: "2026-07-26T01:01:01.000Z",
          durationMs: 22_000,
          jobId: failed.id,
          model: "z-ai/glm-5.2",
          modelCalls: 3,
          status: "failed",
          toolCalls: 2,
          usage: {
            cachedInputTokens: 600,
            cost: 0.004,
            inputTokens: 1500,
            outputTokens: 300,
            reasoningTokens: 60,
            totalTokens: 1800,
          },
        }),
      ].join("\n")
    );

    const snapshot = readUtilityObservability(runDir);
    expect(snapshot).toMatchObject({
      active: 0,
      available: true,
      completed: 1,
      failed: 1,
      jobsTotal: 2,
      latestJobId: failed.id,
      latestState: "failed",
      model: "z-ai/glm-5.2",
      queued: 0,
      usage: {
        cachedInputTokens: 1000,
        costUsd: 0.007,
        inputTokens: 2500,
        modelCalls: 5,
        outputTokens: 550,
        reasoningTokens: 110,
        toolCalls: 3,
        totalTokens: 3050,
      },
    });
    expect(snapshot.transcript.map((entry) => entry.label)).toEqual([
      "CLAUDE→GLM",
      "GLM TOOL",
      "GLM OK",
      "CODEX→GLM",
      "GLM FAIL",
    ]);
    expect(
      snapshot.transcript.find((entry) => entry.label === "GLM OK")?.usage
    ).toEqual({
      costUsd: 0.003,
      durationMs: 12_000,
      modelCalls: 2,
      toolCalls: 1,
      totalTokens: 1250,
    });
    const transcript = snapshot.transcript.map((entry) => entry.text).join(" ");
    expect(transcript).toContain("worker token cap exceeded");
    expect(transcript).not.toContain("raw tool output");
    expect(transcript).toContain("token=[REDACTED]");
    expect(transcript).not.toContain("secret-value");
    expect(transcript).not.toContain("\u001b");
    expect(transcript).not.toContain("\u0007");
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});
