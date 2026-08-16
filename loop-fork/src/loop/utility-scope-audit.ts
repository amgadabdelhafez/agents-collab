import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { UtilityRouteRequest } from "./task-router";
import { isUtilityProtectedPath } from "./utility-path-policy";

export type UtilityScopeAuditKind =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type-changed"
  | "unmerged"
  | "unknown"
  | "untracked";

export type UtilityScopeAuditSurface =
  | "commit"
  | "index"
  | "untracked"
  | "worktree";

export interface UtilityScopeAuditRecord {
  indexStatus?: string;
  kind: UtilityScopeAuditKind;
  path: string;
  previousPath?: string;
  routing: "helper-visible" | "metadata-only";
  surfaces: UtilityScopeAuditSurface[];
  worktreeStatus?: string;
}

export interface UtilityScopeAuditQuery {
  baseRef?: string;
  headRef?: string;
  mode: "diff-index" | "diff-range" | "diff-worktree" | "status";
  paths: string[];
  rangeOperator?: "...";
}

export interface UtilityScopeAuditEvidence {
  clean: boolean;
  count: number;
  query: UtilityScopeAuditQuery;
  records: UtilityScopeAuditRecord[];
  schemaVersion: 1;
  sha256: string;
}

export interface UtilityScopeAuditCollection {
  manifests: UtilityScopeAuditEvidence[];
  schemaVersion: 1;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const COMMIT_HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_STATUS_CODE_RE = /^[A-Z.?U]$/;
const NAME_STATUS_RE = /^[A-Z?][0-9]*$/;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const SURFACE_ORDER: readonly UtilityScopeAuditSurface[] = [
  "commit",
  "index",
  "untracked",
  "worktree",
];

const compareCanonicalStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalPath = (value: string): string => {
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH_RE.test(value)
  ) {
    throw new Error("scope audit path must be repository relative");
  }
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("scope audit path escapes the repository");
  }
  return normalized;
};

const statusKind = (codes: string): UtilityScopeAuditKind => {
  if (codes.includes("R")) {
    return "renamed";
  }
  if (codes.includes("C")) {
    return "copied";
  }
  if (codes.includes("U")) {
    return "unmerged";
  }
  if (codes.includes("A")) {
    return "added";
  }
  if (codes.includes("D")) {
    return "deleted";
  }
  if (codes.includes("T")) {
    return "type-changed";
  }
  if (codes.includes("M")) {
    return "modified";
  }
  if (codes.includes("?")) {
    return "untracked";
  }
  return "unknown";
};

const routingFor = (
  path: string,
  previousPath?: string
): UtilityScopeAuditRecord["routing"] =>
  isUtilityProtectedPath(path) ||
  (previousPath !== undefined && isUtilityProtectedPath(previousPath))
    ? "metadata-only"
    : "helper-visible";

const fieldsAndPath = (
  value: string,
  fieldCount: number
): { fields: string[]; path: string } => {
  const fields: string[] = [];
  let rest = value;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = rest.indexOf(" ");
    if (separator < 0) {
      throw new Error("malformed porcelain-v2 scope record");
    }
    fields.push(rest.slice(0, separator));
    rest = rest.slice(separator + 1);
  }
  if (!rest) {
    throw new Error("porcelain-v2 scope record is missing a path");
  }
  return { fields, path: rest };
};

const surfacesForStatus = (xy: string): UtilityScopeAuditSurface[] => {
  const surfaces: UtilityScopeAuditSurface[] = [];
  if (xy[0] && xy[0] !== ".") {
    surfaces.push("index");
  }
  if (xy[1] && xy[1] !== ".") {
    surfaces.push("worktree");
  }
  return surfaces;
};

const nulDelimitedValues = (raw: string): string[] => {
  if (!raw) {
    return [];
  }
  if (!raw.endsWith("\0")) {
    throw new Error("scope audit Git output is not NUL-terminated");
  }
  const values = raw.split("\0");
  values.pop();
  return values;
};

