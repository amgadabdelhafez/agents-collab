// Guards of the dead-run release that dead-run-release.test.ts does not pin
// on its own (found by mutation on the ea968d82 hotfix). As there, tmux
// liveness, the socket endpoint probe, and process liveness are all fakes: no
// tmux server is started or contacted.

import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmTeardownRelease } from "../../src/loop/governess";
import { reservePairedLaunch } from "../../src/loop/launch-reservation";
import {
  createRunManifest,
  readRunManifest,
  resolveRepoId,
  resolveStorageRoot,
} from "../../src/loop/run-state";
import type { TmuxEndpointState, TmuxTarget } from "../../src/loop/tmux-socket";
import type { LaunchWorkspaceBinding, Options } from "../../src/loop/types";

const SOCKET = "/tmp/ls-guards/run.sock";
const CREATED_AT = "2026-10-05T20:00:00.000Z";
const UPDATED_AT = "2026-10-05T21:00:00.000Z";

const makeOptions = (): Options =>
  ({
    agent: "claude",
    cavemanMode: "lite",
    cavemanModeSource: "default",
    codexModel: "test-model",
    doneSignal: "<done/>",
    format: "raw",
    governessCooldownSeconds: 60,
    governessHeight: "40%",
    governessIdleSeconds: 60,
    governessMaxRecoveries: 1,
    governessModel: "test-model",
    governessUrl: "http://127.0.0.1:1",
    helperCavemanMode: "full",
    helperCavemanModeSource: "default",
    maxIterations: 1,
    pairedMode: true,
    pairWith: "codex",
    proof: "verify",
    review: "claudex",
    tmux: true,
    worktree: false,
  }) as Options;

interface World {
  livePids: Set<number>;
  logs: string[];
}

// The recorded socket's file is gone and its session cannot answer: the
// runtime is positively absent, so only process evidence can block.
const fakeDeps = (home: string, world: World) => ({
  endpointState: (target: TmuxTarget | undefined): TmuxEndpointState =>
    target ? "absent" : "unknown",
  env: {} as Record<string, string | undefined>,
  home,
  isPidAlive: (pid: number) => world.livePids.has(pid),
  log: (line: string) => {
    world.logs.push(line);
  },
  makeClaimId: (() => {
    let next = 0;
    return () => `claim-${++next}`;
  })(),
  now: () => "2026-10-06T12:00:00.000Z",
  pid: 4242,
  pidStartedAt: () => undefined,
  platform: "darwin",
  tmuxLiveness: (): "unknown" => "unknown",
  uid: 501,
});

interface Fixture {
  binding: LaunchWorkspaceBinding;
  home: string;
  repoDir: string;
  root: string;
}

const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "loop-dead-guard-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-dead-guard-home-"));
  try {
    const binding: LaunchWorkspaceBinding = {
      branchRef: "refs/heads/main",
      repoId: resolveRepoId(root),
      root,
    };
    const repoDir = join(resolveStorageRoot(home), binding.repoId);
    await run({ binding, home, repoDir, root });
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
};

