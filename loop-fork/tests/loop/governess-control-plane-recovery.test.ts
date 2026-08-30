import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  governessControlPlaneRecoveryDeps,
  recoverGovernessControlPlane,
} from "../../src/loop/governess-control-plane-recovery";
import {
  createRunManifest,
  resolveRunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";

const commandResult = (stdout = "") => ({
  exitCode: 0,
  stderr: Buffer.alloc(0),
  stdout: Buffer.from(stdout),
});

test("recover-control-plane restores one owned Governess pane to an active paired run", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-governess-recover-"));
  const cwd = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("1", cwd, home);
  mkdirSync(storage.runDir, { recursive: true });
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cwd,
      mode: "paired",
      pid: 1234,
      primaryAgent: "codex",
      repoId: storage.repoId,
      runId: "1",
      state: "working",
      status: "running",
      tmuxPaneLeft: "%1",
      tmuxPaneLeftAgent: "codex",
      tmuxPaneRight: "%2",
      tmuxPaneRightAgent: "claude",
      tmuxSession: "repo-loop-1",
      tmuxSocket: join(root, "tmux.sock"),
    })
  );
  const commands: string[][] = [];
  governessControlPlaneRecoveryDeps.buildLaunchArgv = () => ["/opt/loop"];
  governessControlPlaneRecoveryDeps.now = () => "2026-08-30T08:30:00.000Z";
  governessControlPlaneRecoveryDeps.spawnSync = mock((argv: string[]) => {
    commands.push(argv);
    if (argv.includes("split-window")) {
      return commandResult("%9\n");
    }
    if (argv.includes("display-message")) {
      return commandResult("0\n");
    }
    return commandResult();
  }) as typeof governessControlPlaneRecoveryDeps.spawnSync;

  try {
    expect(recoverGovernessControlPlane("1", cwd, home, {})).toEqual({
      pane: "%9",
      runId: "1",
      status: "recovered",
    });
    const manifest = JSON.parse(
      readFileSync(storage.manifestPath, "utf8")
    ) as Record<string, unknown>;
    expect(manifest.tmuxPaneGoverness).toBe("%9");
    expect(manifest.governess).toBe(true);
    expect(commands.every((argv) => argv[1] === "-S")).toBe(true);
    const split = commands.find((argv) => argv.includes("split-window"));
    expect(split?.at(-1)).toContain("__governess-secure");
    expect(split?.at(-1)).not.toContain("SECRET=");
    expect(commands.some((argv) => argv.includes("pane-died"))).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("recover-control-plane refuses an already owned Governess pane", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-governess-owned-"));
  const cwd = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("1", cwd, home);
  mkdirSync(storage.runDir, { recursive: true });
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cwd,
      mode: "paired",
      pid: 1234,
      repoId: storage.repoId,
      runId: "1",
      state: "working",
      status: "running",
      tmuxPaneGoverness: "%9",
      tmuxSession: "repo-loop-1",
      tmuxSocket: join(root, "tmux.sock"),
    })
  );
  const spawn = mock(() => commandResult());
  governessControlPlaneRecoveryDeps.spawnSync =
    spawn as typeof governessControlPlaneRecoveryDeps.spawnSync;

  try {
    expect(recoverGovernessControlPlane("1", cwd, home, {})).toEqual({
      reason: "run already owns a Governess pane",
      runId: "1",
      status: "refused",
    });
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
