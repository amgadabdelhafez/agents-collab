import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDelegationEvent,
  classifyDelegationIntent,
  makeDelegationEvent,
  readDelegationEvents,
  recordCodexAppServerDelegationCandidate,
  resolveUtilityDelegationMode,
} from "../../src/loop/delegation-policy";

const ROOT = "/repo";

const classify = (
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd = ROOT
) =>
  classifyDelegationIntent({
    agent: "claude",
    cwd,
    repoRoot: ROOT,
    toolInput,
    toolName,
    toolUseId: "tool-1",
  });

describe("delegation classifier", () => {
  test("routes large safe reads but keeps small and governing reads direct", () => {
    expect(
      classify("Read", { file_path: "/repo/src/parser.ts", limit: 300 })
    ).toMatchObject({
      eligible: true,
      operation: "large-read",
      request: { readScope: ["src/parser.ts"] },
    });
    expect(
      classify("Read", { file_path: "src/parser.ts", limit: 80 })
    ).toMatchObject({ eligible: false, reason: "small-context-read" });
    expect(
      classify("Read", {
        file_path: "specs/lower-agent-adoption/spec.md",
        limit: 300,
      })
    ).toMatchObject({ eligible: false, reason: "governed-or-unsafe-path" });
    expect(
      classify("Read", { file_path: "../outside.txt", limit: 300 })
    ).toMatchObject({ eligible: false, reason: "governed-or-unsafe-path" });
  });

  test.each([
    "AGENTS.md",
    ".aws/config",
    ".claude/settings.json",
    "packages/api/.aws/config",
    "packages/api/.claude/settings.json",
    "fixtures/repo/.git/config",
    "packages/api/specs/auth/spec.md",
    "packages/api/docs/architecture/invariants.md",
    ".github/copilot-instructions.md",
    ".github/copilot/mcp.json",
    ".github/agents/reviewer.agent.md",
    ".cursor/rules/project.mdc",
    ".gemini/settings.json",
    ".windsurfrules",
    ".vscode/mcp.json",
    ".mcp.json",
    ".CLAUDE/settings.json",
    "packages/api/.AWS/config",
    "fixtures/repo/.GIT/config",
    "docs/architecture/system-overview.md",
    ".loop/utility-policy.json",
    ".env.local",
    ".ssh/id_ed25519",
    "package.json",
  ])("keeps protected or governing read direct: %s", (filePath) => {
    expect(classify("Read", { file_path: filePath, limit: 300 })).toMatchObject(
      { eligible: false, reason: "governed-or-unsafe-path" }
    );
  });

  test.each([
    ["Read", { file_path: ".claude/settings.json", limit: 300 }],
    ["Grep", { path: ".aws", pattern: "profile" }],
    ["Glob", { path: ".claude", pattern: ".claude/**/*.json" }],
    ["Bash", { command: "rg profile .aws" }],
    ["Bash", { command: "git diff -- .claude/settings.json" }],
    ["Bash", { command: "sed -n '1,300p' .aws/config" }],
    ["Bash", { command: "bun test .claude/hooks.test.ts" }],
    ["Bash", { command: "rg profile packages/api/.aws" }],
    ["Bash", { command: "sed -n '1,300p' .github/copilot-instructions.md" }],
    ["Bash", { command: "rg rule packages/api/.CURSOR" }],
  ])("rejects protected scope for every enforceable tool grammar: %s", (tool, input) => {
    expect(classify(tool, input)).toMatchObject({ eligible: false });
  });

  test("routes bounded searches and globs without widening their scope", () => {
    expect(
      classify("Grep", { path: "src/loop", pattern: "route_task" })
    ).toMatchObject({
      eligible: true,
      operation: "scoped-search",
      request: { readScope: ["src/loop"] },
    });
    expect(classify("Grep", { pattern: "route_task" })).toMatchObject({
      eligible: false,
      reason: "unbounded-or-sensitive-search",
    });
    expect(classify("Glob", { pattern: "src/loop/**/*.ts" })).toMatchObject({
      eligible: true,
      operation: "scoped-glob",
      request: { readScope: ["src/loop"] },
    });
    expect(classify("Glob", { pattern: "**/*.ts" })).toMatchObject({
      eligible: false,
      reason: "glob-without-bounded-base",
    });
  });

  test.each([
    ["git status --short", "git-status", ["."]],
    ["git diff -- src/loop/tmux.ts", "git-diff", ["src/loop/tmux.ts"]],
    ["rg -n 'route|worker' src/loop", "scoped-search", ["src/loop"]],
    ["sed -n '20,80p' src/loop/tmux.ts", "source-slice", ["src/loop/tmux.ts"]],
    [
      "npx vitest run tests/router.test.ts",
      "focused-check",
      ["tests/router.test.ts"],
    ],
    [
      "bun test tests/router.test.ts",
      "focused-check",
      ["tests/router.test.ts"],
    ],
  ])("routes exact mechanical command %s", (command, operation, readScope) => {
    expect(classify("Bash", { command })).toMatchObject({
      eligible: true,
      operation,
      request: { readScope },
    });
  });

  test("normalizes package-relative command paths for the root-scoped broker", () => {
    const classified = classify(
      "Bash",
      { command: "npx vitest run tests/router.test.ts" },
      "/repo/packages/api"
    );
    expect(classified).toMatchObject({
      eligible: true,
      request: { readScope: ["packages/api/tests/router.test.ts"] },
    });
    if (classified.eligible) {
      expect(classified.request.objective).toContain(
        '["npx","vitest","run","packages/api/tests/router.test.ts"]'
      );
      expect(classified.request.objective).not.toContain(
        '["npx","vitest","run","tests/router.test.ts"]'
      );
    }
  });

  test.each([
    ["git diff", "git-diff-without-path-scope"],
    ["git commit -am done", "command-not-in-delegation-grammar"],
    ["rg route src && npm test", "compound-or-unsafe-command"],
    ["npx vitest run", "focused-check-without-safe-scope"],
    ["sed -n '1,900p' src/loop/tmux.ts", "source-slice-out-of-bounds"],
    ["echo API_KEY=abcdefghijklmnop", "compound-or-unsafe-command"],
  ])("keeps unsafe or ambiguous command direct: %s", (command, reason) => {
    expect(classify("Bash", { command })).toMatchObject({
      eligible: false,
      reason,
    });
  });

  test("uses enforce by default and observe for invalid modes", () => {
    expect(resolveUtilityDelegationMode(undefined)).toBe("enforce");
    expect(resolveUtilityDelegationMode("enforce")).toBe("enforce");
    expect(resolveUtilityDelegationMode("observe")).toBe("observe");
    expect(resolveUtilityDelegationMode("off")).toBe("off");
    expect(resolveUtilityDelegationMode("surprise")).toBe("observe");
  });
});

