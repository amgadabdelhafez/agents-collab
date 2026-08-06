import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PairedLaunchClaim } from "../../src/loop/launch-reservation";
import {
  createRunManifest,
  type RunStorage,
  readRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";
import { prepareRunWorldModel } from "../../src/loop/world-model-runtime";

const git = (repo: string, args: string[]): string => {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
};

const fixtureRepository = (root: string): string => {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "specs", "feature"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(
    join(repo, "AGENTS.md"),
    "# Agents\n\n[Spec](specs/feature/spec.md)\n"
  );
  writeFileSync(join(repo, "README.md"), "# Fixture\n");
  writeFileSync(join(repo, "src", "entry.ts"), 'import "./worker";\n');
  writeFileSync(join(repo, "src", "worker.ts"), "export const worker = 1;\n");
  writeFileSync(join(repo, "specs", "feature", "spec.md"), "# Feature\n");
  writeFileSync(join(repo, "tests", "entry.test.ts"), "// producer fixture\n");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "loop@example.test"]);
  git(repo, ["config", "user.name", "Loop Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture"]);
  return repo;
};

const claimFor = (
  root: string,
  repo: string,
  runId: string
): PairedLaunchClaim => {
  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const storage: RunStorage = {
    manifestPath: join(runDir, "manifest.json"),
    repoId: "repo-fixture",
    runDir,
    runId,
    storageRoot: join(root, "runs"),
    transcriptPath: join(runDir, "transcript.jsonl"),
  };
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cwd: repo,
      mode: "paired",
      pid: process.pid,
      repoId: storage.repoId,
      runId,
      workspaceBinding: { repoId: storage.repoId, root: repo },
    })
  );
  return {
    claimId: `claim-${runId}`,
    reserved: true,
    storage,
    workspaceBinding: { repoId: storage.repoId, root: repo },
  };
};

test("prepareRunWorldModel binds producer-backed task context to the run manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-world-runtime-"));
  try {
    const repo = fixtureRepository(root);
    const claim = claimFor(root, repo, "1");
    const binding = prepareRunWorldModel(
      claim,
      "Implement src/entry.ts according to specs/feature/spec.md"
    );
    const contextBytes = readFileSync(binding.contextPath);
    const context = JSON.parse(contextBytes.toString("utf8")) as {
      capsuleSha256: string;
      query: { maxDepth: number; maxStatements: number; seeds: string[] };
    };

    expect(binding.commitSha).toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(binding.seeds).toEqual(["specs/feature/spec.md", "src/entry.ts"]);
    expect(context.query).toMatchObject({
      maxDepth: 2,
      maxStatements: 120,
      seeds: binding.seeds,
    });
    expect(context.capsuleSha256).toBe(binding.capsuleSha256);
    expect(createHash("sha256").update(contextBytes).digest("hex")).toBe(
      binding.contextSha256
    );
    expect(
      binding.databasePath.startsWith(join(claim.storage.runDir, "world-model"))
    ).toBe(true);
    expect(
      binding.contextPath.startsWith(join(claim.storage.runDir, "world-model"))
    ).toBe(true);
    expect(binding.entityCount).toBeGreaterThan(0);
    expect(binding.statementCount).toBeGreaterThan(0);
    expect(readRunManifest(claim.storage.manifestPath)?.worldModel).toEqual(
      binding
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRunWorldModel uses deterministic fallback seeds and capsule", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-world-runtime-"));
  try {
    const repo = fixtureRepository(root);
    const first = prepareRunWorldModel(claimFor(root, repo, "1"));
    const second = prepareRunWorldModel(
      claimFor(root, repo, "2"),
      "task without a tracked entity label"
    );

    expect(first.seeds).toEqual(second.seeds);
    expect(first.seeds).toHaveLength(2);
    expect(first.capsuleSha256).toBe(second.capsuleSha256);
    expect(first.contextSha256).toBe(second.contextSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRunWorldModel fails closed without advertising partial context", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-world-runtime-"));
  try {
    const repo = join(root, "not-git");
    mkdirSync(repo);
    const claim = claimFor(root, repo, "1");

    expect(() => prepareRunWorldModel(claim, "task")).toThrow(
      "git rev-parse HEAD failed"
    );
    expect(
      readRunManifest(claim.storage.manifestPath)?.worldModel
    ).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRunWorldModel cleans producer artifacts when the manifest is absent at bind time", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-world-runtime-"));
  try {
    const repo = fixtureRepository(root);
    const claim = claimFor(root, repo, "1");
    rmSync(claim.storage.manifestPath);

    expect(() =>
      prepareRunWorldModel(
        claim,
        "Implement src/entry.ts according to specs/feature/spec.md"
      )
    ).toThrow(
      `Cannot bind World Model: run manifest is missing at ${claim.storage.manifestPath}`
    );

    expect(readdirSync(join(claim.storage.runDir, "world-model"))).toEqual([]);
    expect(readRunManifest(claim.storage.manifestPath)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
