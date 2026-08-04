import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
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
    "count_lines",
    "list_files",
    "git_status",
    "git_diff",
    "git_inspect",
    "run_check",
    "propose_patch",
  ]);
});

test("counts lines across bounded files without spawning a command", async () => {
  await withRepo(async (root) => {
    await writeFile(join(root, "src", "no-final-newline.ts"), "a\nb");
    const runCommand = mock(() =>
      Promise.resolve({ exitCode: 0, stderr: "", stdout: "unexpected" })
    );
    const broker = await brokerFor(root, runCommand);
    const result = await broker.execute({
      arguments: {
        paths: [
          "src/hello.ts",
          "src/no-final-newline.ts",
          "tests/example.test.ts",
        ],
      },
      name: "count_lines",
    });

    expect(result).toMatchObject({
      data: {
        files: [
          { lines: 1, path: "src/hello.ts" },
          { lines: 1, path: "src/no-final-newline.ts" },
          { lines: 1, path: "tests/example.test.ts" },
        ],
      },
      ok: true,
    });
    expect(runCommand).not.toHaveBeenCalled();
  });
});

test("rejects unsafe or oversized line-count requests", async () => {
  await withRepo(async (root) => {
    const broker = await brokerFor(root);
    const empty = await broker.execute({
      arguments: { paths: [] },
      name: "count_lines",
    });
    const duplicate = await broker.execute({
      arguments: { paths: ["src/hello.ts", "src/hello.ts"] },
      name: "count_lines",
    });
    const directory = await broker.execute({
      arguments: { paths: ["src"] },
      name: "count_lines",
    });
    const outside = await broker.execute({
      arguments: { paths: ["package.json"] },
      name: "count_lines",
    });
    const tooMany = await broker.execute({
      arguments: {
        paths: Array.from({ length: 9 }, (_, index) => `src/file-${index}.ts`),
      },
      name: "count_lines",
    });

    expect(empty).toMatchObject({
      error: { code: "invalid_arguments" },
      ok: false,
    });
    expect(duplicate).toMatchObject({
      error: { code: "invalid_arguments" },
      ok: false,
    });
    expect(directory).toMatchObject({
      error: { code: "path_denied" },
      ok: false,
    });
    expect(outside).toMatchObject({
      error: { code: "scope_denied" },
      ok: false,
    });
    expect(tooMany).toMatchObject({
      error: { code: "invalid_arguments" },
      ok: false,
    });
  });
});

test("exposes and enforces only the tools allowed for an exact request", async () => {
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker({
      allowedTools: ["read_file"],
      artifactDir: ".utility-artifacts",
      readScopes: ["src/hello.ts"],
      repoRoot: root,
      writeScopes: [],
    });
    expect(broker.definitions.map((tool) => tool.function.name)).toEqual([
      "read_file",
    ]);
    expect(
      await broker.execute({ arguments: {}, name: "git_status" })
    ).toMatchObject({ error: { code: "tool_denied" }, ok: false });
  });
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

