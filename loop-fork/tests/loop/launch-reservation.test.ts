import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runGit } from "../../src/loop/git";
import {
  bindLaunchTask,
  cancelPairedLaunch,
  reservePairedLaunch,
} from "../../src/loop/launch-reservation";
import {
  createRunManifest,
  readReservationManifest,
  readRunManifest,
  resolveRepoId,
  resolveRunStorage,
  resolveStorageRoot,
  writeRunManifest,
} from "../../src/loop/run-state";
import { resolveTmuxSocket } from "../../src/loop/tmux-socket";
import type { LaunchWorkspaceBinding, Options } from "../../src/loop/types";
import { resolveWorkspaceBinding } from "../../src/loop/workspace-binding";

const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "claude",
  cavemanMode: "lite",
  cavemanModeSource: "default",
  codexModel: "test-model",
  copilotModel: "test-model",
  cursorModel: "test-model",
  doneSignal: "<done/>",
  format: "raw",
  geminiModel: "test-model",
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
  ...overrides,
});

const makeBinding = (root: string): LaunchWorkspaceBinding => ({
  branchRef: "refs/heads/main",
  repoId: resolveRepoId(root),
  root,
});

const claimIds = () => {
  let next = 0;
  return () => `claim-${++next}`;
};

const reservationDeps = (home: string, pid = 4242) => ({
  env: { LOOP_TMUX_SOCKET: "/tmp/ls-res/a.sock" } as Record<
    string,
    string | undefined
  >,
  home,
  isPidAlive: (candidate: number) => candidate === pid,
  pidStartedAt: () => undefined,
  makeClaimId: claimIds(),
  pid,
  sleep: async () => undefined,
  tmuxLiveness: () => "dead" as const,
  uid: 501,
});

const writeFixtureManifest = (
  home: string,
  binding: LaunchWorkspaceBinding,
  overrides: Partial<Parameters<typeof createRunManifest>[0]> = {}
) => {
  const storage = resolveRunStorage("1", binding.root, home);
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      claudeSessionId: "",
      codexThreadId: "",
      cwd: binding.root,
      mode: "paired",
      pid: 999,
      repoId: storage.repoId,
      runId: "1",
      state: "submitted",
      ...overrides,
    })
  );
  return storage;
};