export const parseGitStatusScopeRecords = (
  raw: string
): UtilityScopeAuditRecord[] => {
  const values = nulDelimitedValues(raw);
  const records: UtilityScopeAuditRecord[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (value.startsWith("# ")) {
      continue;
    }
    if (value.startsWith("? ")) {
      const path = canonicalPath(value.slice(2));
      records.push({
        kind: "untracked",
        path,
        routing: routingFor(path),
        surfaces: ["untracked"],
      });
      continue;
    }
    if (value.startsWith("! ")) {
      continue;
    }
    const parsed = parseTrackedStatusRecord(value, values[index + 1]);
    if (parsed) {
      records.push(parsed.record);
      index += parsed.consumedPreviousPath ? 1 : 0;
      continue;
    }
    throw new Error("unsupported porcelain-v2 scope record");
  }
  return records;
};

const trackedStatusRecord = (
  value: string,
  fieldCount: number,
  kind?: UtilityScopeAuditKind
): UtilityScopeAuditRecord => {
  const parsed = fieldsAndPath(value.slice(2), fieldCount);
  const xy = parsed.fields[0] ?? "..";
  const path = canonicalPath(parsed.path);
  return {
    indexStatus: xy[0] ?? ".",
    kind: kind ?? statusKind(xy),
    path,
    routing: routingFor(path),
    surfaces: surfacesForStatus(xy),
    worktreeStatus: xy[1] ?? ".",
  };
};

const parseTrackedStatusRecord = (
  value: string,
  previousValue?: string
): {
  consumedPreviousPath: boolean;
  record: UtilityScopeAuditRecord;
} | null => {
  if (value.startsWith("1 ")) {
    return {
      consumedPreviousPath: false,
      record: trackedStatusRecord(value, 7),
    };
  }
  if (value.startsWith("u ")) {
    return {
      consumedPreviousPath: false,
      record: trackedStatusRecord(value, 9, "unmerged"),
    };
  }
  if (!value.startsWith("2 ")) {
    return null;
  }
  if (previousValue === undefined) {
    throw new Error("renamed scope record is missing its previous path");
  }
  const parsed = fieldsAndPath(value.slice(2), 8);
  const xy = parsed.fields[0] ?? "..";
  const path = canonicalPath(parsed.path);
  const previousPath = canonicalPath(previousValue);
  return {
    consumedPreviousPath: true,
    record: {
      indexStatus: xy[0] ?? ".",
      kind: statusKind(`${xy}${parsed.fields[7] ?? ""}`),
      path,
      previousPath,
      routing: routingFor(path, previousPath),
      surfaces: surfacesForStatus(xy),
      worktreeStatus: xy[1] ?? ".",
    },
  };
};

const parseNameStatusToken = (
  value: string
): { path?: string; status: string } => {
  const tab = value.indexOf("\t");
  return tab < 0
    ? { status: value }
    : { path: value.slice(tab + 1), status: value.slice(0, tab) };
};

const parseGitDiffScopeRecord = (
  values: readonly string[],
  startIndex: number,
  surface: "commit" | "index" | "worktree"
): { nextIndex: number; record: UtilityScopeAuditRecord } => {
  const parsedStatus = parseNameStatusToken(values[startIndex] ?? "");
  const status = parsedStatus.status;
  if (!NAME_STATUS_RE.test(status)) {
    throw new Error("malformed name-status scope record");
  }
  let nextIndex = startIndex + 1;
  const firstPath = parsedStatus.path ?? values[nextIndex];
  if (firstPath === undefined) {
    throw new Error("name-status scope record is missing a path");
  }
  if (parsedStatus.path === undefined) {
    nextIndex += 1;
  }
  const renamed = status.startsWith("R") || status.startsWith("C");
  const secondPath = renamed ? values[nextIndex] : undefined;
  if (renamed && secondPath === undefined) {
    throw new Error("rename/copy scope record is missing its destination");
  }
  if (renamed) {
    nextIndex += 1;
  }
  const path = canonicalPath(secondPath ?? firstPath);
  const previousPath = renamed ? canonicalPath(firstPath) : undefined;
  return {
    nextIndex,
    record: {
      kind: statusKind(status),
      path,
      ...(previousPath ? { previousPath } : {}),
      routing: routingFor(path, previousPath),
      surfaces: [surface],
    },
  };
};

