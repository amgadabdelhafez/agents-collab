import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP_VERSION } from "../../src/loop/constants";

const tempPaths: string[] = [];

const run = (args: string[], cwd = process.cwd()) =>
  spawnSync(process.execPath, [join(process.cwd(), "src", "cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
  });

const git = (repo: string, args: string[]): void => {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-04T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-04T10:00:00Z",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim());
  }
};

const repository = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "loop-world-cli-repo-"));
  tempPaths.push(repo);
  writeFileSync(join(repo, "README.md"), "# Fixture\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@example.test"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-qm", "fixture"]);
  return repo;
};

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

test("loop world builds and queries a local producer-backed database", () => {
  const repo = repository();
  const root = mkdtempSync(join(tmpdir(), "loop-world-cli-db-"));
  tempPaths.push(root);
  const databasePath = join(root, "world.sqlite");

  const build = run(["world", "build", "--repo", repo, "--db", databasePath]);
  expect(build.status).toBe(0);
  expect(build.stderr).toBe("");
  expect(existsSync(databasePath)).toBe(true);
  expect(JSON.parse(build.stdout)).toMatchObject({
    entityCount: 3,
    repositoryPath: realpathSync(repo),
  });

  const context = run([
    "world",
    "context",
    "--db",
    databasePath,
    "--seed",
    "README.md",
    "--depth",
    "1",
    "--limit",
    "10",
  ]);
  expect(context.status).toBe(0);
  expect(JSON.parse(context.stdout)).toMatchObject({
    ontologyVersion: "loop-world-v1",
    unknownSeeds: [],
  });
});

test("loop world fails nonzero for corrupt or authority-escalating input", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-world-cli-invalid-"));
  tempPaths.push(root);
  const databasePath = join(root, "world.sqlite");
  const assertionPath = join(root, "assertion.json");
  writeFileSync(
    assertionPath,
    JSON.stringify({
      evidenceContent: "untrusted",
      evidenceSource: "fixture:untrusted",
      object: { key: "deployment:1", type: "Deployment" },
      predicate: "deployed_as",
      status: "observed",
      subject: { key: "candidate:1", type: "ReleaseCandidate" },
    })
  );

  const result = run([
    "world",
    "ingest",
    "--db",
    databasePath,
    "--file",
    assertionPath,
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("cannot create observed statements");
});

test("world command dispatch does not change ordinary immediate CLI handling", () => {
  const version = run(["--version"]);
  expect(version.status).toBe(0);
  expect(version.stdout.trim()).toBe(`loop v${LOOP_VERSION}`);

  const ontology = run(["world", "ontology"]);
  expect(ontology.status).toBe(0);
  expect(JSON.parse(ontology.stdout)).toMatchObject({
    version: "loop-world-v1",
  });
});