test("concurrent fresh claims for one workspace produce one winner", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const ids = claimIds();
    const deps = {
      ...reservationDeps(home),
      makeClaimId: ids,
    };
    const results = await Promise.allSettled([
      reservePairedLaunch(makeOptions(), binding, deps),
      reservePairedLaunch(makeOptions(), binding, deps),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    const winner = results.find(
      (
        result
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof reservePairedLaunch>>
      > => result.status === "fulfilled"
    );
    expect(winner).toBeDefined();
    expect(readRunManifest(winner?.value.storage.manifestPath)).toMatchObject({
      state: "submitted",
      workspaceBinding: binding,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("lock heartbeat survives a reservation scan longer than the stale window", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const otherBinding = {
      ...binding,
      branchRef: "refs/heads/unrelated",
      root: `${root}-unrelated`,
    };
    writeFixtureManifest(home, binding, {
      state: "stopped",
      tmuxSession: "slow-dead-probe",
      workspaceBinding: otherBinding,
    });
    let delayed = false;
    const slowDeps = {
      ...reservationDeps(home, 4242),
      tmuxLiveness: async () => {
        if (!delayed) {
          delayed = true;
          await sleep(6200);
        }
        return "dead" as const;
      },
    };
    const first = reservePairedLaunch(makeOptions(), binding, slowDeps);
    await sleep(100);
    const second = reservePairedLaunch(
      makeOptions(),
      binding,
      reservationDeps(home, 5252)
    );
    const results = await Promise.allSettled([first, second]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(
      readdirSync(join(resolveStorageRoot(home), binding.repoId), {
        withFileTypes: true,
      }).filter((entry) => entry.isDirectory())
    ).toHaveLength(2);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
}, 10_000);

// Terminal-plus-dead-tmux used to be enough to release. Under the
// evidence-backed predicate it is not: with no tmuxSession there is no branded
// target and no recorded handback, so conjuncts 1 and 5 fail and the workspace
// stays owned.
test("same branch or same root conflicts, and terminal dead ownership alone no longer releases", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const storage = writeFixtureManifest(home, binding, {
      workspaceBinding: { ...binding, root: `${root}-other` },
    });
    await expect(
      reservePairedLaunch(makeOptions(), binding, reservationDeps(home))
    ).rejects.toThrow("launch conflict: run 1");

    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        claudeSessionId: "",
        codexThreadId: "",
        cwd: root,
        mode: "paired",
        pid: 999,
        repoId: storage.repoId,
        runId: "1",
        state: "submitted",
        workspaceBinding: { ...binding, branchRef: "refs/heads/other" },
      })
    );
    await expect(
      reservePairedLaunch(makeOptions(), binding, reservationDeps(home))
    ).rejects.toThrow("launch conflict: run 1");

    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        claudeSessionId: "",
        codexThreadId: "",
        cwd: root,
        mode: "paired",
        pid: 999,
        repoId: storage.repoId,
        runId: "1",
        state: "stopped",
        workspaceBinding: binding,
      })
    );
    const before = readFileSync(storage.manifestPath);
    await expect(
      reservePairedLaunch(makeOptions(), binding, reservationDeps(home))
    ).rejects.toThrow("launch conflict: run 1");
    expect(readFileSync(storage.manifestPath).equals(before)).toBe(true);
    expect(
      readdirSync(join(resolveStorageRoot(home), binding.repoId))
        .filter((entry) => !entry.startsWith("."))
        .sort()
    ).toEqual(["1"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("active legacy and unknown topology fail closed without mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const storage = writeFixtureManifest(home, binding);
    await expect(
      reservePairedLaunch(makeOptions(), binding, reservationDeps(home))
    ).rejects.toThrow("legacy-unknown");
    expect(readRunManifest(storage.manifestPath)?.state).toBe("submitted");

    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        claudeSessionId: "",
        codexThreadId: "",
        cwd: root,
        mode: "paired",
        pid: 999,
        repoId: storage.repoId,
        runId: "1",
        state: "stopped",
        tmuxSession: "repo-loop-1",
        workspaceBinding: binding,
      })
    );
    await expect(
      reservePairedLaunch(makeOptions(), binding, {
        ...reservationDeps(home),
        tmuxLiveness: () => "unknown",
      })
    ).rejects.toThrow("repo-loop-1");
    expect(readRunManifest(storage.manifestPath)?.state).toBe("stopped");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("active alphanumeric run ids participate in workspace conflict checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const storage = resolveRunStorage("alpha", root, home);
    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        claudeSessionId: "",
        codexThreadId: "",
        cwd: root,
        mode: "paired",
        pid: 999,
        repoId: storage.repoId,
        runId: "alpha",
        state: "submitted",
        workspaceBinding: binding,
      })
    );

    await expect(
      reservePairedLaunch(makeOptions(), binding, reservationDeps(home))
    ).rejects.toThrow("launch conflict: run alpha");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("concurrent cold resumes grant exactly one bootstrap attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const storage = writeFixtureManifest(home, binding, {
      launchClaimId: "immutable-claim",
      workspaceBinding: binding,
    });
    const deps = reservationDeps(home);
    const results = await Promise.allSettled([
      reservePairedLaunch(
        makeOptions({ resumeRunId: storage.runId }),
        binding,
        deps
      ),
      reservePairedLaunch(
        makeOptions({ resumeRunId: storage.runId }),
        binding,
        deps
      ),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(readRunManifest(storage.manifestPath)).toMatchObject({
      launchClaimId: "immutable-claim",
      launchAttemptPid: 4242,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("explicit resume reuses the matching claim and task binding is immutable", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const deps = {
      ...reservationDeps(home),
      makeClaimId: claimIds(),
    };
    const fresh = await reservePairedLaunch(makeOptions(), binding, deps);
    const sha256 = bindLaunchTask(
      fresh,
      "exact charter",
      "2026-07-31T00:00:00Z"
    );
    expect(sha256).toHaveLength(64);
    expect(readRunManifest(fresh.storage.manifestPath)?.sourceTaskSha256).toBe(
      sha256
    );
    expect(() => bindLaunchTask(fresh, "different charter")).toThrow(
      "different source charter"
    );

    cancelPairedLaunch(fresh, "2026-07-31T00:01:00Z");
    expect(readRunManifest(fresh.storage.manifestPath)).toMatchObject({
      sourceTaskSha256: sha256,
      state: "failed",
    });

    const resumed = await reservePairedLaunch(
      makeOptions({ resumeRunId: fresh.storage.runId, workspace: root }),
      binding,
      deps
    );
    expect(resumed).toMatchObject({
      reserved: false,
      storage: { runId: fresh.storage.runId },
      workspaceBinding: binding,
    });
    expect(resumed.claimId).toBeDefined();
    expect(bindLaunchTask(resumed, "exact charter")).toBe(sha256);
    expect(() => bindLaunchTask(resumed, "different charter")).toThrow(
      "different source charter"
    );

    cancelPairedLaunch(resumed, "2026-07-31T00:02:00Z");
    expect(readRunManifest(fresh.storage.manifestPath)?.state).toBe("failed");
    expect(
      readRunManifest(fresh.storage.manifestPath)?.launchAttemptId
    ).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("live reattach validates but never invents source-charter evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const storage = writeFixtureManifest(home, binding, {
      launchClaimId: "immutable-claim",
      state: "working",
      tmuxSession: "repo-loop-1",
      workspaceBinding: binding,
    });
    const live = await reservePairedLaunch(
      makeOptions({ resumeRunId: storage.runId }),
      binding,
      { ...reservationDeps(home), tmuxLiveness: () => "live" }
    );

    expect(live.claimId).toBeUndefined();
    const sha256 = bindLaunchTask(live, "original charter");
    expect(
      readRunManifest(storage.manifestPath)?.sourceTaskSha256
    ).toBeUndefined();
    const manifest = readRunManifest(storage.manifestPath);
    if (!manifest) {
      throw new Error("expected live manifest");
    }
    writeRunManifest(storage.manifestPath, {
      ...manifest,
      sourceTaskSha256: sha256,
    });
    expect(() => bindLaunchTask(live, "changed charter")).toThrow(
      "different source charter"
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("stale canonical lock reclamation stays single-owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const repoDir = join(resolveStorageRoot(home), binding.repoId);
    mkdirSync(repoDir, { recursive: true });
    const staleLock = join(repoDir, ".paired-launch.lock");
    mkdirSync(staleLock);
    utimesSync(staleLock, new Date(0), new Date(0));
    const deps = reservationDeps(home);
    const results = await Promise.allSettled([
      reservePairedLaunch(makeOptions(), binding, deps),
      reservePairedLaunch(makeOptions(), binding, deps),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("a delayed stale cancel cannot clear a replacement resume attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const storage = writeFixtureManifest(home, binding, {
      state: "stopped",
      workspaceBinding: binding,
    });
    const stale = await reservePairedLaunch(
      makeOptions({ resumeRunId: storage.runId }),
      binding,
      {
        ...reservationDeps(home, 4242),
        makeClaimId: (() => {
          let next = 0;
          return () => `stale-${++next}`;
        })(),
      }
    );
    const replacement = await reservePairedLaunch(
      makeOptions({ resumeRunId: storage.runId }),
      binding,
      {
        ...reservationDeps(home, 5252),
        isPidAlive: () => false,
        makeClaimId: (() => {
          let next = 0;
          return () => `replacement-${++next}`;
        })(),
      }
    );

    cancelPairedLaunch(stale);
    expect(readRunManifest(storage.manifestPath)?.launchAttemptId).toBe(
      replacement.claimId
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("distinct registered worktrees on distinct branches can both reserve", async () => {
  const parent = mkdtempSync(join(tmpdir(), "loop-launch-git-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  const root = join(parent, "repo");
  const other = join(parent, "other");
  try {
    runGit(parent, ["init", "-b", "main", root]);
    runGit(root, ["config", "user.email", "loop@example.test"]);
    runGit(root, ["config", "user.name", "Loop Test"]);
    writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
    runGit(root, ["add", "README.md"]);
    runGit(root, ["commit", "-m", "fixture"]);
    runGit(root, ["branch", "other"]);
    runGit(root, ["worktree", "add", other, "other"]);

    const firstBinding = resolveWorkspaceBinding(root, root);
    const secondBinding = resolveWorkspaceBinding(other, root);
    expect(firstBinding.repoId).toBe(secondBinding.repoId);
    const first = await reservePairedLaunch(
      makeOptions(),
      firstBinding,
      reservationDeps(home)
    );
    const second = await reservePairedLaunch(
      makeOptions(),
      secondBinding,
      reservationDeps(home)
    );
    expect([first.storage.runId, second.storage.runId]).toEqual(["1", "2"]);
  } finally {
    rmSync(parent, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

// --- T-04 early launch binding (verify 2, 4, 5) ------------------------------

test("a fresh reservation binds the resolved socket into the manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const claim = await reservePairedLaunch(
      makeOptions(),
      binding,
      reservationDeps(home)
    );
    const manifest = readRunManifest(claim.storage.manifestPath);
    expect(manifest?.tmuxSocket).toBe("/tmp/ls-res/a.sock");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("an unusable socket fails before any run is reserved on disk", async () => {
  // verify 2: no durable active-looking run may exist with an unusable socket.
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    await expect(
      reservePairedLaunch(makeOptions(), binding, {
        ...reservationDeps(home),
        env: { LOOP_TMUX_SOCKET: "relative/not-absolute.sock" },
      })
    ).rejects.toThrow(/never resolved against cwd/);

    // Non-vacuity: the storage root must hold no reserved run at all, so the
    // failure genuinely preceded reservation rather than being cleaned up after.
    const repoDir = join(resolveStorageRoot(home), binding.repoId);
    const reserved = existsSync(repoDir)
      ? readdirSync(repoDir).filter((entry) => !entry.startsWith("."))
      : [];
    expect(reserved).toEqual([]);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("resume never consults the ambient resolver, even when it would throw", async () => {
  // verify 5a: resolveTmuxSocket must be unreachable from a post-launch path.
  // The earlier version of this test used a VALID hostile socket, so resolution
  // succeeded and the manifest read still preserved A — it could not distinguish
  // "resolver ignored" from "resolver called and its result discarded". An
  // INVALID ambient value discriminates: if the resume path resolves at all, it
  // throws and takes a legitimate resume down with it.
  let resolverCalls = 0;
  for (const hostile of [
    "",
    "relative/not-absolute.sock",
    `/tmp/${"a".repeat(200)}`,
  ]) {
    // A fresh workspace per value: reserving twice against one manifest trips
    // the live-bootstrap-attempt interlock, which would mask what is under test.
    const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
    const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
    try {
      const binding = makeBinding(root);
      const storage = writeFixtureManifest(home, binding, {
        tmuxSession: "run-a",
        tmuxSocket: "/tmp/ls-a/a.sock",
      });
      await reservePairedLaunch(makeOptions({ resumeRunId: "1" }), binding, {
        ...reservationDeps(home),
        env: { LOOP_TMUX_SOCKET: hostile },
        resolveSocket: (env, uid) => {
          resolverCalls += 1;
          return resolveTmuxSocket(env, { uid }).socket;
        },
      });
      const manifest = readRunManifest(storage.manifestPath);
      expect(manifest?.tmuxSocket).toBe("/tmp/ls-a/a.sock");
      expect(manifest?.tmuxSession).toBe("run-a");
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(home, { force: true, recursive: true });
    }
  }
  // The counter is the real assertion: preserving A proves the result was not
  // used, but only a zero call count proves the resolver was never reached.
  expect(resolverCalls).toBe(0);
});

test("a fresh launch does consult the resolver, so the counter discriminates", async () => {
  // Positive control: without this, a resolveSocket that was never wired up at
  // all would satisfy the zero-call assertion above.
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    let resolverCalls = 0;
    await reservePairedLaunch(makeOptions(), binding, {
      ...reservationDeps(home),
      resolveSocket: (env, uid) => {
        resolverCalls += 1;
        return resolveTmuxSocket(env, { uid }).socket;
      },
    });
    expect(resolverCalls).toBe(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("a named launch for a non-existent run still resolves before reserving", async () => {
  // The unnamed-fresh ordering test could not see this: naming a run skips the
  // pre-lock resolution, and the branch below still reserves storage. An
  // invalid socket must not leave a reserved run directory behind.
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    let resolverCalls = 0;
    await expect(
      reservePairedLaunch(
        makeOptions({ sessionId: "no-such-run-selector" }),
        binding,
        {
          ...reservationDeps(home),
          env: { LOOP_TMUX_SOCKET: "relative/not-absolute.sock" },
          resolveSocket: (env, uid) => {
            resolverCalls += 1;
            return resolveTmuxSocket(env, { uid }).socket;
          },
        }
      )
    ).rejects.toThrow(/never resolved against cwd/);

    expect(resolverCalls).toBe(1);
    const repoDir = join(resolveStorageRoot(home), binding.repoId);
    const reserved = existsSync(repoDir)
      ? readdirSync(repoDir).filter((entry) => !entry.startsWith("."))
      : [];
    expect(reserved).toEqual([]);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("manifestCanStillOwnWorkspace keeps a tmuxSession manifest with an unusable target as owning the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    writeFixtureManifest(home, binding, {
      state: "completed",
      tmuxSession: "legacy-session",
      tmuxSocket: "relative/unusable.sock",
      workspaceBinding: binding,
    });
    let tmuxContacts = 0;
    await expect(
      reservePairedLaunch(makeOptions(), binding, {
        ...reservationDeps(home),
        tmuxLiveness: (target) => {
          expect(target).toBeUndefined();
          tmuxContacts += 1;
          return "unknown";
        },
      })
    ).rejects.toThrow("still owns workspace");
    expect(tmuxContacts).toBe(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("reserveRequestedLaunch conflicts without mutation when requested tmuxSession has an unusable target", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const storage = writeFixtureManifest(home, binding, {
      tmuxSession: "legacy-session",
      tmuxSocket: "relative/unusable.sock",
      workspaceBinding: binding,
    });
    const before = readFileSync(storage.manifestPath, "utf8");
    const opts = makeOptions({ resumeRunId: "1" });
    let tmuxContacts = 0;
    await expect(
      reservePairedLaunch(opts, binding, {
        ...reservationDeps(home),
        tmuxLiveness: (target) => {
          expect(target).toBeUndefined();
          tmuxContacts += 1;
          return "unknown";
        },
      })
    ).rejects.toThrow("still owns workspace");
    expect(tmuxContacts).toBe(1);
    expect(opts.reservedRunId).toBeUndefined();
    expect(opts.workspaceBinding).toBeUndefined();
    expect(opts.launchClaimId).toBeUndefined();
    expect(readFileSync(storage.manifestPath, "utf8")).toBe(before);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

// --- Terminal reservation release (loop-resume-terminal-reservation-v1) ------
//
// Run 42 held the workspace forever: its tmux endpoint was gone, so liveness
// was "unknown", and unknown was read as ownership. Release now requires the
// full positive conjunction. Every refusal below proves the exact manifest
// bytes are unchanged and that no run directory (hence no counter step) was
// created.

const RUN_42_FIXTURE = join(
  import.meta.dir,
  "../fixtures/loop-resume-terminal-reservation-v1/run-42-manifest.json.fixture"
);
const RUN_42_BYTES = 2814;
const RUN_42_SHA256 =
  "5e466b4ab2c8602bda8b7aefc1d8372356a2f1ae096c2e792769ccb947093b22";
const RUN_42_ENDPOINT = "/private/tmp/harness-d001-tmux/tmux-501/default";

const run42Bytes = (): Buffer => {
  const bytes = readFileSync(RUN_42_FIXTURE);
  expect(bytes.byteLength).toBe(RUN_42_BYTES);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(RUN_42_SHA256);
  return bytes;
};

const installRun42 = (
  home: string,
  binding: LaunchWorkspaceBinding,
  raw?: string
): { manifestPath: string; repoDir: string } => {
  const repoDir = join(resolveStorageRoot(home), binding.repoId);
  const runDir = join(repoDir, "42");
  mkdirSync(runDir, { recursive: true });
  const manifestPath = join(runDir, "manifest.json");
  if (raw === undefined) {
    writeFileSync(manifestPath, run42Bytes());
  } else {
    writeFileSync(manifestPath, raw);
  }
  return { manifestPath, repoDir };
};

const run42Mutated = (
  mutate: (parsed: Record<string, unknown>) => void
): string => {
  const parsed = JSON.parse(run42Bytes().toString("utf8")) as Record<
    string,
    unknown
  >;
  mutate(parsed);
  return JSON.stringify(parsed, null, 2);
};

const runDirs = (repoDir: string): string[] =>
  existsSync(repoDir)
    ? readdirSync(repoDir)
        .filter((entry) => !entry.startsWith("."))
        .sort()
    : [];

const withReservationFixture = async (
  raw: string | undefined,
  run: (context: {
    binding: LaunchWorkspaceBinding;
    home: string;
    manifestPath: string;
    repoDir: string;
  }) => Promise<void>
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const { manifestPath, repoDir } = installRun42(home, binding, raw);
    await run({ binding, home, manifestPath, repoDir });
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
};

const expectReservationRefused = async (
  raw: string | undefined,
  overrides: Record<string, unknown> = {}
): Promise<void> => {
  await withReservationFixture(
    raw,
    async ({ binding, home, manifestPath, repoDir }) => {
      const before = readFileSync(manifestPath);
      await expect(
        reservePairedLaunch(makeOptions(), binding, {
          ...reservationDeps(home),
          tmuxLiveness: () => "unknown" as const,
          ...overrides,
        })
      ).rejects.toThrow();
      expect(readFileSync(manifestPath).equals(before)).toBe(true);
      expect(runDirs(repoDir)).toEqual(["42"]);
    }
  );
};

test("the exact Run 42 manifest releases the workspace under the full terminal-released predicate", async () => {
  expect(existsSync(RUN_42_ENDPOINT)).toBe(false);
  await withReservationFixture(
    undefined,
    async ({ binding, home, manifestPath, repoDir }) => {
      const before = readFileSync(manifestPath);
      const claim = await reservePairedLaunch(makeOptions(), binding, {
        ...reservationDeps(home),
        tmuxLiveness: () => "unknown" as const,
      });
      expect(claim.reserved).toBe(true);
      expect(claim.storage.runId).toBe("43");
      expect(readFileSync(manifestPath).equals(before)).toBe(true);
      expect(readFileSync(manifestPath).byteLength).toBe(RUN_42_BYTES);
      expect(
        createHash("sha256").update(readFileSync(manifestPath)).digest("hex")
      ).toBe(RUN_42_SHA256);
      expect(runDirs(repoDir)).toEqual(["42", "43"]);
    }
  );
});

test("a present endpoint blocks release even when tmux liveness is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-endpoint-present-"));
  try {
    const socket = join(dir, "present.sock");
    writeFileSync(socket, "");
    await expectReservationRefused(
      run42Mutated((parsed) => {
        parsed.tmuxSocket = socket;
      })
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("an unknown endpoint blocks release; unknown is never absence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-endpoint-unknown-"));
  const walled = join(dir, "walled");
  mkdirSync(walled);
  try {
    chmodSync(walled, 0o000);
    await expectReservationRefused(
      run42Mutated((parsed) => {
        parsed.tmuxSocket = join(walled, "denied.sock");
      })
    );
  } finally {
    chmodSync(walled, 0o700);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a live tmux session blocks release", async () => {
  await expectReservationRefused(undefined, {
    tmuxLiveness: () => "live" as const,
  });
});

test("a missing or unusable target blocks release", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.tmuxSocket = "relative/unusable.sock";
    })
  );
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.tmuxSocket = undefined;
    })
  );
});

test("an active or non-enumerated lifecycle state blocks release", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.state = "working";
      parsed.status = "running";
    })
  );
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.state = "reviewing";
      parsed.status = "running";
    })
  );
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.state = "halted-forever";
      parsed.status = "stopped";
    })
  );
});

test("an absent, invalid, or conflicting release marker blocks release", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.workspaceReleasedAt = undefined;
    })
  );
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.workspaceReleasedAt = "2026-02-30T18:30:00Z";
    })
  );
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.workspace_released_at = "2026-08-19T09:00:00.000Z";
    })
  );
});