export const parseGitDiffScopeRecords = (
  raw: string,
  surface: "commit" | "index" | "worktree"
): UtilityScopeAuditRecord[] => {
  const values = nulDelimitedValues(raw);
  const records: UtilityScopeAuditRecord[] = [];
  for (let index = 0; index < values.length; ) {
    const parsed = parseGitDiffScopeRecord(values, index, surface);
    records.push(parsed.record);
    index = parsed.nextIndex;
  }
  return records;
};

const canonicalQueryPath = (value: string): string =>
  value === "." ? value : canonicalPath(value);

const canonicalQueryPaths = (paths: readonly string[]): string[] => {
  const canonical = [...new Set(paths.map(canonicalQueryPath))].sort(
    compareCanonicalStrings
  );
  if (canonical.length === 0) {
    throw new Error("scope audit query requires a Git pathspec");
  }
  return canonical;
};

const canonicalQuery = (
  query: UtilityScopeAuditQuery
): UtilityScopeAuditQuery => {
  const paths = canonicalQueryPaths(query.paths);
  if (query.mode === "diff-range") {
    if (!(query.baseRef && query.headRef)) {
      throw new Error("scope audit diff-range query requires literal refs");
    }
    if (
      !(
        COMMIT_HASH_RE.test(query.baseRef) && COMMIT_HASH_RE.test(query.headRef)
      ) ||
      query.rangeOperator !== "..."
    ) {
      throw new Error(
        "scope audit diff-range query requires literal refs and range operator"
      );
    }
    return {
      baseRef: query.baseRef.toLowerCase(),
      headRef: query.headRef.toLowerCase(),
      mode: query.mode,
      paths,
      rangeOperator: "...",
    };
  }
  if (
    query.mode !== "status" &&
    query.mode !== "diff-index" &&
    query.mode !== "diff-worktree"
  ) {
    throw new Error("scope audit query mode is invalid");
  }
  if (
    query.baseRef !== undefined ||
    query.headRef !== undefined ||
    query.rangeOperator !== undefined
  ) {
    throw new Error("scope audit non-range query cannot carry refs");
  }
  return { mode: query.mode, paths };
};

export const utilityScopeAuditQueryIdentity = (
  query: UtilityScopeAuditQuery
): string => JSON.stringify(canonicalQuery(query));

const canonicalRecord = (
  record: UtilityScopeAuditRecord
): UtilityScopeAuditRecord => {
  const path = canonicalPath(record.path);
  const previousPath = record.previousPath
    ? canonicalPath(record.previousPath)
    : undefined;
  const surfaces = [...new Set(record.surfaces)].sort(
    (left, right) => SURFACE_ORDER.indexOf(left) - SURFACE_ORDER.indexOf(right)
  );
  if (surfaces.length === 0) {
    throw new Error("scope audit record requires a Git surface");
  }
  if (
    record.indexStatus !== undefined &&
    !GIT_STATUS_CODE_RE.test(record.indexStatus)
  ) {
    throw new Error("scope audit index status is invalid");
  }
  if (
    record.worktreeStatus !== undefined &&
    !GIT_STATUS_CODE_RE.test(record.worktreeStatus)
  ) {
    throw new Error("scope audit worktree status is invalid");
  }
  return {
    ...(record.indexStatus === undefined
      ? {}
      : { indexStatus: record.indexStatus }),
    kind: record.kind,
    path,
    ...(previousPath ? { previousPath } : {}),
    routing: routingFor(path, previousPath),
    surfaces,
    ...(record.worktreeStatus === undefined
      ? {}
      : { worktreeStatus: record.worktreeStatus }),
  };
};

const evidencePayload = (
  query: UtilityScopeAuditQuery,
  records: readonly UtilityScopeAuditRecord[]
): string => JSON.stringify({ query, records, schemaVersion: 1 });

