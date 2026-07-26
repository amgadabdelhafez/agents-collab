import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRequest,
  createUtilityToolBroker,
  loadUtilityCommandAllowlist,
  scrubUtilityEnvironment,
  UTILITY_REPOSITORY_POLICY_PATH,
  UTILITY_TOOL_DEFINITIONS,
} from "../../src/loop/utility-tools";

const withRepo = async (
  run: (root: string) => Promise<void>
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "utility-tools-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await mkdir(join(root, ".aws"));
    await mkdir(join(root, ".claude"));
    await mkdir(join(root, "packages", "api", ".aws"), { recursive: true });
    await mkdir(join(root, "packages", "api", ".claude"), {
      recursive: true,
    });
    await mkdir(join(root, "packages", "api", "specs", "auth"), {
      recursive: true,
    });
    await mkdir(join(root, "packages", "api", "docs", "architecture"), {
      recursive: true,
    });
    await mkdir(join(root, "fixtures", "repo", ".git"), { recursive: true });
    await mkdir(join(root, ".github"));
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await mkdir(join(root, ".gemini"));
    await mkdir(join(root, "packages", "api", ".CURSOR", "rules"), {
      recursive: true,
    });
    await writeFile(
      join(root, "src", "hello.ts"),
      "export const hello = 'world';\n"
    );
    await writeFile(join(root, ".env"), "OPENROUTER_API_KEY=never-read\n");
    await writeFile(join(root, ".aws", "config"), "secret-profile\n");
    await writeFile(join(root, ".claude", "settings.json"), "{}\n");
    await writeFile(
      join(root, "packages", "api", ".aws", "config"),
      "nested-secret-profile\n"
    );
    await writeFile(
      join(root, "packages", "api", ".claude", "settings.json"),
      "{}\n"
    );
    await writeFile(
      join(root, "packages", "api", "specs", "auth", "spec.md"),
      "# governing\n"
    );
    await writeFile(
      join(root, "packages", "api", "docs", "architecture", "invariants.md"),
      "# governing\n"
    );
    await writeFile(join(root, "fixtures", "repo", ".git", "config"), "x\n");
    await writeFile(join(root, ".github", "copilot-instructions.md"), "x\n");
    await writeFile(join(root, ".cursor", "rules", "project.mdc"), "x\n");
    await writeFile(join(root, ".gemini", "settings.json"), "{}\n");
    await writeFile(join(root, ".windsurfrules"), "x\n");
    await writeFile(
      join(root, "packages", "api", ".CURSOR", "rules", "project.mdc"),
      "x\n"
    );
    await writeFile(join(root, "tests", "example.test.ts"), "export {};\n");
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const brokerFor = (
  root: string,
  runCommand?: (request: CommandRequest) => Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
    timedOut?: boolean;
    truncated?: boolean;
  }>
) =>
  createUtilityToolBroker(
    {
      artifactDir: ".utility-artifacts",
      readScopes: ["src", "tests"],
      repoRoot: root,
      writeScopes: ["src"],
    },
    { id: () => "patch-1", now: () => 1_700_000_000_000, runCommand }
  );