test("delegation telemetry is compact, durable, and tolerant of missing files", () => {
  const runDir = mkdtempSync(join(tmpdir(), "delegation-events-"));
  expect(readDelegationEvents(runDir)).toEqual([]);
  appendDelegationEvent(
    runDir,
    makeDelegationEvent(
      {
        agent: "claude",
        disposition: "auto-routed",
        fingerprint: "f".repeat(64),
        operation: "git-status",
        reason: "git-status",
        source: "claude-hook",
        taskId: "job-1",
      },
      "2026-07-26T20:00:00.000Z"
    )
  );
  appendDelegationEvent(
    runDir,
    makeDelegationEvent(
      {
        agent: "claude",
        disposition: "auto-routed",
        fingerprint: "f".repeat(64),
        operation: "git-status",
        reason: "git-status",
        source: "claude-hook",
        taskId: "job-1",
      },
      "2026-07-26T20:00:01.000Z"
    )
  );
  expect(readDelegationEvents(runDir)).toEqual([
    expect.objectContaining({ disposition: "auto-routed", taskId: "job-1" }),
  ]);
  rmSync(runDir, { force: true, recursive: true });
});

test("Codex app-server observation records only exact missed candidates", () => {
  const events: unknown[] = [];
  const append = (_runDir: string, event: unknown) => events.push(event);
  expect(
    recordCodexAppServerDelegationCandidate(
      "/run",
      ROOT,
      {
        item: {
          command: "git status --short",
          cwd: ROOT,
          id: "command-1",
          type: "commandExecution",
        },
      },
      "2026-07-26T20:00:00.000Z",
      append
    )
  ).toBe(true);
  expect(events).toEqual([
    expect.objectContaining({
      agent: "codex",
      disposition: "missed-candidate",
      operation: "git-status",
      source: "codex-app-server",
    }),
  ]);
  expect(
    recordCodexAppServerDelegationCandidate(
      "/run",
      ROOT,
      { item: { command: "npm install", type: "commandExecution" } },
      undefined,
      append
    )
  ).toBe(false);
  expect(events).toHaveLength(1);
});