test("a live run PID or a live launch-attempt PID blocks release", async () => {
  await expectReservationRefused(undefined, {
    isPidAlive: (candidate: number) => candidate === 9598,
  });
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.launchAttemptPid = 4242;
    })
  );
});

test("a terminal released run does not own a later process that reused its PID", async () => {
  await withReservationFixture(
    run42Mutated((parsed) => {
      parsed.pid = 45_568;
      parsed.launchAttemptPid = 45_568;
      parsed.workspaceReleasedAt = "2026-08-18T18:27:00.000Z";
    }),
    async ({ binding, home, manifestPath, repoDir }) => {
      const before = readFileSync(manifestPath);
      const claim = await reservePairedLaunch(makeOptions(), binding, {
        ...reservationDeps(home),
        isPidAlive: (candidate: number) => candidate === 45_568,
        pidStartedAt: (candidate: number) =>
          candidate === 45_568
            ? Date.parse("2026-08-29T17:47:22.000Z")
            : undefined,
        tmuxLiveness: () => "unknown" as const,
      });
      expect(claim.reserved).toBe(true);
      expect(claim.storage.runId).toBe("43");
      expect(readFileSync(manifestPath).equals(before)).toBe(true);
      expect(runDirs(repoDir)).toEqual(["42", "43"]);
    }
  );
});