export const buildUtilityScopeAuditEvidence = (
  query: UtilityScopeAuditQuery,
  records: readonly UtilityScopeAuditRecord[]
): UtilityScopeAuditEvidence => {
  const canonical = records
    .map(canonicalRecord)
    .sort((left, right) =>
      compareCanonicalStrings(JSON.stringify(left), JSON.stringify(right))
    );
  const identities = canonical.map((record) => JSON.stringify(record));
  if (new Set(identities).size !== identities.length) {
    throw new Error("scope audit records contain duplicates");
  }
  const normalizedQuery = canonicalQuery(query);
  return {
    clean: canonical.length === 0,
    count: canonical.length,
    query: normalizedQuery,
    records: canonical,
    schemaVersion: 1,
    sha256: createHash("sha256")
      .update(evidencePayload(normalizedQuery, canonical))
      .digest("hex"),
  };
};

export const assertUtilityScopeAuditEvidence = (
  value: unknown
): UtilityScopeAuditEvidence => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.clean !== "boolean" ||
    typeof value.count !== "number" ||
    !Number.isInteger(value.count) ||
    value.count < 0 ||
    !isRecord(value.query) ||
    !Array.isArray(value.records) ||
    typeof value.sha256 !== "string" ||
    !SHA256_HEX_RE.test(value.sha256)
  ) {
    throw new Error("scope audit evidence has an invalid shape");
  }
  const mode = value.query.mode;
  if (
    mode !== "status" &&
    mode !== "diff-index" &&
    mode !== "diff-range" &&
    mode !== "diff-worktree"
  ) {
    throw new Error("scope audit query mode is invalid");
  }
  const baseRef = value.query.baseRef;
  const headRef = value.query.headRef;
  const paths = value.query.paths;
  const rangeOperator = value.query.rangeOperator;
  if (
    (baseRef !== undefined && typeof baseRef !== "string") ||
    (headRef !== undefined && typeof headRef !== "string") ||
    !Array.isArray(paths) ||
    paths.some((path) => typeof path !== "string") ||
    (rangeOperator !== undefined && rangeOperator !== "...")
  ) {
    throw new Error("scope audit query shape is invalid");
  }
  const records = value.records.map((record) => {
    if (
      !isRecord(record) ||
      typeof record.kind !== "string" ||
      typeof record.path !== "string" ||
      (record.previousPath !== undefined &&
        typeof record.previousPath !== "string") ||
      (record.indexStatus !== undefined &&
        typeof record.indexStatus !== "string") ||
      (record.worktreeStatus !== undefined &&
        typeof record.worktreeStatus !== "string") ||
      (record.routing !== "helper-visible" &&
        record.routing !== "metadata-only") ||
      !Array.isArray(record.surfaces) ||
      record.surfaces.some(
        (surface) =>
          surface !== "commit" &&
          surface !== "index" &&
          surface !== "untracked" &&
          surface !== "worktree"
      )
    ) {
      throw new Error("scope audit record has an invalid shape");
    }
    if (
      record.kind !== "added" &&
      record.kind !== "copied" &&
      record.kind !== "deleted" &&
      record.kind !== "modified" &&
      record.kind !== "renamed" &&
      record.kind !== "type-changed" &&
      record.kind !== "unmerged" &&
      record.kind !== "unknown" &&
      record.kind !== "untracked"
    ) {
      throw new Error("scope audit record kind is invalid");
    }
    return record as unknown as UtilityScopeAuditRecord;
  });
  const expected = buildUtilityScopeAuditEvidence(
    {
      ...(typeof baseRef === "string" ? { baseRef } : {}),
      ...(typeof headRef === "string" ? { headRef } : {}),
      mode,
      paths: paths as string[],
      ...(rangeOperator === "..." ? { rangeOperator } : {}),
    },
    records
  );
  if (
    value.count !== expected.count ||
    value.clean !== expected.clean ||
    value.sha256 !== expected.sha256 ||
    JSON.stringify(value.query) !== JSON.stringify(expected.query) ||
    JSON.stringify(value.records) !== JSON.stringify(expected.records)
  ) {
    throw new Error("scope audit evidence count/hash does not reconcile");
  }
  return expected;
};

