import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sleep, spawn } from "bun";
import {
  appendRunTranscriptEntry,
  buildManifestPath,
  buildRunDir,
  buildTranscriptPath,
  createRunManifest,
  createRunResultEntry,
  createRunReviewEntry,
  createRunStatusEntry,
  createRunTranscriptEntry,
  loadRunState,
  readRunManifest,
  readRunTranscriptEntries,
  reserveRunStorage,
  resolveExistingRunId,
  resolveRepoId,
  resolveRunId,
  resolveRunStorage,
  resolveStorageRoot,
  touchRunManifest,
  updateRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";

const makeTempDir = (): string =>
  mkdtempSync(join(tmpdir(), "loop-run-state-"));
const LOOP_REPO_ID_RE = /^loop-[a-f0-9]{12}$/;
const REPO_ID_RE = /^repo-[a-f0-9]{12}$/;

test("resolveRepoId prefers git common dir and stays stable across worktrees", () => {
  const calls: string[] = [];
  const runGit = (args: string[]) => {
    calls.push(args.join(" "));
    return args.includes("--git-common-dir")
      ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
      : { exitCode: 0, stderr: "", stdout: "" };
  };

  const first = resolveRepoId("/repo", { runGit });
  const second = resolveRepoId("/repo/worktree", { runGit });

  expect(first).toBe(second);
  expect(calls).toEqual([
    "rev-parse --path-format=absolute --git-common-dir",
    "rev-parse --path-format=absolute --git-common-dir",
  ]);
});

test("resolveRepoId falls back to top-level when git common dir is unavailable", () => {
  const runGit = (args: string[]) => {
    if (args.includes("--git-common-dir")) {
      return { exitCode: 1, stderr: "", stdout: "" };
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: "/Users/me/code/loop\n",
    };
  };

  expect(resolveRepoId("/Users/me/code/loop/src", { runGit })).toMatch(
    LOOP_REPO_ID_RE
  );
});

test("resolveStorageRoot and run path helpers build the expected layout", () => {
  const storageRoot = resolveStorageRoot("/Users/me");
  const runDir = buildRunDir(storageRoot, "repo-abc123", "42");

  expect(storageRoot).toBe("/Users/me/.loop/runs");
  expect(runDir).toBe("/Users/me/.loop/runs/repo-abc123/42");
  expect(buildManifestPath(runDir)).toBe(
    "/Users/me/.loop/runs/repo-abc123/42/manifest.json"
  );
  expect(buildTranscriptPath(runDir)).toBe(
    "/Users/me/.loop/runs/repo-abc123/42/transcript.jsonl"
  );
});

test("resolveRunStorage resolves the same run dir for a resumed run id", () => {
  const storage = resolveRunStorage("7", "/repo/worktree", "/Users/me", {
    runGit: (args: string[]) =>
      args.includes("--git-common-dir")
        ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
        : { exitCode: 0, stderr: "", stdout: "" },
  });

  expect(storage.repoId).toMatch(REPO_ID_RE);
  expect(storage.runDir).toBe(`/Users/me/.loop/runs/${storage.repoId}/7`);
  expect(storage.manifestPath).toBe(join(storage.runDir, "manifest.json"));
  expect(storage.transcriptPath).toBe(join(storage.runDir, "transcript.jsonl"));
});

test("resolveRunId prefers LOOP_RUN_ID over auto-incrementing storage", () => {
  const home = makeTempDir();
  const storageRoot = resolveStorageRoot(home);
  const repoId = "repo-abc123";
  const repoDir = join(storageRoot, repoId);
  mkdirSync(join(repoDir, "1"), { recursive: true });
  mkdirSync(join(repoDir, "2"), { recursive: true });

  const originalRunId = process.env.LOOP_RUN_ID;
  process.env.LOOP_RUN_ID = "19";
  try {
    expect(resolveRunId(storageRoot, repoId, process.env)).toBe("19");
  } finally {
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveRunId increments from the latest stored run", () => {
  const home = makeTempDir();
  const storageRoot = resolveStorageRoot(home);
  const repoId = "repo-abc123";
  const repoDir = join(storageRoot, repoId);
  mkdirSync(join(repoDir, "1"), { recursive: true });
  mkdirSync(join(repoDir, "3"), { recursive: true });

  const originalRunId = process.env.LOOP_RUN_ID;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
  try {
    expect(resolveRunId(storageRoot, repoId)).toBe("4");
  } finally {
    if (originalRunId === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
    } else {
      process.env.LOOP_RUN_ID = originalRunId;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("reserveRunStorage exclusively creates the next numeric run directory", () => {
  const home = makeTempDir();
  const cwd = join(home, "repo");
  mkdirSync(cwd);
  const runGit = () => ({ exitCode: 1, stderr: "", stdout: "" });
  const repoId = resolveRepoId(cwd, { runGit });
  const repoDir = join(resolveStorageRoot(home), repoId);
  mkdirSync(join(repoDir, "1"), { recursive: true });
  mkdirSync(join(repoDir, "3"));

  const reserved = reserveRunStorage(cwd, home, { runGit });

  expect(reserved.runId).toBe("4");
  expect(readFileSync(reserved.transcriptPath, "utf8")).toBe("");
  expect(readdirSync(repoDir).sort()).toEqual(["1", "3", "4"]);
  rmSync(home, { recursive: true, force: true });
});

test("competing processes reserve distinct numeric run directories", async () => {
  const home = makeTempDir();
  const cwd = join(home, "repo");
  const readyDir = join(home, "ready");
  const gatePath = join(home, "gate");
  mkdirSync(cwd);
  mkdirSync(readyDir);
  const moduleUrl = pathToFileURL(
    join(import.meta.dir, "../../src/loop/run-state.ts")
  ).href;
  const workerScript = [
    'import { existsSync, writeFileSync } from "node:fs";',
    "const moduleUrl = process.env.RUN_STATE_TEST_MODULE;",
    "const cwd = process.env.RUN_STATE_TEST_CWD;",
    "const home = process.env.RUN_STATE_TEST_HOME;",
    "const gate = process.env.RUN_STATE_TEST_GATE;",
    "const ready = process.env.RUN_STATE_TEST_READY;",
    'if (!(moduleUrl && cwd && home && gate && ready)) throw new Error("missing test inputs");',
    'writeFileSync(ready, "ready\\n");',
    "while (!existsSync(gate)) Bun.sleepSync(1);",
    "const { reserveRunStorage } = await import(moduleUrl);",
    "const storage = reserveRunStorage(cwd, home);",
    'process.stdout.write(storage.runId + "\\n");',
  ].join(" ");
  const children = Array.from({ length: 6 }, (_, index) =>
    spawn({
      cmd: [process.execPath, "-e", workerScript],
      env: {
        ...process.env,
        RUN_STATE_TEST_CWD: cwd,
        RUN_STATE_TEST_GATE: gatePath,
        RUN_STATE_TEST_HOME: home,
        RUN_STATE_TEST_MODULE: moduleUrl,
        RUN_STATE_TEST_READY: join(readyDir, String(index)),
      },
      stderr: "pipe",
      stdout: "pipe",
    })
  );

  try {
    const readyDeadline = Date.now() + 5000;
    while (readdirSync(readyDir).length < children.length) {
      if (Date.now() >= readyDeadline) {
        throw new Error("reservation workers did not reach the barrier");
      }
      await sleep(5);
    }
    writeFileSync(gatePath, "go\n", "utf8");

    const [outputs, errors, exitCodes] = await Promise.all([
      Promise.all(
        children.map(async (child) =>
          (await new Response(child.stdout).text()).trim()
        )
      ),
      Promise.all(
        children.map(async (child) =>
          (await new Response(child.stderr).text()).trim()
        )
      ),
      Promise.all(children.map(async (child) => child.exited)),
    ]);

    expect(errors).toEqual(Array.from({ length: children.length }, () => ""));
    expect(exitCodes).toEqual(Array.from({ length: children.length }, () => 0));
    expect(outputs.map(Number).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);

    const [repoDir] = readdirSync(resolveStorageRoot(home));
    expect(
      readdirSync(join(resolveStorageRoot(home), repoDir as string)).sort(
        (a, b) => Number(a) - Number(b)
      )
    ).toEqual(["1", "2", "3", "4", "5", "6"]);
  } finally {
    for (const child of children) {
      child.kill();
      await child.exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("manifest helpers write, read, and touch run metadata", () => {
  const dir = makeTempDir();
  const manifestPath = join(dir, "manifest.json");
  const manifest = createRunManifest(
    {
      cavemanMode: "lite",
      claudeSessionId: "claude-1",
      codexAppServerPid: 4321,
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-1",
      cwd: "/repo",
      driverEffort: "medium",
      helperCavemanMode: "full",
      launchAttemptId: "attempt-456",
      launchAttemptPid: 5678,
      launchClaimId: "claim-123",
      mode: "paired",
      pid: 1234,
      repoId: "repo-abc123",
      runId: "9",
      reviewerEffort: "high",
      sourceTaskSha256: "c".repeat(64),
      state: "working",
      tmuxPaneGoverness: "repo-loop-9:0.3",
      tmuxPaneLeft: "repo-loop-9:0.0",
      tmuxPaneLeftAgent: "cursor",
      tmuxPaneRight: "repo-loop-9:0.2",
      tmuxPaneRightAgent: "codex",
      tmuxPaneUtility: "repo-loop-9:0.1",
      tmuxSession: "repo-loop-9",
      workspaceBinding: {
        branchRef: "refs/heads/feature/run-state",
        repoId: "repo-abc123",
        root: "/repo",
      },
      worldModel: {
        capsuleSha256: "d".repeat(64),
        commitSha: "e".repeat(40),
        contextPath: join(dir, "world-model", "bootstrap.json"),
        contextSha256: "f".repeat(64),
        databasePath: join(dir, "world-model", "project.sqlite"),
        entityCount: 12,
        generatedAt: "2026-03-22T09:59:00.000Z",
        ontologyVersion: "0.1.0",
        seeds: ["src/entry.ts"],
        statementCount: 24,
      },
    },
    "2026-03-22T10:00:00.000Z"
  );
  manifest.launchCharters = {
    claude: {
      bytes: 8192,
      path: "/repo/.loop/runs/9/launch-charters/claude.md",
      sha256: "a".repeat(64),
    },
    codex: {
      bytes: 9216,
      path: "/repo/.loop/runs/9/launch-charters/codex.md",
      sha256: "b".repeat(64),
    },
  };

  writeRunManifest(manifestPath, manifest);
  const loaded = readRunManifest(manifestPath);
  const touched = touchRunManifest(manifest, "2026-03-22T11:00:00.000Z");

  expect(loaded).toEqual(manifest);
  expect(loaded).toMatchObject({
    cavemanMode: "lite",
    driverEffort: "medium",
    helperCavemanMode: "full",
    launchCharters: manifest.launchCharters,
    launchAttemptId: "attempt-456",
    launchAttemptPid: 5678,
    launchClaimId: "claim-123",
    reviewerEffort: "high",
    sourceTaskSha256: "c".repeat(64),
    workspaceBinding: {
      branchRef: "refs/heads/feature/run-state",
      repoId: "repo-abc123",
      root: "/repo",
    },
    worldModel: manifest.worldModel,
  });
  expect(touched.updatedAt).toBe("2026-03-22T11:00:00.000Z");
  expect(touched.createdAt).toBe(manifest.createdAt);
  rmSync(dir, { recursive: true, force: true });
});

test("manifest reader rejects an invalid World Model binding as a whole", () => {
  const dir = makeTempDir();
  const manifestPath = join(dir, "manifest.json");
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-abc123",
    runId: "9",
  });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      worldModel: {
        capsuleSha256: "a".repeat(64),
        commitSha: "b".repeat(40),
        contextPath: "relative/context.json",
        contextSha256: "c".repeat(64),
        databasePath: "/tmp/project.sqlite",
        entityCount: 10,
        generatedAt: "2026-03-22T09:59:00.000Z",
        ontologyVersion: "0.1.0",
        seeds: ["src/entry.ts"],
        statementCount: 20,
      },
    }),
    "utf8"
  );

  expect(readRunManifest(manifestPath)?.worldModel).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("createRunManifest rejects an invalid source task SHA-256", () => {
  expect(() =>
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-abc123",
      runId: "9",
      sourceTaskSha256: "not-a-sha",
    })
  ).toThrow("Invalid source task SHA-256");
});

test("manifest reader preserves legacy manifests without launch bindings", () => {
  const dir = makeTempDir();
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      created_at: "2026-03-22T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repo_id: "repo-abc123",
      run_id: "9",
      source_task_sha256: "invalid",
      status: "active",
      updated_at: "2026-03-22T11:00:00.000Z",
    }),
    "utf8"
  );

  expect(readRunManifest(manifestPath)).toEqual({
    claudeSessionId: "",
    codexThreadId: "",
    createdAt: "2026-03-22T10:00:00.000Z",
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-abc123",
    runId: "9",
    state: "working",
    status: "running",
    updatedAt: "2026-03-22T11:00:00.000Z",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("writeRunManifest atomically replaces a complete manifest", () => {
  const dir = makeTempDir();
  const manifestPath = join(dir, "manifest.json");
  const manifest = createRunManifest(
    {
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-abc123",
      runId: "9",
    },
    "2026-03-22T10:00:00.000Z"
  );
  writeRunManifest(manifestPath, manifest);
  const originalInode = statSync(manifestPath).ino;
  const next = touchRunManifest(manifest, "2026-03-22T11:00:00.000Z");

  writeRunManifest(manifestPath, next);

  expect(statSync(manifestPath).ino).not.toBe(originalInode);
  expect(readRunManifest(manifestPath)).toEqual(next);
  expect(readdirSync(dir)).toEqual(["manifest.json"]);
  rmSync(dir, { recursive: true, force: true });
});

test("writeRunManifest removes its temporary file when rename fails", () => {
  const dir = makeTempDir();
  const manifestPath = join(dir, "manifest.json");
  mkdirSync(manifestPath);
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo-abc123",
    runId: "9",
  });

  expect(() => writeRunManifest(manifestPath, manifest)).toThrow();
  expect(
    readdirSync(dir).filter((name) => name.startsWith(".manifest.json."))
  ).toEqual([]);
  expect(statSync(manifestPath).isDirectory()).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("manifest reader ignores malformed files", () => {
  const dir = makeTempDir();
  const path = join(dir, "manifest.json");
  writeFileSync(path, "{not json}", "utf8");

  expect(readRunManifest(path)).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("loadRunState resolves an existing run by run id", () => {
  const home = makeTempDir();
  const runGit = (args: string[]) =>
    args.includes("--git-common-dir")
      ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
      : { exitCode: 0, stderr: "", stdout: "" };
  const repoId = resolveRepoId("/repo/worktree", { runGit });
  const runDir = join(home, ".loop", "runs", repoId, "7");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      claude_session_id: "claude-1",
      codex_thread_id: "codex-1",
      created_at: "2026-03-22T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: "1234",
      repo_id: repoId,
      run_id: "7",
      status: "active",
      updated_at: "2026-03-22T11:00:00.000Z",
    })
  );
  writeFileSync(
    join(runDir, "transcript.jsonl"),
    `${JSON.stringify({
      at: "2026-03-22T10:01:00.000Z",
      from: "claude",
      message: "hello",
      to: "codex",
    })}\n`
  );

  const state = loadRunState("7", "/repo/worktree", home, { runGit });

  expect(state.storage.runDir).toBe(runDir);
  expect(state.manifest).toEqual({
    claudeSessionId: "claude-1",
    codexThreadId: "codex-1",
    createdAt: "2026-03-22T10:00:00.000Z",
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId,
    runId: "7",
    state: "working",
    status: "running",
    updatedAt: "2026-03-22T11:00:00.000Z",
  });
  expect(state.transcript).toEqual([
    {
      at: "2026-03-22T10:01:00.000Z",
      from: "claude",
      message: "hello",
      to: "codex",
    },
  ]);

  rmSync(home, { recursive: true, force: true });
});

test("resolveExistingRunId returns a matching stored run id", () => {
  const home = makeTempDir();
  const runGit = (args: string[]) =>
    args.includes("--git-common-dir")
      ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
      : { exitCode: 0, stderr: "", stdout: "" };
  const repoId = resolveRepoId("/repo/worktree", { runGit });
  const runDir = join(home, ".loop", "runs", repoId, "alpha");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      created_at: "2026-03-22T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repo_id: repoId,
      run_id: "alpha",
      status: "active",
      updated_at: "2026-03-22T11:00:00.000Z",
    })
  );

  expect(
    resolveExistingRunId("alpha", "/repo/worktree", home, { runGit })
  ).toBe("alpha");
  expect(
    resolveExistingRunId("missing", "/repo/worktree", home, { runGit })
  ).toBe(undefined);
  expect(
    resolveExistingRunId("../oops", "/repo/worktree", home, { runGit })
  ).toBe(undefined);

  rmSync(home, { recursive: true, force: true });
});

test("resolveExistingRunId matches stored Claude and Codex session ids", () => {
  const home = makeTempDir();
  const runGit = (args: string[]) =>
    args.includes("--git-common-dir")
      ? { exitCode: 0, stderr: "", stdout: "/repo/.git\n" }
      : { exitCode: 0, stderr: "", stdout: "" };
  const repoId = resolveRepoId("/repo/worktree", { runGit });
  const runDir = join(home, ".loop", "runs", repoId, "alpha");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      claude_session_id: "claude-session-1",
      codex_thread_id: "codex-thread-1",
      created_at: "2026-03-22T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repo_id: repoId,
      run_id: "alpha",
      status: "active",
      updated_at: "2026-03-22T11:00:00.000Z",
    })
  );

  expect(
    resolveExistingRunId("claude-session-1", "/repo/worktree", home, {
      runGit,
    })
  ).toBe("alpha");
  expect(
    resolveExistingRunId("codex-thread-1", "/repo/worktree", home, {
      runGit,
    })
  ).toBe("alpha");

  rmSync(home, { recursive: true, force: true });
});

