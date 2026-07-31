import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "bun";
import { runGit } from "../../src/loop/git";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  applyUtilityJobPatch,
  processPendingUtilityRoutes,
  runUtilityWorker,
} from "../../src/loop/utility-runtime";
import {
  appendUtilityRouteRequest,
  claimUtilityJob,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";
import { createUtilityToolBroker } from "../../src/loop/utility-tools";
import {
  resolveUtilityRequestWorkspace,
  resolveVerifiedUtilityWorkspaceRoot,
} from "../../src/loop/utility-workspace";

const requireGit = (cwd: string, args: string[]): void => {
  const result = runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
};

const workspaceFixture = (): {
  base: string;
  linkedA: string;
  linkedB: string;
  root: string;
  unrelated: string;
} => {
  const root = mkdtempSync(join(tmpdir(), "loop-utility-worktree-"));
  const base = join(root, "base");
  const linkedA = join(root, "linked-a");
  const linkedB = join(root, "linked-b");
  const unrelated = join(root, "unrelated");
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "sample.ts"), "base checkout\n");
  writeFileSync(join(base, "src", "check.js"), "const ready = true;\n");
  requireGit(base, ["init"]);
  requireGit(base, ["config", "user.email", "utility@example.test"]);
  requireGit(base, ["config", "user.name", "Utility Test"]);
  requireGit(base, ["add", "src/sample.ts", "src/check.js"]);
  requireGit(base, ["commit", "-m", "fixture"]);
  requireGit(base, ["worktree", "add", "-b", "linked-a", linkedA]);
  requireGit(base, ["worktree", "add", "-b", "linked-b", linkedB]);
  writeFileSync(join(linkedA, "src", "sample.ts"), "active linked checkout\n");

  mkdirSync(join(unrelated, "src"), { recursive: true });
  writeFileSync(join(unrelated, "src", "sample.ts"), "unrelated\n");
  requireGit(unrelated, ["init"]);
  requireGit(unrelated, ["config", "user.email", "utility@example.test"]);
  requireGit(unrelated, ["config", "user.name", "Utility Test"]);
  requireGit(unrelated, ["add", "src/sample.ts"]);
  requireGit(unrelated, ["commit", "-m", "fixture"]);
  return { base, linkedA, linkedB, root, unrelated };
};

const requestFor = (
  id: string,
  readScope: string[],
  executionCwd?: string,
  executionRead?: {
    endLine?: number;
    lastLines?: number;
    path: string;
    startLine?: number;
  },
  workspaceRoot?: string
) =>
  createUtilityRouteRequest({
    acceptanceCriteria: ["report the file contents"],
    authority: {},
    ...(executionCwd ? { executionCwd } : {}),
    ...(executionRead
      ? { executionProfile: "file-read" as const, executionRead }
      : {}),
    id,
    idempotencyKey: id,
    kind: "inspect",
    objective: "Inspect the bounded sample file",
    readScope,
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    ...(workspaceRoot ? { workspaceRoot } : {}),
    writeScope: [],
  });

const editRequestFor = (id: string, path: string, workspaceRoot?: string) =>
  createUtilityRouteRequest({
    acceptanceCriteria: ["propose one bounded patch"],
    authority: {},
    id,
    idempotencyKey: id,
    kind: "edit",
    objective: "Edit the bounded sample file",
    readScope: [path],
    requester: "claude",
    requiredCapabilities: ["inspect", "scoped-edit"],
    risk: "low",
    ...(workspaceRoot ? { workspaceRoot } : {}),
    writeScope: [path],
  });

