import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeGitRepository,
  WorldModelStore,
} from "../../src/loop/world-model";

const FIXED_DATE = "2026-08-04T10:00:00Z";
const SECOND_DATE = "2026-08-04T11:00:00Z";
const tempPaths: string[] = [];

const runGit = (repo: string, args: string[], date = FIXED_DATE): string => {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim());
  }
  return result.stdout.trim();
};

const fixtureRepository = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "loop-world-repo-"));
  tempPaths.push(repo);
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "docs"));
  mkdirSync(join(repo, "specs"));
  mkdirSync(join(repo, "tests"));
  writeFileSync(
    join(repo, "src", "main.ts"),
    'import { value } from "./value";\nexport const answer = value;\n'
  );
  writeFileSync(join(repo, "src", "value.ts"), "export const value = 42;\n");
  writeFileSync(
    join(repo, "docs", "overview.md"),
    "# Overview\n\nSee [[../specs/spec]] and [source](../src/main.ts).\n"
  );
  writeFileSync(join(repo, "specs", "spec.md"), "# Requirement\n");
  writeFileSync(join(repo, "tests", "main.test.ts"), "// producer fixture\n");
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.email", "fixture@example.test"]);
  runGit(repo, ["config", "user.name", "Fixture"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-qm", "fixture"]);
  return repo;
};

const fixtureStore = (): { databasePath: string; store: WorldModelStore } => {
  const root = mkdtempSync(join(tmpdir(), "loop-world-db-"));
  tempPaths.push(root);
  const databasePath = join(root, "world.sqlite");
  return { databasePath, store: new WorldModelStore(databasePath) };
};

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("Project World Model materializer", () => {
  test("rebuilds an identical bounded graph from the same committed producer state", () => {
    const repo = fixtureRepository();
    const { store } = fixtureStore();
    const first = materializeGitRepository(store, repo);
    const firstContext = store.context({
      maxDepth: 3,
      maxStatements: 100,
      seeds: ["src/main.ts"],
    });
    const firstStatements = store.statements();

    const second = materializeGitRepository(store, repo);
    const secondContext = store.context({
      maxDepth: 3,
      maxStatements: 100,
      seeds: ["src/main.ts"],
    });

    expect(second).toEqual(first);
    expect(store.statements()).toEqual(firstStatements);
    expect(secondContext.capsuleSha256).toBe(firstContext.capsuleSha256);
    expect(
      firstStatements.every((item) => item.evidenceSha256.length === 64)
    ).toBe(true);
    expect(firstStatements.some((item) => item.predicate === "imports")).toBe(
      true
    );
    expect(
      firstStatements.some(
        (item) =>
          item.predicate === "depends_on" &&
          item.extractionMethod === "markdown-link"
      )
    ).toBe(true);
    expect(firstContext.unknownSeeds).toEqual([]);
    store.close();
  });

  test("binds changed file evidence to the new commit", () => {
    const repo = fixtureRepository();
    const { store } = fixtureStore();
    const first = materializeGitRepository(store, repo);
    const firstFile = store
      .entities()
      .find((entity) => entity.label === "src/value.ts");
    const firstHash = firstFile?.metadata.sha256;

    writeFileSync(join(repo, "src", "value.ts"), "export const value = 43;\n");
    runGit(repo, ["add", "src/value.ts"], SECOND_DATE);
    runGit(repo, ["commit", "-qm", "change value"], SECOND_DATE);
    const second = materializeGitRepository(store, repo);
    const secondFile = store
      .entities()
      .find((entity) => entity.label === "src/value.ts");

    expect(second.commitSha).not.toBe(first.commitSha);
    expect(secondFile?.metadata.sha256).not.toBe(firstHash);
    expect(
      store
        .statements()
        .filter((item) => item.subjectId === secondFile?.id)
        .every((item) => item.commitSha === second.commitSha)
    ).toBe(true);
    store.close();
  });

  test("replaces deterministic projection without deleting explicit assertions", () => {
    const repo = fixtureRepository();
    const { store } = fixtureStore();
    materializeGitRepository(store, repo);
    const assertion = store.ingestAssertion({
      evidenceContent: "curated decision",
      evidenceSource: "fixture:curated-decision",
      object: { key: "deployment:curated", type: "Deployment" },
      predicate: "deployed_as",
      status: "asserted",
      subject: { key: "candidate:curated", type: "ReleaseCandidate" },
    });

    materializeGitRepository(store, repo);

    expect(store.statement(assertion.id)).toMatchObject({
      authorityClass: "candidate",
      status: "asserted",
    });
    store.close();
  });

  test("marks explicit count and depth truncation instead of hiding it", () => {
    const repo = fixtureRepository();
    const { store } = fixtureStore();
    materializeGitRepository(store, repo);

    const capsule = store.context({
      maxDepth: 1,
      maxStatements: 1,
      seeds: [repo],
    });

    expect(capsule.statements).toHaveLength(1);
    expect(capsule.truncation.statementLimitHit).toBe(true);
    const zeroDepth = store.context({
      maxDepth: 0,
      maxStatements: 10,
      seeds: [repo],
    });
    expect(zeroDepth.statements).toHaveLength(0);
    expect(zeroDepth.truncation.depthLimitHit).toBe(true);
    store.close();
  });
});

describe("Project World Model assertions and time", () => {
  test("fails closed for ontology corruption and empty evidence", () => {
    const { databasePath, store } = fixtureStore();
    expect(() =>
      store.ingestAssertion({
        evidenceSource: "fixture:empty",
        object: { key: "deployment:empty", type: "Deployment" },
        predicate: "deployed_as",
        status: "asserted",
        subject: { key: "candidate:empty", type: "ReleaseCandidate" },
      })
    ).toThrow("requires evidence content or SHA-256");
    store.close();

    const database = new Database(databasePath);
    database.run(
      "UPDATE world_meta SET value = 'unknown-ontology' WHERE key = 'ontology_version'"
    );
    database.close();

    expect(() => new WorldModelStore(databasePath)).toThrow(
      "ontology mismatch"
    );
  });

  test("rejects candidate observations and preserves temporal supersession", () => {
    const { store } = fixtureStore();
    const base = {
      evidenceContent: "founder statement",
      evidenceSource: "fixture:founder-message-1",
      object: { key: "deploy:a", type: "Deployment" },
      predicate: "deployed_as",
      status: "asserted",
      subject: { key: "candidate:1", type: "ReleaseCandidate" },
    } as const;
    expect(() =>
      store.ingestAssertion({ ...base, status: "observed" })
    ).toThrow("cannot create observed statements");

    const oldStatement = store.ingestAssertion({
      ...base,
      observedAt: FIXED_DATE,
      validFrom: FIXED_DATE,
    });
    const newStatement = store.ingestAssertion({
      ...base,
      evidenceContent: "superseding founder statement",
      evidenceSource: "fixture:founder-message-2",
      object: { key: "deploy:b", type: "Deployment" },
      observedAt: SECOND_DATE,
      supersedesId: oldStatement.id,
      validFrom: SECOND_DATE,
    });

    expect(store.statement(oldStatement.id)).toMatchObject({
      status: "superseded",
      validTo: new Date(SECOND_DATE).toISOString(),
    });
    const historical = store.context({
      at: "2026-08-04T10:30:00Z",
      seeds: ["candidate:1"],
    });
    const current = store.context({ seeds: ["candidate:1"] });
    expect(historical.statements.map((item) => item.id)).toContain(
      oldStatement.id
    );
    expect(current.statements.map((item) => item.id)).toContain(
      newStatement.id
    );
    expect(current.supersessionHistory.map((item) => item.id)).toContain(
      oldStatement.id
    );
    store.close();
  });

  test("reports contradictory current single-valued assertions with both sources", () => {
    const { store } = fixtureStore();
    const common = {
      observedAt: FIXED_DATE,
      predicate: "deployed_as",
      status: "asserted",
      subject: { key: "candidate:conflict", type: "ReleaseCandidate" },
    } as const;
    const first = store.ingestAssertion({
      ...common,
      evidenceContent: "first",
      evidenceSource: "fixture:first",
      object: { key: "deployment:first", type: "Deployment" },
    });
    const second = store.ingestAssertion({
      ...common,
      evidenceContent: "second",
      evidenceSource: "fixture:second",
      object: { key: "deployment:second", type: "Deployment" },
    });
    const context = store.context({ seeds: ["candidate:conflict"] });

    expect(context.contradictions).toHaveLength(1);
    expect(context.contradictions[0]?.statementIds).toEqual(
      [first.id, second.id].sort()
    );
    expect(
      context.statements.map((item) => item.evidenceSource).sort()
    ).toEqual(["fixture:first", "fixture:second"]);
    store.close();
  });
});