test("publishes provider-agnostic definitions for bounded tools", () => {
  expect(UTILITY_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual([
    "search_repo",
    "read_file",
    "git_status",
    "git_diff",
    "run_check",
    "propose_patch",
  ]);
});

test("reads and searches only declared non-secret scope", async () => {
  await withRepo(async (root) => {
    const broker = await brokerFor(root);
    const read = await broker.execute({
      arguments: { endLine: 1, path: "src/hello.ts" },
      name: "read_file",
    });
    expect(read.ok).toBe(true);
    expect(read.data).toMatchObject({
      content: "export const hello = 'world';",
    });

    const search = await broker.execute({
      arguments: { query: "hello" },
      name: "search_repo",
    });
    expect(search.ok).toBe(true);
    expect(search.data).toEqual([
      { line: 1, path: "src/hello.ts", text: "export const hello = 'world';" },
    ]);

    const secret = await broker.execute({
      arguments: { path: ".env" },
      name: "read_file",
    });
    expect(secret.error?.code).toBe("path_denied");
  });
});

test("central protected-path policy denies credential and agent settings", async () => {
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker({
      artifactDir: ".utility-artifacts",
      readScopes: ["."],
      repoRoot: root,
      writeScopes: [],
    });
    for (const path of [
      ".aws/config",
      ".claude/settings.json",
      "packages/api/.aws/config",
      "packages/api/.claude/settings.json",
      "packages/api/specs/auth/spec.md",
      "packages/api/docs/architecture/invariants.md",
      "fixtures/repo/.git/config",
      ".github/copilot-instructions.md",
      ".cursor/rules/project.mdc",
      ".gemini/settings.json",
      ".windsurfrules",
      "packages/api/.CURSOR/rules/project.mdc",
      ".CLAUDE/settings.json",
      "packages/api/.AWS/config",
      "fixtures/repo/.GIT/config",
    ]) {
      const read = await broker.execute({
        arguments: { path },
        name: "read_file",
      });
      expect(read.error?.code).toBe("path_denied");
    }

    let statusRequest: CommandRequest | undefined;
    const statusBroker = await createUtilityToolBroker(
      {
        artifactDir: ".utility-artifacts",
        readScopes: ["."],
        repoRoot: root,
        writeScopes: [],
      },
      {
        runCommand: (request) => {
          statusRequest = request;
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
        },
      }
    );
    expect(
      await statusBroker.execute({ arguments: {}, name: "git_status" })
    ).toMatchObject({ ok: true });
    expect(statusRequest?.argv).toContain(":(exclude,glob,icase)**/.cursor/**");
    expect(statusRequest?.argv).toContain(
      ":(exclude,glob,icase)**/copilot-instructions.md"
    );
  });
});