test("linked worktree scopes resolve to one root-relative verified workspace", () => {
  const fixture = workspaceFixture();
  try {
    const resolution = resolveUtilityRequestWorkspace(
      requestFor("linked", [join(fixture.linkedA, "src", "sample.ts")]),
      fixture.base
    );
    expect(resolution).toMatchObject({
      request: { readScope: ["src/sample.ts"] },
      workspace: {
        readScope: ["src/sample.ts"],
        root: realpathSync(fixture.linkedA),
        writeScope: [],
      },
    });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("explicit workspace root binds relative scopes to the exact linked worktree", () => {
  const fixture = workspaceFixture();
  try {
    const linkedRoot = realpathSync(fixture.linkedA);
    expect(
      resolveUtilityRequestWorkspace(
        requestFor(
          "explicit-linked",
          ["src/sample.ts"],
          undefined,
          undefined,
          linkedRoot
        ),
        fixture.base
      )
    ).toMatchObject({
      request: {
        readScope: ["src/sample.ts"],
        workspaceRoot: linkedRoot,
      },
      workspace: {
        readScope: ["src/sample.ts"],
        root: linkedRoot,
        writeScope: [],
      },
    });
    expect(
      resolveUtilityRequestWorkspace(
        editRequestFor("explicit-new-file", "src/new-file.ts", linkedRoot),
        fixture.base
      )
    ).toMatchObject({
      request: {
        readScope: ["src/new-file.ts"],
        writeScope: ["src/new-file.ts"],
        workspaceRoot: linkedRoot,
      },
      workspace: {
        root: linkedRoot,
        writeScope: ["src/new-file.ts"],
      },
    });
    expect(
      resolveUtilityRequestWorkspace(
        requestFor(
          "explicit-run-root",
          ["src/sample.ts"],
          undefined,
          undefined,
          realpathSync(fixture.base)
        ),
        fixture.base
      )
    ).toMatchObject({ workspace: { root: realpathSync(fixture.base) } });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("explicit workspace root rejects aliases and roots outside the registered set", () => {
  const fixture = workspaceFixture();
  const alias = join(fixture.root, "linked-alias");
  const unregistered = join(fixture.root, "unregistered");
  try {
    mkdirSync(unregistered);
    symlinkSync(realpathSync(fixture.linkedA), alias);
    for (const [id, workspaceRoot] of [
      ["unrelated-root", realpathSync(fixture.unrelated)],
      ["unregistered-root", realpathSync(unregistered)],
      ["aliased-root", alias],
      ["worktree-subdirectory", realpathSync(join(fixture.linkedA, "src"))],
    ] as const) {
      expect(
        resolveUtilityRequestWorkspace(
          requestFor(
            id,
            ["src/sample.ts"],
            undefined,
            undefined,
            workspaceRoot
          ),
          fixture.base
        )
      ).toEqual({
        detail:
          "workspace_root must name the exact canonical run root or an exact registered worktree of the run repository",
        reason: "workspace-unverified",
      });
    }
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("explicit workspace root rejects absolute and symlinked packet paths", () => {
  const fixture = workspaceFixture();
  try {
    const linkedRoot = realpathSync(fixture.linkedA);
    const absoluteFile = join(linkedRoot, "src", "sample.ts");
    const escaped = join(linkedRoot, "linked-src");
    symlinkSync(realpathSync(join(fixture.unrelated, "src")), escaped);
    const requests = [
      requestFor(
        "absolute-read-scope",
        [absoluteFile],
        undefined,
        undefined,
        linkedRoot
      ),
      requestFor(
        "absolute-execution-read",
        ["src/sample.ts"],
        undefined,
        { endLine: 1, path: absoluteFile, startLine: 1 },
        linkedRoot
      ),
      createUtilityRouteRequest({
        acceptanceCriteria: ["the exact syntax check passes"],
        authority: {},
        executionArgv: ["node", "--check", absoluteFile],
        executionCwd: ".",
        executionProfile: "focused-check",
        id: "absolute-execution-argv",
        idempotencyKey: "absolute-execution-argv",
        kind: "command",
        objective: "Run the exact linked-worktree syntax check",
        readScope: [".", "src/sample.ts"],
        requester: "claude",
        requiredCapabilities: ["bounded-command", "focused-verify"],
        risk: "low",
        workspaceRoot: linkedRoot,
        writeScope: [],
      }),
      editRequestFor("symlink-parent", "linked-src/new-file.ts", linkedRoot),
    ];
    for (const request of requests) {
      expect(resolveUtilityRequestWorkspace(request, fixture.base)).toEqual({
        detail:
          "workspace_root requires every packet path to be repo-relative, symlink-free, and contained beneath the selected root",
        reason: "workspace-unverified",
      });
    }
    expect(
      resolveUtilityRequestWorkspace(
        editRequestFor("directory-write", "src", linkedRoot),
        fixture.base
      )
    ).toEqual({
      detail:
        "edit scopes must name exact regular files under the selected workspace; relative scopes bind to the run root unless workspace_root selects a registered linked worktree",
      reason: "workspace-unverified",
    });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("edit workspace resolution accepts files and rejects directory-wide scope", () => {
  const fixture = workspaceFixture();
  try {
    expect(
      resolveUtilityRequestWorkspace(
        editRequestFor("directory-write", "src"),
        fixture.base
      )
    ).toEqual({
      detail:
        "edit scopes must name exact regular files under the selected workspace; relative scopes bind to the run root unless workspace_root selects a registered linked worktree",
      reason: "workspace-unverified",
    });
    expect(
      resolveUtilityRequestWorkspace(
        {
          ...editRequestFor("directory-read", "src/sample.ts"),
          readScope: ["src", "src/sample.ts"],
        },
        fixture.base
      )
    ).toEqual({
      detail:
        "edit scopes must name exact regular files under the selected workspace; relative scopes bind to the run root unless workspace_root selects a registered linked worktree",
      reason: "workspace-unverified",
    });
    expect(
      resolveUtilityRequestWorkspace(
        editRequestFor("new-file", "src/new-file.ts"),
        fixture.base
      )
    ).toMatchObject({
      request: {
        readScope: ["src/new-file.ts"],
        writeScope: ["src/new-file.ts"],
      },
      workspace: { root: realpathSync(fixture.base) },
    });
    mkdirSync(join(fixture.unrelated, "src", "nested"));
    symlinkSync(
      join(fixture.unrelated, "src"),
      join(fixture.base, "linked-src")
    );
    for (const [id, path] of [
      ["symlink-existing", "linked-src/sample.ts"],
      ["symlink-parent", "linked-src/nested/new-file.ts"],
    ] as const) {
      expect(
        resolveUtilityRequestWorkspace(editRequestFor(id, path), fixture.base)
      ).toEqual({
        detail:
          "edit scopes must name exact regular files under the selected workspace; relative scopes bind to the run root unless workspace_root selects a registered linked worktree",
        reason: "workspace-unverified",
      });
    }
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("linked focused-check cwd and argv resolve and execute in the verified workspace", async () => {
  const fixture = workspaceFixture();
  try {
    const linkedRoot = realpathSync(fixture.linkedA);
    const absoluteFile = join(linkedRoot, "src", "check.js");
    const request = createUtilityRouteRequest({
      acceptanceCriteria: ["the exact syntax check passes"],
      authority: {},
      executionArgv: ["node", "--check", absoluteFile],
      executionCwd: linkedRoot,
      executionProfile: "focused-check",
      id: "linked-cwd",
      idempotencyKey: "linked-cwd",
      kind: "command",
      objective: "Run the exact linked-worktree syntax check",
      readScope: [linkedRoot, absoluteFile],
      requester: "claude",
      requiredCapabilities: ["bounded-command", "focused-verify"],
      risk: "low",
      writeScope: [],
    });
    const resolution = resolveUtilityRequestWorkspace(request, fixture.base);
    expect(resolution).toMatchObject({
      request: {
        executionArgv: ["node", "--check", "src/check.js"],
        executionCwd: ".",
        readScope: [".", "src/check.js"],
      },
      workspace: {
        executionArgv: ["node", "--check", "src/check.js"],
        executionCwd: ".",
        readScope: [".", "src/check.js"],
        root: linkedRoot,
      },
    });
    if (!("workspace" in resolution && resolution.workspace)) {
      throw new Error("expected verified linked workspace");
    }
    const broker = await createUtilityToolBroker({
      allowedTools: ["run_check"],
      artifactDir: ".utility-artifacts",
      commandCwds: [resolution.workspace.executionCwd ?? ""],
      exactCommand: resolution.workspace.executionArgv,
      readScopes: ["src/check.js"],
      repoRoot: resolution.workspace.root,
      writeScopes: [],
    });
    expect(
      await broker.execute({
        arguments: {
          argv: ["node", "--check", "src/check.js"],
          cwd: ".",
        },
        name: "run_check",
      })
    ).toMatchObject({ exitCode: 0, ok: true });

    const runDir = join(fixture.base, ".loop", "runs", "linked-command");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify({ cwd: fixture.base })
    );
    appendUtilityRouteRequest(runDir, request);
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 51,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_HARNESS: "pi-sdk",
      },
      { spawnWorker: () => true }
    );
    expect(readUtilityJob(runDir, request.id)?.decision).toMatchObject({
      target: "utility",
      tierId: "utility-direct",
      workspace: {
        executionArgv: ["node", "--check", "src/check.js"],
        executionCwd: ".",
        root: linkedRoot,
      },
    });
    await runUtilityWorker(runDir, 51, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: { status: "completed" },
      state: "completed",
    });
    expect(
      readFileSync(join(runDir, "utility", "tool-events.jsonl"), "utf8")
    ).toContain('"exitCode":0');
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("linked exact read range resolves with the same verified workspace", () => {
  const fixture = workspaceFixture();
  const file = join(fixture.linkedA, "src", "sample.ts");
  try {
    const resolution = resolveUtilityRequestWorkspace(
      requestFor("linked-read", [file], undefined, {
        endLine: 20,
        path: file,
        startLine: 1,
      }),
      fixture.base
    );
    expect(resolution).toMatchObject({
      request: {
        executionRead: {
          endLine: 20,
          path: "src/sample.ts",
          startLine: 1,
        },
      },
      workspace: {
        executionRead: {
          endLine: 20,
          path: "src/sample.ts",
          startLine: 1,
        },
        root: realpathSync(fixture.linkedA),
      },
    });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("linked structured read plan preserves every stage boundary", () => {
  const fixture = workspaceFixture();
  const file = join(fixture.linkedA, "src", "sample.ts");
  const directory = join(fixture.linkedA, "src");
  try {
    const request = createUtilityRouteRequest({
      acceptanceCriteria: ["report both bounded stages"],
      authority: {},
      executionPlan: [
        {
          executionOutput: { lineLimit: 1, position: "head" },
          executionProfile: "file-read",
          executionRead: { endLine: 20, path: file, startLine: 1 },
          objective: "Read the sample",
          readScope: [file],
        },
        {
          executionProfile: "file-list",
          objective: "List source",
          readScope: [directory],
        },
      ],
      executionProfile: "read-plan",
      id: "linked-plan",
      idempotencyKey: "linked-plan",
      kind: "inspect",
      objective: "Run the bounded read plan",
      readScope: [file, directory],
      requester: "claude",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    const resolution = resolveUtilityRequestWorkspace(request, fixture.base);
    expect(resolution).toMatchObject({
      request: {
        executionPlan: [
          {
            executionOutput: { lineLimit: 1, position: "head" },
            executionProfile: "file-read",
            executionRead: {
              endLine: 20,
              path: "src/sample.ts",
              startLine: 1,
            },
            readScope: ["src/sample.ts"],
          },
          { executionProfile: "file-list", readScope: ["src"] },
        ],
      },
      workspace: {
        executionPlan: [
          {
            executionRead: { path: "src/sample.ts" },
            readScope: ["src/sample.ts"],
          },
          { readScope: ["src"] },
        ],
        root: realpathSync(fixture.linkedA),
      },
    });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("active paths resolve only to the run root or a registered linked worktree", () => {
  const fixture = workspaceFixture();
  try {
    expect(
      resolveVerifiedUtilityWorkspaceRoot(
        fixture.base,
        join(fixture.base, "src")
      )
    ).toBe(realpathSync(fixture.base));
    expect(
      resolveVerifiedUtilityWorkspaceRoot(
        fixture.base,
        join(fixture.linkedA, "src")
      )
    ).toBe(realpathSync(fixture.linkedA));
    expect(
      resolveVerifiedUtilityWorkspaceRoot(
        fixture.base,
        join(fixture.unrelated, "src")
      )
    ).toBeUndefined();
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("unrelated, mixed-worktree, and symlink escape scopes fail closed", () => {
  const fixture = workspaceFixture();
  try {
    const cases = [
      [join(fixture.unrelated, "src", "sample.ts")],
      ["src/sample.ts", join(fixture.linkedA, "src", "sample.ts")],
      [
        join(fixture.linkedA, "src", "sample.ts"),
        join(fixture.linkedB, "src", "sample.ts"),
      ],
    ];
    const escapeLink = join(fixture.linkedA, "escape");
    symlinkSync(fixture.unrelated, escapeLink);
    cases.push([join(escapeLink, "src", "sample.ts")]);
    for (const [index, readScope] of cases.entries()) {
      expect(
        resolveUtilityRequestWorkspace(
          requestFor(`rejected-${index}`, readScope),
          fixture.base
        )
      ).toEqual({
        detail:
          "scopes do not resolve to one verified worktree of the run repository",
        reason: "workspace-unverified",
      });
    }
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("a copied linked-worktree gitdir pointer cannot spoof registration", () => {
  const fixture = workspaceFixture();
  const fake = join(fixture.root, "fake-worktree");
  try {
    mkdirSync(join(fake, "src"), { recursive: true });
    writeFileSync(
      join(fake, ".git"),
      readFileSync(join(fixture.linkedA, ".git"))
    );
    writeFileSync(join(fake, "src", "sample.ts"), "spoofed checkout\n");
    expect(
      resolveUtilityRequestWorkspace(
        requestFor("spoofed", [join(fake, "src", "sample.ts")]),
        fixture.base
      )
    ).toEqual({
      detail:
        "scopes do not resolve to one verified worktree of the run repository",
      reason: "workspace-unverified",
    });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("a registered worktree path replaced by a symlink cannot register its target", async () => {
  const fixture = workspaceFixture();
  const linkedRoot = realpathSync(fixture.linkedA);
  const fake = join(fixture.root, "replacement-fake-worktree");
  const runDir = join(fixture.base, ".loop", "runs", "replacement-fake");
  const gitPointer = readFileSync(join(linkedRoot, ".git"));
  try {
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(fake, "src"), { recursive: true });
    writeFileSync(join(fake, ".git"), gitPointer);
    writeFileSync(join(fake, "src", "sample.ts"), "replacement spoof\n");
    const fakeRoot = realpathSync(fake);
    rmSync(linkedRoot, { force: true, recursive: true });
    symlinkSync(fakeRoot, linkedRoot);
    expect(
      resolveVerifiedUtilityWorkspaceRoot(
        fixture.base,
        join(fakeRoot, "src", "sample.ts")
      )
    ).toBeUndefined();

    const requests = [
      requestFor("replacement-legacy", [join(fakeRoot, "src", "sample.ts")]),
      requestFor(
        "replacement-explicit",
        ["src/sample.ts"],
        undefined,
        undefined,
        fakeRoot
      ),
    ];
    for (const request of requests) {
      expect(
        resolveUtilityRequestWorkspace(request, fixture.base)
      ).toMatchObject({
        reason: "workspace-unverified",
      });
      appendUtilityRouteRequest(runDir, request);
    }
    let spawnCalls = 0;
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 59,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        spawnWorker: () => {
          spawnCalls += 1;
          return true;
        },
      }
    );
    expect(spawnCalls).toBe(0);
    for (const request of requests) {
      expect(readUtilityJob(runDir, request.id)).toMatchObject({
        decision: { reason: "workspace-unverified", target: "driver" },
        state: "routed-driver",
      });
    }
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("dangling final and parent symlinks are not treated as missing edit targets", () => {
  const fixture = workspaceFixture();
  const runRoot = realpathSync(fixture.base);
  try {
    symlinkSync(
      join(fixture.root, "absent-final-target"),
      join(runRoot, "src", "dangling-final.ts")
    );
    symlinkSync(
      join(fixture.root, "absent-parent-target"),
      join(runRoot, "src", "dangling-parent")
    );
    for (const request of [
      editRequestFor("dangling-final-legacy", "src/dangling-final.ts"),
      editRequestFor(
        "dangling-final-explicit",
        "src/dangling-final.ts",
        runRoot
      ),
      editRequestFor(
        "dangling-parent-legacy",
        "src/dangling-parent/new-file.ts"
      ),
      editRequestFor(
        "dangling-parent-explicit",
        "src/dangling-parent/new-file.ts",
        runRoot
      ),
    ]) {
      expect(
        resolveUtilityRequestWorkspace(request, fixture.base)
      ).toMatchObject({
        reason: "workspace-unverified",
      });
    }
    expect(
      resolveUtilityRequestWorkspace(
        editRequestFor("genuine-missing-legacy", "src/genuine-missing.ts"),
        fixture.base
      )
    ).toMatchObject({ workspace: { root: runRoot } });
    expect(
      resolveUtilityRequestWorkspace(
        editRequestFor(
          "genuine-missing-explicit",
          "src/genuine-explicit.ts",
          runRoot
        ),
        fixture.base
      )
    ).toMatchObject({ workspace: { root: runRoot } });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("runtime returns an unverified explicit root without spawning utility", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "mismatch");
  mkdirSync(runDir, { recursive: true });
  const request = requestFor(
    "mismatch",
    ["src/sample.ts"],
    undefined,
    undefined,
    realpathSync(fixture.unrelated)
  );
  appendUtilityRouteRequest(runDir, request);
  let spawnCalls = 0;
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 46,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        spawnWorker: () => {
          spawnCalls += 1;
          return true;
        },
      }
    );
    expect(spawnCalls).toBe(0);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      decision: {
        detail:
          "workspace_root must name the exact canonical run root or an exact registered worktree of the run repository",
        reason: "workspace-unverified",
        target: "driver",
      },
      state: "routed-driver",
    });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("run-102 replay needs an explicit root before linked relative edit scopes route", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "run-102-replay");
  const linkedRoot = realpathSync(fixture.linkedA);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(linkedRoot, "src", "linked-context.ts"),
    "export const linkedContext = true;\n"
  );
  const replayRequest = (id: string, workspaceRoot?: string) =>
    createUtilityRouteRequest({
      acceptanceCriteria: ["propose the exact linked-worktree file"],
      authority: {},
      id,
      idempotencyKey: id,
      kind: "edit",
      objective: "Add the bounded linked-worktree target",
      readScope: ["src/linked-context.ts", "src/generated.ts"],
      requester: "claude",
      requiredCapabilities: ["inspect", "scoped-edit"],
      risk: "low",
      ...(workspaceRoot ? { workspaceRoot } : {}),
      writeScope: ["src/generated.ts"],
    });
  const omitted = replayRequest("run-102-omitted");
  const explicit = replayRequest("run-102-explicit", linkedRoot);
  appendUtilityRouteRequest(runDir, omitted);
  appendUtilityRouteRequest(runDir, explicit);
  let spawnCalls = 0;
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 54,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        spawnWorker: () => {
          spawnCalls += 1;
          return true;
        },
      }
    );
    expect(spawnCalls).toBe(1);
    expect(readUtilityJob(runDir, omitted.id)).toMatchObject({
      decision: {
        detail:
          "edit scopes must name exact regular files under the selected workspace; relative scopes bind to the run root unless workspace_root selects a registered linked worktree",
        reason: "workspace-unverified",
        target: "driver",
      },
      state: "routed-driver",
    });
    expect(readUtilityJob(runDir, explicit.id)).toMatchObject({
      decision: {
        reason: "utility-eligible",
        target: "utility",
        workspace: {
          readScope: ["src/linked-context.ts", "src/generated.ts"],
          root: linkedRoot,
          writeScope: ["src/generated.ts"],
        },
      },
      state: "routed-utility",
    });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("protected paths keep their protected-scope reason under a valid explicit root", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "explicit-protected");
  const linkedRoot = realpathSync(fixture.linkedA);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(linkedRoot, ".env"));
  symlinkSync(
    join(fixture.root, "absent-protected-target"),
    join(linkedRoot, ".env.local")
  );
  const exactFileFailure = editRequestFor(
    "explicit-protected-exact",
    ".env",
    linkedRoot
  );
  const normalizationFailure = editRequestFor(
    "explicit-protected-normalization",
    ".env.local",
    linkedRoot
  );
  expect(
    resolveUtilityRequestWorkspace(exactFileFailure, fixture.base)
  ).toEqual({
    detail:
      "edit scopes must name exact regular files under the selected workspace; relative scopes bind to the run root unless workspace_root selects a registered linked worktree",
    reason: "protected-scope",
  });
  expect(
    resolveUtilityRequestWorkspace(normalizationFailure, fixture.base)
  ).toEqual({
    detail:
      "workspace_root requires every packet path to be repo-relative, symlink-free, and contained beneath the selected root",
    reason: "protected-scope",
  });
  appendUtilityRouteRequest(runDir, exactFileFailure);
  appendUtilityRouteRequest(runDir, normalizationFailure);
  let spawnCalls = 0;
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 55,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        spawnWorker: () => {
          spawnCalls += 1;
          return true;
        },
      }
    );
    expect(spawnCalls).toBe(0);
    for (const request of [exactFileFailure, normalizationFailure]) {
      expect(readUtilityJob(runDir, request.id)).toMatchObject({
        decision: { reason: "protected-scope", target: "driver" },
        state: "routed-driver",
      });
    }
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("an invalid alias to an in-root protected target keeps protected-scope", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "protected-alias");
  const runRoot = realpathSync(fixture.base);
  const protectedTarget = join(runRoot, ".git", "hooks", "pre-commit.sample");
  mkdirSync(join(runRoot, ".git", "hooks"), { recursive: true });
  writeFileSync(protectedTarget, "#!/bin/sh\nexit 0\n");
  symlinkSync(protectedTarget, join(runRoot, "src", "hidden-hook"));
  symlinkSync(
    join(runRoot, "src", "sample.ts"),
    join(runRoot, "src", "sample-alias.ts")
  );
  mkdirSync(runDir, { recursive: true });

  const topLevel = requestFor(
    "protected-alias-top-level",
    ["src/hidden-hook"],
    undefined,
    undefined,
    runRoot
  );
  const exactRead = requestFor(
    "protected-alias-execution-read",
    ["src/sample.ts"],
    undefined,
    { endLine: 1, path: "src/hidden-hook", startLine: 1 },
    runRoot
  );
  const readPlan = createUtilityRouteRequest({
    acceptanceCriteria: ["report the bounded stage"],
    authority: {},
    executionPlan: [
      {
        executionProfile: "file-read",
        executionRead: {
          endLine: 1,
          path: "src/hidden-hook",
          startLine: 1,
        },
        objective: "Read the exact selected file",
        readScope: ["src/sample.ts"],
      },
    ],
    executionProfile: "read-plan",
    id: "protected-alias-read-plan",
    idempotencyKey: "protected-alias-read-plan",
    kind: "inspect",
    objective: "Run the bounded read plan",
    readScope: ["src/sample.ts"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    workspaceRoot: runRoot,
    writeScope: [],
  });
  const expectedFailure = {
    detail:
      "workspace_root requires every packet path to be repo-relative, symlink-free, and contained beneath the selected root",
    reason: "protected-scope",
  } as const;
  for (const request of [topLevel, exactRead, readPlan]) {
    expect(resolveUtilityRequestWorkspace(request, fixture.base)).toEqual(
      expectedFailure
    );
  }
  expect(
    resolveUtilityRequestWorkspace(
      requestFor(
        "ordinary-in-root-alias",
        ["src/sample-alias.ts"],
        undefined,
        undefined,
        runRoot
      ),
      fixture.base
    )
  ).toEqual({
    detail:
      "workspace_root requires every packet path to be repo-relative, symlink-free, and contained beneath the selected root",
    reason: "workspace-unverified",
  });
  appendUtilityRouteRequest(runDir, topLevel);
  let spawnCalls = 0;
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 60,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:1/v1/chat/completions",
      },
      {
        spawnWorker: () => {
          spawnCalls += 1;
          return true;
        },
      }
    );
    expect(spawnCalls).toBe(0);
    expect(readUtilityJob(runDir, topLevel.id)).toMatchObject({
      decision: expectedFailure,
      state: "routed-driver",
    });
    expect(existsSync(join(runDir, "utility", "tool-events.jsonl"))).toBe(
      false
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("invalid explicit roots and path forms never spawn a worker", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "explicit-invalid-matrix");
  const linkedRoot = realpathSync(fixture.linkedA);
  const alias = join(fixture.root, "runtime-linked-alias");
  const unregistered = join(fixture.root, "runtime-unregistered");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(unregistered);
  symlinkSync(linkedRoot, alias);
  symlinkSync(
    realpathSync(join(fixture.unrelated, "src")),
    join(linkedRoot, "runtime-linked-src")
  );
  const requests = [
    requestFor(
      "runtime-unrelated-root",
      ["src/sample.ts"],
      undefined,
      undefined,
      realpathSync(fixture.unrelated)
    ),
    requestFor(
      "runtime-unregistered-root",
      ["src/sample.ts"],
      undefined,
      undefined,
      realpathSync(unregistered)
    ),
    requestFor(
      "runtime-alias-root",
      ["src/sample.ts"],
      undefined,
      undefined,
      alias
    ),
    requestFor(
      "runtime-subdirectory-root",
      ["src/sample.ts"],
      undefined,
      undefined,
      realpathSync(join(linkedRoot, "src"))
    ),
    requestFor(
      "runtime-absolute-scope",
      [join(linkedRoot, "src", "sample.ts")],
      undefined,
      undefined,
      linkedRoot
    ),
    requestFor(
      "runtime-mixed-scope",
      ["src/sample.ts", join(linkedRoot, "src", "check.js")],
      undefined,
      undefined,
      linkedRoot
    ),
    editRequestFor(
      "runtime-symlink-parent",
      "runtime-linked-src/new-file.ts",
      linkedRoot
    ),
    editRequestFor("runtime-directory-write", "src", linkedRoot),
  ];
  for (const request of requests) {
    appendUtilityRouteRequest(runDir, request);
  }
  let spawnCalls = 0;
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 56,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        spawnWorker: () => {
          spawnCalls += 1;
          return true;
        },
      }
    );
    expect(spawnCalls).toBe(0);
    for (const request of requests) {
      expect(readUtilityJob(runDir, request.id)).toMatchObject({
        decision: { reason: "workspace-unverified", target: "driver" },
        state: "routed-driver",
      });
    }
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("same linked-worktree writes conflict after scope normalization", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "linked-conflict");
  mkdirSync(runDir, { recursive: true });
  const target = join(fixture.linkedA, "src", "sample.ts");
  const first = editRequestFor("linked-conflict-a", target);
  const second = editRequestFor("linked-conflict-b", target);
  appendUtilityRouteRequest(runDir, first);
  appendUtilityRouteRequest(runDir, second);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 49,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      { spawnWorker: () => true }
    );
    expect(readUtilityJob(runDir, first.id)?.state).toBe("routed-utility");
    expect(readUtilityJob(runDir, second.id)).toMatchObject({
      decision: { reason: "write-conflict", target: "driver" },
      state: "routed-driver",
    });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("identical relative paths in base and linked worktrees do not conflict", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "separate-workspaces");
  mkdirSync(runDir, { recursive: true });
  const base = editRequestFor("base-write", "src/sample.ts");
  const linked = editRequestFor(
    "linked-write",
    join(fixture.linkedA, "src", "sample.ts")
  );
  appendUtilityRouteRequest(runDir, base);
  appendUtilityRouteRequest(runDir, linked);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 50,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      { spawnWorker: () => true }
    );
    expect(readUtilityJob(runDir, base.id)?.state).toBe("routed-utility");
    expect(readUtilityJob(runDir, linked.id)?.state).toBe("routed-utility");
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("routing persists the adopted root and the worker reads the linked checkout", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "linked-worker");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: fixture.base })
  );
  const request = requestFor("linked-worker", [
    join(fixture.linkedA, "src", "sample.ts"),
  ]);
  appendUtilityRouteRequest(runDir, request);
  let toolResult = "";
  let providerCalls = 0;
  const server = serve({
    fetch: async (incoming) => {
      providerCalls += 1;
      const body = (await incoming.json()) as {
        messages?: Array<{ content?: string; role?: string }>;
      };
      toolResult =
        body.messages?.findLast((message) => message.role === "tool")
          ?.content ?? toolResult;
      return Response.json({
        choices: [
          {
            finish_reason: providerCalls === 1 ? "tool_calls" : "stop",
            message:
              providerCalls === 1
                ? {
                    content: null,
                    role: "assistant",
                    tool_calls: [
                      {
                        function: {
                          arguments: '{"path":"src/sample.ts"}',
                          name: "read_file",
                        },
                        id: "read-linked",
                        type: "function",
                      },
                    ],
                  }
                : { content: "Linked file confirmed.", role: "assistant" },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
      });
    },
    port: 0,
  });
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 47,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_HARNESS: "legacy",
        LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
        LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      },
      { spawnWorker: () => true }
    );
    expect(
      readUtilityJob(runDir, request.id)?.decision?.workspace
    ).toMatchObject({
      readScope: ["src/sample.ts"],
      root: realpathSync(fixture.linkedA),
    });
    await runUtilityWorker(runDir, 47, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_HARNESS: "legacy",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(toolResult).toContain("active linked checkout");
    expect(toolResult).not.toContain("base checkout");
    expect(readUtilityJob(runDir, request.id)?.state).toBe("completed");
  } finally {
    server.stop(true);
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("worker start rejects a persisted workspace root replaced by a symlink", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "replaced-worker-root");
  const linkedRoot = realpathSync(fixture.linkedA);
  const fake = join(fixture.root, "worker-root-fake");
  const gitPointer = readFileSync(join(linkedRoot, ".git"));
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(fake, "src"), { recursive: true });
  writeFileSync(join(fake, ".git"), gitPointer);
  writeFileSync(join(fake, "src", "sample.ts"), "worker fake checkout\n");
  const fakeRoot = realpathSync(fake);
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: fixture.base })
  );
  const request = requestFor(
    "replaced-worker-root",
    ["src/sample.ts"],
    undefined,
    undefined,
    linkedRoot
  );
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 57,
        peer: "codex",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_HARNESS: "legacy",
        LOOP_NANNY_URL: "http://127.0.0.1:1/v1/chat/completions",
        LOOP_UTILITY_URL: "http://127.0.0.1:1/v1/chat/completions",
      },
      { spawnWorker: () => true }
    );
    expect(readUtilityJob(runDir, request.id)?.decision?.workspace?.root).toBe(
      linkedRoot
    );
    rmSync(linkedRoot, { force: true, recursive: true });
    symlinkSync(fakeRoot, linkedRoot);

    await runUtilityWorker(runDir, 57, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_HARNESS: "legacy",
      LOOP_NANNY_URL: "http://127.0.0.1:1/v1/chat/completions",
      LOOP_UTILITY_URL: "http://127.0.0.1:1/v1/chat/completions",
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker:
          "verified helper workspace no longer matches the run repository",
        status: "failed",
      },
      state: "failed",
    });
    expect(existsSync(join(runDir, "utility", "tool-events.jsonl"))).toBe(
      false
    );
    expect(readFileSync(join(fakeRoot, "src", "sample.ts"), "utf8")).toBe(
      "worker fake checkout\n"
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("guarded apply reuses the verified linked-worktree boundary", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "linked-apply");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: fixture.base })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["propose one guarded patch"],
    authority: {},
    id: "linked-apply",
    kind: "edit",
    objective: "Update the bounded sample file",
    readScope: [join(fixture.linkedA, "src", "sample.ts")],
    requester: "codex",
    requiredCapabilities: ["inspect", "scoped-edit"],
    risk: "low",
    writeScope: [join(fixture.linkedA, "src", "sample.ts")],
  });
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 48,
        peer: "claude",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      { spawnWorker: () => true }
    );
    claimUtilityJob(runDir, 48, { jobId: request.id, workerPid: process.pid });
    transitionUtilityJob(runDir, request.id, "running");
    const broker = await createUtilityToolBroker({
      artifactDir: `.loop/utility-artifacts/${request.id}`,
      commandAllowlist: [],
      readScopes: ["src/sample.ts"],
      repoRoot: fixture.linkedA,
      writeScopes: ["src/sample.ts"],
    });
    const proposal = await broker.execute({
      arguments: {
        patch: [
          "diff --git a/src/sample.ts b/src/sample.ts",
          "--- a/src/sample.ts",
          "+++ b/src/sample.ts",
          "@@ -1 +1 @@",
          "-active linked checkout",
          "+updated linked checkout",
          "",
        ].join("\n"),
        summary: "update linked checkout",
      },
      name: "propose_patch",
    });
    if (!(proposal.ok && proposal.artifact)) {
      throw new Error("failed to create linked-worktree patch proposal");
    }
    transitionUtilityJob(runDir, request.id, "completed", {
      result: {
        artifactRefs: [
          {
            kind: "diff",
            manifestPath: proposal.artifact.manifestPath,
            manifestSha256: proposal.artifact.manifestSha256,
            path: proposal.artifact.path,
            sha256: proposal.artifact.sha256,
          },
        ],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary: "guarded patch proposed",
      },
    });
    await applyUtilityJobPatch(
      runDir,
      request.id,
      proposal.artifact.sha256,
      "codex"
    );
    expect(
      readFileSync(join(fixture.linkedA, "src", "sample.ts"), "utf8")
    ).toBe("updated linked checkout\n");
    expect(readFileSync(join(fixture.base, "src", "sample.ts"), "utf8")).toBe(
      "base checkout\n"
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("guarded apply rejects a persisted workspace root replaced by a symlink", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "replaced-apply-root");
  const linkedRoot = realpathSync(fixture.linkedA);
  const fake = join(fixture.root, "apply-root-fake");
  const gitPointer = readFileSync(join(linkedRoot, ".git"));
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(fake, "src"), { recursive: true });
  writeFileSync(join(fake, ".git"), gitPointer);
  writeFileSync(join(fake, "src", "sample.ts"), "apply fake checkout\n");
  const fakeRoot = realpathSync(fake);
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: fixture.base })
  );
  const request = editRequestFor(
    "replaced-apply-root",
    "src/sample.ts",
    linkedRoot
  );
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 58,
        peer: "claude",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      { spawnWorker: () => true }
    );
    claimUtilityJob(runDir, 58, { jobId: request.id, workerPid: process.pid });
    transitionUtilityJob(runDir, request.id, "running");
    const broker = await createUtilityToolBroker({
      artifactDir: `.loop/utility-artifacts/${request.id}`,
      commandAllowlist: [],
      exactWriteScopes: true,
      readScopes: ["src/sample.ts"],
      repoRoot: linkedRoot,
      writeScopes: ["src/sample.ts"],
    });
    const proposal = await broker.execute({
      arguments: {
        patch: [
          "diff --git a/src/sample.ts b/src/sample.ts",
          "--- a/src/sample.ts",
          "+++ b/src/sample.ts",
          "@@ -1 +1 @@",
          "-active linked checkout",
          "+must not reach replacement",
          "",
        ].join("\n"),
        summary: "exercise replaced apply root",
      },
      name: "propose_patch",
    });
    if (!(proposal.ok && proposal.artifact)) {
      throw new Error("failed to create replaced-root patch proposal");
    }
    transitionUtilityJob(runDir, request.id, "completed", {
      result: {
        artifactRefs: [
          {
            kind: "diff",
            manifestPath: proposal.artifact.manifestPath,
            manifestSha256: proposal.artifact.manifestSha256,
            path: proposal.artifact.path,
            sha256: proposal.artifact.sha256,
          },
        ],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary: "guarded patch proposed",
      },
    });
    rmSync(linkedRoot, { force: true, recursive: true });
    symlinkSync(fakeRoot, linkedRoot);

    await expect(
      applyUtilityJobPatch(
        runDir,
        request.id,
        proposal.artifact.sha256,
        "codex"
      )
    ).rejects.toThrow(
      "verified helper workspace no longer matches the run repository"
    );
    expect(readFileSync(join(fakeRoot, "src", "sample.ts"), "utf8")).toBe(
      "apply fake checkout\n"
    );
    expect(readUtilityJob(runDir, request.id)?.application).toBeUndefined();
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("explicit linked root guards a missing exact write target and pre-creation race", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "linked-new-file");
  const linkedRoot = realpathSync(fixture.linkedA);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: fixture.base })
  );
  const proposeNewFile = async (
    id: string,
    target: string,
    exportedName: string,
    epoch: number
  ) => {
    const request = editRequestFor(id, target, linkedRoot);
    appendUtilityRouteRequest(runDir, request);
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch,
        peer: "claude",
        repoRoot: fixture.base,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      { spawnWorker: () => true }
    );
    expect(readUtilityJob(runDir, id)?.decision?.workspace).toMatchObject({
      root: linkedRoot,
      writeScope: [target],
    });
    claimUtilityJob(runDir, epoch, { jobId: id, workerPid: process.pid });
    transitionUtilityJob(runDir, id, "running");
    const broker = await createUtilityToolBroker({
      artifactDir: `.loop/utility-artifacts/${id}`,
      commandAllowlist: [],
      exactWriteScopes: true,
      readScopes: [target],
      repoRoot: linkedRoot,
      writeScopes: [target],
    });
    const proposal = await broker.execute({
      arguments: {
        patch: [
          `diff --git a/${target} b/${target}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${target}`,
          "@@ -0,0 +1 @@",
          `+export const ${exportedName} = true;`,
          "",
        ].join("\n"),
        summary: `create ${target}`,
      },
      name: "propose_patch",
    });
    if (!(proposal.ok && proposal.artifact?.manifestPath)) {
      throw new Error("failed to create linked-worktree new-file proposal");
    }
    const manifest = JSON.parse(
      readFileSync(proposal.artifact.manifestPath, "utf8")
    ) as { preimages: Array<{ path: string; sha256: string | null }> };
    expect(manifest.preimages).toEqual([{ path: target, sha256: null }]);
    transitionUtilityJob(runDir, id, "completed", {
      result: {
        artifactRefs: [
          {
            kind: "diff",
            manifestPath: proposal.artifact.manifestPath,
            manifestSha256: proposal.artifact.manifestSha256,
            path: proposal.artifact.path,
            sha256: proposal.artifact.sha256,
          },
        ],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary: "guarded new-file patch proposed",
      },
    });
    return proposal.artifact;
  };

  try {
    const created = await proposeNewFile(
      "linked-new-file",
      "src/linked-only.ts",
      "linkedOnly",
      52
    );
    await applyUtilityJobPatch(
      runDir,
      "linked-new-file",
      created.sha256,
      "codex"
    );
    expect(
      readFileSync(join(linkedRoot, "src", "linked-only.ts"), "utf8")
    ).toBe("export const linkedOnly = true;\n");
    expect(existsSync(join(fixture.base, "src", "linked-only.ts"))).toBe(false);

    const raced = await proposeNewFile(
      "linked-new-file-race",
      "src/raced.ts",
      "shouldNotWin",
      53
    );
    writeFileSync(join(linkedRoot, "src", "raced.ts"), "race winner\n");
    await expect(
      applyUtilityJobPatch(
        runDir,
        "linked-new-file-race",
        raced.sha256,
        "codex"
      )
    ).rejects.toThrow("preimage drift detected");
    expect(readFileSync(join(linkedRoot, "src", "raced.ts"), "utf8")).toBe(
      "race winner\n"
    );
    expect(existsSync(join(fixture.base, "src", "raced.ts"))).toBe(false);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
