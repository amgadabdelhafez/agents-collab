import { expect, mock, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRequest,
  createUtilityToolBroker,
  scrubUtilityEnvironment,
  UTILITY_TOOL_DEFINITIONS,
} from "../../src/loop/utility-tools";

const withRepo = async (
  run: (root: string) => Promise<void>
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "utility-tools-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(
      join(root, "src", "hello.ts"),
      "export const hello = 'world';\n"
    );
    await writeFile(join(root, ".env"), "OPENROUTER_API_KEY=never-read\n");
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
