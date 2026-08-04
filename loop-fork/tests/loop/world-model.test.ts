import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeGitRepository,
  WorldModelStore,
  worldSha256,
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

type PutStatementInput = Parameters<WorldModelStore["putStatement"]>[0];

const validStatementInput = (store: WorldModelStore): PutStatementInput => {
  const subject = store.putEntity({ key: "subject", type: "Claim" });
  const object = store.putEntity({ key: "object", type: "Evidence" });
  return {
    authorityClass: "candidate",
    confidence: 0.5,
    evidenceSha256: worldSha256("evidence"),
    evidenceSource: "fixture:evidence",
    extractionMethod: "fixture",
    objectId: object.id,
    observedAt: FIXED_DATE,
    predicate: "supports",
    sourceKind: "assertion",
    status: "asserted",
    subjectId: subject.id,
    validFrom: FIXED_DATE,
  };
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

describe("Project World Model fail-closed validation", () => {
  test("rejects an empty database path before SQLite opens", () => {
    expect(() => new WorldModelStore("  ")).toThrow(
      "world model database path cannot be empty"
    );
  });

  test("rejects a corrupt persisted entity type on read", () => {
    const repo = fixtureRepository();
    const { store } = fixtureStore();
    materializeGitRepository(store, repo);
    store.database.run("UPDATE world_entities SET type = 'UnknownEntity'");
    expect(() => store.entities()).toThrow(
      "world model contains unknown entity type: UnknownEntity"
    );
    store.close();
  });

  test("rejects a corrupt persisted predicate on read", () => {
    const repo = fixtureRepository();
    const { store } = fixtureStore();
    materializeGitRepository(store, repo);
    store.database.run(
      "UPDATE world_statements SET predicate = 'unknown_predicate'"
    );
    expect(() => store.statements()).toThrow(
      "world model contains unknown predicate: unknown_predicate"
    );
    store.close();
  });

  test("rejects a corrupt persisted status on read", () => {
    const repo = fixtureRepository();
    const { store } = fixtureStore();
    materializeGitRepository(store, repo);
    store.database.run("UPDATE world_statements SET status = 'unknown_status'");
    expect(() => store.statements()).toThrow(
      "world model contains unknown status: unknown_status"
    );
    store.close();
  });

  test("rejects a corrupt persisted evidence SHA-256 on read", () => {
    const repo = fixtureRepository();
    const { store } = fixtureStore();
    materializeGitRepository(store, repo);
    store.database.run("UPDATE world_statements SET evidence_sha256 = 'BAD'");
    expect(() => store.statements()).toThrow(
      "persisted evidenceSha256 must be a lowercase SHA-256"
    );
    store.close();
  });

  test.each([
    ["evidence source", "evidence_source"],
    ["extraction method", "extraction_method"],
  ] as const)("rejects a persisted statement without %s", (_name, column) => {
    const { store } = fixtureStore();
    store.putStatement(validStatementInput(store));
    store.database.run(`UPDATE world_statements SET ${column} = ''`);
    expect(() => store.statements()).toThrow(
      "world model contains statement without evidence source and extraction method"
    );
    store.close();
  });

  test.each([
    ["authority class", "authority_class"],
    ["source kind", "source_kind"],
  ] as const)("rejects a persisted statement without %s", (_name, column) => {
    const { store } = fixtureStore();
    store.putStatement(validStatementInput(store));
    store.database.run(`UPDATE world_statements SET ${column} = ''`);
    expect(() => store.statements()).toThrow(
      "world model contains statement without authority class and source kind"
    );
    store.close();
  });

  test("rejects persisted confidence outside 0..1", () => {
    const { store } = fixtureStore();
    store.putStatement(validStatementInput(store));
    store.database.run("UPDATE world_statements SET confidence = 1.01");
    expect(() => store.statements()).toThrow(
      "world model contains confidence outside 0..1"
    );
    store.close();
  });

  test.each([
    ["observedAt", "observed_at"],
    ["validFrom", "valid_from"],
    ["validTo", "valid_to"],
  ] as const)("rejects corrupt persisted %s", (name, column) => {
    const { store } = fixtureStore();
    store.putStatement(validStatementInput(store));
    store.database.run(`UPDATE world_statements SET ${column} = 'not-a-date'`);
    expect(() => store.statements()).toThrow(
      `persisted ${name} must be an ISO date`
    );
    store.close();
  });

  test("rejects malformed assertion evidence SHA-256 on ingest", () => {
    const { store } = fixtureStore();
    expect(() =>
      store.ingestAssertion({
        evidenceSha256: "BAD",
        evidenceSource: "fixture:bad-hash",
        object: { key: "object", type: "Evidence" },
        predicate: "supports",
        status: "asserted",
        subject: { key: "subject", type: "Claim" },
      })
    ).toThrow("evidenceSha256 must be a lowercase SHA-256");
    store.close();
  });

  test("rejects invalid observedAt independently", () => {
    const { store } = fixtureStore();
    const input = validStatementInput(store);
    expect(() =>
      store.putStatement({ ...input, observedAt: "not-a-date" })
    ).toThrow("observedAt must be an ISO date");
    store.close();
  });

  test("rejects invalid validFrom independently", () => {
    const { store } = fixtureStore();
    const input = validStatementInput(store);
    expect(() =>
      store.putStatement({ ...input, validFrom: "not-a-date" })
    ).toThrow("validFrom must be an ISO date");
    store.close();
  });

  test("rejects invalid validTo independently", () => {
    const { store } = fixtureStore();
    const input = validStatementInput(store);
    expect(() =>
      store.putStatement({ ...input, validTo: "not-a-date" })
    ).toThrow("validTo must be an ISO date");
    store.close();
  });

  test("rejects a temporal range ending at or before its start", () => {
    const { store } = fixtureStore();
    const input = validStatementInput(store);
    expect(() => store.putStatement({ ...input, validTo: FIXED_DATE })).toThrow(
      "world-model validTo must be after validFrom"
    );
    store.close();
  });

  test("rejects persisted temporal corruption on read", () => {
    const { store } = fixtureStore();
    store.putStatement(validStatementInput(store));
    store.database.run(
      "UPDATE world_statements SET valid_to = valid_from WHERE id = (SELECT id FROM world_statements LIMIT 1)"
    );
    expect(() => store.statements()).toThrow(
      "world model contains validTo at or before validFrom"
    );
    store.close();
  });

  test("rejects candidate deterministic-producer authority", () => {
    const { store } = fixtureStore();
    expect(() =>
      store.ingestAssertion({
        authorityClass: "deterministic-producer",
        evidenceContent: "candidate evidence",
        evidenceSource: "fixture:candidate",
        object: { key: "object", type: "Evidence" },
        predicate: "supports",
        status: "asserted",
        subject: { key: "subject", type: "Claim" },
      })
    ).toThrow(
      "candidate ingestion cannot claim deterministic-producer authority"
    );
    store.close();
  });

  test("rejects candidate ingestion without an evidence source", () => {
    const { store } = fixtureStore();
    expect(() =>
      store.ingestAssertion({
        evidenceContent: "candidate evidence",
        evidenceSource: "  ",
        object: { key: "object", type: "Evidence" },
        predicate: "supports",
        status: "asserted",
        subject: { key: "subject", type: "Claim" },
      })
    ).toThrow("candidate ingestion requires an evidence source");
    store.close();
  });

  test.each([
    ["unknown entity type", { key: "subject", type: "UnknownEntity" }],
    ["empty entity key", { key: "  ", type: "Claim" }],
  ] as const)("rejects %s", (_name, entity) => {
    const { store } = fixtureStore();
    expect(() => store.putEntity(entity)).toThrow();
    store.close();
  });

  test.each([
    [
      "predicate",
      { predicate: "unknown_predicate" },
      "unknown world-model predicate: unknown_predicate",
    ],
    [
      "status",
      { status: "unknown_status" },
      "unknown world-model status: unknown_status",
    ],
    [
      "observed authority",
      { authorityClass: "candidate", status: "observed" },
      "observed statements require deterministic-producer authority",
    ],
    [
      "evidence source",
      { evidenceSource: "" },
      "world-model statements require evidence source and extraction method",
    ],
    [
      "extraction method",
      { extractionMethod: "" },
      "world-model statements require evidence source and extraction method",
    ],
    [
      "authority class",
      { authorityClass: "" },
      "world-model statements require authority class and source kind",
    ],
    [
      "source kind",
      { sourceKind: "" },
      "world-model statements require authority class and source kind",
    ],
  ] as const)("rejects invalid direct statement %s", (_name, change, error) => {
    const { store } = fixtureStore();
    const input = validStatementInput(store);
    expect(() =>
      store.putStatement({ ...input, ...change } as PutStatementInput)
    ).toThrow(error);
    store.close();
  });

  test("rejects invalid confidence", () => {
    const { store } = fixtureStore();
    const input = validStatementInput(store);
    expect(() => store.putStatement({ ...input, confidence: 1.01 })).toThrow(
      "world-model confidence must be between 0 and 1"
    );
    store.close();
  });

  test("rejects missing statement evidence provenance", () => {
    const { store } = fixtureStore();
    const input = validStatementInput(store);
    expect(() => store.putStatement({ ...input, evidenceSource: "" })).toThrow(
      "world-model statements require evidence source and extraction method"
    );
    store.close();
  });

  test("rejects a missing superseded statement", () => {
    const { store } = fixtureStore();
    const input = validStatementInput(store);
    expect(() =>
      store.putStatement({ ...input, supersedesId: "statement:missing" })
    ).toThrow("superseded statement not found: statement:missing");
    store.close();
  });

  test("rejects unknown candidate predicate", () => {
    const { store } = fixtureStore();
    expect(() =>
      store.ingestAssertion({
        evidenceContent: "candidate evidence",
        evidenceSource: "fixture:candidate",
        object: { key: "object", type: "Evidence" },
        predicate: "unknown_predicate",
        status: "asserted",
        subject: { key: "subject", type: "Claim" },
      })
    ).toThrow("unknown world-model predicate: unknown_predicate");
    store.close();
  });

  test("rejects unknown candidate status", () => {
    const { store } = fixtureStore();
    expect(() =>
      store.ingestAssertion({
        evidenceContent: "candidate evidence",
        evidenceSource: "fixture:candidate",
        object: { key: "object", type: "Evidence" },
        predicate: "supports",
        status: "unknown_status",
        subject: { key: "subject", type: "Claim" },
      })
    ).toThrow("invalid candidate statement status: unknown_status");
    store.close();
  });

  test("rejects empty seeds and each context bound independently", () => {
    const { store } = fixtureStore();
    expect(() => store.context({ seeds: ["  "] })).toThrow(
      "world context requires at least one non-empty seed"
    );
    expect(() => store.context({ maxDepth: 11, seeds: ["subject"] })).toThrow(
      "world context maxDepth must be an integer from 0 to 10"
    );
    expect(() =>
      store.context({ maxStatements: 0, seeds: ["subject"] })
    ).toThrow("world context maxStatements must be an integer from 1 to 5000");
    expect(() =>
      store.context({ at: "not-a-date", seeds: ["subject"] })
    ).toThrow("at must be an ISO date");
    store.close();
  });
});