test("transcript helpers append and read jsonl entries", () => {
  const dir = makeTempDir();
  const transcriptPath = join(dir, "transcript.jsonl");
  const first = createRunTranscriptEntry(
    "claude",
    "hello",
    "codex",
    "2026-03-22T10:00:00.000Z"
  );
  const second = createRunTranscriptEntry(
    "codex",
    "hi",
    "claude",
    "2026-03-22T10:01:00.000Z"
  );

  appendRunTranscriptEntry(transcriptPath, first);
  appendRunTranscriptEntry(transcriptPath, second);

  expect(readRunTranscriptEntries(transcriptPath)).toEqual([first, second]);
  expect(readFileSync(transcriptPath, "utf8")).toContain('"from":"claude"');
  rmSync(dir, { recursive: true, force: true });
});

test("transcript helpers parse structured status, review, and result entries", () => {
  const dir = makeTempDir();
  const transcriptPath = join(dir, "transcript.jsonl");
  const entries = [
    createRunStatusEntry(
      "working",
      "paired sessions ready",
      "2026-03-22T10:00:00.000Z"
    ),
    createRunReviewEntry(
      "codex",
      "fail",
      "Needs one more test.",
      "2026-03-22T10:01:00.000Z"
    ),
    createRunResultEntry(
      "done-signal-detected",
      "<done/>",
      "2026-03-22T10:02:00.000Z"
    ),
  ];

  for (const entry of entries) {
    appendRunTranscriptEntry(transcriptPath, entry);
  }

  expect(readRunTranscriptEntries(transcriptPath)).toEqual(entries);
  rmSync(dir, { recursive: true, force: true });
});