test("treats safely bounded absent search paths as empty without weakening path gates", async () => {
  await withRepo(async (root) => {
    const broker = await brokerFor(root);

    // Producer shape from harvto loop 121: the model names a plausible child
    // directory inside its declared project scope, but that directory is absent.
    const absent = await broker.execute({
      arguments: { paths: ["src/packages"], query: "hello" },
      name: "search_repo",
    });
    expect(absent).toMatchObject({ data: [], ok: true });

    const mixed = await broker.execute({
      arguments: {
        paths: ["src/packages", "src"],
        query: "hello",
      },
      name: "search_repo",
    });
    expect(mixed).toMatchObject({
      data: [
        {
          line: 1,
          path: "src/hello.ts",
          text: "export const hello = 'world';",
        },
      ],
      ok: true,
    });

    const outsideScope = await broker.execute({
      arguments: { paths: ["other/missing"], query: "hello" },
      name: "search_repo",
    });
    expect(outsideScope.error?.code).toBe("scope_denied");

    const protectedPath = await broker.execute({
      arguments: { paths: ["src/.aws/missing"], query: "hello" },
      name: "search_repo",
    });
    expect(protectedPath.error?.code).toBe("path_denied");

    const outside = await mkdtemp(join(tmpdir(), "utility-search-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "hello from outside\n");
      await symlink(outside, join(root, "src", "outside-search"));
      const escaped = await broker.execute({
        arguments: { paths: ["src/outside-search"], query: "hello" },
        name: "search_repo",
      });
      expect(escaped.error?.code).toBe("path_denied");
    } finally {
      await rm(outside, { force: true, recursive: true });
    }

    const missingRead = await broker.execute({
      arguments: { path: "src/packages" },
      name: "read_file",
    });
    expect(missingRead.error?.code).toBe("not_found");
  });
});

test("missing reads suggest only bounded in-scope filename matches", async () => {
  await withRepo(async (root) => {
    await mkdir(join(root, "src", "nested"));
    await writeFile(
      join(root, "src", "nested", "moved.ts"),
      "export const moved = true;\n"
    );
    await writeFile(join(root, "tests", "moved.ts"), "outside narrow scope\n");
    const broker = await createUtilityToolBroker({
      allowedTools: ["read_file"],
      artifactDir: ".utility-artifacts",
      readScopes: ["src"],
      repoRoot: root,
      writeScopes: [],
    });

    const result = await broker.execute({
      arguments: { path: "src/moved.ts" },
      name: "read_file",
    });
    const errorMessage = String(result.error?.message ?? "");
    expect(errorMessage).toContain("In-scope candidate: src/nested/moved.ts");
    expect(errorMessage.includes("tests/moved.ts")).toBe(false);
    expect(result).toMatchObject({
      error: {
        code: "not_found",
      },
      ok: false,
    });
    expect(result.data).toBeUndefined();
  });
});

test("missing-path suggestions do not traverse a symlinked read-scope root", async () => {
  await withRepo(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "utility-candidate-outside-"));
    try {
      await mkdir(join(outside, "nested"));
      await writeFile(join(outside, "nested", "missing.ts"), "outside\n");
      await symlink(outside, join(root, "src", "linked-outside"));
      expect(
        (await lstat(join(root, "src", "linked-outside"))).isSymbolicLink()
      ).toBe(true);
      const broker = await createUtilityToolBroker({
        allowedTools: ["read_file"],
        artifactDir: ".utility-artifacts",
        readScopes: ["src/linked-outside"],
        repoRoot: root,
        writeScopes: [],
      });

      const result = await broker.execute({
        arguments: { path: "src/linked-outside/missing.ts" },
        name: "read_file",
      });
      expect(result).toMatchObject({
        error: { code: "not_found" },
        ok: false,
      });
      expect(result.error?.message).not.toContain("In-scope candidate");
      expect(result.data).toBeUndefined();
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("lists one bounded directory without exposing protected entries", async () => {
  await withRepo(async (root) => {
    await writeFile(join(root, "src", ".ordinary-hidden"), "ok\n");
    await mkdir(join(root, "src", "nested"));
    await writeFile(join(root, "src", "nested", "child.ts"), "export {};\n");
    await mkdir(join(root, "src", ".git"));
    await writeFile(join(root, "src", ".git", "config"), "secret\n");
    const broker = await createUtilityToolBroker({
      allowedTools: ["list_files"],
      artifactDir: ".utility-artifacts",
      limits: { maxListEntries: 1 },
      readScopes: ["src"],
      repoRoot: root,
      writeScopes: [],
    });
    expect(broker.definitions.map((tool) => tool.function.name)).toEqual([
      "list_files",
    ]);
    const result = await broker.execute({
      arguments: { includeHidden: true, path: "src" },
      name: "list_files",
    });
    expect(result).toMatchObject({
      data: {
        entries: expect.arrayContaining([
          expect.objectContaining({ path: "src/.ordinary-hidden" }),
        ]),
        path: "src",
        truncated: true,
      },
      ok: true,
    });
    expect(JSON.stringify(result)).not.toContain("src/.git");
    expect(
      await broker.execute({
        arguments: { path: "src/nested" },
        name: "list_files",
      })
    ).toMatchObject({
      data: {
        entries: [expect.objectContaining({ path: "src/nested/child.ts" })],
        path: "src/nested",
      },
      ok: true,
    });
    expect(
      await broker.execute({
        arguments: { path: "src/hello.ts" },
        name: "list_files",
      })
    ).toMatchObject({ error: { code: "path_denied" }, ok: false });
    const outsideScope = await broker.execute({
      arguments: { path: "tests" },
      name: "list_files",
    });
    expect(outsideScope).toMatchObject({
      error: {
        code: "scope_denied",
        message: expect.stringContaining(
          "Allowed read scope(s): src. Retry only inside a listed scope"
        ),
      },
      ok: false,
    });
    const fileBroker = await createUtilityToolBroker({
      allowedTools: ["list_files"],
      artifactDir: ".utility-artifacts",
      readScopes: ["src/hello.ts"],
      repoRoot: root,
      writeScopes: [],
    });
    expect(
      await fileBroker.execute({
        arguments: { path: "src/hello.ts" },
        name: "list_files",
      })
    ).toMatchObject({ error: { code: "path_denied" }, ok: false });
  });
});

test("directory listing truncates before the shared output byte limit", async () => {
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker({
      allowedTools: ["list_files"],
      artifactDir: ".utility-artifacts",
      limits: { maxOutputBytes: 90 },
      readScopes: ["."],
      repoRoot: root,
      writeScopes: [],
    });
    const result = await broker.execute({
      arguments: { path: "." },
      name: "list_files",
    });
    expect(result).toMatchObject({ data: { truncated: true }, ok: true });
    expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThanOrEqual(
      90
    );
  });
});

test("reads an exact bounded tail without widening file authority", async () => {
  await withRepo(async (root) => {
    await writeFile(join(root, "src", "lines.txt"), "one\ntwo\nthree\nfour\n");
    const broker = await brokerFor(root);
    expect(
      await broker.execute({
        arguments: { lastLines: 2, path: "src/lines.txt" },
        name: "read_file",
      })
    ).toMatchObject({
      data: { content: "three\nfour", endLine: 4, startLine: 3 },
      ok: true,
    });
    expect(
      await broker.execute({
        arguments: { lastLines: 2, path: "src/lines.txt", startLine: 1 },
        name: "read_file",
      })
    ).toMatchObject({ error: { code: "invalid_arguments" }, ok: false });
  });
});

test("broker enforces the persisted exact read range against model deviation", async () => {
  await withRepo(async (root) => {
    await writeFile(join(root, "src", "lines.txt"), "one\ntwo\nthree\nfour\n");
    const broker = await createUtilityToolBroker({
      allowedTools: ["read_file"],
      artifactDir: ".utility-artifacts",
      exactRead: { endLine: 2, path: "src/lines.txt", startLine: 1 },
      readScopes: ["src/lines.txt"],
      repoRoot: root,
      writeScopes: [],
    });
    expect(
      await broker.execute({
        arguments: { endLine: 2, path: "src/lines.txt", startLine: 1 },
        name: "read_file",
      })
    ).toMatchObject({ data: { content: "one\ntwo" }, ok: true });
    for (const arguments_ of [
      { path: "src/lines.txt" },
      { endLine: 4, path: "src/lines.txt", startLine: 1 },
      { lastLines: 2, path: "src/lines.txt" },
    ]) {
      expect(
        await broker.execute({ arguments: arguments_, name: "read_file" })
      ).toMatchObject({ error: { code: "command_denied" }, ok: false });
    }
  });
});

test("broker caps range reads even when exact metadata is tampered", async () => {
  await withRepo(async (root) => {
    await writeFile(
      join(root, "src", "many-lines.txt"),
      `${Array.from({ length: 501 }, () => "line").join("\n")}\n`
    );
    const exactRead = {
      endLine: 501,
      path: "src/many-lines.txt",
      startLine: 1,
    };
    const broker = await createUtilityToolBroker({
      allowedTools: ["read_file"],
      artifactDir: ".utility-artifacts",
      exactRead,
      readScopes: [exactRead.path],
      repoRoot: root,
      writeScopes: [],
    });
    const rejected = await broker.execute({
      arguments: exactRead,
      name: "read_file",
    });
    const rejectedMessage = String(rejected.error?.message);
    expect(rejected).toMatchObject({
      error: {
        code: "invalid_arguments",
      },
      ok: false,
    });
    expect(rejectedMessage).toContain("bounded read limit of 500 lines");
    expect(rejectedMessage).toContain("endLine <= startLine + 499");
  });
});

test("broker narrows an oversized model-driven read with continuation evidence", async () => {
  await withRepo(async (root) => {
    await writeFile(
      join(root, "src", "many-lines.txt"),
      `${Array.from({ length: 600 }, (_, index) => `line-${index + 1}`).join("\n")}\n`
    );
    const broker = await createUtilityToolBroker({
      artifactDir: ".utility-artifacts",
      readScopes: ["src/many-lines.txt"],
      repoRoot: root,
      writeScopes: [],
    });

    const result = await broker.execute({
      arguments: {
        endLine: 600,
        path: "src/many-lines.txt",
        startLine: 1,
      },
      name: "read_file",
    });

    expect(result).toMatchObject({
      data: {
        endLine: 500,
        nextStartLine: 501,
        path: "src/many-lines.txt",
        requestedEndLine: 600,
        startLine: 1,
        truncated: true,
      },
      ok: true,
    });
    expect(String((result.data as { content: string }).content)).toContain(
      "line-500"
    );
    expect(String((result.data as { content: string }).content)).not.toContain(
      "line-501"
    );
  });
});

test("a malformed automatic file-read boundary fails closed", async () => {
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker({
      allowedTools: ["read_file"],
      artifactDir: ".utility-artifacts",
      exactRead: null,
      readScopes: ["src/hello.ts"],
      repoRoot: root,
      writeScopes: [],
    });
    expect(
      await broker.execute({
        arguments: { endLine: 1, path: "src/hello.ts", startLine: 1 },
        name: "read_file",
      })
    ).toMatchObject({ error: { code: "command_denied" }, ok: false });
  });
});

