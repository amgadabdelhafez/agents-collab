import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { GitResult } from "./git";
import { runGit as runGitCommand } from "./git";
import { resolveCheckoutId } from "./run-state";

/**
 * Location-independent repository identity (RA1).
 *
 * - repoKey: "<owner>/<name>", the same in every checkout of one repository.
 *   It comes from the committed `.harness/project.json` at the repo root, or,
 *   when that file is absent, from the normalized `origin` remote path.
 * - checkoutId: the path-hash id `resolveCheckoutId` has always computed (the
 *   historical `repoId`). It stays a local cache key only: run storage under
 *   `~/.loop/runs/<checkoutId>`, run manifests, endpoint run refs, the panel.
 * - role id: `supervisor:<repoKey>/<project>` for a project the repository
 *   declares. One holder at a time is the r9 lease's job, not this module's.
 */

export const PROJECT_FILE = ".harness/project.json";
const PROJECT_DIR = ".harness";
const PROJECT_FILE_NAME = "project.json";
const PROJECT_FILE_MAX_BYTES = 64 * 1024;
const PROJECT_FILE_KEYS = ["repo", "projects"] as const;

/** One path segment: RECIPIENT_RE's body character rules, without '/'. */
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** RECIPIENT_RE's body length bound, kept for role ids. */
const ID_BODY_MAX = 128;
const SUPERVISOR_PREFIX = "supervisor:";

/**
 * A role id: RECIPIENT_RE (`supervisor:[a-z0-9][a-z0-9._-]{0,127}`) extended
 * for '/'. The body is still at most 128 characters of [a-z0-9._-/], and every
 * '/'-separated segment starts with a letter or digit, so no segment is empty,
 * "." or "..". Exactly three segments: owner, name, project.
 */
export const SUPERVISOR_ROLE_ID_RE =
  /^supervisor:(?=[a-z0-9._/-]{1,128}$)[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

/** A legacy flat supervisor id: RECIPIENT_RE exactly. */
const LEGACY_SUPERVISOR_ID_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/;
const SESSION_ID_RE = /^session:[a-z0-9][a-z0-9._-]{0,127}$/;
const OPERATOR_PRINCIPAL_RE = /^operator:[a-z0-9][a-z0-9._-]{0,127}$/;

export class ProjectIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectIdentityError";
  }
}

export interface ProjectFile {
  projects: readonly string[];
  repo: string;
}

export type RepoKeySource = "project-file" | "origin-remote" | "none";

export interface RepoIdentity {
  /** Path-hash id of this clone: a local cache key, never an identity. */
  checkoutId: string;
  /** Projects the committed file declares; empty without the file. */
  projects: readonly string[];
  /** "<owner>/<name>"; absent when neither source names the repository. */
  repoKey?: string;
  /** The checkout's top level, when cwd is inside a git work tree. */
  repoRoot?: string;
  source: RepoKeySource;
}

export interface ProjectIdentityDeps {
  runGit: (cwd: string, args: string[]) => GitResult;
}

const defaultDeps: ProjectIdentityDeps = {
  runGit: (cwd, args) => runGitCommand(cwd, args, "ignore"),
};

const quoted = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
};

const fail = (message: string): never => {
  throw new ProjectIdentityError(`${PROJECT_FILE}: ${message}`);
};

const SEGMENT_RULE =
  "lowercase letters, digits, '.', '_' or '-', starting with a letter or digit";

/** "<owner>/<name>" with both parts valid segments and no ".git" suffix. */
export const isRepoKey = (value: string): boolean => {
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    parts.every((part) => SEGMENT_RE.test(part)) &&
    !value.endsWith(".git") &&
    value.length <= ID_BODY_MAX
  );
};

export const isProjectName = (value: string): boolean => SEGMENT_RE.test(value);

export const isSupervisorRoleId = (value: string): boolean =>
  SUPERVISOR_ROLE_ID_RE.test(value);

/** `supervisor:<repoKey>/<project>`, refused unless both parts are valid. */
export const supervisorRoleId = (repoKey: string, project: string): string => {
  if (!isRepoKey(repoKey)) {
    throw new ProjectIdentityError(
      `repo key must be "<owner>/<name>": ${SEGMENT_RULE} in each part (got ${quoted(repoKey)})`
    );
  }
  if (!isProjectName(project)) {
    throw new ProjectIdentityError(
      `project must be a name of ${SEGMENT_RULE} (got ${quoted(project)})`
    );
  }
  const roleId = `${SUPERVISOR_PREFIX}${repoKey}/${project}`;
  if (!SUPERVISOR_ROLE_ID_RE.test(roleId)) {
    throw new ProjectIdentityError(
      `role id ${quoted(roleId)} exceeds ${ID_BODY_MAX} characters after "supervisor:"`
    );
  }
  return roleId;
};