test("a live PID with pre-release or unreadable start identity remains ownership", async () => {
  await expectReservationRefused(undefined, {
    isPidAlive: (candidate: number) => candidate === 9598,
    pidStartedAt: (candidate: number) =>
      candidate === 9598 ? Date.parse("2026-08-18T18:29:59.000Z") : undefined,
  });
  await expectReservationRefused(undefined, {
    isPidAlive: (candidate: number) => candidate === 9598,
    pidStartedAt: () => undefined,
  });
});

test("a malformed or mismatched PID blocks release", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.pid = "9598junk";
    })
  );
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.launchAttemptPid = "9598junk";
    })
  );
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.launch_attempt_pid = 1234;
    })
  );
});

test("a present-invalid state with a terminal status, or state/status disagreement, blocks release", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.state = "not-a-state";
      parsed.status = "stopped";
    })
  );
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.state = "stopped";
      parsed.status = "running";
    })
  );
});

test("an existing malformed or unreadable manifest refuses before any run allocation", async () => {
  for (const raw of ["{ not json", "[]", "null", "{}"]) {
    await expectReservationRefused(raw);
  }
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const repoDir = join(resolveStorageRoot(home), binding.repoId);
    const manifestPath = join(repoDir, "42", "manifest.json");
    mkdirSync(manifestPath, { recursive: true });
    await expect(
      reservePairedLaunch(makeOptions(), binding, {
        ...reservationDeps(home),
        tmuxLiveness: () => "unknown" as const,
      })
    ).rejects.toThrow();
    expect(runDirs(repoDir)).toEqual(["42"]);
    expect(readReservationManifest(manifestPath)?.kind).toBe("refuse");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("a provenance failure in the endpoint classifier blocks release", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.tmuxSocket = `${"x".repeat(120)}/not-absolute.sock`;
    })
  );
});

