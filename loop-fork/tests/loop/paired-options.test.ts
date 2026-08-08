import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeChannelServerName } from "../../src/loop/bridge-config";
import { CODEX_NATIVE_FALLBACK_PROFILE } from "../../src/loop/native-subagent";
import {
  preparePairedOptions,
  preparePairedRun,
} from "../../src/loop/paired-options";
import {
  createRunManifest,
  readRunManifest,
  resolveRunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";
import { createTmuxSkipSink, targetArgv } from "../../src/loop/tmux-socket";
import type { Options } from "../../src/loop/types";

const makeTempHome = (): string => mkdtempSync(join(tmpdir(), "loop-paired-"));
const ORIGINAL_CAVEMAN_MODE = process.env.LOOP_CAVEMAN_MODE;
const ORIGINAL_HELPER_CAVEMAN_MODE = process.env.LOOP_HELPER_CAVEMAN_MODE;

afterEach(() => {
  for (const [name, value] of [
    ["LOOP_CAVEMAN_MODE", ORIGINAL_CAVEMAN_MODE],
    ["LOOP_HELPER_CAVEMAN_MODE", ORIGINAL_HELPER_CAVEMAN_MODE],
  ] as const) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
});

const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  codexModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  proof: "verify with tests",
  ...overrides,
});

test("preparePairedRun persists resolved asymmetric launch effort", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = "effort-proof";
  try {
    const opts = makeOptions({
      driverEffort: "medium",
      driverEffortSource: "cli-role",
      pairedMode: true,
      pairWith: "claude",
      reviewerEffort: "high",
      reviewerEffortSource: "cli-role",
    });
    const prepared = preparePairedRun(opts, process.cwd());

    expect(prepared.manifest).toMatchObject({
      driverEffort: "medium",
      reviewerEffort: "high",
    });
    expect(readRunManifest(prepared.storage.manifestPath)).toMatchObject({
      driverEffort: "medium",
      reviewerEffort: "high",
    });
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { force: true, recursive: true });
  }
});

test("live tmux reattach rejects an effort change it cannot apply", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const storage = resolveRunStorage("effort-live", process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        cwd: process.cwd(),
        driverEffort: "medium",
        mode: "paired",
        pid: 1234,
        repoId: storage.repoId,
        reviewerEffort: "high",
        runId: storage.runId,
        state: "working",
        tmuxPaneLeftAgent: "claude",
        tmuxPaneRightAgent: "codex",
        tmuxSession: "repo-loop-effort-live",
        tmuxSocket: "/tmp/paired-effort-live.sock",
      })
    );
    const opts = makeOptions({
      driverEffort: "high",
      driverEffortSource: "cli-role",
      pairedMode: true,
      resumeRunId: storage.runId,
      reviewerEffort: "high",
      reviewerEffortSource: "default",
      tmux: true,
    });

    expect(() => preparePairedRun(opts, process.cwd(), () => "live")).toThrow(
      "Cannot change --effort-driver from medium to high"
    );
    expect(readRunManifest(storage.manifestPath)).toMatchObject({
      driverEffort: "medium",
      reviewerEffort: "high",
    });
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(home, { force: true, recursive: true });
  }
});

