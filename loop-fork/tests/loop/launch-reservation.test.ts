import { expect, test } from "bun:test";
import {
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

test("same branch or same root conflicts while terminal dead ownership permits", async () => {
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
    const allowed = await reservePairedLaunch(
      makeOptions(),
      binding,
      reservationDeps(home)
    );
    expect(allowed.storage.runId).toBe("2");
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
