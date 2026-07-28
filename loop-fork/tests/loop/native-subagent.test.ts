import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLoopCodexConfig,
  buildLoopCodexFallbackAgent,
  ensureLoopCodexHome,
} from "../../src/loop/codex-home";
import {
  appendNativeFallbackRequest,
  bindNativeFallbackStart,
  CLAUDE_NATIVE_FALLBACK_PROFILE,
  CODEX_NATIVE_FALLBACK_PROFILE,
  completeNativeFallback,
  consumeNativeFallbackLease,
  createNativeFallbackRequest,
  nativeFallbackForChild,
  nativeFallbackScopeAllows,
  processPendingNativeFallbackRequests,
  readNativeFallbackObservability,
  readNativeFallbackRequests,
  resolveNativeSubagentMode,
} from "../../src/loop/native-subagent";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  claudeNativeFallbackDefinition,
  claudeNativeSubagentArgs,
  tmuxInternals,
} from "../../src/loop/tmux";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

const settledUtilityJob = (
  runDir: string,
  requester: "claude" | "codex",
  id: string
): void => {
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["return evidence"],
    authority: {},
    id,
    kind: "inspect",
    objective: "Inspect a bounded source file",
    readScope: ["src/example.ts"],
    requester,
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  transitionUtilityJob(runDir, id, "routed-driver", {
    decision: { reason: "request-not-bounded", target: "driver" },
  });
};

const fallbackRequest = (
  requester: "claude" | "codex",
  evidenceTaskId: string,
  id: string
) =>
  createNativeFallbackRequest({
    acceptanceCriteria: ["return file-backed findings"],
    evidenceTaskIds: [evidenceTaskId],
    fallbackReason: "utility-ineligible",
    id,
    kind: "explore",
    objective: "Trace the bounded parser path",
    readScope: ["src/parser"],
    requester,
  });

test("native fallback mode defaults utility-first and unknown values fail strict", () => {
  expect(resolveNativeSubagentMode(undefined)).toBe("utility-first");
  expect(resolveNativeSubagentMode("utility-first")).toBe("utility-first");
  expect(resolveNativeSubagentMode("off")).toBe("off");
  expect(resolveNativeSubagentMode("strict")).toBe("strict");
  expect(resolveNativeSubagentMode("surprise")).toBe("strict");
});

test("native fallback requests require utility evidence and reject protected scope", () => {
  expect(() =>
    createNativeFallbackRequest({
      acceptanceCriteria: ["inspect"],
      fallbackReason: "utility-failed",
      kind: "review",
      objective: "Review one path",
      readScope: ["src"],
      requester: "claude",
    })
  ).toThrow("evidence_task_ids");
  expect(() =>
    createNativeFallbackRequest({
      acceptanceCriteria: ["inspect"],
      evidenceTaskIds: ["task-1"],
      fallbackReason: "utility-failed",
      kind: "review",
      objective: "Review governing instructions",
      readScope: ["AGENTS.md"],
      requester: "claude",
    })
  ).toThrow("non-protected");
  expect(() =>
    createNativeFallbackRequest({
      acceptanceCriteria: ["inspect"],
      evidenceTaskIds: ["task-1"],
      fallbackReason: "utility-failed",
      kind: "review",
      objective: "Review the repository root",
      readScope: ["."],
      requester: "claude",
    })
  ).toThrow("non-root");
  expect(() =>
    createNativeFallbackRequest({
      acceptanceCriteria: ["inspect"],
      evidenceTaskIds: ["task-1"],
      fallbackReason: "human-authorized",
      humanAuthorized: false,
      kind: "review",
      objective: "Review one path",
      readScope: ["src"],
      requester: "claude",
    })
  ).toThrow("supervisor authorization");
});