export const buildUtilityScopeAuditCollection = (
  manifests: readonly UtilityScopeAuditEvidence[]
): UtilityScopeAuditCollection => {
  if (manifests.length === 0) {
    throw new Error("scope audit collection requires a manifest");
  }
  const canonical = manifests
    .map(assertUtilityScopeAuditEvidence)
    .sort((left, right) =>
      compareCanonicalStrings(
        utilityScopeAuditQueryIdentity(left.query),
        utilityScopeAuditQueryIdentity(right.query)
      )
    );
  const identities = canonical.map((manifest) =>
    utilityScopeAuditQueryIdentity(manifest.query)
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error("scope audit collection contains duplicate queries");
  }
  return { manifests: canonical, schemaVersion: 1 };
};

export const assertUtilityScopeAuditCollection = (
  value: unknown
): UtilityScopeAuditCollection => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.manifests)
  ) {
    throw new Error("scope audit collection has an invalid shape");
  }
  const expected = buildUtilityScopeAuditCollection(value.manifests);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("scope audit collection does not reconcile");
  }
  return expected;
};

export type UtilityScopeAuditRequestReasonCode =
  | "scope-audit-evidence-missing"
  | "scope-audit-mode-mismatch"
  | "scope-audit-orphan-manifest"
  | "scope-audit-paths-narrowed"
  | "scope-audit-range-mismatch";

export class UtilityScopeAuditRequestError extends Error {
  readonly reasonCode: UtilityScopeAuditRequestReasonCode;

  constructor(reasonCode: UtilityScopeAuditRequestReasonCode, detail: string) {
    super(`${reasonCode}: ${detail}`);
    this.reasonCode = reasonCode;
  }
}

interface UtilityScopeAuditDeclaration {
  legacyUndeclared: boolean;
  mode: UtilityScopeAuditQuery["mode"];
  paths: string[];
  range?: {
    baseRef: string;
    headRef: string;
    rangeOperator: "...";
  };
}

const scopeAuditDeclaration = (
  profile: "git-diff" | "git-status",
  paths: readonly string[],
  executionGitDiff: UtilityRouteRequest["executionGitDiff"]
): UtilityScopeAuditDeclaration => {
  const canonicalPaths = canonicalQueryPaths(paths);
  if (profile === "git-status") {
    return {
      legacyUndeclared: false,
      mode: "status",
      paths: canonicalPaths,
    };
  }
  if (executionGitDiff?.kind === "index") {
    return {
      legacyUndeclared: false,
      mode: "diff-index",
      paths: canonicalPaths,
    };
  }
  if (executionGitDiff?.kind === "range") {
    return {
      legacyUndeclared: false,
      mode: "diff-range",
      paths: canonicalPaths,
      range: {
        baseRef: executionGitDiff.base,
        headRef: executionGitDiff.head,
        rangeOperator: executionGitDiff.operator,
      },
    };
  }
  return {
    legacyUndeclared: executionGitDiff === undefined,
    mode: "diff-worktree",
    paths: canonicalPaths,
  };
};

const scopeAuditDeclarations = (
  request: UtilityRouteRequest
): UtilityScopeAuditDeclaration[] => {
  if (
    request.executionProfile === "git-status" ||
    request.executionProfile === "git-diff"
  ) {
    return [
      scopeAuditDeclaration(
        request.executionProfile,
        request.readScope,
        request.executionGitDiff
      ),
    ];
  }
  if (request.executionProfile !== "read-plan") {
    return [];
  }
  return (request.executionPlan ?? []).flatMap((step) =>
    step.executionProfile === "git-status" ||
    step.executionProfile === "git-diff"
      ? [
          scopeAuditDeclaration(
            step.executionProfile,
            step.readScope,
            step.executionGitDiff
          ),
        ]
      : []
  );
};