test("reads a bounded range from a regular file larger than 128 KiB", async () => {
  await withRepo(async (root) => {
    await writeFile(
      join(root, "src", "large.md"),
      `first line\n${"x".repeat(135_000)}\nlast line\n`
    );
    const broker = await brokerFor(root);
    const bounded = await broker.execute({
      arguments: { endLine: 1, path: "src/large.md", startLine: 1 },
      name: "read_file",
    });
    expect(bounded).toMatchObject({
      data: { content: "first line", endLine: 1, startLine: 1 },
      ok: true,
    });
    const unbounded = await broker.execute({
      arguments: { path: "src/large.md" },
      name: "read_file",
    });
    expect(unbounded).toMatchObject({
      error: { code: "output_limit" },
      ok: false,
    });
  });
});

test("search rejects matching output larger than the broker output budget", async () => {
  await withRepo(async (root) => {
    await writeFile(
      join(root, "src", "large-match.txt"),
      `needle ${"x".repeat(200_000)}\n`
    );
    const broker = await brokerFor(root);
    expect(
      await broker.execute({
        arguments: { paths: ["src/large-match.txt"], query: "needle" },
        name: "search_repo",
      })
    ).toMatchObject({ error: { code: "output_limit" }, ok: false });
  });
});

test("git_inspect runs only literal bounded read-only metadata commands", async () => {
  await withRepo(async (root) => {
    const requests: CommandRequest[] = [];
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["git_inspect"],
        artifactDir: ".utility-artifacts",
        readScopes: ["."],
        repoRoot: root,
        writeScopes: [],
      },
      {
        runCommand: (request) => {
          requests.push(request);
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "ok" });
        },
      }
    );

    for (const args of [
      { action: "resolve-ref", ref: "origin/main" },
      { action: "log", limit: 3, ref: "origin/main" },
      { action: "log", limit: 2 },
      { action: "show-stat", includeMetadata: false, ref: "53a8d5dd" },
      { action: "branch-list", pattern: "*loop51*" },
      { action: "current-branch" },
      { action: "worktree-list" },
      { action: "object-type", ref: "53a8d5dd" },
    ]) {
      expect(
        await broker.execute({ arguments: args, name: "git_inspect" })
      ).toMatchObject({ ok: true });
    }

    expect(requests.map((request) => request.argv.slice(0, 3))).toEqual([
      ["git", "rev-parse", "--verify"],
      ["git", "log", "--no-decorate"],
      ["git", "log", "--no-decorate"],
      ["git", "show", "--no-ext-diff"],
      ["git", "branch", "--all"],
      ["git", "branch", "--show-current"],
      ["git", "worktree", "list"],
      ["git", "cat-file", "-t"],
    ]);
    expect(requests[1]?.argv).toContain("-n");
    expect(requests[1]?.argv).toContain("3");
    expect(requests[2]?.argv.at(-1)).toBe("HEAD");
    expect(requests[3]?.argv).toContain("--stat");
    expect(requests[3]?.argv).toContain("--format=");
    expect(requests[3]?.argv).toContain(":(exclude,glob,icase)**/.claude/**");
    expect(requests.every((request) => request.env.CI === "1")).toBe(true);

    for (const args of [
      { action: "resolve-ref", ref: "--exec-path" },
      { action: "log", limit: 1000, ref: "origin/main" },
      { action: "branch-list", pattern: "$(touch /tmp/nope)" },
      { action: "show-stat", extra: true, ref: "53a8d5dd" },
    ]) {
      expect(
        await broker.execute({ arguments: args, name: "git_inspect" })
      ).toMatchObject({ error: { code: "invalid_arguments" }, ok: false });
    }
    expect(requests).toHaveLength(8);
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