// An evidence-backed scan must never fall through to the legacy dead-tmux
// release. Once ownership evidence exists, the full conjunction is the only
// route to release; a conjunct that merely fails must not hand the verdict
// back to the older, weaker rule.
test("evidence-backed terminal manifest without tmuxSession and without a release marker blocks", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.tmuxSession = undefined;
      parsed.workspaceReleasedAt = undefined;
    })
  );
});

test("evidence-backed terminal manifest with dead liveness blocks when the conjunction fails", async () => {
  await expectReservationRefused(undefined, {
    tmuxLiveness: () => "dead" as const,
  });
});

// An explicit null is present-and-unusable, not absent. Each case refuses
// before any write: manifest bytes unchanged, no new run directory, no counter
// step.
test("a null launchAttemptPid blocks release", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.launchAttemptPid = null;
    })
  );
});

test("a null workspaceReleasedAt blocks release", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.workspaceReleasedAt = null;
    })
  );
});

test("a null release alias blocks release even beside a valid snake_case alias", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.workspaceReleasedAt = null;
      parsed.workspace_released_at = "2026-08-18T18:30:00.000Z";
    })
  );
});

test("a null state blocks release even beside a terminal status", async () => {
  await expectReservationRefused(
    run42Mutated((parsed) => {
      parsed.state = null;
      parsed.status = "stopped";
    })
  );
});