test("structured transcript entries round-trip without undefined optional fields", () => {
  const dir = makeTempDir();
  const transcriptPath = join(dir, "transcript.jsonl");
  const entries = [
    createRunStatusEntry("working", undefined, "2026-03-22T10:00:00.000Z"),
    createRunReviewEntry(
      "codex",
      "pass",
      undefined,
      "2026-03-22T10:01:00.000Z"
    ),
    createRunResultEntry("stopped", undefined, "2026-03-22T10:02:00.000Z"),
  ];

  for (const entry of entries) {
    appendRunTranscriptEntry(transcriptPath, entry);
  }

  expect(readRunTranscriptEntries(transcriptPath)).toEqual(entries);
  rmSync(dir, { recursive: true, force: true });
});

test("run ids are validated before storage paths are built", () => {
  expect(() => buildRunDir("/tmp", "repo", "../oops")).toThrow(
    "Invalid run id"
  );
  expect(() => buildRunDir("/tmp", "repo", "foo..bar")).toThrow(
    "Invalid run id"
  );
});

test("manifest revision hashes the exact validated persisted bytes", () => {
  const dir = makeTempDir();
  const manifestPath = join(dir, "manifest.json");
  const manifest = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 42,
    repoId: "repo-abc123",
    resolvedConfig: {
      governess: false,
      pairedMode: true,
      proofConfigured: true,
      review: "claudex",
      reviewPlan: "other",
      tmux: true,
      version: 1,
      worktree: false,
    },
    runId: "revision-proof",
    tmuxAdapterIdentity: {
      processBirthId: "darwin:1787693386000",
      serverPid: 4242,
      socketPath: "/private/tmp/tmux-501/default",
      version: 1,
    },
  });

  writeRunManifest(manifestPath, manifest);
  const bytes = readFileSync(manifestPath);
  const read = readRunManifest(manifestPath);

  expect(read?.manifestRevision).toBe(
    createHash("sha256").update(bytes).digest("hex")
  );
  expect(JSON.parse(bytes.toString("utf8"))).not.toHaveProperty(
    "manifestRevision"
  );
  expect(read?.tmuxAdapterIdentity).toEqual(manifest.tmuxAdapterIdentity);
  expect(read?.resolvedConfig).toEqual(manifest.resolvedConfig);
  expect(Object.isFrozen(read?.resolvedConfig)).toBe(true);
  const updated = updateRunManifest(manifestPath, (current) =>
    current ? { ...current, updatedAt: "2026-08-25T22:00:00.000Z" } : undefined
  );
  expect(updated?.manifestRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(updated?.manifestRevision).not.toBe(read?.manifestRevision);
  rmSync(dir, { recursive: true, force: true });
});