test("broker enforces merged tail output for a focused check", async () => {
  await withRepo(async (root) => {
    const argv = ["bun", "test", "tests/example.test.ts"];
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["run_check"],
        artifactDir: ".utility-artifacts",
        commandCwds: ["."],
        exactCommand: argv,
        outputBoundary: {
          lineLimit: 2,
          position: "tail",
          stderr: "merge",
        },
        readScopes: ["tests/example.test.ts"],
        repoRoot: root,
        writeScopes: [],
      },
      {
        runCommand: async () => ({
          exitCode: 0,
          stderr: "error-one\nerror-two\n",
          stdout: "output-one\noutput-two\n",
        }),
      }
    );
    expect(
      await broker.execute({
        arguments: { argv, cwd: "." },
        name: "run_check",
      })
    ).toMatchObject({
      ok: true,
      stderr: "",
      stdout: "error-one\nerror-two\n",
    });
  });
});

test("broker applies literal presentation filters without a shell", async () => {
  await withRepo(async (root) => {
    const argv = ["bun", "test", "tests/example.test.ts"];
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["run_check"],
        artifactDir: ".utility-artifacts",
        commandCwds: ["."],
        exactCommand: argv,
        outputBoundary: {
          excludeLines: ["SKIP"],
          includeLines: ["Tests ", "FAIL "],
          lineLimit: 2,
          position: "tail",
          stderr: "merge",
          stripAnsi: true,
        },
        readScopes: ["tests/example.test.ts"],
        repoRoot: root,
        writeScopes: [],
      },
      {
        runCommand: async () => ({
          exitCode: 1,
          stderr: "\u001b[31mFAIL suite\u001b[0m\nSKIP Tests old\n",
          stdout: "setup\nTests 7 passed\nTests 1 failed\n",
        }),
      }
    );
    expect(
      await broker.execute({
        arguments: { argv, cwd: "." },
        name: "run_check",
      })
    ).toMatchObject({
      exitCode: 1,
      ok: true,
      stderr: "",
      stdout: "Tests 1 failed\nFAIL suite\n",
    });
  });
});