export const parseSupervisorRoleId = (
  value: string
): { project: string; repoKey: string } | undefined => {
  if (!SUPERVISOR_ROLE_ID_RE.test(value)) {
    return undefined;
  }
  const body = value.slice(SUPERVISOR_PREFIX.length);
  const cut = body.lastIndexOf("/");
  return { project: body.slice(cut + 1), repoKey: body.slice(0, cut) };
};

/** Validate parsed JSON as a project file; every error names the file. */
export const parseProjectFile = (text: string): ProjectFile => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PROJECT_FILE_KEYS as readonly string[]).includes(key)) {
      fail(`unknown key ${quoted(key)} (allowed: "repo", "projects")`);
    }
  }
  const repo = record.repo;
  if (typeof repo !== "string") {
    return fail(`"repo" must be a string "<owner>/<name>"`);
  }
  if (!isRepoKey(repo)) {
    fail(
      `"repo" must be "<owner>/<name>": ${SEGMENT_RULE} in each part, no ".git" suffix (got ${quoted(repo)})`
    );
  }
  const projects = record.projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    return fail(`"projects" must be a non-empty array of project names`);
  }
  const seen = new Set<string>();
  projects.forEach((project: unknown, index) => {
    if (typeof project !== "string" || !isProjectName(project)) {
      fail(
        `"projects"[${index}] must be a project name of ${SEGMENT_RULE} (got ${quoted(project)})`
      );
    }
    const name = project as string;
    if (seen.has(name)) {
      fail(`"projects" lists ${quoted(name)} more than once`);
    }
    seen.add(name);
    try {
      supervisorRoleId(repo, name);
    } catch (error) {
      fail((error as Error).message);
    }
  });
  return { projects: [...seen], repo };
};

const lstatOrUndefined = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
};

/**
 * Read `<repoRoot>/.harness/project.json`. Absent is `undefined`; anything
 * present but not a well-formed regular file is refused, never ignored, so a
 * broken file cannot silently fall back to the remote.
 */