// --- Shared-socket runtime absence (exact legacy Run 61) --------------------
//
// Run 42's socket file was itself gone, so "endpoint absent" happened to
// coincide with "runtime gone". Run 61 falsifies that generalisation: its
// session is positively gone, but its socket is the SHARED default that other
// live sessions still hold, so the endpoint is present forever. Endpoint
// absence was only ever a proxy; a positively dead verdict on the exact branded
// target is the stronger fact.

const RUN_61_FIXTURE = join(
  import.meta.dir,
  "../fixtures/loop-resume-terminal-reservation-v1/run-61-manifest.json.fixture"
);
const RUN_61_BYTES = 2636;
const RUN_61_SHA256 =
  "8222eaada187aae0a18e0bb3f68884c5b7402aac8df1e28f792e6dc5bba20569";
const RUN_61_SHARED_ENDPOINT = "/private/tmp/tmux-501/default";

const run61Bytes = (): Buffer => {
  const bytes = readFileSync(RUN_61_FIXTURE);
  expect(bytes.byteLength).toBe(RUN_61_BYTES);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(RUN_61_SHA256);
  return bytes;
};

const run61Mutated = (
  mutate: (parsed: Record<string, unknown>) => void
): string => {
  const parsed = JSON.parse(run61Bytes().toString("utf8")) as Record<
    string,
    unknown
  >;
  mutate(parsed);
  return JSON.stringify(parsed, null, 2);
};