test("broker slices list output and marks the listing truncated", async () => {
  await withRepo(async (root) => {
    await writeFile(join(root, "src", "a.ts"), "a\n");
    await writeFile(join(root, "src", "b.ts"), "b\n");
    const broker = await createUtilityToolBroker({
      allowedTools: ["list_files"],
      artifactDir: ".utility-artifacts",
      outputBoundary: { lineLimit: 1, position: "head" },
      readScopes: ["src"],
      repoRoot: root,
      writeScopes: [],
    });
    expect(
      await broker.execute({
        arguments: { path: "src" },
        name: "list_files",
      })
    ).toMatchObject({
      data: { entries: [expect.any(Object)], truncated: true },
      ok: true,
    });
  });
});

test("explicit focused cwd is exact while legacy read-scope cwd remains contained", async () => {
  await withRepo(async (root) => {
    const runner = mock(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "pass",
    }));
    const containedBroker = await createUtilityToolBroker(
      {
        allowedTools: ["run_check"],
        artifactDir: ".utility-artifacts",
        readScopes: ["."],
        repoRoot: root,
        writeScopes: [],
      },
      { runCommand: runner }
    );
    expect(
      await containedBroker.execute({
        arguments: {
          argv: ["bun", "test", "tests/example.test.ts"],
          cwd: "tests",
        },
        name: "run_check",
      })
    ).toMatchObject({ ok: true });

    const exactBroker = await createUtilityToolBroker(
      {
        allowedTools: ["run_check"],
        artifactDir: ".utility-artifacts",
        commandCwds: ["."],
        readScopes: ["tests/example.test.ts"],
        repoRoot: root,
        writeScopes: [],
      },
      { runCommand: runner }
    );
    expect(
      await exactBroker.execute({
        arguments: {
          argv: ["bun", "test", "tests/example.test.ts"],
          cwd: "tests",
        },
        name: "run_check",
      })
    ).toMatchObject({ error: { code: "scope_denied" }, ok: false });
  });
});

