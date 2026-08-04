import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  buildUtilityContextCapsule,
  MAX_UTILITY_CONTEXT_REF_CHARS,
  MAX_UTILITY_CONTEXT_REFS_CHARS,
  MAX_UTILITY_INSTRUCTION_CHARS,
  persistUtilityContextCapsule,
  utilityContextPath,
  utilityContextPrompt,
} from "../../src/loop/utility-context";
import {
  isUtilityContextRefPath,
  isUtilityProtectedPath,
} from "../../src/loop/utility-path-policy";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const request = (contextRefs?: string[]) =>
  createUtilityRouteRequest(
    {
      acceptanceCriteria: ["return source-backed evidence"],
      authority: {},
      ...(contextRefs ? { contextRefs } : {}),
      kind: "inspect",
      objective: "Inspect the bounded source",
      readScope: ["src"],
      requester: "codex",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    },
    {
      now: () => "2026-07-27T12:00:00.000Z",
      randomId: () => "context-job",
    }
  );

test("builds a deterministic bounded capsule and persists the exact prompt", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "utility-context-"));
  const runDir = join(repoRoot, ".loop", "runs", "context");
  try {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(
      join(repoRoot, "UTILITY.instructions.md"),
      `project-guidance-${"p".repeat(MAX_UTILITY_INSTRUCTION_CHARS)}`
    );
    writeFileSync(join(repoRoot, "docs", "guide.md"), "selected-guide");
    const routeRequest = request(["./docs/guide.md"]);
    const first = buildUtilityContextCapsule({
      repoRoot,
      request: routeRequest,
    });
    const second = buildUtilityContextCapsule({
      repoRoot,
      request: routeRequest,
    });

    expect(first).toEqual(second);
    expect(first.sha256).toMatch(SHA256_HEX_RE);
    expect(first.projectInstructions).toMatchObject({
      path: "UTILITY.instructions.md",
      status: "loaded",
      truncated: true,
    });
    expect(first.projectInstructions.text?.length).toBe(
      MAX_UTILITY_INSTRUCTION_CHARS
    );
    expect(first.references).toEqual([
      expect.objectContaining({
        path: "docs/guide.md",
        status: "loaded",
        text: "selected-guide",
      }),
    ]);
    expect(first.request).toEqual(routeRequest);
    expect(first.writeTargets).toEqual([]);
    expect(first.workspace.name).toBe(repoRoot.split("/").at(-1));
    expect(first.workspace.rootSha256).toMatch(SHA256_HEX_RE);

    const path = persistUtilityContextCapsule(runDir, routeRequest.id, first);
    expect(path).toBe(utilityContextPath(runDir, routeRequest.id));
    expect(readFileSync(path, "utf8").trim()).toBe(utilityContextPrompt(first));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("binds existing and new write-target state into the capsule hash", () => {
  const repoRoot = mkdtempSync(
    join(tmpdir(), "utility-context-write-targets-")
  );
  try {
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "existing.ts"), "existing\n");
    const routeRequest = createUtilityRouteRequest({
      acceptanceCriteria: ["propose the exact files"],
      authority: {},
      kind: "edit",
      objective: "Add one file and update one file",
      readScope: ["src"],
      requester: "codex",
      requiredCapabilities: ["inspect", "scoped-edit"],
      risk: "low",
      writeScope: ["src/existing.ts", "src/new.ts"],
    });
    const before = buildUtilityContextCapsule({
      repoRoot,
      request: routeRequest,
    });
    expect(before.writeTargets).toEqual([
      { path: "src/existing.ts", state: "existing" },
      { path: "src/new.ts", state: "new" },
    ]);
    writeFileSync(join(repoRoot, "src", "new.ts"), "created\n");
    const after = buildUtilityContextCapsule({
      repoRoot,
      request: routeRequest,
    });
    expect(after.writeTargets[1]).toEqual({
      path: "src/new.ts",
      state: "existing",
    });
    expect(after.sha256).not.toBe(before.sha256);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("missing instructions are valid and selected refs obey per-file and total budgets", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "utility-context-budget-"));
  try {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    const refs = Array.from({ length: 7 }, (_, index) => `docs/${index}.md`);
    for (const ref of refs) {
      writeFileSync(join(repoRoot, ref), "x".repeat(5000));
    }
    const capsule = buildUtilityContextCapsule({
      repoRoot,
      request: request(refs),
    });
    expect(capsule.projectInstructions).toEqual({
      path: "UTILITY.instructions.md",
      status: "missing",
    });
    expect(capsule.references).toHaveLength(6);
    expect(
      capsule.references.reduce(
        (total, reference) => total + (reference.text?.length ?? 0),
        0
      )
    ).toBe(MAX_UTILITY_CONTEXT_REFS_CHARS);
    expect(
      capsule.references.every(
        (reference) =>
          (reference.text?.length ?? 0) <= MAX_UTILITY_CONTEXT_REF_CHARS
      )
    ).toBe(true);
    expect(capsule.references.at(-1)).toMatchObject({
      status: "loaded",
      text: "",
      truncated: true,
    });
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("rejects invalid context paths, symlinks, directories, and governing files", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "utility-context-reject-"));
  try {
    mkdirSync(join(repoRoot, "docs", "folder.md"), { recursive: true });
    mkdirSync(join(repoRoot, "real-docs"), { recursive: true });
    writeFileSync(join(repoRoot, "outside.md"), "outside");
    writeFileSync(join(repoRoot, "real-docs", "inner.md"), "inner");
    symlinkSync(
      join(repoRoot, "outside.md"),
      join(repoRoot, "docs", "linked.md")
    );
    symlinkSync(
      join(repoRoot, "outside.md"),
      join(repoRoot, "UTILITY.instructions.md")
    );
    symlinkSync(
      join(repoRoot, "real-docs"),
      join(repoRoot, "docs", "linked-dir")
    );
    const capsule = buildUtilityContextCapsule({
      repoRoot,
      request: request([
        "../README.md",
        "docs/../README.md",
        "/tmp/README.md",
        "AGENTS.md",
        "docs/linked.md",
        "docs/linked-dir/inner.md",
        "docs/folder.md",
      ]),
    });
    expect(capsule.projectInstructions).toEqual({
      path: "UTILITY.instructions.md",
      status: "rejected",
    });
    expect(capsule.references.map((reference) => reference.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(isUtilityContextRefPath("README.md")).toBe(true);
    expect(isUtilityContextRefPath("docs/guide.md")).toBe(true);
    expect(isUtilityContextRefPath("specs/router/spec.md")).toBe(true);
    expect(isUtilityContextRefPath("docs/.ssh/key.md")).toBe(false);
    expect(isUtilityContextRefPath("src/readme.md")).toBe(false);
    expect(isUtilityProtectedPath("UTILITY.instructions.md")).toBe(true);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("capsule hash changes when selected context changes", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "utility-context-hash-"));
  try {
    writeFileSync(join(repoRoot, "README.md"), "first");
    const routeRequest = request(["README.md"]);
    const first = buildUtilityContextCapsule({
      repoRoot,
      request: routeRequest,
    });
    writeFileSync(join(repoRoot, "README.md"), "second");
    const second = buildUtilityContextCapsule({
      repoRoot,
      request: routeRequest,
    });
    expect(first.sha256).not.toBe(second.sha256);
    expect(first.references[0]?.sha256).not.toBe(second.references[0]?.sha256);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});