const writeRun = (
  fixture: Fixture,
  runId: string,
  fields: Record<string, unknown>
): string => {
  const runDir = join(fixture.repoDir, runId);
  mkdirSync(runDir, { recursive: true });
  const base = createRunManifest(
    {
      cwd: fixture.root,
      mode: "paired",
      pid: 81_001,
      repoId: fixture.binding.repoId,
      runId,
      state: "stopped",
      workspaceBinding: fixture.binding,
    },
    CREATED_AT
  );
  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...base,
        createdAt: CREATED_AT,
        tmuxSession: `guards-loop-${runId}`,
        tmuxSocket: SOCKET,
        updatedAt: UPDATED_AT,
        ...fields,
      },
      null,
      2
    )}\n`
  );
  return manifestPath;
};

const runDirs = (repoDir: string): string[] =>
  readdirSync(repoDir)
    .filter((entry) => !entry.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const expectBlocked = async (
  fixture: Fixture,
  world: World,
  manifestPath: string,
  message: string | RegExp
) => {
  const before = readFileSync(manifestPath);
  const dirs = runDirs(fixture.repoDir);
  await expect(
    reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, world)
    )
  ).rejects.toThrow(message);
  expect(readFileSync(manifestPath).equals(before)).toBe(true);
  expect(runDirs(fixture.repoDir)).toEqual(dirs);
  expect(world.logs).toEqual([]);
};

test("a live Codex app-server pid keeps a dead stopped run owning; a dead one does not", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, "81", {
      codexAppServerPid: 81_005,
      state: "stopped",
      status: "stopped",
    });
    const world: World = { livePids: new Set([81_005]), logs: [] };
    await expectBlocked(
      fixture,
      world,
      manifestPath,
      "recorded-process-may-be-live: codexAppServerPid pid 81005"
    );

    // Control: the same run with the app-server gone is released.
    world.livePids.delete(81_005);
    const claim = await reservePairedLaunch(
      makeOptions(),
      fixture.binding,
      fakeDeps(fixture.home, world)
    );
    expect(claim.storage.runId).toBe("82");
    expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBe(
      "2026-10-06T12:00:00.000Z"
    );
  });
});

test("an unreadable run-processes registry blocks release instead of reading as empty", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, "81", {
      state: "failed",
      status: "failed",
    });
    // A registry that is not a directory cannot be listed (ENOTDIR).
    writeFileSync(join(fixture.repoDir, "81", "run-processes"), "not a dir\n");
    await expectBlocked(
      fixture,
      { livePids: new Set(), logs: [] },
      manifestPath,
      "recorded-process-evidence-unreadable: run-processes is unreadable"
    );
  });
});

test("a completed run with no handback is never auto-released, even with every evidence dead", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, "81", {
      state: "completed",
      status: "done",
    });
    await expectBlocked(
      fixture,
      { livePids: new Set(), logs: [] },
      manifestPath,
      "launch conflict: run 81"
    );
    expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBeUndefined();
  });
});

// --- Teardown confirmation retries -----------------------------------------

const teardownDeps = (
  runtimeAnswers: boolean[],
  sleeps: number[],
  attempts = 3
) => ({
  attempts,
  now: () => "2026-10-06T11:00:01.000Z",
  pidCanStillOwnRun: () => false,
  retryMs: 300,
  runtimeAbsent: () => Promise.resolve(runtimeAnswers.shift() ?? false),
  sleep: (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  },
});

test("teardown confirmation retries a session that is still exiting, then releases", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, "81", {
      state: "stopped",
      status: "stopped",
    });
    const sleeps: number[] = [];
    const result = await confirmTeardownRelease(
      manifestPath,
      "81",
      teardownDeps([false, true], sleeps)
    );
    expect(result).toEqual({
      detail: "changed at 2026-10-06T11:00:01.000Z",
      released: true,
    });
    expect(sleeps).toEqual([300]);
  });
});

test("teardown confirmation gives up after its bounded attempts", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, "81", {
      state: "stopped",
      status: "stopped",
    });
    const sleeps: number[] = [];
    const result = await confirmTeardownRelease(
      manifestPath,
      "81",
      teardownDeps([false, false, false, true], sleeps)
    );
    expect(result).toEqual({
      detail: "tmux-runtime-not-absent",
      released: false,
    });
    expect(sleeps).toEqual([300, 300]);
    expect(readRunManifest(manifestPath)?.workspaceReleasedAt).toBeUndefined();
  });
});

test("teardown confirmation does not retry a refusal that waiting cannot clear", async () => {
  await withFixture(async (fixture) => {
    const manifestPath = writeRun(fixture, "81", {
      state: "working",
      status: "running",
    });
    const sleeps: number[] = [];
    const result = await confirmTeardownRelease(
      manifestPath,
      "81",
      teardownDeps([true, true, true], sleeps)
    );
    expect(result).toEqual({ detail: "run-is-not-stopped", released: false });
    expect(sleeps).toEqual([]);
    expect(readRunManifest(manifestPath)?.state).toBe("working");
  });
});
