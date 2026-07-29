import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLoopCodexConfig,
  ensureLoopCodexHome,
} from "../../src/loop/codex-home";
import {
  appendNativeFallbackRequest,
  bindNativeFallbackStart,
  CLAUDE_NATIVE_FALLBACK_PROFILE,
  CODEX_NATIVE_FALLBACK_PROFILE,
  CODEX_NATIVE_FALLBACK_UNAVAILABLE_REASON,
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
  buildPairedPaneEnv,
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
    objective: `Inspect a bounded source file for ${id}`,
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
          requester: "claude",
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
        "claude",
        "canceled-without-result",
        "native-canceled-evidence"
      )
    );
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest(
        "claude",
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
    settledUtilityJob(runDir, "claude", "utility-2");
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("claude", "utility-1", "native-1")
    );
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("claude", "utility-2", "native-2")
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
    settledUtilityJob(runDir, "claude", "utility-expiry");
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("claude", "utility-expiry", "native-expiry")
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
        agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
        mode: "utility-first",
        nowMs: 2_120_001,
        provider: "claude",
        runDir,
        toolName: "Agent",
      })
    ).toMatchObject({ allowed: false, reason: "native-lease-missing" });
    expect(readNativeFallbackRequests(runDir)[0]?.state).toBe("expired");
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("Codex native fallback is denied because its child inherits the parent sandbox", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-codex-disabled-"));
  try {
    activateUtilityEpoch(runDir, 21);
    settledUtilityJob(runDir, "codex", "utility-codex-disabled");
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest(
        "codex",
        "utility-codex-disabled",
        "native-codex-disabled"
      )
    );
    processPendingNativeFallbackRequests({
      epoch: 21,
      mode: "utility-first",
      runDir,
    });
    expect(readNativeFallbackRequests(runDir)[0]).toMatchObject({
      reason: CODEX_NATIVE_FALLBACK_UNAVAILABLE_REASON,
      state: "denied",
    });
    expect(
      consumeNativeFallbackLease({
        agentType: CODEX_NATIVE_FALLBACK_PROFILE,
        mode: "utility-first",
        provider: "codex",
        runDir,
        toolName: "spawn_agent",
      })
    ).toMatchObject({
      allowed: false,
      reason: CODEX_NATIVE_FALLBACK_UNAVAILABLE_REASON,
    });
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("running native fallback expires before further tools or completion", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-runtime-expiry-"));
  try {
    activateUtilityEpoch(runDir, 12);
    settledUtilityJob(runDir, "claude", "utility-runtime-expiry");
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest(
        "claude",
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
      agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
      mode: "utility-first",
      nowMs: 3_001_000,
      provider: "claude",
      runDir,
      toolName: "Agent",
    });
    bindNativeFallbackStart({
      agentId: "runtime-child",
      agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
      nowMs: 3_002_000,
      provider: "claude",
      runDir,
    });

    expect(
      nativeFallbackForChild(runDir, "claude", "runtime-child", 3_300_999)
        ?.state
    ).toBe("running");
    expect(
      nativeFallbackForChild(runDir, "claude", "runtime-child", 3_301_001)
    ).toBeUndefined();
    expect(
      completeNativeFallback({
        agentId: "runtime-child",
        nowMs: 3_301_002,
        provider: "claude",
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

test("a new Governess epoch immediately fences a running native child", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-epoch-fence-"));
  try {
    activateUtilityEpoch(runDir, 31);
    settledUtilityJob(runDir, "claude", "utility-epoch-fence");
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("claude", "utility-epoch-fence", "native-epoch-fence")
    );
    processPendingNativeFallbackRequests({
      epoch: 31,
      mode: "utility-first",
      nowMs: 4_000_000,
      runDir,
    });
    consumeNativeFallbackLease({
      agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
      mode: "utility-first",
      nowMs: 4_001_000,
      provider: "claude",
      runDir,
      toolName: "Agent",
    });
    bindNativeFallbackStart({
      agentId: "epoch-child",
      agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
      nowMs: 4_002_000,
      provider: "claude",
      runDir,
    });

    activateUtilityEpoch(runDir, 32);
    expect(
      nativeFallbackForChild(runDir, "claude", "epoch-child", 4_003_000)
    ).toBeUndefined();
    expect(readNativeFallbackRequests(runDir)[0]).toMatchObject({
      reason: "native-fallback-stale-epoch",
      state: "expired",
    });
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("loop-scoped provider definitions enforce one read-only fallback", () => {
  const utilityFirst = buildLoopCodexConfig("/repo", "utility-first");
  expect(utilityFirst).toContain("[agents]");
  expect(utilityFirst).toContain("enabled = false");
  expect(utilityFirst).not.toContain("max_concurrent_threads_per_session");
  expect(buildLoopCodexConfig("/repo", "strict")).toContain("enabled = false");
  expect(buildLoopCodexConfig("/repo", "off")).not.toContain("[agents]");

  const claude =
    claudeNativeFallbackDefinition()[CLAUDE_NATIVE_FALLBACK_PROFILE];
  expect(claude?.tools).toEqual(["Read", "Grep"]);
  expect(claude?.maxTurns).toBe(8);
  // TeamCreate exists in Claude Code 2.1.220 and creates a fleet WITHOUT going
  // through Agent, so gating Agent/Task alone left a bypass.
  expect(claudeNativeSubagentArgs("strict")).toEqual([
    "--disallowedTools",
    "Agent",
    "Task",
    "TeamCreate",
  ]);
  expect(claude?.disallowedTools).toContain("TeamCreate");
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
  ).toEqual(expect.arrayContaining(["-c", "agents.enabled=false"]));
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

test("ensureLoopCodexHome disables Codex native spawning without a fallback profile", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-codex-home-"));
  try {
    const codexHome = ensureLoopCodexHome(runDir, "/repo", {
      LOOP_NATIVE_SUBAGENT_MODE: "utility-first",
    });
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain(
      "enabled = false"
    );
    expect(
      existsSync(
        join(codexHome, "agents", `${CODEX_NATIVE_FALLBACK_PROFILE}.toml`)
      )
    ).toBe(false);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

// The slot is a CONCURRENCY slot, not one grant per run. Requirement 5 lists the
// occupying states exactly — granted, consumed, running — so a completed or expired
// fallback frees it. Nothing locked that before: a refactor could have made the slot
// permanent (starving long runs) or made it never free (unbounded fleets) and every
// existing test would still pass. This pins both directions.
test("native fallback slot is one-at-a-time: completion and expiry free it, active occupancy denies", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-native-slot-"));
  try {
    activateUtilityEpoch(runDir, 11);
    for (const id of ["utility-a", "utility-b", "utility-c", "utility-d"]) {
      settledUtilityJob(runDir, "claude", id);
    }

    // 1. First request is granted and taken all the way to completed.
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("claude", "utility-a", "slot-1")
    );
    processPendingNativeFallbackRequests({
      epoch: 11,
      mode: "utility-first",
      nowMs: 2_000_000,
      runDir,
    });
    consumeNativeFallbackLease({
      agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
      mode: "utility-first",
      nowMs: 2_001_000,
      provider: "claude",
      runDir,
      toolName: "Agent",
      toolUseId: "slot-tool-1",
    });
    bindNativeFallbackStart({
      agentId: "slot-child-1",
      agentType: CLAUDE_NATIVE_FALLBACK_PROFILE,
      nowMs: 2_002_000,
      provider: "claude",
      runDir,
    });
    expect(
      completeNativeFallback({
        agentId: "slot-child-1",
        nowMs: 2_003_000,
        provider: "claude",
        runDir,
      }).lease?.state
    ).toBe("completed");
    expect(readNativeFallbackObservability(runDir, "utility-first").slot).toBe(
      "open"
    );

    // 2. COMPLETION FREES THE SLOT: a later request is granted, not denied.
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("claude", "utility-b", "slot-2")
    );
    processPendingNativeFallbackRequests({
      epoch: 11,
      mode: "utility-first",
      nowMs: 2_010_000,
      runDir,
    });
    const afterCompletion = readNativeFallbackRequests(runDir).find(
      (snapshot) => snapshot.request.id === "slot-2"
    );
    expect(afterCompletion?.state).toBe("granted");

    // 3. AN ACTIVE GRANT OCCUPIES THE SLOT: the next request is denied, naming it.
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("claude", "utility-c", "slot-3")
    );
    processPendingNativeFallbackRequests({
      epoch: 11,
      mode: "utility-first",
      nowMs: 2_011_000,
      runDir,
    });
    const blocked = readNativeFallbackRequests(runDir).find(
      (snapshot) => snapshot.request.id === "slot-3"
    );
    expect(blocked?.state).toBe("denied");
    expect(blocked?.reason).toBe("native-slot-busy:slot-2");

    // 4. EXPIRY FREES THE SLOT: past the 120s grant window, a new request is granted.
    appendNativeFallbackRequest(
      runDir,
      fallbackRequest("claude", "utility-d", "slot-4")
    );
    processPendingNativeFallbackRequests({
      epoch: 11,
      mode: "utility-first",
      nowMs: 2_010_000 + 121_000,
      runDir,
    });
    const afterExpiry = readNativeFallbackRequests(runDir).find(
      (snapshot) => snapshot.request.id === "slot-4"
    );
    expect(afterExpiry?.state).toBe("granted");
    expect(
      readNativeFallbackObservability(runDir, "utility-first").expired
    ).toBeGreaterThanOrEqual(1);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

// The composed pane command must actually EXECUTE. `env` stops option parsing at
// the first NAME=VALUE operand, so a `-u` placed after an assignment is taken as
// the utility to run: exit 127, pane never starts, in the DEFAULT mode. A string
// assertion would have passed against that broken build, so this runs the real
// argv and inspects the child's environment.
test("governed pane env unsets fleet surfaces and the composed command still runs", () => {
  const govEnv = buildPairedPaneEnv({
    governess: true,
    inheritedEnv: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: "1",
    } as NodeJS.ProcessEnv,
    nativeSubagentMode: "utility-first",
    runBase: "/tmp/base",
    runId: "run-1",
  });

  // Ordering invariant: every -u precedes every NAME=VALUE operand.
  const firstAssignment = govEnv.findIndex((entry) => entry.includes("="));
  const lastUnsetFlag = govEnv.lastIndexOf("-u");
  expect(lastUnsetFlag).toBeGreaterThanOrEqual(0);
  expect(lastUnsetFlag).toBeLessThan(firstAssignment);

  // Behavioral: the real argv executes, and neither surface reaches the child.
  // The inner `env` prints the child's whole environment, so this inspects what
  // actually arrives rather than trusting a shell expansion.
  const probe = spawnSync("env", [...govEnv, "env"], {
    encoding: "utf8",
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: "1",
      PATH: process.env.PATH ?? "",
    },
  });
  expect(probe.status).toBe(0);
  expect(probe.stderr).toBe("");
  expect(probe.stdout).not.toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
  expect(probe.stdout).not.toContain(
    "CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS"
  );
  // Proves the probe is meaningful: an untouched var DOES arrive.
  expect(probe.stdout).toContain("LOOP_RUN_ID=run-1");

  // `off` claims no enforcement, so it must not strip anything.
  const offEnv = buildPairedPaneEnv({
    governess: false,
    inheritedEnv: {} as NodeJS.ProcessEnv,
    nativeSubagentMode: "off",
    runBase: "/tmp/base",
    runId: "run-1",
  });
  expect(offEnv).not.toContain("-u");
});