test("focused check cwd does not widen its exact file authority", async () => {
  await withRepo(async (root) => {
    const runner = mock(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "pass",
    }));
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["run_check"],
        artifactDir: ".utility-artifacts",
        commandCwds: ["."],
        exactCommand: ["bun", "test", "tests/example.test.ts"],
        readScopes: ["tests/example.test.ts"],
        repoRoot: root,
        writeScopes: [],
      },
      { runCommand: runner }
    );
    expect(
      await broker.execute({
        arguments: {
          argv: ["bun", "test", "tests/example.test.ts"],
          cwd: ".",
        },
        name: "run_check",
      })
    ).toMatchObject({ ok: true });
    expect(
      await broker.execute({
        arguments: { argv: ["bun", "test", "src/hello.ts"], cwd: "." },
        name: "run_check",
      })
    ).toMatchObject({ error: { code: "command_denied" }, ok: false });
    expect(
      await broker.execute({
        arguments: {
          argv: [
            "bun",
            "test",
            "tests/example.test.ts",
            "tests/example.test.ts",
          ],
          cwd: ".",
        },
        name: "run_check",
      })
    ).toMatchObject({ error: { code: "command_denied" }, ok: false });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

test("focused checks reject files above the configured input bound", async () => {
  await withRepo(async (root) => {
    const oversizedPath = "tests/oversized.test.ts";
    await writeFile(join(root, oversizedPath), "x".repeat(1024 * 1024 + 1));
    const runner = mock(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "pass",
    }));
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["run_check"],
        artifactDir: ".utility-artifacts",
        commandCwds: ["."],
        exactCommand: ["bun", "test", oversizedPath],
        readScopes: [oversizedPath],
        repoRoot: root,
        writeScopes: [],
      },
      { runCommand: runner }
    );
    expect(
      await broker.execute({
        arguments: { argv: ["bun", "test", oversizedPath], cwd: "." },
        name: "run_check",
      })
    ).toMatchObject({ error: { code: "output_limit" }, ok: false });
    expect(runner).not.toHaveBeenCalled();
  });
});