test("Governess requires substantive utility evidence, not only a settled state", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-evidence-"));
  try {
    activateUtilityEpoch(runDir, 13);
    for (const id of ["canceled-without-result", "route-without-decision"]) {
      appendUtilityRouteRequest(
        runDir,
        createUtilityRouteRequest({
          acceptanceCriteria: ["return evidence"],
          authority: {},
          id,
          kind: "inspect",
          objective: `Inspect one bounded file for ${id}`,
          readScope: ["src/example.ts"],
          requester: "codex",
          requiredCapabilities: ["inspect"],
          risk: "low",
          writeScope: [],
        })
      );
    }
    transitionUtilityJob(runDir, "canceled-without-result", "canceled", {
      reason: "request canceled before inspection",
    });
    transitionUtilityJob(runDir, "route-without-decision", "routed-driver");
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest(
        "codex",
        "canceled-without-result",
        "native-canceled-evidence"
      )
    );
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest(
        "codex",
        "route-without-decision",
        "native-route-evidence"
      )
    );

    expect(
      processPendingNativeFallbackRequests({
        epoch: 13,
        mode: "utility-first",
        runDir,
      })
    ).toBe(2);
    expect(
      readNativeFallbackRequests(runDir).map((snapshot) => snapshot.reason)
    ).toEqual([
      "utility-evidence-result-missing:canceled-without-result",
      "utility-evidence-decision-missing:route-without-decision",
    ]);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("Governess grants one lease and provider hooks consume and close it once", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-fallback-"));
  try {
    activateUtilityEpoch(runDir, 7);
    settledUtilityJob(runDir, "claude", "utility-1");
    settledUtilityJob(runDir, "codex", "utility-2");
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("claude", "utility-1", "native-1")
    );
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("codex", "utility-2", "native-2")
    );

    expect(
      processPendingNativeFallbackRequests({
        epoch: 7,
        mode: "utility-first",
        nowMs: 1_000_000,
        runDir,
      })
    ).toBe(2);
    expect(
      readNativeFallbackRequests(runDir).map((snapshot) => snapshot.state)
    ).toEqual(["granted", "denied"]);

    expect(
      consumeNativeFallbackLease({
        agentType: "Explore",
        mode: "utility-first",
        nowMs: 1_001_000,
        provider: "claude",
        runDir,
        toolName: "Agent",
      })
    ).toMatchObject({
      allowed: false,
      reason: `native-profile-required:${CLAUDE_NATIVE_FALLBACK_PROFILE}`,
    });

    const consumed = consumeNativeFallbackLease({
      agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
      mode: "utility-first",
      nowMs: 1_002_000,
      provider: "claude",
      runDir,
      toolName: "Agent",
      toolUseId: "tool-1",
    });
    expect(consumed.allowed).toBe(true);
    expect(consumed.lease?.state).toBe("consumed");
    expect(
      consumeNativeFallbackLease({
        agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
        mode: "utility-first",
        nowMs: 1_003_000,
        provider: "claude",
        runDir,
        toolName: "Agent",
      })
    ).toMatchObject({ allowed: false, reason: "native-lease-missing" });

    const started = bindNativeFallbackStart({
      agentId: "child-1",
      agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
      nowMs: 1_004_000,
      provider: "claude",
      runDir,
    });
    expect(started.lease?.state).toBe("running");
    const child = nativeFallbackForChild(
      runDir,
      "claude",
      "child-1",
      1_004_500
    );
    if (!child) {
      throw new Error("expected a bound native child");
    }
    expect(nativeFallbackScopeAllows(child, "src/parser/index.ts")).toBe(true);
    expect(nativeFallbackScopeAllows(child, "src/other.ts")).toBe(false);

    expect(
      completeNativeFallback({
        agentId: "child-1",
        nowMs: 1_005_000,
        provider: "claude",
        runDir,
      }).lease?.state
    ).toBe("completed");
    expect(
      readNativeFallbackObservability(runDir, "utility-first")
    ).toMatchObject({
      active: 0,
      blockedAttempts: 2,
      completed: 1,
      denied: 1,
      grants: 1,
      requests: 2,
      slot: "open",
    });
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("unused native fallback lease expires and stale epochs cannot grant", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-expiry-"));
  try {
    activateUtilityEpoch(runDir, 11);
    settledUtilityJob(runDir, "codex", "utility-expiry");
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("codex", "utility-expiry", "native-expiry")
    );
    expect(() =>
      processPendingNativeFallbackRequests({
        epoch: 10,
        mode: "utility-first",
        runDir,
      })
    ).toThrow("stale Governess epoch");
    processPendingNativeFallbackRequests({
      epoch: 11,
      mode: "utility-first",
      nowMs: 2_000_000,
      runDir,
    });
    expect(
      consumeNativeFallbackLease({
        agentType: CODEX_NATIVE_FALLBACK_PROFILE,
        mode: "utility-first",
        nowMs: 2_120_001,
        provider: "codex",
        runDir,
        toolName: "spawn_agent",
      })
    ).toMatchObject({ allowed: false, reason: "native-lease-missing" });
    expect(readNativeFallbackRequests(runDir)[0]?.state).toBe("expired");
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("running native fallback expires before further tools or completion", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-runtime-expiry-"));
  try {
    activateUtilityEpoch(runDir, 12);
    settledUtilityJob(runDir, "codex", "utility-runtime-expiry");
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest(
        "codex",
        "utility-runtime-expiry",
        "native-runtime-expiry"
      )
    );
    processPendingNativeFallbackRequests({
      epoch: 12,
      mode: "utility-first",
      nowMs: 3_000_000,
      runDir,
    });
    consumeNativeFallbackLease({
      agentType: CODEX_NATIVE_FALLBACK_PROFILE,
      mode: "utility-first",
      nowMs: 3_001_000,
      provider: "codex",
      runDir,
      toolName: "spawn_agent",
    });
    bindNativeFallbackStart({
      agentId: "runtime-child",
      agentType: CODEX_NATIVE_FALLBACK_PROFILE,
      nowMs: 3_002_000,
      provider: "codex",
      runDir,
    });

    expect(
      nativeFallbackForChild(runDir, "codex", "runtime-child", 3_300_999)?.state
    ).toBe("running");
    expect(
      nativeFallbackForChild(runDir, "codex", "runtime-child", 3_301_001)
    ).toBeUndefined();
    expect(
      completeNativeFallback({
        agentId: "runtime-child",
        nowMs: 3_301_002,
        provider: "codex",
        runDir,
      })
    ).toMatchObject({
      allowed: false,
      reason: "native-child-lease-missing",
    });
    expect(readNativeFallbackRequests(runDir)[0]?.state).toBe("expired");
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("loop-scoped provider definitions enforce one read-only fallback", () => {
  const utilityFirst = buildLoopCodexConfig("/repo", "utility-first");
  expect(utilityFirst).toContain("[agents]");
  expect(utilityFirst).toContain("enabled = true");
  expect(utilityFirst).toContain("max_concurrent_threads_per_session = 1");
  expect(buildLoopCodexConfig("/repo", "strict")).toContain("enabled = false");
  expect(buildLoopCodexConfig("/repo", "off")).not.toContain("[agents]");
  const codexFallback = buildLoopCodexFallbackAgent();
  expect(codexFallback).toContain('sandbox_mode = "read-only"');
  expect(codexFallback).toContain("allow_login_shell = false");
  expect(codexFallback).toContain('web_search = "disabled"');
  expect(codexFallback).toContain("multi_agent = false");
  expect(codexFallback).toContain("shell_tool = true");
  expect(codexFallback).toContain("unified_exec = false");
  expect(codexFallback).toContain("absolute system binaries");
  expect(codexFallback).toContain("[shell_environment_policy]");
  expect(codexFallback).toContain('inherit = "none"');
  expect(codexFallback).toContain('PATH = "/usr/bin:/bin"');
  expect(codexFallback).toContain("experimental_use_profile = false");
  expect(codexFallback).not.toContain("rg --no-config");
  expect(codexFallback).not.toContain("rg --files");
  expect(codexFallback).toContain("[mcp_servers.loop-bridge]");
  expect(codexFallback).toContain('url = "http://127.0.0.1:1/mcp"');
  expect(codexFallback).toContain("enabled = false");

  const claude =
    claudeNativeFallbackDefinition()[CLAUDE_NATIVE_FALLBACK_PROFILE];
  expect(claude?.tools).toEqual(["Read", "Grep"]);
  expect(claude?.maxTurns).toBe(8);
  expect(claudeNativeSubagentArgs("strict")).toEqual([
    "--disallowedTools",
    "Agent",
    "Task",
  ]);
  expect(claudeNativeSubagentArgs("off")).toEqual([]);

  const claudeCommand = tmuxInternals.buildClaudeCommand(
    "session-1",
    "opus",
    "loop-bridge-1",
    false,
    undefined,
    undefined,
    undefined,
    "utility-first"
  );
  expect(claudeCommand).toContain("--agents");
  expect(claudeCommand.join(" ")).toContain(CLAUDE_NATIVE_FALLBACK_PROFILE);
  expect(
    tmuxInternals.buildClaudeCommand(
      "session-1",
      "opus",
      "loop-bridge-1",
      false,
      undefined,
      undefined,
      undefined,
      "strict"
    )
  ).toEqual(expect.arrayContaining(["--disallowedTools", "Agent", "Task"]));

  expect(
    tmuxInternals.buildCodexCommand(
      "http://loop.invalid",
      "gpt-5.6-sol",
      [],
      undefined,
      false,
      "utility-first"
    )
  ).toEqual(
    expect.arrayContaining([
      "-c",
      "agents.max_concurrent_threads_per_session=1",
    ])
  );
  expect(
    tmuxInternals.buildCodexCommand(
      "http://loop.invalid",
      "gpt-5.6-sol",
      [],
      undefined,
      false,
      "strict"
    )
  ).toEqual(expect.arrayContaining(["-c", "agents.enabled=false"]));
});

test("ensureLoopCodexHome writes only loop-scoped native policy", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-codex-home-"));
  try {
    const codexHome = ensureLoopCodexHome(runDir, "/repo", {
      LOOP_NATIVE_SUBAGENT_MODE: "utility-first",
    });
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain(
      "max_concurrent_threads_per_session = 1"
    );
    expect(
      readFileSync(
        join(codexHome, "agents", `${CODEX_NATIVE_FALLBACK_PROFILE}.toml`),
        "utf8"
      )
    ).toContain('sandbox_mode = "read-only"');
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});