const withRun61Fixture = async (
  raw: string | undefined,
  run: (context: {
    binding: LaunchWorkspaceBinding;
    home: string;
    manifestPath: string;
    repoDir: string;
  }) => Promise<void>
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "loop-launch-root-"));
  const home = mkdtempSync(join(tmpdir(), "loop-launch-home-"));
  try {
    const binding = makeBinding(root);
    const repoDir = join(resolveStorageRoot(home), binding.repoId);
    mkdirSync(join(repoDir, "61"), { recursive: true });
    const manifestPath = join(repoDir, "61", "manifest.json");
    if (raw === undefined) {
      writeFileSync(manifestPath, run61Bytes());
    } else {
      writeFileSync(manifestPath, raw);
    }
    await run({ binding, home, manifestPath, repoDir });
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
};

const expectRun61Refused = async (
  raw: string | undefined,
  overrides: Record<string, unknown>
): Promise<void> => {
  await withRun61Fixture(
    raw,
    async ({ binding, home, manifestPath, repoDir }) => {
      const before = readFileSync(manifestPath);
      await expect(
        reservePairedLaunch(makeOptions(), binding, {
          ...reservationDeps(home),
          ...overrides,
        })
      ).rejects.toThrow();
      expect(readFileSync(manifestPath).equals(before)).toBe(true);
      expect(runDirs(repoDir)).toEqual(["61"]);
    }
  );
};