test("broker rejects a tampered focused check with more than four files", async () => {
  await withRepo(async (root) => {
    const paths = Array.from(
      { length: 5 },
      (_, index) => `tests/${index + 1}.test.ts`
    );
    await Promise.all(
      paths.map((path) => writeFile(join(root, path), "export {};\n"))
    );
    const argv = ["bun", "test", ...paths];
    const runner = mock(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "pass",
    }));
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["run_check"],
        artifactDir: ".utility-artifacts",
        commandCwds: ["."],
        exactCommand: argv,
        readScopes: paths,
        repoRoot: root,
        writeScopes: [],
      },
      { runCommand: runner }
    );
    expect(
      await broker.execute({
        arguments: { argv, cwd: "." },
        name: "run_check",
      })
    ).toMatchObject({ error: { code: "command_denied" }, ok: false });
    expect(runner).not.toHaveBeenCalled();
  });
});

test("git_diff supports bounded commit comparison and diff check", async () => {
  await withRepo(async (root) => {
    let captured: CommandRequest | undefined;
    const broker = await createUtilityToolBroker(
      {
        artifactDir: ".utility-artifacts",
        readScopes: ["src"],
        repoRoot: root,
        writeScopes: [],
      },
      {
        runCommand: (request) => {
          captured = request;
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
        },
      }
    );
    expect(
      await broker.execute({
        arguments: {
          baseRef: "28968b22",
          check: true,
          headRef: "e5bf6dc2",
          nameOnly: true,
        },
        name: "git_diff",
      })
    ).toMatchObject({ ok: true });
    expect(captured?.argv).toEqual(
      expect.arrayContaining([
        "--check",
        "--name-only",
        "28968b22...e5bf6dc2",
        "--",
        "src",
      ])
    );
    expect(
      (
        await broker.execute({
          arguments: { baseRef: "--output=/tmp/escape" },
          name: "git_diff",
        })
      ).error?.code
    ).toBe("invalid_arguments");
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
        runCommand: (request) => {
          captured = request;
          return Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: "vitest pass",
          });
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
        runCommand: (request) => {
          captured = request;
          return Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: "vitest pass",
          });
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
        runCommand: (request) => {
          captured = request;
          return Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: "vitest pass",
          });
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

test("treats an exact declared new write file as an empty search domain", async () => {
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker(
      {
        artifactDir: ".new-file-artifacts",
        exactWriteScopes: true,
        readScopes: ["src"],
        repoRoot: root,
        writeScopes: ["src/new.ts"],
      },
      { id: () => "new-file-patch", now: () => 1_700_000_000_000 }
    );
    const search = await broker.execute({
      arguments: { paths: ["src/new.ts"], query: "export" },
      name: "search_repo",
    });
    expect(search).toMatchObject({ data: [], ok: true });

    const outsideScope = await broker.execute({
      arguments: { paths: ["tests/missing.ts"], query: "export" },
      name: "search_repo",
    });
    expect(outsideScope.error?.code).toBe("scope_denied");

    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export const created = true;",
      "",
    ].join("\n");
    const proposal = await broker.execute({
      arguments: { patch, summary: "new exact file" },
      name: "propose_patch",
    });
    expect(proposal).toMatchObject({
      data: {
        preimages: [{ path: "src/new.ts", sha256: null }],
        targets: ["src/new.ts"],
      },
      ok: true,
    });
    await expect(lstat(join(root, "src", "new.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

test("exact edit scopes cannot act as directory-wide patch authority", async () => {
  await withRepo(async (root) => {
    const patch = [
      "diff --git a/src/hello.ts b/src/hello.ts",
      "--- a/src/hello.ts",
      "+++ b/src/hello.ts",
      "@@ -1 +1 @@",
      "-export const hello = 'world';",
      "+export const hello = 'au-pair';",
      "",
    ].join("\n");
    const exact = await createUtilityToolBroker(
      {
        artifactDir: ".exact-utility-artifacts",
        exactWriteScopes: true,
        readScopes: ["src/hello.ts"],
        repoRoot: root,
        writeScopes: ["src/hello.ts"],
      },
      { id: () => "exact-patch", now: () => 1_700_000_000_000 }
    );
    expect(
      await exact.execute({ arguments: { patch }, name: "propose_patch" })
    ).toMatchObject({ ok: true });

    const directoryBroad = await createUtilityToolBroker(
      {
        artifactDir: ".broad-utility-artifacts",
        exactWriteScopes: true,
        readScopes: ["src"],
        repoRoot: root,
        writeScopes: ["src"],
      },
      { id: () => "broad-patch", now: () => 1_700_000_000_000 }
    );
    const denied = await directoryBroad.execute({
      arguments: { patch },
      name: "propose_patch",
    });
    expect(denied.error).toMatchObject({
      code: "patch_denied",
      message: "Patch target is not an exact declared write file: src/hello.ts",
    });
  });
});

test("guarded apply enforces exact scopes and patch size for legacy artifacts", async () => {
  await withRepo(async (root) => {
    const artifactDir = join(root, ".legacy-utility-artifacts");
    await mkdir(artifactDir);
    const patchPath = join(artifactDir, "legacy.patch");
    const manifestPath = join(artifactDir, "legacy.json");
    const patch = [
      "diff --git a/src/hello.ts b/src/hello.ts",
      "--- a/src/hello.ts",
      "+++ b/src/hello.ts",
      "@@ -1 +1 @@",
      "-export const hello = 'world';",
      "+export const hello = 'legacy';",
      "",
    ].join("\n");
    await writeFile(patchPath, patch);
    const manifest = JSON.stringify({
      createdAt: "2026-07-28T12:00:00.000Z",
      patchPath,
      preimages: [
        {
          path: "src/hello.ts",
          sha256: createHash("sha256")
            .update("export const hello = 'world';\n")
            .digest("hex"),
        },
      ],
    });
    await writeFile(manifestPath, manifest);
    const apply = (
      broker: Awaited<ReturnType<typeof createUtilityToolBroker>>
    ) =>
      broker.applyPatchProposal({
        appliedBy: "codex",
        expectedManifestSha256: createHash("sha256")
          .update(manifest)
          .digest("hex"),
        expectedPatchSha256: createHash("sha256").update(patch).digest("hex"),
        manifestPath,
        patchPath,
      });

    const broad = await createUtilityToolBroker({
      artifactDir: ".legacy-utility-artifacts",
      commandAllowlist: [],
      exactWriteScopes: true,
      readScopes: ["src"],
      repoRoot: root,
      writeScopes: ["src"],
    });
    await expect(apply(broad)).rejects.toThrow(
      "Patch target is not an exact declared write file"
    );

    const oversized = await createUtilityToolBroker({
      artifactDir: ".legacy-utility-artifacts",
      commandAllowlist: [],
      exactWriteScopes: true,
      limits: { maxPatchBytes: 32 },
      readScopes: ["src/hello.ts"],
      repoRoot: root,
      writeScopes: ["src/hello.ts"],
    });
    await expect(apply(oversized)).rejects.toThrow(
      "Patch exceeds the configured size limit"
    );
    expect(await readFile(join(root, "src", "hello.ts"), "utf8")).toContain(
      "world"
    );
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