export const readProjectFile = (repoRoot: string): ProjectFile | undefined => {
  const dir = join(repoRoot, PROJECT_DIR);
  const dirStat = lstatOrUndefined(dir);
  if (!dirStat) {
    return undefined;
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    fail(`${PROJECT_DIR} must be a directory, not a symlink or file`);
  }
  const path = join(dir, PROJECT_FILE_NAME);
  const stat = lstatOrUndefined(path);
  if (!stat) {
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("must be a regular file, not a symlink");
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      fail("must be a regular file, not a symlink");
    }
    if (opened.size > PROJECT_FILE_MAX_BYTES) {
      fail(`larger than ${PROJECT_FILE_MAX_BYTES} bytes`);
    }
    return parseProjectFile(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
};

const SCHEME_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// scp-like `[user@]host:path`, where host has no '/' and path is not `//...`.
const SCP_LIKE_RE = /^(?:[^@/\s]+@)?[^:/\s]+:(?!\/\/)(\S+)$/;
const NETWORK_SCHEMES = new Set([
  "http:",
  "https:",
  "ssh:",
  "git:",
  "git+ssh:",
]);

/**
 * The repo key a hosted remote names: Forgejo or GitHub, over https, http,
 * ssh or scp-like syntax. Scheme, credentials, host, port and a ".git"
 * suffix are dropped and the rest lowercased. Local paths, file:// URLs and
 * anything not exactly "<owner>/<name>" name no repository: `undefined`.
 */
export const normalizeRemoteRepoKey = (remote: string): string | undefined => {
  const text = remote.trim();
  let path: string;
  if (SCHEME_URL_RE.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    if (!(NETWORK_SCHEMES.has(url.protocol.toLowerCase()) && url.host)) {
      return undefined;
    }
    if (url.search || url.hash) {
      return undefined;
    }
    path = url.pathname;
  } else {
    const match = SCP_LIKE_RE.exec(text);
    if (!match?.[1]) {
      return undefined;
    }
    path = match[1];
  }
  if (path.includes("%") || path.includes("\\")) {
    return undefined;
  }
  let key = path.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (key.endsWith(".git")) {
    key = key.slice(0, -".git".length);
  }
  return isRepoKey(key) ? key : undefined;
};

const gitStdout = (
  deps: ProjectIdentityDeps,
  cwd: string,
  args: string[]
): string | undefined => {
  const result = deps.runGit(cwd, args);
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
};

export const resolveRepoRoot = (
  cwd: string,
  overrides: Partial<ProjectIdentityDeps> = {}
): string | undefined => {
  const deps = { ...defaultDeps, ...overrides };
  const top = gitStdout(deps, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  return top ? resolvePath(cwd, top) : undefined;
};

/** The origin remote's repo key, or `undefined` (no origin, local path). */
export const resolveOriginRepoKey = (
  cwd: string,
  overrides: Partial<ProjectIdentityDeps> = {}
): string | undefined => {
  const deps = { ...defaultDeps, ...overrides };
  const url = gitStdout(deps, cwd, ["config", "--get", "remote.origin.url"]);
  return url ? normalizeRemoteRepoKey(url) : undefined;
};

export const resolveRepoIdentity = (
  cwd = process.cwd(),
  overrides: Partial<ProjectIdentityDeps> = {}
): RepoIdentity => {
  const deps = { ...defaultDeps, ...overrides };
  const checkoutId = resolveCheckoutId(cwd, {
    runGit: (args) => deps.runGit(cwd, args),
  });
  const repoRoot = resolveRepoRoot(cwd, deps);
  const file = repoRoot ? readProjectFile(repoRoot) : undefined;
  if (file) {
    return {
      checkoutId,
      projects: file.projects,
      repoKey: file.repo,
      ...(repoRoot ? { repoRoot } : {}),
      source: "project-file",
    };
  }
  const originKey = repoRoot ? resolveOriginRepoKey(repoRoot, deps) : undefined;
  return {
    checkoutId,
    projects: [],
    ...(originKey ? { repoKey: originKey } : {}),
    ...(repoRoot ? { repoRoot } : {}),
    source: originKey ? "origin-remote" : "none",
  };
};

/**
 * The role id this checkout serves for `project`. Only a project the
 * committed file declares has a role; with exactly one declared project the
 * argument may be omitted.
 */
export const resolveSupervisorRole = (
  identity: RepoIdentity,
  project?: string
): string => {
  if (identity.source !== "project-file" || !identity.repoKey) {
    throw new ProjectIdentityError(
      `no ${PROJECT_FILE} in this repository: a supervisor role needs a declared project (run \`loop project init\`)`
    );
  }
  let chosen = project;
  if (chosen === undefined) {
    if (identity.projects.length !== 1) {
      throw new ProjectIdentityError(
        `${PROJECT_FILE} declares ${identity.projects.length} projects: name one of ${identity.projects.map(quoted).join(", ")}`
      );
    }
    chosen = identity.projects[0] as string;
  }
  if (!identity.projects.includes(chosen)) {
    throw new ProjectIdentityError(
      `project ${quoted(chosen)} is not declared in ${PROJECT_FILE} (declared: ${identity.projects.map(quoted).join(", ")})`
    );
  }
  return supervisorRoleId(identity.repoKey, chosen);
};

// ---------------------------------------------------------------------------
// Legacy supervisor ids, kept working for one release.

export type LegacySupervisorAlias =
  | { kind: "role"; legacyId: string; project: string }
  | {
      kind: "session";
      legacyId: string;
      /** The legacy role id this session may hold, resolved like any role. */
      mayHold: string;
      sessionId: string;
    }
  | { kind: "operator"; legacyId: string; principal: string };

const LEGACY_ALIAS_LIST: readonly LegacySupervisorAlias[] = [
  { kind: "role", legacyId: "supervisor:harness", project: "harness" },
  { kind: "role", legacyId: "supervisor:harvto", project: "harvto" },
  { kind: "role", legacyId: "supervisor:ai-cur", project: "ai-cur" },
  {
    kind: "session",
    legacyId: "supervisor:harness-desktop",
    mayHold: "supervisor:harness",
    sessionId: "session:harness-desktop",
  },
  {
    kind: "operator",
    legacyId: "supervisor:portfolio-coordinator",
    principal: "operator:portfolio-coordinator",
  },
];

/**
 * The five supervisor ids in use before RA1. They keep working for one
 * release, then this table is deleted: every entry is a flat legacy id, and
 * nothing here is a role id, so the table cannot shadow a new identity.
 */
export const LEGACY_SUPERVISOR_ALIASES: ReadonlyMap<
  string,
  LegacySupervisorAlias
> = new Map(LEGACY_ALIAS_LIST.map((alias) => [alias.legacyId, alias]));

export type ResolvedSupervisorIdentity =
  | { kind: "role"; legacyId?: string; roleId: string }
  | {
      kind: "session";
      legacyId: string;
      mayHoldRoleId: string;
      sessionId: string;
    }
  | { kind: "operator"; legacyId: string; principal: string };

/**
 * Resolve a supervisor id to its RA1 identity. A role id passes through. A
 * legacy role or session needs the repo key its role lives in, from
 * `legacyRepoKeys` (operator configuration keyed by the legacy role id); this
 * module never guesses which repository a legacy id meant.
 */
export const resolveSupervisorIdentity = (
  supervisorId: string,
  legacyRepoKeys: Readonly<Record<string, string>> = {}
): ResolvedSupervisorIdentity => {
  if (isSupervisorRoleId(supervisorId)) {
    return { kind: "role", roleId: supervisorId };
  }
  const alias = LEGACY_SUPERVISOR_ALIASES.get(supervisorId);
  if (!alias) {
    throw new ProjectIdentityError(
      `${quoted(supervisorId)} is neither a role id "supervisor:<owner>/<name>/<project>" nor a legacy supervisor id`
    );
  }
  const legacyRole = (legacyId: string): string => {
    const target = LEGACY_SUPERVISOR_ALIASES.get(legacyId);
    if (target?.kind !== "role") {
      throw new ProjectIdentityError(
        `${quoted(legacyId)} is not a legacy role`
      );
    }
    const repoKey = legacyRepoKeys[legacyId];
    if (repoKey === undefined) {
      throw new ProjectIdentityError(
        `legacy ${legacyId} has no repo key: bind it to "<owner>/<name>"`
      );
    }
    return supervisorRoleId(repoKey, target.project);
  };
  switch (alias.kind) {
    case "role":
      return {
        kind: "role",
        legacyId: alias.legacyId,
        roleId: legacyRole(alias.legacyId),
      };
    case "session":
      return {
        kind: "session",
        legacyId: alias.legacyId,
        mayHoldRoleId: legacyRole(alias.mayHold),
        sessionId: alias.sessionId,
      };
    default:
      return {
        kind: "operator",
        legacyId: alias.legacyId,
        principal: alias.principal,
      };
  }
};

/** Self-check of the alias table's shapes; run at import. */
const checkAliasTable = (): void => {
  for (const alias of LEGACY_ALIAS_LIST) {
    if (!LEGACY_SUPERVISOR_ID_RE.test(alias.legacyId)) {
      throw new Error(`legacy alias ${alias.legacyId} is not a flat id`);
    }
    if (alias.kind === "session" && !SESSION_ID_RE.test(alias.sessionId)) {
      throw new Error(`legacy alias ${alias.legacyId} has a bad session id`);
    }
    if (
      alias.kind === "operator" &&
      !OPERATOR_PRINCIPAL_RE.test(alias.principal)
    ) {
      throw new Error(`legacy alias ${alias.legacyId} has a bad principal`);
    }
  }
};
checkAliasTable();

// ---------------------------------------------------------------------------
// `loop project init`

export interface ProjectInitResult {
  overwritten: boolean;
  path: string;
  projects: readonly string[];
  repo: string;
  repoSource: "flag" | "origin-remote";
}

export const renderProjectFile = (file: ProjectFile): string =>
  `${JSON.stringify({ repo: file.repo, projects: [...file.projects] }, null, 2)}\n`;

/**
 * Write `<repoRoot>/.harness/project.json`. Refuses an existing file unless
 * `force`; the content is validated by the same parser that reads it, and
 * written by rename so a reader never sees half a file.
 */
export const initProjectFile = (input: {
  cwd: string;
  force: boolean;
  projects: readonly string[];
  repo?: string;
  deps?: Partial<ProjectIdentityDeps>;
}): ProjectInitResult => {
  const deps = { ...defaultDeps, ...input.deps };
  const repoRoot = resolveRepoRoot(input.cwd, deps);
  if (!repoRoot) {
    throw new ProjectIdentityError(
      "loop project init must run inside a git work tree"
    );
  }
  const repo = input.repo ?? resolveOriginRepoKey(repoRoot, deps);
  if (!repo) {
    throw new ProjectIdentityError(
      'loop project init needs --repo <owner>/<name>: the origin remote names no "<owner>/<name>"'
    );
  }
  if (input.projects.length === 0) {
    throw new ProjectIdentityError(
      "loop project init needs at least one --project <name>"
    );
  }
  const content = renderProjectFile({ projects: input.projects, repo });
  const file = parseProjectFile(content);
  const dir = join(repoRoot, PROJECT_DIR);
  const dirStat = lstatOrUndefined(dir);
  if (dirStat && (!dirStat.isDirectory() || dirStat.isSymbolicLink())) {
    fail(`${PROJECT_DIR} must be a directory, not a symlink or file`);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PROJECT_FILE_NAME);
  const existing = lstatOrUndefined(path);
  if (existing && !input.force) {
    fail("already exists; pass --force to overwrite");
  }
  const temp = join(dir, `.${PROJECT_FILE_NAME}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return {
    overwritten: Boolean(existing),
    path,
    projects: file.projects,
    repo: file.repo,
    repoSource: input.repo === undefined ? "origin-remote" : "flag",
  };
};