test("exact Run 61 releases on a live shared socket when the exact session is positively dead", async () => {
  // Precondition, asserted rather than assumed: the bound endpoint really is a
  // live shared socket on this host, which is the whole point of the case.
  expect(existsSync(RUN_61_SHARED_ENDPOINT)).toBe(true);
  await withRun61Fixture(
    undefined,
    async ({ binding, home, manifestPath, repoDir }) => {
      const before = readFileSync(manifestPath);
      const claim = await reservePairedLaunch(makeOptions(), binding, {
        ...reservationDeps(home),
        tmuxLiveness: () => "dead" as const,
      });
      expect(claim.reserved).toBe(true);
      expect(claim.storage.runId).toBe("62");
      expect(readFileSync(manifestPath).equals(before)).toBe(true);
      expect(readFileSync(manifestPath).byteLength).toBe(RUN_61_BYTES);
      expect(
        createHash("sha256").update(readFileSync(manifestPath)).digest("hex")
      ).toBe(RUN_61_SHA256);
      expect(runDirs(repoDir)).toEqual(["61", "62"]);
    }
  );
});

test("a present endpoint with unknown liveness blocks: we learned nothing about the session", async () => {
  await expectRun61Refused(undefined, {
    tmuxLiveness: () => "unknown" as const,
  });
});

test("a present endpoint with live tmux blocks", async () => {
  await expectRun61Refused(undefined, { tmuxLiveness: () => "live" as const });
});

test("an unknown endpoint blocks even when liveness reports dead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-endpoint-walled-"));
  const walled = join(dir, "walled");
  mkdirSync(walled);
  try {
    chmodSync(walled, 0o000);
    await expectRun61Refused(
      run61Mutated((parsed) => {
        parsed.tmuxSocket = join(walled, "denied.sock");
      }),
      { tmuxLiveness: () => "dead" as const }
    );
  } finally {
    chmodSync(walled, 0o700);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("an absent endpoint with a dead verdict blocks: the verdict cannot have come from the bound endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-endpoint-gone-"));
  try {
    await expectRun61Refused(
      run61Mutated((parsed) => {
        parsed.tmuxSocket = join(dir, "gone.sock");
      }),
      { tmuxLiveness: () => "dead" as const }
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
