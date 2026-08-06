import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, posix, resolve } from "node:path";
import {
  isWorldEntityType,
  isWorldPredicate,
  isWorldStatementStatus,
  WORLD_MODEL_ONTOLOGY_VERSION,
  type WorldEntityType,
  type WorldPredicate,
  type WorldStatementStatus,
} from "./world-model-ontology";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const LOCAL_IMPORT_RE =
  /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/gu;
const REQUIRE_RE = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu;
const MARKDOWN_LINK_RE =
  /\[[^\]]*\]\((?!https?:|mailto:|#)([^)#?]+)(?:[?#][^)]*)?\)/gu;
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu;
const CODE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
const GIT_OBJECT_SIZE_RE = /^(?:0|[1-9]\d*)$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const TEST_PATH_RE = /(?:^|\/)test\.[^/]+$/u;
const SPEC_PATH_RE = /(?:^|\/)spec\.md$/u;
const LEADING_DOT_SLASH_RE = /^\.\//u;
const SINGLE_VALUED_PREDICATES = new Set<WorldPredicate>([
  "assigned_to",
  "authorized_by",
  "bound_to_sha",
  "deployed_as",
  "routed_to",
  "running_as",
]);

export interface WorldEntity {
  id: string;
  key: string;
  label: string;
  metadata: Record<string, unknown>;
  type: WorldEntityType;
}

export interface WorldStatement {
  authorityClass: string;
  commitSha?: string;
  confidence: number;
  evidenceSha256: string;
  evidenceSource: string;
  extractionMethod: string;
  id: string;
  objectId: string;
  observedAt: string;
  predicate: WorldPredicate;
  repositoryId?: string;
  sourceKind: string;
  status: WorldStatementStatus;
  subjectId: string;
  supersedesId?: string;
  validFrom: string;
  validTo?: string;
}

export interface WorldAssertionInput {
  authorityClass?: string;
  confidence?: number;
  evidenceContent?: string;
  evidenceSha256?: string;
  evidenceSource: string;
  object: WorldEntityInput;
  observedAt?: string;
  predicate: string;
  repositoryId?: string;
  status: string;
  subject: WorldEntityInput;
  supersedesId?: string;
  validFrom?: string;
}

export interface WorldEntityInput {
  key: string;
  label?: string;
  metadata?: Record<string, unknown>;
  type: string;
}

export interface WorldContextOptions {
  at?: string;
  maxDepth?: number;
  maxStatements?: number;
  seeds: string[];
}

export interface WorldConflict {
  objectIds: string[];
  predicate: WorldPredicate;
  statementIds: string[];
  subjectId: string;
}

export interface WorldContextCapsule {
  applicableConstraints: WorldEntity[];
  capsuleSha256: string;
  contradictions: WorldConflict[];
  entities: WorldEntity[];
  ontologyVersion: string;
  query: Required<Pick<WorldContextOptions, "maxDepth" | "maxStatements">> & {
    at?: string;
    seeds: string[];
  };
  statements: WorldStatement[];
  supersessionHistory: WorldStatement[];
  truncation: {
    depthLimitHit: boolean;
    statementLimitHit: boolean;
  };
  unknownSeeds: string[];
}

interface StatementInput extends Omit<WorldStatement, "id"> {
  id?: string;
}

interface SqlEntityRow {
  id: string;
  key: string;
  label: string;
  metadata_json: string;
  type: string;
}

interface SqlStatementRow {
  authority_class: string;
  commit_sha: string | null;
  confidence: number;
  evidence_sha256: string;
  evidence_source: string;
  extraction_method: string;
  id: string;
  object_id: string;
  observed_at: string;
  predicate: string;
  repository_id: string | null;
  source_kind: string;
  status: string;
  subject_id: string;
  supersedes_id: string | null;
  valid_from: string;
  valid_to: string | null;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

export const worldSha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const stableId = (namespace: string, value: unknown): string =>
  `${namespace}:${worldSha256(canonicalJson(value))}`;

const decode = (value: Uint8Array): string => textDecoder.decode(value);

const commandOutputBytes = (
  value: string | Uint8Array | null | undefined
): Uint8Array =>
  typeof value === "string"
    ? textEncoder.encode(value)
    : (value ?? new Uint8Array());

const requireIsoDate = (value: string, name: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`${name} must be an ISO date: ${value}`);
  }
  return parsed.toISOString();
};

const requireSha256 = (value: string, name: string): string => {
  if (!SHA256_RE.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256`);
  }
  return value;
};

const entityFromRow = (row: SqlEntityRow): WorldEntity => {
  if (!isWorldEntityType(row.type)) {
    throw new Error(`world model contains unknown entity type: ${row.type}`);
  }
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    type: row.type,
  };
};

const statementFromRow = (row: SqlStatementRow): WorldStatement => {
  if (!isWorldPredicate(row.predicate)) {
    throw new Error(`world model contains unknown predicate: ${row.predicate}`);
  }
  if (!isWorldStatementStatus(row.status)) {
    throw new Error(`world model contains unknown status: ${row.status}`);
  }
  const evidenceSha256 = requireSha256(
    row.evidence_sha256,
    "persisted evidenceSha256"
  );
  if (!(row.evidence_source.trim() && row.extraction_method.trim())) {
    throw new Error(
      "world model contains statement without evidence source and extraction method"
    );
  }
  if (!(row.authority_class.trim() && row.source_kind.trim())) {
    throw new Error(
      "world model contains statement without authority class and source kind"
    );
  }
  if (!(row.confidence >= 0 && row.confidence <= 1)) {
    throw new Error("world model contains confidence outside 0..1");
  }
  const observedAt = requireIsoDate(row.observed_at, "persisted observedAt");
  const validFrom = requireIsoDate(row.valid_from, "persisted validFrom");
  const validTo = row.valid_to
    ? requireIsoDate(row.valid_to, "persisted validTo")
    : undefined;
  if (validTo && validTo <= validFrom) {
    throw new Error("world model contains validTo at or before validFrom");
  }
  return {
    authorityClass: row.authority_class,
    ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    confidence: row.confidence,
    evidenceSha256,
    evidenceSource: row.evidence_source,
    extractionMethod: row.extraction_method,
    id: row.id,
    objectId: row.object_id,
    observedAt,
    predicate: row.predicate,
    ...(row.repository_id ? { repositoryId: row.repository_id } : {}),
    sourceKind: row.source_kind,
    status: row.status,
    subjectId: row.subject_id,
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
    validFrom,
    ...(validTo ? { validTo } : {}),
  };
};

const entityTypeForPath = (path: string): WorldEntityType => {
  if (path.startsWith("tests/") || TEST_PATH_RE.test(path)) {
    return "Test";
  }
  if (path.startsWith("specs/") || SPEC_PATH_RE.test(path)) {
    return "Spec";
  }
  return "File";
};

const normalizeTrackedPath = (value: string): string => {
  if (!value) {
    return "";
  }
  return posix
    .normalize(value.replaceAll("\\", "/"))
    .replace(LEADING_DOT_SLASH_RE, "");
};

const resolveTrackedTarget = (
  sourcePath: string,
  rawTarget: string,
  tracked: Set<string>,
  markdown: boolean
): string | undefined => {
  const base = normalizeTrackedPath(
    posix.join(posix.dirname(sourcePath), rawTarget.trim())
  );
  const extensions = markdown
    ? ["", ".md", "/README.md", "/index.md"]
    : [...CODE_EXTENSIONS, "/index.ts", "/index.tsx", "/index.js"];
  return extensions
    .map((suffix) => `${base}${suffix}`)
    .find((item) => tracked.has(item));
};

const git = (
  repoPath: string,
  args: string[],
  maxBuffer?: number
): Uint8Array => {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: null,
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  });
  if (result.status !== 0) {
    const detail =
      decode(commandOutputBytes(result.stderr)).trim() || result.error?.message;
    throw new Error(
      `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`
    );
  }
  return commandOutputBytes(result.stdout);
};

const committedBlob = (
  repoPath: string,
  commitSha: string,
  path: string
): Uint8Array => {
  const object = `${commitSha}:${path}`;
  const rawSize = decode(git(repoPath, ["cat-file", "-s", object])).trim();
  if (!GIT_OBJECT_SIZE_RE.test(rawSize)) {
    throw new Error(`git object size is invalid for ${object}: ${rawSize}`);
  }
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`git object size is unsafe for ${object}: ${rawSize}`);
  }
  // Git's immutable object metadata is the bound. The extra byte lets a blob
  // whose size equals the limit complete without choosing an arbitrary global
  // repository-file ceiling.
  const bytes = git(repoPath, ["show", object], size + 1);
  if (bytes.byteLength !== size) {
    throw new Error(
      `git show ${object} returned ${bytes.byteLength} bytes; expected ${size}`
    );
  }
  return bytes;
};

export class WorldModelStore {
  readonly database: Database;

  constructor(databasePath: string) {
    if (!databasePath.trim()) {
      throw new Error("world model database path cannot be empty");
    }
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }
    this.database = new Database(databasePath, { create: true });
    this.database.run("PRAGMA foreign_keys = ON");
    this.initialize();
  }

  close(): void {
    this.database.close();
  }

  initialize(): void {
    this.database.transaction(() => {
      this.database.run(`
        CREATE TABLE IF NOT EXISTS world_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT
      `);
      this.database.run(`
        CREATE TABLE IF NOT EXISTS world_entities (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          key TEXT NOT NULL,
          label TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          UNIQUE(type, key)
        ) STRICT
      `);
      this.database.run(`
        CREATE TABLE IF NOT EXISTS world_statements (
          id TEXT PRIMARY KEY,
          subject_id TEXT NOT NULL REFERENCES world_entities(id),
          predicate TEXT NOT NULL,
          object_id TEXT NOT NULL REFERENCES world_entities(id),
          evidence_source TEXT NOT NULL,
          evidence_sha256 TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          extraction_method TEXT NOT NULL,
          repository_id TEXT,
          commit_sha TEXT,
          observed_at TEXT NOT NULL,
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          authority_class TEXT NOT NULL,
          confidence REAL NOT NULL,
          status TEXT NOT NULL,
          supersedes_id TEXT REFERENCES world_statements(id)
        ) STRICT
      `);
      this.database.run(
        "CREATE INDEX IF NOT EXISTS world_statements_subject ON world_statements(subject_id)"
      );
      this.database.run(
        "CREATE INDEX IF NOT EXISTS world_statements_object ON world_statements(object_id)"
      );
      this.database.run(
        "CREATE INDEX IF NOT EXISTS world_statements_time ON world_statements(valid_from, valid_to)"
      );
      const existing = this.database
        .query("SELECT value FROM world_meta WHERE key = 'ontology_version'")
        .get() as { value: string } | null;
      if (existing && existing.value !== WORLD_MODEL_ONTOLOGY_VERSION) {
        throw new Error(
          `world model ontology mismatch: ${existing.value} != ${WORLD_MODEL_ONTOLOGY_VERSION}`
        );
      }
      this.database.run(
        "INSERT OR REPLACE INTO world_meta(key, value) VALUES ('ontology_version', ?)",
        [WORLD_MODEL_ONTOLOGY_VERSION]
      );
    })();
  }

  clear(): void {
    this.database.transaction(() => {
      this.database.run("DELETE FROM world_statements");
      this.database.run("DELETE FROM world_entities");
    })();
  }

  replaceObservedProjection(repositoryId: string): void {
    this.database.transaction(() => {
      this.database.run(
        `DELETE FROM world_statements
         WHERE repository_id = ? AND authority_class = 'deterministic-producer'`,
        [repositoryId]
      );
      this.database.run(
        `DELETE FROM world_entities
         WHERE id != ?
           AND NOT EXISTS (
             SELECT 1 FROM world_statements
             WHERE subject_id = world_entities.id OR object_id = world_entities.id
           )`,
        [repositoryId]
      );
    })();
  }

  putEntity(input: WorldEntityInput): WorldEntity {
    if (!isWorldEntityType(input.type)) {
      throw new Error(`unknown world-model entity type: ${input.type}`);
    }
    const key = input.key.trim();
    if (!key) {
      throw new Error("world-model entity key cannot be empty");
    }
    const entity: WorldEntity = {
      id: stableId("entity", { key, type: input.type }),
      key,
      label: input.label?.trim() || key,
      metadata: input.metadata ?? {},
      type: input.type,
    };
    this.database.run(
      `INSERT INTO world_entities(id, type, key, label, metadata_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(type, key) DO UPDATE SET
         label = excluded.label,
         metadata_json = excluded.metadata_json`,
      [
        entity.id,
        entity.type,
        entity.key,
        entity.label,
        canonicalJson(entity.metadata),
      ]
    );
    return entity;
  }

  putStatement(input: StatementInput): WorldStatement {
    if (!isWorldPredicate(input.predicate)) {
      throw new Error(`unknown world-model predicate: ${input.predicate}`);
    }
    if (!isWorldStatementStatus(input.status)) {
      throw new Error(`unknown world-model status: ${input.status}`);
    }
    if (
      input.status === "observed" &&
      input.authorityClass !== "deterministic-producer"
    ) {
      throw new Error(
        "observed statements require deterministic-producer authority"
      );
    }
    if (!(input.evidenceSource.trim() && input.extractionMethod.trim())) {
      throw new Error(
        "world-model statements require evidence source and extraction method"
      );
    }
    if (!(input.authorityClass.trim() && input.sourceKind.trim())) {
      throw new Error(
        "world-model statements require authority class and source kind"
      );
    }
    requireSha256(input.evidenceSha256, "evidenceSha256");
    if (!(input.confidence >= 0 && input.confidence <= 1)) {
      throw new Error("world-model confidence must be between 0 and 1");
    }
    const observedAt = requireIsoDate(input.observedAt, "observedAt");
    const validFrom = requireIsoDate(input.validFrom, "validFrom");
    const validTo = input.validTo
      ? requireIsoDate(input.validTo, "validTo")
      : undefined;
    if (validTo && validTo <= validFrom) {
      throw new Error("world-model validTo must be after validFrom");
    }
    const id =
      input.id ??
      stableId("statement", {
        commitSha: input.commitSha,
        evidenceSha256: input.evidenceSha256,
        evidenceSource: input.evidenceSource,
        extractionMethod: input.extractionMethod,
        objectId: input.objectId,
        predicate: input.predicate,
        repositoryId: input.repositoryId,
        subjectId: input.subjectId,
      });
    const statement: WorldStatement = {
      ...input,
      id,
      observedAt,
      validFrom,
      ...(validTo ? { validTo } : {}),
    };
    const previous = statement.supersedesId
      ? this.statement(statement.supersedesId)
      : undefined;
    if (statement.supersedesId && !previous) {
      throw new Error(
        `superseded statement not found: ${statement.supersedesId}`
      );
    }
    this.database.transaction(() => {
      if (statement.supersedesId) {
        this.database.run(
          "UPDATE world_statements SET status = 'superseded', valid_to = ? WHERE id = ?",
          [validFrom, statement.supersedesId]
        );
      }
      this.database.run(
        `INSERT INTO world_statements(
        id, subject_id, predicate, object_id, evidence_source,
        evidence_sha256, source_kind, extraction_method, repository_id,
        commit_sha, observed_at, valid_from, valid_to, authority_class,
        confidence, status, supersedes_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        observed_at = excluded.observed_at,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        authority_class = excluded.authority_class,
        confidence = excluded.confidence,
        status = excluded.status,
        supersedes_id = excluded.supersedes_id`,
        [
          statement.id,
          statement.subjectId,
          statement.predicate,
          statement.objectId,
          statement.evidenceSource,
          statement.evidenceSha256,
          statement.sourceKind,
          statement.extractionMethod,
          statement.repositoryId ?? null,
          statement.commitSha ?? null,
          statement.observedAt,
          statement.validFrom,
          statement.validTo ?? null,
          statement.authorityClass,
          statement.confidence,
          statement.status,
          statement.supersedesId ?? null,
        ]
      );
    })();
    return statement;
  }

  ingestAssertion(input: WorldAssertionInput): WorldStatement {
    if (input.status === "observed") {
      throw new Error("candidate ingestion cannot create observed statements");
    }
    if (
      !isWorldStatementStatus(input.status) ||
      input.status === "superseded"
    ) {
      throw new Error(`invalid candidate statement status: ${input.status}`);
    }
    if (!isWorldPredicate(input.predicate)) {
      throw new Error(`unknown world-model predicate: ${input.predicate}`);
    }
    const authorityClass = input.authorityClass?.trim() || "candidate";
    if (authorityClass === "deterministic-producer") {
      throw new Error(
        "candidate ingestion cannot claim deterministic-producer authority"
      );
    }
    const evidenceSource = input.evidenceSource.trim();
    if (!evidenceSource) {
      throw new Error("candidate ingestion requires an evidence source");
    }
    let evidenceSha256: string | undefined;
    if (input.evidenceSha256) {
      evidenceSha256 = requireSha256(input.evidenceSha256, "evidenceSha256");
    } else if (input.evidenceContent) {
      evidenceSha256 = worldSha256(input.evidenceContent);
    }
    if (!evidenceSha256) {
      throw new Error(
        "candidate ingestion requires evidence content or SHA-256"
      );
    }
    const subject = this.putEntity(input.subject);
    const object = this.putEntity(input.object);
    const observedAt = input.observedAt ?? new Date().toISOString();
    return this.putStatement({
      authorityClass,
      confidence: input.confidence ?? 0.5,
      evidenceSha256,
      evidenceSource,
      extractionMethod: "explicit-candidate-ingestion",
      objectId: object.id,
      observedAt,
      predicate: input.predicate,
      ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      sourceKind: "assertion",
      status: input.status,
      subjectId: subject.id,
      ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
      validFrom: input.validFrom ?? observedAt,
    });
  }

  statement(id: string): WorldStatement | undefined {
    const row = this.database
      .query("SELECT * FROM world_statements WHERE id = ?")
      .get(id) as SqlStatementRow | null;
    return row ? statementFromRow(row) : undefined;
  }

  entities(): WorldEntity[] {
    return (
      this.database
        .query("SELECT * FROM world_entities ORDER BY type, key, id")
        .all() as SqlEntityRow[]
    ).map(entityFromRow);
  }

  statements(): WorldStatement[] {
    return (
      this.database
        .query("SELECT * FROM world_statements ORDER BY id")
        .all() as SqlStatementRow[]
    ).map(statementFromRow);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded traversal keeps limits, temporal filtering, and truncation evidence together
  context(options: WorldContextOptions): WorldContextCapsule {
    const seeds = [
      ...new Set(options.seeds.map((seed) => seed.trim()).filter(Boolean)),
    ].sort();
    if (seeds.length === 0) {
      throw new Error("world context requires at least one non-empty seed");
    }
    const maxDepth = options.maxDepth ?? 2;
    const maxStatements = options.maxStatements ?? 100;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) {
      throw new Error("world context maxDepth must be an integer from 0 to 10");
    }
    if (
      !Number.isInteger(maxStatements) ||
      maxStatements < 1 ||
      maxStatements > 5000
    ) {
      throw new Error(
        "world context maxStatements must be an integer from 1 to 5000"
      );
    }
    const at = options.at ? requireIsoDate(options.at, "at") : undefined;
    const allEntities = this.entities();
    const byId = new Map(allEntities.map((entity) => [entity.id, entity]));
    const matchedBySeed = new Map<string, WorldEntity[]>();
    for (const seed of seeds) {
      const lowered = seed.toLowerCase();
      matchedBySeed.set(
        seed,
        allEntities.filter(
          (entity) =>
            entity.id === seed ||
            entity.key.toLowerCase().includes(lowered) ||
            entity.label.toLowerCase().includes(lowered)
        )
      );
    }
    const unknownSeeds = seeds.filter(
      (seed) => matchedBySeed.get(seed)?.length === 0
    );
    const selectedEntityIds = new Set(
      [...matchedBySeed.values()].flat().map((entity) => entity.id)
    );
    let frontier = new Set(selectedEntityIds);
    const eligibleStatements = this.statements().filter((statement) => {
      if (at) {
        return (
          statement.validFrom <= at &&
          (!statement.validTo || statement.validTo > at)
        );
      }
      return !statement.validTo && statement.status !== "superseded";
    });
    const selected = new Map<string, WorldStatement>();
    let statementLimitHit = false;
    let depthLimitHit =
      maxDepth === 0 &&
      eligibleStatements.some(
        (statement) =>
          frontier.has(statement.subjectId) || frontier.has(statement.objectId)
      );
    for (let depth = 0; depth < maxDepth && frontier.size > 0; depth += 1) {
      const adjacent = eligibleStatements
        .filter(
          (statement) =>
            frontier.has(statement.subjectId) ||
            frontier.has(statement.objectId)
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      const nextFrontier = new Set<string>();
      for (const statement of adjacent) {
        if (selected.has(statement.id)) {
          continue;
        }
        if (selected.size >= maxStatements) {
          statementLimitHit = true;
          break;
        }
        selected.set(statement.id, statement);
        for (const id of [statement.subjectId, statement.objectId]) {
          if (!selectedEntityIds.has(id)) {
            selectedEntityIds.add(id);
            nextFrontier.add(id);
          }
        }
      }
      if (depth + 1 === maxDepth && nextFrontier.size > 0) {
        depthLimitHit = true;
      }
      frontier = nextFrontier;
      if (statementLimitHit) {
        break;
      }
    }
    const statements = [...selected.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const entities = [...selectedEntityIds]
      .map((id) => byId.get(id))
      .filter((entity): entity is WorldEntity => Boolean(entity))
      .sort((left, right) => left.id.localeCompare(right.id));
    const contradictions = this.conflicts(statements);
    const supersessionIds = new Set(
      statements.flatMap((statement) =>
        statement.supersedesId ? [statement.supersedesId] : []
      )
    );
    const supersessionHistory = this.statements()
      .filter(
        (statement) =>
          supersessionIds.has(statement.id) ||
          (statement.supersedesId && selected.has(statement.supersedesId))
      )
      .sort((left, right) => left.validFrom.localeCompare(right.validFrom));
    const capsuleWithoutHash = {
      applicableConstraints: entities.filter(
        (entity) => entity.type === "Constraint"
      ),
      contradictions,
      entities,
      ontologyVersion: WORLD_MODEL_ONTOLOGY_VERSION,
      query: {
        ...(at ? { at } : {}),
        maxDepth,
        maxStatements,
        seeds,
      },
      statements,
      supersessionHistory,
      truncation: { depthLimitHit, statementLimitHit },
      unknownSeeds,
    };
    return {
      ...capsuleWithoutHash,
      capsuleSha256: worldSha256(canonicalJson(capsuleWithoutHash)),
    };
  }

  private conflicts(statements: WorldStatement[]): WorldConflict[] {
    const groups = new Map<string, WorldStatement[]>();
    for (const statement of statements) {
      const key = `${statement.subjectId}\0${statement.predicate}`;
      const group = groups.get(key) ?? [];
      group.push(statement);
      groups.set(key, group);
    }
    return [...groups.values()]
      .filter(
        (group) =>
          SINGLE_VALUED_PREDICATES.has(group[0]?.predicate as WorldPredicate) &&
          new Set(group.map((item) => item.objectId)).size > 1
      )
      .map((group) => ({
        objectIds: [...new Set(group.map((item) => item.objectId))].sort(),
        predicate: group[0]?.predicate as WorldPredicate,
        statementIds: group.map((item) => item.id).sort(),
        subjectId: group[0]?.subjectId ?? "",
      }))
      .sort((left, right) =>
        `${left.subjectId}:${left.predicate}`.localeCompare(
          `${right.subjectId}:${right.predicate}`
        )
      );
  }
}

const observe = (
  store: WorldModelStore,
  input: Omit<
    StatementInput,
    "authorityClass" | "confidence" | "sourceKind" | "status"
  >
): WorldStatement =>
  store.putStatement({
    ...input,
    authorityClass: "deterministic-producer",
    confidence: 1,
    sourceKind: "git-blob",
    status: "observed",
  });

export interface MaterializeResult {
  commitSha: string;
  entityCount: number;
  ontologyVersion: string;
  repositoryId: string;
  repositoryPath: string;
  statementCount: number;
}

export const materializeGitRepository = (
  store: WorldModelStore,
  repositoryPath: string
): MaterializeResult => {
  const repoPath = realpathSync(resolve(repositoryPath));
  const commitSha = decode(git(repoPath, ["rev-parse", "HEAD"])).trim();
  const commitTime = requireIsoDate(
    decode(git(repoPath, ["show", "-s", "--format=%cI", commitSha])).trim(),
    "git commit time"
  );
  const rawFiles = decode(
    git(repoPath, ["ls-tree", "-r", "--name-only", "-z", commitSha])
  );
  const files = rawFiles
    .split("\0")
    .map(normalizeTrackedPath)
    .filter(Boolean)
    .sort();
  if (files.length === 0) {
    throw new Error("cannot materialize a repository with no tracked files");
  }
  const writeProjection = store.database.transaction(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: deterministic extraction keeps evidence binding auditable in one transaction
    (): MaterializeResult => {
      const repository = store.putEntity({
        key: repoPath,
        label: posix.basename(repoPath),
        metadata: { commitSha, path: repoPath },
        type: "Repository",
      });
      store.replaceObservedProjection(repository.id);
      const commit = store.putEntity({
        key: `${repoPath}@${commitSha}`,
        label: commitSha.slice(0, 12),
        metadata: { commitSha, repositoryPath: repoPath },
        type: "Commit",
      });
      const tracked = new Set(files);
      const entitiesByPath = new Map<string, WorldEntity>();
      const contents = new Map<string, string>();
      const hashes = new Map<string, string>();
      for (const path of files) {
        const bytes = committedBlob(repoPath, commitSha, path);
        const hash = worldSha256(bytes);
        const content = decode(bytes);
        const entity = store.putEntity({
          key: `${repoPath}:${path}`,
          label: path,
          metadata: { commitSha, path, sha256: hash },
          type: entityTypeForPath(path),
        });
        entitiesByPath.set(path, entity);
        contents.set(path, content);
        hashes.set(path, hash);
        const evidenceSource = `git:${commitSha}:${path}`;
        observe(store, {
          commitSha,
          evidenceSha256: hash,
          evidenceSource,
          extractionMethod: "git-ls-tree",
          objectId: entity.id,
          observedAt: commitTime,
          predicate: "contains",
          repositoryId: repository.id,
          subjectId: repository.id,
          validFrom: commitTime,
        });
        observe(store, {
          commitSha,
          evidenceSha256: hash,
          evidenceSource,
          extractionMethod: "git-blob-commit-binding",
          objectId: commit.id,
          observedAt: commitTime,
          predicate: "bound_to_sha",
          repositoryId: repository.id,
          subjectId: entity.id,
          validFrom: commitTime,
        });
        const componentName = path.includes("/")
          ? path.split("/")[0]
          : undefined;
        if (componentName) {
          const component = store.putEntity({
            key: `${repoPath}:component:${componentName}`,
            label: componentName,
            metadata: { path: componentName },
            type: "Component",
          });
          observe(store, {
            commitSha,
            evidenceSha256: hash,
            evidenceSource,
            extractionMethod: "path-component",
            objectId: entity.id,
            observedAt: commitTime,
            predicate: "contains",
            repositoryId: repository.id,
            subjectId: component.id,
            validFrom: commitTime,
          });
        }
      }
      for (const path of files) {
        const source = entitiesByPath.get(path);
        const content = contents.get(path) ?? "";
        const evidenceSha256 = hashes.get(path) ?? "";
        if (!(source && evidenceSha256) || content.includes("\0")) {
          continue;
        }
        const targets: Array<{
          method: string;
          path: string;
          predicate: WorldPredicate;
        }> = [];
        if (
          [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"].includes(extname(path))
        ) {
          for (const pattern of [LOCAL_IMPORT_RE, REQUIRE_RE]) {
            pattern.lastIndex = 0;
            for (const match of content.matchAll(pattern)) {
              const rawTarget = match[1];
              const target = rawTarget
                ? resolveTrackedTarget(path, rawTarget, tracked, false)
                : undefined;
              if (target) {
                targets.push({
                  method: "static-import",
                  path: target,
                  predicate: "imports",
                });
              }
            }
          }
        }
        if (extname(path).toLowerCase() === ".md") {
          for (const pattern of [MARKDOWN_LINK_RE, WIKI_LINK_RE]) {
            pattern.lastIndex = 0;
            for (const match of content.matchAll(pattern)) {
              const rawTarget = match[1];
              const target = rawTarget
                ? resolveTrackedTarget(path, rawTarget, tracked, true)
                : undefined;
              if (target) {
                targets.push({
                  method: "markdown-link",
                  path: target,
                  predicate: "depends_on",
                });
              }
            }
          }
        }
        for (const target of targets
          .filter(
            (item, index, all) =>
              all.findIndex(
                (candidate) =>
                  candidate.path === item.path &&
                  candidate.predicate === item.predicate
              ) === index
          )
          .sort((left, right) => left.path.localeCompare(right.path))) {
          const object = entitiesByPath.get(target.path);
          if (!object) {
            continue;
          }
          observe(store, {
            commitSha,
            evidenceSha256,
            evidenceSource: `git:${commitSha}:${path}`,
            extractionMethod: target.method,
            objectId: object.id,
            observedAt: commitTime,
            predicate: target.predicate,
            repositoryId: repository.id,
            subjectId: source.id,
            validFrom: commitTime,
          });
        }
      }
      return {
        commitSha,
        entityCount: store.entities().length,
        ontologyVersion: WORLD_MODEL_ONTOLOGY_VERSION,
        repositoryId: repository.id,
        repositoryPath: repoPath,
        statementCount: store.statements().length,
      };
    }
  );
  return writeProjection();
};

export const readWorldAssertionFile = (path: string): WorldAssertionInput => {
  const content = readFileSync(resolve(path), "utf8").trim();
  if (!content) {
    throw new Error("world assertion file cannot be empty");
  }
  const parsed = JSON.parse(content) as unknown;
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    throw new Error("world assertion file must contain one JSON object");
  }
  return parsed as WorldAssertionInput;
};
