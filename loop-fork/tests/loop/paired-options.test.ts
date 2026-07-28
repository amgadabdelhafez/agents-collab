import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeChannelServerName } from "../../src/loop/bridge-config";
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
    preparePairedRun(reusedTmux, alternatePairCwd, () => true);
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
      preparePairedRun(liveModeChange, alternatePairCwd, () => true)
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
      preparePairedRun(liveHelperModeChange, alternatePairCwd, () => true)
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
    preparePairedRun(staleTmux, alternatePairCwd, () => false);
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
    expect(config).toContain('model_reasoning_effort = "xhigh"');
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

test("preparePairedRun clears a stale tmux session outside tmux mode", () => {
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
        },
        "2026-03-22T10:00:00.000Z"
      )
    );
    const opts = makeOptions({ resumeRunId: "alpha", tmux: false });

    const prepared = preparePairedRun(opts, process.cwd());

    expect(prepared.manifest.tmuxSession).toBeUndefined();
    expect(prepared.manifest.codexRemoteUrl).toBe("ws://127.0.0.1:4500");
    expect(readRunManifest(storage.manifestPath)?.tmuxSession).toBeUndefined();
    expect(readRunManifest(storage.manifestPath)?.codexRemoteUrl).toBe(
      "ws://127.0.0.1:4500"
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