test("rejects traversal and symlink escape", async () => {
  await withRepo(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "utility-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "hidden\n");
      await symlink(outside, join(root, "src", "outside"));
      const broker = await brokerFor(root);
      const traversal = await broker.execute({
        arguments: { path: "../outside" },
        name: "read_file",
      });
      const escaped = await broker.execute({
        arguments: { path: "src/outside/secret.txt" },
        name: "read_file",
      });
      expect(traversal.error?.code).toBe("path_denied");
      expect(escaped.error?.code).toBe("path_denied");
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("runs literal allowlisted argv with a scrubbed environment", async () => {
  await withRepo(async (root) => {
    let captured: CommandRequest | undefined;
    const runner = mock((request: CommandRequest) => {
      captured = request;
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "pass" });
    });
    const broker = await createUtilityToolBroker(
      {
        artifactDir: ".utility-artifacts",
        commandAllowlist: [{ executable: "bun", prefixes: [["test"]] }],
        readScopes: ["src", "tests"],
        repoRoot: root,
        writeScopes: ["src"],
      },
      {
        runCommand: runner,
        sourceEnv: {
          OPENROUTER_API_KEY: "secret",
          PATH: "/bin",
          TOKEN: "secret",
        },
      }
    );
    const result = await broker.execute({
      arguments: {
        argv: ["bun", "test", "tests/example.test.ts"],
        cwd: "tests",
      },
      name: "run_check",
    });
    expect(result).toMatchObject({ exitCode: 0, ok: true, stdout: "pass" });
    expect(captured?.argv).toEqual(["bun", "test", "example.test.ts"]);
    expect(captured?.env).toEqual({ CI: "1", NO_COLOR: "1", PATH: "/bin" });

    const denied = await broker.execute({
      arguments: { argv: ["bun", "test", "x; rm -rf y"] },
      name: "run_check",
    });
    expect(denied.error?.code).toBe("command_denied");
    const optionEscape = await broker.execute({
      arguments: {
        argv: ["bun", "test", "--preload=/tmp/escape.ts"],
        cwd: "tests",
      },
      name: "run_check",
    });
    const traversal = await broker.execute({
      arguments: {
        argv: ["bun", "test", "../../escape.test.ts"],
        cwd: "tests",
      },
      name: "run_check",
    });
    expect(optionEscape.error?.code).toBe("command_denied");
    expect(traversal.error?.code).toBe("path_denied");
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

test("loads a repository policy for local offline npx vitest checks", async () => {
  await withRepo(async (root) => {
    await mkdir(join(root, ".loop"), { recursive: true });
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    const vitest = join(root, "node_modules", ".bin", "vitest");
    await writeFile(vitest, "#!/bin/sh\nexit 0\n");
    await chmod(vitest, 0o755);
    await writeFile(
      join(root, UTILITY_REPOSITORY_POLICY_PATH),
      JSON.stringify({
        commandAllowlist: [
          {
            executable: "npx",
            prefixes: [["vitest", "run"]],
            requireLocalBinary: "vitest",
          },
        ],
        version: 1,
      })
    );
    let captured: CommandRequest | undefined;
    const broker = await createUtilityToolBroker(
      {
        artifactDir: ".utility-artifacts",
        readScopes: ["src", "tests"],
        repoRoot: root,
        writeScopes: ["src"],
      },
      {
        runCommand: async (request) => {
          captured = request;
          return { exitCode: 0, stderr: "", stdout: "vitest pass" };
        },
      }
    );
    const result = await broker.execute({
      arguments: {
        argv: ["npx", "vitest", "run", "tests/example.test.ts"],
        cwd: "tests",
      },
      name: "run_check",
    });
    expect(result).toMatchObject({ exitCode: 0, ok: true });
    expect(captured?.argv).toEqual(["npx", "vitest", "run", "example.test.ts"]);
    expect(captured?.env).toMatchObject({
      CI: "1",
      NPM_CONFIG_OFFLINE: "true",
      NPM_CONFIG_YES: "false",
      NO_COLOR: "1",
    });

    const option = await broker.execute({
      arguments: {
        argv: ["npx", "vitest", "run", "--config", "tests/example.test.ts"],
      },
      name: "run_check",
    });
    expect(option.error?.code).toBe("command_denied");
  });
});

test("supports a local offline vitest check without repository mutation", async () => {
  await withRepo(async (root) => {
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    const vitest = join(root, "node_modules", ".bin", "vitest");
    await writeFile(vitest, "#!/bin/sh\nexit 0\n");
    await chmod(vitest, 0o755);
    let captured: CommandRequest | undefined;
    const broker = await createUtilityToolBroker(
      {
        artifactDir: ".utility-artifacts",
        readScopes: ["tests"],
        repoRoot: root,
        writeScopes: [],
      },
      {
        runCommand: async (request) => {
          captured = request;
          return { exitCode: 0, stderr: "", stdout: "vitest pass" };
        },
      }
    );

    const result = await broker.execute({
      arguments: {
        argv: ["npx", "vitest", "run", "tests/example.test.ts"],
        cwd: "tests",
      },
      name: "run_check",
    });

    expect(result).toMatchObject({ exitCode: 0, ok: true });
    expect(captured?.argv).toEqual(["npx", "vitest", "run", "example.test.ts"]);
    expect(captured?.env).toMatchObject({
      NPM_CONFIG_OFFLINE: "true",
      NPM_CONFIG_YES: "false",
    });
  });
});

test("resolves a monorepo package-local vitest from the declared cwd", async () => {
  await withRepo(async (root) => {
    const packageRoot = join(root, "packages", "ar-prototype");
    await mkdir(join(packageRoot, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(packageRoot, "tests"), { recursive: true });
    await writeFile(join(packageRoot, "tests", "yaw.test.ts"), "export {};\n");
    const vitest = join(packageRoot, "node_modules", ".bin", "vitest");
    await writeFile(vitest, "#!/bin/sh\nexit 0\n");
    await chmod(vitest, 0o755);
    let captured: CommandRequest | undefined;
    const broker = await createUtilityToolBroker(
      {
        artifactDir: ".utility-artifacts",
        readScopes: ["packages/ar-prototype"],
        repoRoot: root,
        writeScopes: [],
      },
      {
        runCommand: async (request) => {
          captured = request;
          return { exitCode: 0, stderr: "", stdout: "vitest pass" };
        },
      }
    );

    const result = await broker.execute({
      arguments: {
        argv: [
          "npx",
          "vitest",
          "run",
          "packages/ar-prototype/tests/yaw.test.ts",
        ],
        cwd: "packages/ar-prototype",
      },
      name: "run_check",
    });

    expect(result).toMatchObject({ exitCode: 0, ok: true });
    expect(captured?.argv).toEqual([
      "npx",
      "vitest",
      "run",
      "tests/yaw.test.ts",
    ]);
    expect(captured?.cwd).toBe(await realpath(packageRoot));
  });
});

test("repository command policy fails closed when malformed or open-world", async () => {
  await withRepo(async (root) => {
    await mkdir(join(root, ".loop"), { recursive: true });
    const policyPath = join(root, UTILITY_REPOSITORY_POLICY_PATH);
    await writeFile(policyPath, "{not-json");
    await expect(loadUtilityCommandAllowlist(root)).rejects.toThrow(
      "not valid JSON"
    );

    await writeFile(
      policyPath,
      JSON.stringify({
        commandAllowlist: [
          { executable: "npx", prefixes: [["vitest", "run"]] },
        ],
        version: 1,
      })
    );
    await expect(loadUtilityCommandAllowlist(root)).rejects.toThrow(
      "requires requireLocalBinary"
    );

    await writeFile(
      policyPath,
      JSON.stringify({
        commandAllowlist: [{ executable: "sh", prefixes: [["-c"]] }],
        version: 1,
      })
    );
    await expect(loadUtilityCommandAllowlist(root)).rejects.toThrow(
      "executable is not allowed"
    );
  });
});

test("repository npx policy refuses a missing local binary", async () => {
  await withRepo(async (root) => {
    await mkdir(join(root, ".loop"), { recursive: true });
    await writeFile(
      join(root, UTILITY_REPOSITORY_POLICY_PATH),
      JSON.stringify({
        commandAllowlist: [
          {
            executable: "npx",
            prefixes: [["vitest", "run"]],
            requireLocalBinary: "vitest",
          },
        ],
        version: 1,
      })
    );
    const runner = mock(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "should not run",
    }));
    const broker = await createUtilityToolBroker(
      {
        artifactDir: ".utility-artifacts",
        readScopes: ["tests"],
        repoRoot: root,
        writeScopes: [],
      },
      { runCommand: runner }
    );
    const result = await broker.execute({
      arguments: {
        argv: ["npx", "vitest", "run", "tests/example.test.ts"],
        cwd: "tests",
      },
      name: "run_check",
    });
    expect(result.error?.code).toBe("command_denied");
    expect(runner).not.toHaveBeenCalled();
  });
});

test("rejects timed out and oversized command output", async () => {
  await withRepo(async (root) => {
    const timeoutBroker = await brokerFor(root, async () => ({
      exitCode: 137,
      stderr: "",
      stdout: "",
      timedOut: true,
    }));
    const timeout = await timeoutBroker.execute({
      arguments: {
        argv: ["bun", "test", "tests/example.test.ts"],
        cwd: "tests",
      },
      name: "run_check",
    });
    expect(timeout.error?.code).toBe("timeout");

    const outputBroker = await brokerFor(root, async () => ({
      exitCode: 137,
      stderr: "",
      stdout: "partial",
      truncated: true,
    }));
    const output = await outputBroker.execute({
      arguments: {
        argv: ["bun", "test", "tests/example.test.ts"],
        cwd: "tests",
      },
      name: "run_check",
    });
    expect(output.error?.code).toBe("output_limit");
  });
});

test("stores a validated patch proposal without modifying the source", async () => {
  await withRepo(async (root) => {
    const broker = await brokerFor(root);
    const patch = [
      "diff --git a/src/hello.ts b/src/hello.ts",
      "--- a/src/hello.ts",
      "+++ b/src/hello.ts",
      "@@ -1 +1 @@",
      "-export const hello = 'world';",
      "+export const hello = 'utility';",
      "",
    ].join("\n");
    const result = await broker.execute({
      arguments: { patch, summary: "small edit" },
      name: "propose_patch",
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, "src", "hello.ts"), "utf8")).toContain(
      "world"
    );
    expect(await readFile(result.artifact?.path ?? "", "utf8")).toBe(patch);
    expect(result.data).toMatchObject({ targets: ["src/hello.ts"] });

    const dependency = await broker.execute({
      arguments: {
        patch:
          "--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{}\n",
      },
      name: "propose_patch",
    });
    expect(dependency.error?.code).toBe("scope_denied");
  });
});

test("guarded apply revalidates write scope and dependency targets", async () => {
  await withRepo(async (root) => {
    await writeFile(join(root, "package.json"), "{}\n");
    const artifactDir = join(root, ".utility-artifacts");
    await mkdir(artifactDir);
    const patchPath = join(artifactDir, "dependency.patch");
    const manifestPath = join(artifactDir, "dependency.json");
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1 +1 @@",
      "-{}",
      '+{"changed":true}',
      "",
    ].join("\n");
    await writeFile(patchPath, patch);
    await writeFile(
      manifestPath,
      JSON.stringify({
        createdAt: "2026-07-26T16:00:00.000Z",
        patchPath,
        preimages: [
          {
            path: "package.json",
            sha256: createHash("sha256").update("{}\n").digest("hex"),
          },
        ],
      })
    );
    const broker = await createUtilityToolBroker({
      artifactDir: ".utility-artifacts",
      commandAllowlist: [],
      readScopes: ["src"],
      repoRoot: root,
      writeScopes: ["package.json"],
    });
    await expect(
      broker.applyPatchProposal({
        appliedBy: "codex",
        expectedManifestSha256: createHash("sha256")
          .update(await readFile(manifestPath))
          .digest("hex"),
        expectedPatchSha256: createHash("sha256").update(patch).digest("hex"),
        manifestPath,
        patchPath,
      })
    ).rejects.toThrow("Dependency file denied");

    const scopePatchPath = join(artifactDir, "scope.patch");
    const scopeManifestPath = join(artifactDir, "scope.json");
    const scopePatch = [
      "diff --git a/tests/example.test.ts b/tests/example.test.ts",
      "--- a/tests/example.test.ts",
      "+++ b/tests/example.test.ts",
      "@@ -1 +1 @@",
      "-export {};",
      "+export const changed = true;",
      "",
    ].join("\n");
    await writeFile(scopePatchPath, scopePatch);
    await writeFile(
      scopeManifestPath,
      JSON.stringify({
        createdAt: "2026-07-26T16:00:00.000Z",
        patchPath: scopePatchPath,
        preimages: [
          {
            path: "tests/example.test.ts",
            sha256: createHash("sha256").update("export {};\n").digest("hex"),
          },
        ],
      })
    );
    await expect(
      broker.applyPatchProposal({
        appliedBy: "codex",
        expectedManifestSha256: createHash("sha256")
          .update(await readFile(scopeManifestPath))
          .digest("hex"),
        expectedPatchSha256: createHash("sha256")
          .update(scopePatch)
          .digest("hex"),
        manifestPath: scopeManifestPath,
        patchPath: scopePatchPath,
      })
    ).rejects.toThrow("outside declared write scope");
  });
});

test("guarded apply refuses symlink escapes from write scope", async () => {
  await withRepo(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "utility-apply-outside-"));
    try {
      await writeFile(join(outside, "data.ts"), "export const n = 1;\n");
      await symlink(outside, join(root, "src", "outside"));
      const artifactDir = join(root, ".utility-artifacts");
      await mkdir(artifactDir);
      const patchPath = join(artifactDir, "escape.patch");
      const manifestPath = join(artifactDir, "escape.json");
      const patch = [
        "diff --git a/src/outside/data.ts b/src/outside/data.ts",
        "--- a/src/outside/data.ts",
        "+++ b/src/outside/data.ts",
        "@@ -1 +1 @@",
        "-export const n = 1;",
        "+export const n = 2;",
        "",
      ].join("\n");
      await writeFile(patchPath, patch);
      await writeFile(
        manifestPath,
        JSON.stringify({
          createdAt: "2026-07-26T16:00:00.000Z",
          patchPath,
          preimages: [
            {
              path: "src/outside/data.ts",
              sha256: createHash("sha256")
                .update("export const n = 1;\n")
                .digest("hex"),
            },
          ],
        })
      );
      const broker = await createUtilityToolBroker({
        artifactDir: ".utility-artifacts",
        commandAllowlist: [],
        readScopes: ["src"],
        repoRoot: root,
        writeScopes: ["src"],
      });
      await expect(
        broker.applyPatchProposal({
          appliedBy: "claude",
          expectedManifestSha256: createHash("sha256")
            .update(await readFile(manifestPath))
            .digest("hex"),
          expectedPatchSha256: createHash("sha256").update(patch).digest("hex"),
          manifestPath,
          patchPath,
        })
      ).rejects.toThrow("resolves outside repository");
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("guarded apply refuses an in-repository symlink write-scope escape", async () => {
  await withRepo(async (root) => {
    await symlink(join(root, "tests"), join(root, "src", "linked-tests"));
    const artifactDir = join(root, ".utility-artifacts");
    await mkdir(artifactDir);
    const patchPath = join(artifactDir, "scope-link.patch");
    const manifestPath = join(artifactDir, "scope-link.json");
    const patch = [
      "diff --git a/src/linked-tests/example.test.ts b/src/linked-tests/example.test.ts",
      "--- a/src/linked-tests/example.test.ts",
      "+++ b/src/linked-tests/example.test.ts",
      "@@ -1 +1 @@",
      "-export {};",
      "+export const escaped = true;",
      "",
    ].join("\n");
    await writeFile(patchPath, patch);
    await writeFile(
      manifestPath,
      JSON.stringify({
        createdAt: "2026-07-26T16:00:00.000Z",
        patchPath,
        preimages: [
          {
            path: "src/linked-tests/example.test.ts",
            sha256: createHash("sha256").update("export {};\n").digest("hex"),
          },
        ],
      })
    );
    const broker = await createUtilityToolBroker({
      artifactDir: ".utility-artifacts",
      commandAllowlist: [],
      readScopes: ["src"],
      repoRoot: root,
      writeScopes: ["src"],
    });

    await expect(
      broker.applyPatchProposal({
        appliedBy: "codex",
        expectedManifestSha256: createHash("sha256")
          .update(await readFile(manifestPath))
          .digest("hex"),
        expectedPatchSha256: createHash("sha256").update(patch).digest("hex"),
        manifestPath,
        patchPath,
      })
    ).rejects.toThrow("outside declared write scope");
  });
});

test("environment scrubbing is allowlist based", () => {
  expect(
    scrubUtilityEnvironment({
      COOKIE: "x",
      HOME: "/private",
      LANG: "C",
      PATH: "/bin",
    })
  ).toEqual({ CI: "1", LANG: "C", NO_COLOR: "1", PATH: "/bin" });
});