const queryMatchesDeclaration = (
  query: UtilityScopeAuditQuery,
  declaration: UtilityScopeAuditDeclaration
): boolean =>
  query.mode === declaration.mode &&
  (declaration.mode !== "diff-range" ||
    (query.baseRef === declaration.range?.baseRef &&
      query.headRef === declaration.range?.headRef &&
      query.rangeOperator === declaration.range?.rangeOperator));

const queryCoversDeclarationPaths = (
  query: UtilityScopeAuditQuery,
  declaration: UtilityScopeAuditDeclaration
): boolean => {
  const queryPaths = new Set(query.paths);
  return declaration.paths.every((path) => queryPaths.has(path));
};

const failScopeAuditRequest = (
  reasonCode: UtilityScopeAuditRequestReasonCode,
  detail: string
): never => {
  throw new UtilityScopeAuditRequestError(reasonCode, detail);
};

const assertDeclarationCovered = (
  collection: UtilityScopeAuditCollection,
  declaration: UtilityScopeAuditDeclaration
): void => {
  const sameMode = collection.manifests.filter(
    (manifest) => manifest.query.mode === declaration.mode
  );
  const sameSelection = sameMode.filter((manifest) =>
    queryMatchesDeclaration(manifest.query, declaration)
  );
  if (sameSelection.length === 0) {
    if (declaration.mode === "diff-range" && sameMode.length > 0) {
      failScopeAuditRequest(
        "scope-audit-range-mismatch",
        "persisted Git range differs from the declared literal range"
      );
    }
    if (
      declaration.legacyUndeclared &&
      collection.manifests.some(
        (manifest) => manifest.query.mode === "diff-range"
      )
    ) {
      failScopeAuditRequest(
        "scope-audit-orphan-manifest",
        "a range manifest cannot satisfy an undeclared Git-diff selection"
      );
    }
    failScopeAuditRequest(
      "scope-audit-mode-mismatch",
      `no manifest matches declared Git mode ${declaration.mode}`
    );
  }
  if (
    !sameSelection.some((manifest) =>
      queryCoversDeclarationPaths(manifest.query, declaration)
    )
  ) {
    failScopeAuditRequest(
      "scope-audit-paths-narrowed",
      "persisted Git pathspec omits a declared literal path"
    );
  }
};

const assertManifestIsDeclared = (
  manifest: UtilityScopeAuditEvidence,
  declarations: readonly UtilityScopeAuditDeclaration[]
): void => {
  const compatibleDeclarations = declarations.filter((declaration) =>
    queryMatchesDeclaration(manifest.query, declaration)
  );
  if (compatibleDeclarations.length === 0) {
    failScopeAuditRequest(
      "scope-audit-orphan-manifest",
      `manifest mode ${manifest.query.mode} has no matching declaration`
    );
  }
  const declaredPaths = new Set(
    compatibleDeclarations.flatMap((declaration) => declaration.paths)
  );
  if (manifest.query.paths.some((path) => !declaredPaths.has(path))) {
    failScopeAuditRequest(
      "scope-audit-orphan-manifest",
      "manifest pathspec includes a path absent from matching declarations"
    );
  }
};

export const assertUtilityScopeAuditCollectionForRequest = (
  request: UtilityRouteRequest,
  value: unknown
): UtilityScopeAuditCollection | undefined => {
  const declarations = scopeAuditDeclarations(request);
  if (declarations.length === 0 && value === undefined) {
    return undefined;
  }
  if (value === undefined) {
    return failScopeAuditRequest(
      "scope-audit-evidence-missing",
      "Git scope request completed without an authoritative manifest"
    );
  }
  const collection = assertUtilityScopeAuditCollection(value);
  if (declarations.length === 0) {
    return failScopeAuditRequest(
      "scope-audit-orphan-manifest",
      "scope evidence exists without a declared Git scope request"
    );
  }

  for (const declaration of declarations) {
    assertDeclarationCovered(collection, declaration);
  }

  for (const manifest of collection.manifests) {
    assertManifestIsDeclared(manifest, declarations);
  }
  return collection;
};
