import { expect, test } from "bun:test";
import {
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
  requireGit(base, ["init"]);
  requireGit(base, ["config", "user.email", "utility@example.test"]);
  requireGit(base, ["config", "user.name", "Utility Test"]);
  requireGit(base, ["add", "src/sample.ts"]);
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
  }
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
    writeScope: [],
  });

const editRequestFor = (id: string, path: string) =>
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

test("linked focused-check cwd resolves with the same verified workspace", () => {
  const fixture = workspaceFixture();
  try {
    const resolution = resolveUtilityRequestWorkspace(
      requestFor(
        "linked-cwd",
        [join(fixture.linkedA, "src", "sample.ts")],
        join(fixture.linkedA, "src")
      ),
      fixture.base
    );
    expect(resolution).toMatchObject({
      request: { executionCwd: "src", readScope: ["src/sample.ts"] },
      workspace: {
        executionCwd: "src",
        readScope: ["src/sample.ts"],
        root: realpathSync(fixture.linkedA),
      },
    });
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
    });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("runtime journals a safe mismatch detail instead of spawning utility", async () => {
  const fixture = workspaceFixture();
  const runDir = join(fixture.base, ".loop", "runs", "mismatch");
  mkdirSync(runDir, { recursive: true });
  const request = requestFor("mismatch", [
    join(fixture.unrelated, "src", "sample.ts"),
  ]);
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
          "scopes do not resolve to one verified worktree of the run repository",
        reason: "protected-scope",
        target: "driver",
      },
      state: "routed-driver",
    });
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