test("prepared runs reject a superseded bootstrap attempt", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
  try {
    const storage = resolveRunStorage("alpha", process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        cwd: process.cwd(),
        launchAttemptId: "new-attempt",
        launchAttemptPid: 4321,
        launchClaimId: "immutable-claim",
        mode: "paired",
        pid: 4321,
        repoId: storage.repoId,
        runId: "alpha",
        state: "submitted",
      })
    );
    const opts = makeOptions({
      launchAttemptId: "old-attempt",
      launchClaimId: "immutable-claim",
      pairedMode: true,
      resumeRunId: "alpha",
    });

    expect(() => preparePairedOptions(opts, process.cwd(), false)).toThrow(
      "launch attempt old-attempt no longer owns run alpha"
    );
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("preparePairedOptions accepts a raw session id without creating a paired manifest", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    const opts = makeOptions({
      agent: "claude",
      pairedMode: true,
      sessionId: "claude-session-raw",
    });

    expect(() =>
      preparePairedOptions(opts, process.cwd(), false)
    ).not.toThrow();

    const storage = resolveRunStorage("1", process.cwd(), home);
    expect(process.env.LOOP_RUN_ID).toBe("1");
    expect(readRunManifest(storage.manifestPath)).toBeUndefined();
    expect(opts.claudePersistentSession).toBe(true);
    expect(opts.pairedSessionIds).toEqual({
      claude: "claude-session-raw",
    });
    expect(opts.cavemanMode).toBe("lite");
    expect(opts.cavemanModeSource).toBe("default");
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("paired resumes restore Caveman modes unless CLI explicitly overrides", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  const storage = resolveRunStorage("71", process.cwd(), home);
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cavemanMode: "full",
      cwd: process.cwd(),
      helperCavemanMode: "ultra",
      mode: "paired",
      pid: 1234,
      repoId: storage.repoId,
      runId: "71",
      state: "working",
    })
  );

  try {
    const resumed = makeOptions({
      cavemanMode: "lite",
      cavemanModeSource: "default",
      helperCavemanMode: "full",
      helperCavemanModeSource: "default",
      pairedMode: true,
      resumeRunId: "71",
    });
    preparePairedRun(resumed, process.cwd());
    expect(resumed).toMatchObject({
      cavemanMode: "full",
      cavemanModeSource: "manifest",
      helperCavemanMode: "ultra",
      helperCavemanModeSource: "manifest",
    });

    const overridden = makeOptions({
      cavemanMode: "off",
      cavemanModeSource: "cli",
      helperCavemanMode: "off",
      helperCavemanModeSource: "cli",
      pairedMode: true,
      resumeRunId: "71",
    });
    preparePairedRun(overridden, process.cwd());
    expect(readRunManifest(storage.manifestPath)).toMatchObject({
      cavemanMode: "off",
      helperCavemanMode: "off",
    });
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy resumes apply only Caveman modes their agents can receive", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  const storage = resolveRunStorage("72", process.cwd(), home);
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      claudeSessionId: "legacy-claude-session",
      cwd: process.cwd(),
      mode: "paired",
      pid: 1234,
      repoId: storage.repoId,
      runId: "72",
      state: "working",
    })
  );

  try {
    const overrideStorage = resolveRunStorage("72-cli", process.cwd(), home);
    writeRunManifest(
      overrideStorage.manifestPath,
      createRunManifest({
        claudeSessionId: "legacy-override-session",
        cwd: process.cwd(),
        mode: "paired",
        pid: 1234,
        repoId: overrideStorage.repoId,
        runId: "72-cli",
        state: "working",
      })
    );
    const explicitOverride = makeOptions({
      cavemanMode: "full",
      cavemanModeSource: "cli",
      pairedMode: true,
      resumeRunId: "72-cli",
    });
    preparePairedRun(explicitOverride, process.cwd());
    expect(explicitOverride.cavemanMode).toBe("full");

    const resumed = makeOptions({
      cavemanMode: "lite",
      cavemanModeSource: "default",
      helperCavemanMode: "full",
      helperCavemanModeSource: "default",
      pairedMode: true,
      resumeRunId: "72",
    });
    preparePairedRun(resumed, process.cwd());
    expect(resumed).toMatchObject({
      cavemanMode: "lite",
      cavemanModeSource: "default",
      helperCavemanMode: "full",
    });
    expect(readRunManifest(storage.manifestPath)).toMatchObject({
      cavemanMode: "lite",
      helperCavemanMode: "full",
    });

    const freshStorage = resolveRunStorage("73", process.cwd(), home);
    writeRunManifest(
      freshStorage.manifestPath,
      createRunManifest({
        cwd: process.cwd(),
        mode: "paired",
        pid: 1234,
        repoId: freshStorage.repoId,
        runId: "73",
        state: "submitted",
      })
    );
    const bothNew = makeOptions({
      cavemanMode: "lite",
      cavemanModeSource: "default",
      helperCavemanMode: "full",
      helperCavemanModeSource: "default",
      pairedMode: true,
      resumeRunId: "73",
    });
    preparePairedRun(bothNew, process.cwd());
    expect(bothNew).toMatchObject({
      cavemanMode: "lite",
      cavemanModeSource: "default",
      helperCavemanMode: "full",
    });

    const alternatePairCwd = join(home, "alternate-pair-project");
    mkdirSync(alternatePairCwd, { recursive: true });
    const changedPairStorage = resolveRunStorage("74", alternatePairCwd, home);
    writeRunManifest(
      changedPairStorage.manifestPath,
      createRunManifest({
        claudeSessionId: "out-of-pair-legacy-claude",
        cwd: alternatePairCwd,
        mode: "paired",
        pid: 1234,
        repoId: changedPairStorage.repoId,
        runId: "74",
        state: "working",
      })
    );
    const changedPair = makeOptions({
      cavemanMode: "lite",
      cavemanModeSource: "default",
      helperCavemanMode: "full",
      helperCavemanModeSource: "default",
      pairWith: "copilot",
      pairedMode: true,
      resumeRunId: "74",
    });
    preparePairedRun(changedPair, alternatePairCwd);
    expect(changedPair.cavemanMode).toBe("lite");
    expect(readRunManifest(changedPairStorage.manifestPath)).toMatchObject({
      cavemanMode: "lite",
      claudeSessionId: "",
    });

    const liveTmuxStorage = resolveRunStorage("75", alternatePairCwd, home);
    writeRunManifest(
      liveTmuxStorage.manifestPath,
      createRunManifest({
        claudeSessionId: "live-legacy-claude",
        codexThreadId: "live-legacy-codex",
        cwd: alternatePairCwd,
        mode: "paired",
        pid: 1234,
        primaryAgent: "claude",
        repoId: liveTmuxStorage.repoId,
        runId: "75",
        state: "working",
        tmuxPaneLeftAgent: "claude",
        tmuxPaneRightAgent: "codex",
        tmuxSession: "repo-loop-75",
        tmuxSocket: "/tmp/paired-75.sock",
      })
    );
    const reusedTmux = makeOptions({
      agent: "codex",
      cavemanMode: "lite",
      cavemanModeSource: "default",
      helperCavemanMode: "full",
      helperCavemanModeSource: "default",
      pairWith: "copilot",
      pairedMode: true,
      resumeRunId: "75",
      tmux: true,
    });
    preparePairedRun(reusedTmux, alternatePairCwd, () => "live");
    expect(reusedTmux).toMatchObject({
      agent: "claude",
      cavemanMode: "off",
      helperCavemanMode: "off",
      pairWith: "codex",
    });
    expect(readRunManifest(liveTmuxStorage.manifestPath)).toMatchObject({
      cavemanMode: "off",
      claudeSessionId: "live-legacy-claude",
      codexThreadId: "live-legacy-codex",
      helperCavemanMode: "off",
    });
    const liveModeChange = makeOptions({
      cavemanMode: "full",
      cavemanModeSource: "cli",
      pairedMode: true,
      resumeRunId: "75",
      tmux: true,
    });
    expect(() =>
      preparePairedRun(liveModeChange, alternatePairCwd, () => "live")
    ).toThrow(
      "Cannot change --caveman from off to full while reusing live tmux agents"
    );
    const liveHelperModeChange = makeOptions({
      cavemanMode: "off",
      cavemanModeSource: "cli",
      helperCavemanMode: "full",
      helperCavemanModeSource: "cli",
      pairedMode: true,
      resumeRunId: "75",
      tmux: true,
    });
    expect(() =>
      preparePairedRun(liveHelperModeChange, alternatePairCwd, () => "live")
    ).toThrow(
      "Cannot change --helper-caveman from off to full while reusing a live Governess"
    );

    const staleTmuxStorage = resolveRunStorage("76", alternatePairCwd, home);
    writeRunManifest(
      staleTmuxStorage.manifestPath,
      createRunManifest({
        claudeSessionId: "stale-legacy-claude",
        codexThreadId: "stale-legacy-codex",
        cwd: alternatePairCwd,
        mode: "paired",
        pid: 1234,
        primaryAgent: "claude",
        repoId: staleTmuxStorage.repoId,
        runId: "76",
        state: "working",
        tmuxPaneLeftAgent: "claude",
        tmuxPaneRightAgent: "codex",
        tmuxSession: "repo-loop-76",
        tmuxSocket: "/tmp/paired-76.sock",
      })
    );
    const staleTmux = makeOptions({
      agent: "codex",
      cavemanMode: "lite",
      cavemanModeSource: "default",
      helperCavemanMode: "full",
      helperCavemanModeSource: "default",
      pairWith: "copilot",
      pairedMode: true,
      resumeRunId: "76",
      tmux: true,
    });
    preparePairedRun(staleTmux, alternatePairCwd, () => "dead");
    expect(staleTmux).toMatchObject({
      agent: "codex",
      cavemanMode: "off",
      pairWith: "copilot",
    });
    expect(readRunManifest(staleTmuxStorage.manifestPath)).toMatchObject({
      cavemanMode: "off",
      claudeSessionId: "",
      codexThreadId: "stale-legacy-codex",
    });

    const unknownTmuxStorage = resolveRunStorage("77", alternatePairCwd, home);
    writeRunManifest(
      unknownTmuxStorage.manifestPath,
      createRunManifest({
        claudeSessionId: "unknown-claude",
        codexThreadId: "unknown-codex",
        cwd: alternatePairCwd,
        mode: "paired",
        pid: 1234,
        primaryAgent: "claude",
        repoId: unknownTmuxStorage.repoId,
        runId: "77",
        state: "working",
        tmuxPaneLeftAgent: "claude",
        tmuxPaneRightAgent: "codex",
        tmuxSession: "repo-loop-77",
        tmuxSocket: "/tmp/paired-77.sock",
      })
    );
    const unknownTmux = makeOptions({
      pairedMode: true,
      resumeRunId: "77",
      tmux: true,
    });
    expect(() =>
      preparePairedRun(unknownTmux, alternatePairCwd, () => "unknown")
    ).toThrow(
      'tmux session "repo-loop-77" liveness is unknown; refusing to clear or duplicate it'
    );
    expect(readRunManifest(unknownTmuxStorage.manifestPath)).toMatchObject({
      claudeSessionId: "unknown-claude",
      codexThreadId: "unknown-codex",
      tmuxSession: "repo-loop-77",
    });
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("persistedTmuxIsLive records unavailable targets and refuses state mutation", () => {
  const fixtures = [
    {
      fields: { tmuxSession: "repo-loop-unavailable" },
      socketState: "missing",
    },
    {
      fields: {
        tmuxSession: "repo-loop-unavailable",
        tmuxSocket: "relative/tmux.sock",
      },
      socketState: "invalid",
    },
    {
      fields: {
        tmuxSession: "repo-loop-unavailable",
        tmuxSocket: "/tmp/paired-a.sock",
        tmux_socket: "/tmp/paired-b.sock",
      },
      socketState: "conflicting",
    },
  ] as const;
  for (const [index, fixture] of fixtures.entries()) {
    const home = makeTempHome();
    const cwd = join(home, "repo");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    mkdirSync(cwd, { recursive: true });
    try {
      const storage = resolveRunStorage(`unavailable-${index}`, cwd, home);
      mkdirSync(storage.runDir, { recursive: true });
      writeFileSync(
        storage.manifestPath,
        JSON.stringify({
          createdAt: "2026-03-27T10:00:00.000Z",
          cwd,
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId: storage.runId,
          state: "working",
          updatedAt: "2026-03-27T10:00:00.000Z",
          ...fixture.fields,
        })
      );
      const before = readFileSync(storage.manifestPath, "utf8");
      const opts = makeOptions({
        pairedMode: true,
        resumeRunId: storage.runId,
        tmux: true,
      });
      const beforeOpts = { ...opts };
      const skipSink = createTmuxSkipSink();
      let tmuxContacts = 0;
      expect(() =>
        preparePairedRun(
          opts,
          cwd,
          () => {
            tmuxContacts += 1;
            return "dead";
          },
          skipSink
        )
      ).toThrow(
        'tmux session "repo-loop-unavailable" liveness is unknown; refusing to clear or duplicate it'
      );
      expect(tmuxContacts).toBe(0);
      expect(opts).toEqual(beforeOpts);
      expect(readFileSync(storage.manifestPath, "utf8")).toBe(before);
      expect(skipSink.records).toEqual([
        {
          consumer: "paired-options.persistedTmuxIsLive",
          effectSkipped: "clear-or-duplicate-persisted-tmux-state",
          pane: null,
          reason:
            "persisted manifest target is unavailable; refusing to clear or duplicate tmux state",
          runId: storage.runId,
          session: "repo-loop-unavailable",
          socketState: fixture.socketState,
        },
      ]);
    } finally {
      if (originalHome === undefined) {
        Reflect.deleteProperty(process.env, "HOME");
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("persistedTmuxIsLive preserves the no-session guard without a skip record", () => {
  const home = makeTempHome();
  const cwd = join(home, "repo");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(cwd, { recursive: true });
  try {
    const storage = resolveRunStorage("no-session", cwd, home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        cwd,
        mode: "paired",
        pid: 1234,
        primaryAgent: "oss",
        repoId: storage.repoId,
        runId: storage.runId,
        state: "working",
        tmuxPaneLeftAgent: "claude",
        tmuxPaneRightAgent: "oss",
        tmuxSocket: "/tmp/paired-no-session.sock",
      })
    );
    const beforeSocket = readRunManifest(storage.manifestPath)?.tmuxSocket;
    const skipSink = createTmuxSkipSink();
    let tmuxContacts = 0;
    const opts = makeOptions({
      agent: "codex",
      pairedMode: true,
      pairWith: "claude",
      resumeRunId: storage.runId,
      tmux: true,
    });
    preparePairedRun(
      opts,
      cwd,
      () => {
        tmuxContacts += 1;
        return "dead";
      },
      skipSink
    );
    expect(tmuxContacts).toBe(0);
    expect(skipSink.records).toEqual([]);
    expect(opts).toMatchObject({ agent: "codex", pairWith: "claude" });
    expect(readRunManifest(storage.manifestPath)?.tmuxSocket).toBe(
      beforeSocket
    );
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  "live",
  "dead",
] as const)("persistedTmuxIsLive uses a target-bound %s control without a skip record", (liveness) => {
  const home = makeTempHome();
  const cwd = join(home, "repo");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(cwd, { recursive: true });
  try {
    const storage = resolveRunStorage(`target-${liveness}`, cwd, home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        cwd,
        mode: "paired",
        pid: 1234,
        repoId: storage.repoId,
        runId: storage.runId,
        state: "working",
        tmuxSession: "repo-loop-target",
        tmuxSocket: "/tmp/paired-target.sock",
      })
    );
    const skipSink = createTmuxSkipSink();
    let tmuxContacts = 0;
    preparePairedRun(
      makeOptions({
        pairedMode: true,
        resumeRunId: storage.runId,
        tmux: true,
      }),
      cwd,
      (target) => {
        tmuxContacts += 1;
        expect(targetArgv(target, "has-session")).toEqual([
          "tmux",
          "-S",
          "/tmp/paired-target.sock",
          "has-session",
          "-t",
          "repo-loop-target",
        ]);
        return liveness;
      },
      skipSink
    );
    expect(tmuxContacts).toBe(1);
    expect(skipSink.records).toEqual([]);
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("preparePairedOptions writes a readable Claude bridge server for fresh runs", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    const opts = makeOptions({ agent: "claude", pairedMode: true });

    preparePairedOptions(opts, process.cwd(), true);

    const storage = resolveRunStorage("1", process.cwd(), home);
    const manifest = readRunManifest(storage.manifestPath);
    const serverName = claudeChannelServerName(storage.runId, storage.repoId);
    expect(manifest?.claudeChannelServer).toBe(serverName);
    expect(manifest?.claudeChannelServer).not.toContain(storage.repoId);
    const configPath = opts.claudeMcpConfigPath;
    expect(configPath).toBeDefined();
    const config = JSON.parse(readFileSync(configPath ?? "", "utf8"));
    expect(Object.keys(config.mcpServers)).toEqual([serverName]);
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("preparePairedOptions keeps non-tmux native policy off without global MCP config", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    const opts = makeOptions({
      governess: true,
      pairedMode: true,
      tmux: false,
    });

    preparePairedOptions(opts, process.cwd(), true);

    const storage = resolveRunStorage("1", process.cwd(), home);
    expect(opts.codexHome).toBe(join(storage.runDir, "codex-home"));
    const config = readFileSync(
      join(opts.codexHome ?? "", "config.toml"),
      "utf8"
    );
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('sandbox_mode = "danger-full-access"');
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config).toContain('model_reasoning_effort = "medium"');
    expect(config).toContain('service_tier = "standard"');
    expect(config).toContain(`[projects.${JSON.stringify(process.cwd())}]`);
    expect(config).not.toContain("[agents]");
    expect(config).not.toContain("[mcp_servers.");
    expect(config).not.toContain("[plugins.");
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("preparePairedRun upgrades an older hashed Claude bridge server name", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    const storage = resolveRunStorage("alpha", process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest(
        {
          claudeChannelServer: `loop-bridge-${storage.repoId}-alpha`,
          claudeSessionId: "claude-session-1",
          codexThreadId: "codex-thread-1",
          cwd: process.cwd(),
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId: "alpha",
          status: "running",
        },
        "2026-03-29T10:00:00.000Z"
      )
    );
    const opts = makeOptions({ resumeRunId: "alpha" });

    const prepared = preparePairedRun(opts, process.cwd());
    const serverName = claudeChannelServerName(storage.runId, storage.repoId);

    expect(prepared.manifest.claudeChannelServer).toBe(serverName);
    expect(readRunManifest(storage.manifestPath)?.claudeChannelServer).toBe(
      serverName
    );
    expect(serverName).not.toContain(storage.repoId);
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("preparePairedOptions ignores stored session ids from a completed paired run", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    const storage = resolveRunStorage("alpha", process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest(
        {
          claudeSessionId: "claude-session-1",
          codexThreadId: "codex-thread-1",
          cwd: process.cwd(),
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId: "alpha",
          status: "done",
        },
        "2026-03-22T10:00:00.000Z"
      )
    );
    const opts = makeOptions({ sessionId: "codex-thread-1" });

    preparePairedOptions(opts, process.cwd(), false);

    expect(process.env.LOOP_RUN_ID).toBe("alpha");
    expect(opts.pairedSessionIds).toBeUndefined();
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("preparePairedRun clears stale tmux state and Codex governance outside tmux mode", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    const storage = resolveRunStorage("alpha", process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest(
        {
          claudeSessionId: "claude-session-1",
          codexRemoteUrl: "ws://127.0.0.1:4500",
          codexThreadId: "codex-thread-1",
          cwd: process.cwd(),
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId: "alpha",
          status: "running",
          tmuxSession: "repo-loop-alpha",
          tmuxSocket: "/tmp/paired-alpha.sock",
        },
        "2026-03-22T10:00:00.000Z"
      )
    );
    const codexHome = join(storage.runDir, "codex-home");
    const fallbackProfile = join(
      codexHome,
      "agents",
      `${CODEX_NATIVE_FALLBACK_PROFILE}.toml`
    );
    mkdirSync(join(codexHome, "agents"), { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), '{"hooks":{}}\n', "utf8");
    writeFileSync(
      fallbackProfile,
      `name = "${CODEX_NATIVE_FALLBACK_PROFILE}"\n`,
      "utf8"
    );
    const opts = makeOptions({ resumeRunId: "alpha", tmux: false });

    const prepared = preparePairedRun(opts, process.cwd());

    expect(prepared.manifest.tmuxSession).toBeUndefined();
    expect(prepared.manifest.codexRemoteUrl).toBe("ws://127.0.0.1:4500");
    expect(readRunManifest(storage.manifestPath)?.tmuxSession).toBeUndefined();
    expect(readRunManifest(storage.manifestPath)?.codexRemoteUrl).toBe(
      "ws://127.0.0.1:4500"
    );
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
    expect(existsSync(fallbackProfile)).toBe(false);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain(
      "[agents]"
    );
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("preparePairedRun preserves governed Codex gates and removes stale child profiles on live tmux reattach", () => {
  const home = makeTempHome();
  const originalHome = process.env.HOME;
  const originalRunId = process.env.LOOP_RUN_ID;
  const originalNativeMode = process.env.LOOP_NATIVE_SUBAGENT_MODE;
  process.env.HOME = home;
  process.env.LOOP_NATIVE_SUBAGENT_MODE = "utility-first";
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");

  try {
    const storage = resolveRunStorage("alpha", process.cwd(), home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest(
        {
          claudeSessionId: "claude-session-1",
          codexThreadId: "codex-thread-1",
          cwd: process.cwd(),
          mode: "paired",
          pid: 1234,
          repoId: storage.repoId,
          runId: "alpha",
          status: "running",
          tmuxSession: "repo-loop-alpha",
          tmuxSocket: "/tmp/paired-alpha.sock",
        },
        "2026-03-22T10:00:00.000Z"
      )
    );
    const codexHome = join(storage.runDir, "codex-home");
    const hooksPath = join(codexHome, "hooks.json");
    const fallbackProfile = join(
      codexHome,
      "agents",
      `${CODEX_NATIVE_FALLBACK_PROFILE}.toml`
    );
    mkdirSync(join(codexHome, "agents"), { recursive: true });
    writeFileSync(hooksPath, '{"hooks":{"PreToolUse":[]}}\n', "utf8");
    writeFileSync(
      fallbackProfile,
      `name = "${CODEX_NATIVE_FALLBACK_PROFILE}"\nsandbox_mode = "read-only"\n`,
      "utf8"
    );

    const prepared = preparePairedRun(
      makeOptions({ governess: true, resumeRunId: "alpha", tmux: true }),
      process.cwd(),
      () => "live"
    );

    expect(prepared.manifest.tmuxSession).toBe("repo-loop-alpha");
    expect(readFileSync(hooksPath, "utf8")).toContain("PreToolUse");
    expect(existsSync(fallbackProfile)).toBe(false);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain(
      "enabled = false"
    );

    process.env.LOOP_NATIVE_SUBAGENT_MODE = "strict";
    writeFileSync(hooksPath, '{"hooks":{"PreToolUse":["strict"]}}\n', "utf8");
    writeFileSync(
      fallbackProfile,
      `name = "${CODEX_NATIVE_FALLBACK_PROFILE}"\n`,
      "utf8"
    );
    preparePairedRun(
      makeOptions({ governess: true, resumeRunId: "alpha", tmux: true }),
      process.cwd(),
      () => "live"
    );
    expect(readFileSync(hooksPath, "utf8")).toContain("strict");
    expect(existsSync(fallbackProfile)).toBe(false);
  } finally {
    if (originalHome === undefined) {
      Reflect.deleteProperty(process.env, "HOME");
    } else {
      process.env.HOME = originalHome;
    }
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    if (originalNativeMode === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_NATIVE_SUBAGENT_MODE");
    } else {
      process.env.LOOP_NATIVE_SUBAGENT_MODE = originalNativeMode;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