test("manifest reader fails closed on invalid UTF-8 and new-field schema", () => {
  const dir = makeTempDir();
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, Buffer.from([0xc3, 0x28]));
  expect(readRunManifest(manifestPath)).toBeUndefined();

  const base = createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 42,
    repoId: "repo-abc123",
    runId: "strict-schema",
  });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      ...base,
      tmuxAdapterIdentity: {
        processBirthId: "darwin:0",
        serverPid: 0,
        socketPath: "relative.sock",
        version: 1,
      },
    })}\n`,
    "utf8"
  );
  expect(readRunManifest(manifestPath)).toBeUndefined();

  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      ...base,
      tmuxAdapterIdentity: {
        hiddenPayload: "not allowed",
        processBirthId: "darwin:1787693386000",
        serverPid: 4242,
        socketPath: "/tmp/server.sock",
        version: 1,
      },
    })}\n`,
    "utf8"
  );
  expect(readRunManifest(manifestPath)).toBeUndefined();

  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      ...base,
      resolvedConfig: {
        proofConfigured: false,
        secretPath: "/tmp/private",
        version: 1,
      },
    })}\n`,
    "utf8"
  );
  expect(readRunManifest(manifestPath)).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("legacy manifests keep adapter identity and resolved config unknown", () => {
  const dir = makeTempDir();
  const manifestPath = join(dir, "manifest.json");
  writeRunManifest(
    manifestPath,
    createRunManifest({
      cwd: "/repo",
      mode: "paired",
      pid: 42,
      repoId: "repo-abc123",
      runId: "legacy-unknown",
    })
  );

  const read = readRunManifest(manifestPath);
  expect(read?.tmuxAdapterIdentity).toBeUndefined();
  expect(read?.resolvedConfig).toBeUndefined();
  expect(read?.manifestRevision).toMatch(/^[a-f0-9]{64}$/);
  rmSync(dir, { recursive: true, force: true });
});
