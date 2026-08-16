import { createHash, randomUUID } from "node:crypto";
import { type Dirent, constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawn } from "bun";
import type { Agent } from "./types";
import {
  DEFAULT_UTILITY_PROTECTED_PATHS,
  isUtilityProtectedPath,
  UTILITY_PROTECTED_GIT_GLOBS,
} from "./utility-path-policy";
import {
  buildUtilityScopeAuditEvidence,
  parseGitDiffScopeRecords,
  parseGitStatusScopeRecords,
  type UtilityScopeAuditEvidence,
  type UtilityScopeAuditQuery,
  type UtilityScopeAuditSurface,
} from "./utility-scope-audit";
import type {
  UtilityFileImage,
  UtilityPatchApplication,
} from "./utility-store";

export type UtilityToolName =
  | "search_repo"
  | "read_file"
  | "count_lines"
  | "list_files"
  | "git_status"
  | "git_diff"
  | "git_inspect"
  | "run_check"
  | "propose_patch";

export interface UtilityToolCall {
  arguments: unknown;
  name: UtilityToolName;
}

export interface UtilityToolDefinition {
  function: {
    description: string;
    name: UtilityToolName;
    parameters: Record<string, unknown>;
  };
  type: "function";
}

export interface UtilityToolError {
  code: string;
  message: string;
}

export interface UtilityArtifactReference {
  manifestPath?: string;
  manifestSha256?: string;
  path: string;
  sha256: string;
}

export interface UtilityToolResult<T = unknown> {
  artifact?: UtilityArtifactReference;
  data?: T;
  durationMs: number;
  error?: UtilityToolError;
  exitCode?: number;
  ok: boolean;
  scopeAudit?: UtilityScopeAuditEvidence;
  stderr?: string;
  stdout?: string;
  tool: UtilityToolName;
  truncated?: boolean;
}

export interface UtilityCommandPolicy {
  /** The executable name must match exactly; paths and shell executables are rejected. */
  executable: string;
  /** At least one argv prefix must match. Any remaining arguments must be scoped paths. */
  prefixes: readonly (readonly string[])[];
  /** Require this repository-local node_modules binary before invoking npx. */
  requireLocalBinary?: string;
}

export interface UtilityToolLimits {
  maxCommandArgs: number;
  maxFileBytes: number;
  maxListEntries: number;
  maxOutputBytes: number;
  maxPatchBytes: number;
  maxSearchFiles: number;
  maxSearchResults: number;
  timeoutMs: number;
}

export interface UtilityExactRead {
  endLine?: number;
  lastLines?: number;
  path: string;
  startLine?: number;
}

export interface UtilityOutputBoundary {
  excludeLines?: string[];
  includeLines?: string[];
  lineLimit?: number;
  position?: "head" | "tail";
  stderr?: "merge" | "omit";
  stripAnsi?: boolean;
}

export interface UtilityToolBrokerConfig {
  allowedTools?: readonly UtilityToolName[];
  artifactDir: string;
  commandAllowlist?: readonly UtilityCommandPolicy[];
  commandCwds?: readonly string[];
  exactCommand?: readonly string[];
  exactRead?: UtilityExactRead | null;
  exactWriteScopes?: boolean;
  limits?: Partial<UtilityToolLimits>;
  outputBoundary?: UtilityOutputBoundary;
  protectedPaths?: readonly string[];
  readScopes: readonly string[];
  repoRoot: string;
  writeScopes: readonly string[];
}

export interface CommandRequest {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface CommandExecution {
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface UtilityToolDependencies {
  id?: () => string;
  now?: () => number;
  runCommand?: (request: CommandRequest) => Promise<CommandExecution>;
  sourceEnv?: Readonly<Record<string, string | undefined>>;
}

export interface SearchMatch {
  line: number;
  path: string;
  text: string;
}

export interface PatchPreimage {
  path: string;
  sha256: string | null;
}

export interface PatchProposalManifest {
  createdAt: string;
  patchPath: string;
  preimages: PatchPreimage[];
  summary?: string;
}

export interface GuardedPatchApplyInput {
  appliedBy: Agent;
  existingApplication?: UtilityPatchApplication;
  expectedManifestSha256: string;
  expectedPatchSha256: string;
  manifestPath: string;
  patchPath: string;
}

export interface GuardedPatchApplyResult {
  application: UtilityPatchApplication;
  status: "applied" | "already-applied";
}

const DEFAULT_LIMITS: UtilityToolLimits = {
  maxCommandArgs: 24,
  maxFileBytes: 1024 * 1024,
  maxListEntries: 500,
  maxOutputBytes: 64 * 1024,
  maxPatchBytes: 256 * 1024,
  maxSearchFiles: 500,
  maxSearchResults: 100,
  timeoutMs: 60_000,
};

const DEFAULT_COMMAND_ALLOWLIST: readonly UtilityCommandPolicy[] = [
  { executable: "bun", prefixes: [["test"]] },
  { executable: "node", prefixes: [["--check"]] },
  {
    executable: "npx",
    prefixes: [["vitest", "run"]],
    requireLocalBinary: "vitest",
  },
];
export const UTILITY_REPOSITORY_POLICY_PATH = ".loop/utility-policy.json";
const MAX_COMMAND_POLICIES = 16;
const MAX_PREFIXES_PER_POLICY = 16;
const MAX_PREFIX_LENGTH = 8;

const SAFE_ENV_NAMES = new Set([
  "CI",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
]);
const SECRET_ENV_NAME =
  /(?:api[_-]?key|auth|cookie|credential|password|secret|session|token)/i;
const SHELL_META = /[;&|`$<>\n\r\0]/;
const LINE_BREAK = /\r?\n/;
const LINE_MATCHER_CONTROL_RE = /[\n\r\0]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR escape matcher
const ANSI_SGR_RE = /\u001b\[[0-9;]*m/g;
const FORBIDDEN_PATCH_OPERATION =
  /^(?:deleted file mode|rename from|rename to|old mode|new mode|GIT binary patch|Binary files )/m;
const SHELL_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "dash",
  "fish",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const DANGEROUS_COMMAND_OPTIONS = new Set([
  "--config",
  "--cwd",
  "--eval",
  "--preload",
  "-c",
  "-e",
]);
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const GIT_BRANCH_PATTERN_RE = /^[A-Za-z0-9._/*?-]{1,128}$/;
const LOCAL_BINARY_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const COMMIT_HASH_RE = /^[0-9a-f]{7,64}$/i;
const RESOLVED_COMMIT_HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const DEPENDENCY_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.toml",
  "composer.json",
  "gemfile",
  "go.mod",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pyproject.toml",
  "requirements.txt",
  "yarn.lock",
]);
const DEFAULT_PROTECTED_PATHS = [...DEFAULT_UTILITY_PROTECTED_PATHS] as const;
const MAX_LINE_COUNT_FILES = 8;

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  additionalProperties: false,
  properties,
  required,
  type: "object",
});

export const UTILITY_TOOL_DEFINITIONS: readonly UtilityToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_repo",
      description: "Search text in declared repository read scopes.",
      parameters: objectSchema(
        {
          caseSensitive: { type: "boolean" },
          maxResults: { minimum: 1, type: "integer" },
          paths: { items: { type: "string" }, type: "array" },
          query: { minLength: 1, type: "string" },
          regex: { type: "boolean" },
        },
        ["query"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read at most 500 lines from a declared repository file. Split larger reads into non-overlapping ranges of 500 lines or fewer.",
      parameters: objectSchema(
        {
          endLine: { minimum: 1, type: "integer" },
          lastLines: { maximum: 500, minimum: 1, type: "integer" },
          path: { minLength: 1, type: "string" },
          startLine: { minimum: 1, type: "integer" },
        },
        ["path"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "count_lines",
      description:
        "Count newline characters in up to eight declared regular files, matching wc -l semantics without invoking a shell.",
      parameters: objectSchema(
        {
          paths: {
            items: { minLength: 1, type: "string" },
            maxItems: MAX_LINE_COUNT_FILES,
            minItems: 1,
            type: "array",
          },
        },
        ["paths"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List one declared repository directory without recursion or symlink traversal.",
      parameters: objectSchema(
        {
          includeHidden: { type: "boolean" },
          path: { minLength: 1, type: "string" },
        },
        ["path"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Return bounded porcelain status for declared read scopes.",
      parameters: objectSchema({}),
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description:
        "Return a bounded git diff for declared paths, optionally between literal commit hashes; use check for git diff --check and nameOnly for a changed-file list.",
      parameters: objectSchema({
        baseRef: { minLength: 7, type: "string" },
        check: { type: "boolean" },
        headRef: { minLength: 7, type: "string" },
        nameOnly: { type: "boolean" },
        paths: { items: { type: "string" }, type: "array" },
        staged: { type: "boolean" },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "git_inspect",
      description:
        "Run one bounded read-only Git metadata query: resolve-ref, log, show-stat, branch-list, current-branch, worktree-list, or object-type.",
      parameters: objectSchema(
        {
          action: {
            enum: [
              "resolve-ref",
              "log",
              "show-stat",
              "branch-list",
              "current-branch",
              "worktree-list",
              "object-type",
            ],
            type: "string",
          },
          limit: { maximum: 50, minimum: 1, type: "integer" },
          includeMetadata: { type: "boolean" },
          pattern: { minLength: 1, type: "string" },
          ref: { minLength: 1, type: "string" },
        },
        ["action"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "run_check",
      description:
        "Run one allowlisted command as literal argv without a shell.",
      parameters: objectSchema(
        {
          argv: { items: { type: "string" }, minItems: 1, type: "array" },
          cwd: { type: "string" },
        },
        ["argv"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "propose_patch",
      description:
        "Validate and store a patch proposal artifact without applying it.",
      parameters: objectSchema(
        {
          patch: { minLength: 1, type: "string" },
          summary: { type: "string" },
        },
        ["patch"]
      ),
    },
  },
];

class ToolPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const outputBoundaryIsValid = (value: UtilityOutputBoundary): boolean => {
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        ![
          "excludeLines",
          "includeLines",
          "lineLimit",
          "position",
          "stderr",
          "stripAnsi",
        ].includes(key)
    )
  ) {
    return false;
  }
  const hasFilter =
    value.lineLimit !== undefined || value.position !== undefined;
  const validFilter =
    Number.isSafeInteger(value.lineLimit) &&
    (value.lineLimit as number) > 0 &&
    (value.lineLimit as number) <= 500 &&
    (value.position === "head" || value.position === "tail");
  const validLineMatchers = (candidate: unknown): boolean =>
    candidate === undefined ||
    (Array.isArray(candidate) &&
      candidate.length >= 1 &&
      candidate.length <= 16 &&
      candidate.every(
        (entry) =>
          typeof entry === "string" &&
          entry.length >= 1 &&
          entry.length <= 80 &&
          !LINE_MATCHER_CONTROL_RE.test(entry)
      ));
  return (
    (!hasFilter || validFilter) &&
    (value.stderr === undefined ||
      value.stderr === "merge" ||
      value.stderr === "omit") &&
    (value.stripAnsi === undefined || typeof value.stripAnsi === "boolean") &&
    validLineMatchers(value.includeLines) &&
    validLineMatchers(value.excludeLines) &&
    (hasFilter ||
      value.stderr !== undefined ||
      value.stripAnsi === true ||
      value.includeLines !== undefined ||
      value.excludeLines !== undefined)
  );
};

const sliceBoundedValues = <T>(
  values: readonly T[],
  boundary: UtilityOutputBoundary
): T[] => {
  if (!(boundary.lineLimit && boundary.position)) {
    return [...values];
  }
  return boundary.position === "head"
    ? values.slice(0, boundary.lineLimit)
    : values.slice(-boundary.lineLimit);
};

const sliceBoundedText = (
  value: string,
  boundary: UtilityOutputBoundary
): { lineCount: number; text: string } => {
  if (!(boundary.lineLimit && boundary.position)) {
    return {
      lineCount: value.length === 0 ? 0 : value.split(LINE_BREAK).length,
      text: value,
    };
  }
  const lines = value.length === 0 ? [] : value.split(LINE_BREAK);
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) {
    lines.pop();
  }
  const selected = sliceBoundedValues(lines, boundary);
  return {
    lineCount: selected.length,
    text: `${selected.join("\n")}${trailingNewline && selected.length > 0 ? "\n" : ""}`,
  };
};

type UtilityDispatchResult = Omit<
  UtilityToolResult,
  "durationMs" | "ok" | "tool"
>;

const boundCommandOutput = (
  result: UtilityDispatchResult,
  boundary: UtilityOutputBoundary
): UtilityDispatchResult => {
  if (typeof result.stdout !== "string") {
    return result;
  }
  const bounded = { ...result };
  if (boundary.stderr === "merge") {
    const separator =
      bounded.stdout && bounded.stderr && !bounded.stdout.endsWith("\n")
        ? "\n"
        : "";
    bounded.stdout = `${bounded.stdout}${separator}${bounded.stderr ?? ""}`;
    bounded.stderr = "";
  } else if (boundary.stderr === "omit") {
    bounded.stderr = "";
  }
  const filterText = (value: string): string => {
    let next = boundary.stripAnsi ? value.replace(ANSI_SGR_RE, "") : value;
    if (boundary.includeLines || boundary.excludeLines) {
      const trailingNewline = next.endsWith("\n");
      const lines = next.length === 0 ? [] : next.split(LINE_BREAK);
      if (lines.at(-1) === "") {
        lines.pop();
      }
      next = lines
        .filter(
          (line) =>
            (!boundary.includeLines ||
              boundary.includeLines.some((needle) => line.includes(needle))) &&
            !boundary.excludeLines?.some((needle) => line.includes(needle))
        )
        .join("\n");
      if (trailingNewline && next.length > 0) {
        next += "\n";
      }
    }
    return sliceBoundedText(next, boundary).text;
  };
  bounded.stdout = filterText(bounded.stdout);
  if (typeof bounded.stderr === "string") {
    bounded.stderr = filterText(bounded.stderr);
  }
  return bounded;
};

const boundStructuredOutput = (
  data: unknown,
  boundary: UtilityOutputBoundary
): unknown => {
  if (Array.isArray(data)) {
    return sliceBoundedValues(data, boundary);
  }
  if (!isRecord(data)) {
    return data;
  }
  const bounded = { ...data };
  if (Array.isArray(bounded.entries)) {
    const originalEntries = bounded.entries;
    const entries = sliceBoundedValues(originalEntries, boundary);
    bounded.entries = entries;
    bounded.truncated =
      bounded.truncated === true || entries.length < originalEntries.length;
  }
  if (
    typeof bounded.content !== "string" ||
    typeof bounded.startLine !== "number" ||
    typeof bounded.endLine !== "number"
  ) {
    return bounded;
  }
  const sliced = sliceBoundedText(bounded.content, boundary);
  bounded.content = sliced.text;
  if (boundary.position === "tail") {
    bounded.startLine = Math.max(
      bounded.startLine,
      bounded.endLine - sliced.lineCount + 1
    );
  } else {
    bounded.endLine = Math.min(
      bounded.endLine,
      bounded.startLine + sliced.lineCount - 1
    );
  }
  return bounded;
};

const applyOutputBoundary = (
  result: UtilityDispatchResult,
  boundary: UtilityOutputBoundary | undefined
): UtilityDispatchResult => {
  if (!boundary) {
    return result;
  }
  const bounded = boundCommandOutput(result, boundary);
  return bounded.data === undefined
    ? bounded
    : { ...bounded, data: boundStructuredOutput(bounded.data, boundary) };
};

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new ToolPolicyError(
      "invalid_arguments",
      "Arguments must be an object"
    );
  }
  return value;
};

const requireString = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolPolicyError(
      "invalid_arguments",
      `${key} must be a non-empty string`
    );
  }
  return value;
};

const optionalString = (
  args: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolPolicyError("invalid_arguments", `${key} must be a string`);
  }
  return value;
};

const optionalBoolean = (
  args: Record<string, unknown>,
  key: string
): boolean | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolPolicyError("invalid_arguments", `${key} must be a boolean`);
  }
  return value;
};

const optionalPositiveInteger = (
  args: Record<string, unknown>,
  key: string
): number | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ToolPolicyError(
      "invalid_arguments",
      `${key} must be a positive integer`
    );
  }
  return value as number;
};

const optionalStringArray = (
  args: Record<string, unknown>,
  key: string
): string[] | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolPolicyError(
      "invalid_arguments",
      `${key} must be a string array`
    );
  }
  return value as string[];
};

interface UtilityGitDiffSelection {
  baseRef?: string;
  check: boolean;
  headRef?: string;
  nameOnly: boolean;
  paths: string[];
  staged: boolean;
  surface: Exclude<UtilityScopeAuditSurface, "untracked">;
}

interface UtilityGitDiffExecution {
  query: UtilityScopeAuditQuery;
  range?: string;
}

const utilityGitDiffSelection = (
  args: Record<string, unknown>,
  defaultPaths: readonly string[]
): UtilityGitDiffSelection => {
  const paths = [...(optionalStringArray(args, "paths") ?? defaultPaths)];
  const staged = optionalBoolean(args, "staged") ?? false;
  const baseRef = optionalString(args, "baseRef");
  const headRef = optionalString(args, "headRef");
  const check = optionalBoolean(args, "check") ?? false;
  const nameOnly = optionalBoolean(args, "nameOnly") ?? false;
  if (headRef && !baseRef) {
    throw new ToolPolicyError("invalid_arguments", "headRef requires baseRef");
  }
  if (staged && (baseRef || headRef)) {
    throw new ToolPolicyError(
      "invalid_arguments",
      "staged Git diff cannot carry range refs"
    );
  }
  for (const [label, ref] of [
    ["baseRef", baseRef],
    ["headRef", headRef],
  ] as const) {
    if (ref && !COMMIT_HASH_RE.test(ref)) {
      throw new ToolPolicyError(
        "invalid_arguments",
        `${label} must be a literal commit hash`
      );
    }
  }
  if (baseRef) {
    return {
      baseRef,
      check,
      headRef: headRef ?? "HEAD",
      nameOnly,
      paths,
      staged,
      surface: "commit",
    };
  }
  return {
    check,
    nameOnly,
    paths,
    staged,
    surface: staged ? "index" : "worktree",
  };
};

const exactKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void => {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ToolPolicyError(
      "invalid_policy",
      `${label} contains unsupported key: ${unknown}`
    );
  }
};

const exactArgumentKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void => {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ToolPolicyError(
      "invalid_arguments",
      `${label} contains unsupported key: ${unknown}`
    );
  }
};

const requireBoundedGitRef = (args: Record<string, unknown>): string => {
  const ref = requireString(args, "ref");
  if (!GIT_REF_RE.test(ref) || ref.includes("..")) {
    throw new ToolPolicyError(
      "invalid_arguments",
      "ref must be a bounded literal Git ref"
    );
  }
  return ref;
};

const gitInspectNoArgArgv = (
  action: string,
  args: Record<string, unknown>
): string[] | undefined => {
  if (action !== "current-branch" && action !== "worktree-list") {
    return undefined;
  }
  exactArgumentKeys(args, new Set(["action"]), "git_inspect");
  return action === "current-branch"
    ? ["git", "branch", "--show-current"]
    : ["git", "worktree", "list"];
};

const gitInspectLogArgv = (args: Record<string, unknown>): string[] => {
  exactArgumentKeys(args, new Set(["action", "limit", "ref"]), "git_inspect");
  const limit = optionalPositiveInteger(args, "limit") ?? 10;
  if (limit > 50) {
    throw new ToolPolicyError(
      "invalid_arguments",
      "log limit cannot exceed 50"
    );
  }
  const ref = optionalString(args, "ref");
  if (ref !== undefined && (!GIT_REF_RE.test(ref) || ref.includes(".."))) {
    throw new ToolPolicyError(
      "invalid_arguments",
      "ref must be a bounded literal Git ref"
    );
  }
  return [
    "git",
    "log",
    "--no-decorate",
    "--oneline",
    "-n",
    String(limit),
    ref ?? "HEAD",
  ];
};

const validatePolicyToken = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !value ||
    SHELL_META.test(value) ||
    DANGEROUS_COMMAND_OPTIONS.has(value)
  ) {
    throw new ToolPolicyError(
      "invalid_policy",
      `${label} contains an unsafe token`
    );
  }
  return value;
};

const parseCommandPolicy = (
  value: unknown,
  index: number
): UtilityCommandPolicy => {
  if (!isRecord(value)) {
    throw new ToolPolicyError(
      "invalid_policy",
      `commandAllowlist[${index}] must be an object`
    );
  }
  exactKeys(
    value,
    new Set(["executable", "prefixes", "requireLocalBinary"]),
    `commandAllowlist[${index}]`
  );
  const executable = validatePolicyToken(
    value.executable,
    `commandAllowlist[${index}].executable`
  );
  if (
    executable.includes("/") ||
    executable.includes("\\") ||
    SHELL_EXECUTABLES.has(executable.toLowerCase())
  ) {
    throw new ToolPolicyError(
      "invalid_policy",
      `commandAllowlist[${index}] executable is not allowed`
    );
  }
  if (
    !Array.isArray(value.prefixes) ||
    value.prefixes.length === 0 ||
    value.prefixes.length > MAX_PREFIXES_PER_POLICY
  ) {
    throw new ToolPolicyError(
      "invalid_policy",
      `commandAllowlist[${index}].prefixes is not bounded`
    );
  }
  const prefixes = value.prefixes.map((prefix, prefixIndex) => {
    if (
      !Array.isArray(prefix) ||
      prefix.length === 0 ||
      prefix.length > MAX_PREFIX_LENGTH
    ) {
      throw new ToolPolicyError(
        "invalid_policy",
        `commandAllowlist[${index}].prefixes[${prefixIndex}] is not bounded`
      );
    }
    return prefix.map((token, tokenIndex) =>
      validatePolicyToken(
        token,
        `commandAllowlist[${index}].prefixes[${prefixIndex}][${tokenIndex}]`
      )
    );
  });
  const requireLocalBinary = value.requireLocalBinary;
  if (
    requireLocalBinary !== undefined &&
    (typeof requireLocalBinary !== "string" ||
      !LOCAL_BINARY_NAME_RE.test(requireLocalBinary))
  ) {
    throw new ToolPolicyError(
      "invalid_policy",
      `commandAllowlist[${index}].requireLocalBinary is invalid`
    );
  }
  if (executable === "npx" && !requireLocalBinary) {
    throw new ToolPolicyError(
      "invalid_policy",
      "npx policy requires requireLocalBinary to prevent package download"
    );
  }
  return {
    executable,
    prefixes,
    ...(typeof requireLocalBinary === "string" ? { requireLocalBinary } : {}),
  };
};

export const loadUtilityCommandAllowlist = async (
  repoRoot: string
): Promise<readonly UtilityCommandPolicy[]> => {
  const canonicalRoot = await realpath(repoRoot);
  const path = resolve(canonicalRoot, UTILITY_REPOSITORY_POLICY_PATH);
  let policyStat: Awaited<ReturnType<typeof lstat>>;
  try {
    policyStat = await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return DEFAULT_COMMAND_ALLOWLIST;
    }
    throw new ToolPolicyError(
      "invalid_policy",
      "utility repository policy cannot be inspected"
    );
  }
  if (!policyStat.isFile() || policyStat.isSymbolicLink()) {
    throw new ToolPolicyError(
      "invalid_policy",
      "utility repository policy must be a regular non-symlink file"
    );
  }
  const canonicalPolicy = await realpath(path);
  if (!isContained(canonicalRoot, canonicalPolicy)) {
    throw new ToolPolicyError(
      "invalid_policy",
      "utility repository policy resolves outside repository"
    );
  }
  let raw: string;
  try {
    raw = await readFile(canonicalPolicy, "utf8");
  } catch {
    throw new ToolPolicyError(
      "invalid_policy",
      "utility repository policy cannot be read"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ToolPolicyError(
      "invalid_policy",
      "utility repository policy is not valid JSON"
    );
  }
  if (!isRecord(parsed)) {
    throw new ToolPolicyError(
      "invalid_policy",
      "utility repository policy must be an object"
    );
  }
  exactKeys(
    parsed,
    new Set(["version", "commandAllowlist"]),
    "utility repository policy"
  );
  if (parsed.version !== 1) {
    throw new ToolPolicyError(
      "invalid_policy",
      "utility repository policy version must be 1"
    );
  }
  if (
    !Array.isArray(parsed.commandAllowlist) ||
    parsed.commandAllowlist.length > MAX_COMMAND_POLICIES
  ) {
    throw new ToolPolicyError(
      "invalid_policy",
      "utility repository commandAllowlist is not bounded"
    );
  }
  return [
    ...DEFAULT_COMMAND_ALLOWLIST,
    ...parsed.commandAllowlist.map(parseCommandPolicy),
  ];
};

const relativePath = (root: string, target: string): string => {
  const value = relative(root, target);
  return value === "" ? "." : value.split(sep).join("/");
};

const isContained = (root: string, target: string): boolean => {
  const value = relative(root, target);
  return (
    value === "" ||
    !(value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value))
  );
};

const normalizeRequestedPath = (value: string): string => {
  if (!value || isAbsolute(value) || value.includes("\0")) {
    throw new ToolPolicyError(
      "path_denied",
      `Path must be repository-relative: ${value}`
    );
  }
  const normalized = relative(".", resolve(".", value)).split(sep).join("/");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new ToolPolicyError(
      "path_denied",
      `Path escapes repository: ${value}`
    );
  }
  return normalized === "" ? "." : normalized;
};

const inScope = (candidate: string, scope: string): boolean =>
  scope === "." || candidate === scope || candidate.startsWith(`${scope}/`);

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const directoryEntryType = (entry: Dirent): string => {
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isFile()) {
    return "file";
  }
  return entry.isSymbolicLink() ? "symlink" : "other";
};

export const scrubUtilityEnvironment = (
  source: Readonly<Record<string, string | undefined>>
): Record<string, string> => {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      SAFE_ENV_NAMES.has(name) &&
      !SECRET_ENV_NAME.test(name)
    ) {
      safe[name] = value;
    }
  }
  safe.CI = safe.CI ?? "1";
  safe.NO_COLOR = safe.NO_COLOR ?? "1";
  return safe;
};

const readProcessStream = async (
  stream: ReadableStream<Uint8Array>,
  budget: { remaining: number; truncated: boolean },
  onLimit: () => void
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const bytes = chunk.value;
      if (bytes.byteLength > budget.remaining) {
        output += decoder.decode(bytes.slice(0, budget.remaining), {
          stream: true,
        });
        budget.remaining = 0;
        budget.truncated = true;
        onLimit();
        break;
      }
      budget.remaining -= bytes.byteLength;
      output += decoder.decode(bytes, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return output + decoder.decode();
};

export const runUtilityCommand = async (
  request: CommandRequest
): Promise<CommandExecution> => {
  const child = spawn([...request.argv], {
    cwd: request.cwd,
    env: { ...request.env },
    stderr: "pipe",
    stdout: "pipe",
  });
  let timedOut = false;
  const kill = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the limit check and the signal.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, request.timeoutMs);
  const budget = { remaining: request.maxOutputBytes, truncated: false };
  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessStream(child.stdout, budget, kill),
    readProcessStream(child.stderr, budget, kill),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  return { exitCode, stderr, stdout, timedOut, truncated: budget.truncated };
};

interface UtilityReadRange {
  endLine: number;
  oversized: boolean;
  requestedEndLine: number;
  startLine: number;
  truncated: boolean;
}

const resolveUtilityReadRange = (
  args: Record<string, unknown>,
  lineCount: number,
  exactRead: boolean
): UtilityReadRange => {
  const lastLines = optionalPositiveInteger(args, "lastLines");
  if (
    lastLines !== undefined &&
    (args.startLine !== undefined || args.endLine !== undefined)
  ) {
    throw new ToolPolicyError(
      "invalid_arguments",
      "lastLines cannot be combined with startLine or endLine"
    );
  }
  if (lastLines !== undefined && lastLines > 500) {
    throw new ToolPolicyError(
      "invalid_arguments",
      "lastLines exceeds the bounded read limit of 500; retry with lastLines <= 500"
    );
  }
  const startLine =
    lastLines === undefined
      ? (optionalPositiveInteger(args, "startLine") ?? 1)
      : Math.max(1, lineCount - lastLines + 1);
  const requestedEndLine =
    lastLines === undefined
      ? (optionalPositiveInteger(args, "endLine") ?? lineCount)
      : lineCount;
  const oversized =
    lastLines === undefined && requestedEndLine - startLine + 1 > 500;
  if (oversized && exactRead) {
    throw new ToolPolicyError(
      "invalid_arguments",
      "Requested file range exceeds the bounded read limit of 500 lines; retry with endLine <= startLine + 499 and use another non-overlapping call only if needed"
    );
  }
  const boundedEndLine = oversized ? startLine + 499 : requestedEndLine;
  const endLine = Math.min(boundedEndLine, lineCount);
  if (startLine > endLine && lineCount > 0) {
    throw new ToolPolicyError("invalid_arguments", "startLine exceeds endLine");
  }
  return {
    endLine,
    oversized,
    requestedEndLine,
    startLine,
    truncated: oversized && endLine < Math.min(requestedEndLine, lineCount),
  };
};

export class UtilityToolBroker {
  readonly definitions: readonly UtilityToolDefinition[];
  private readonly allowedTools: ReadonlySet<UtilityToolName>;
  private readonly artifactDir: string;
  private readonly commandAllowlist: readonly UtilityCommandPolicy[];
  private readonly commandCwds: readonly string[];
  private readonly commandCwdsAreExact: boolean;
  private readonly exactCommand?: readonly string[];
  private readonly exactRead?: UtilityExactRead | null;
  private readonly exactWriteScopes: boolean;
  private readonly id: () => string;
  private readonly limits: UtilityToolLimits;
  private readonly now: () => number;
  private readonly outputBoundary?: UtilityOutputBoundary;
  private readonly protectedPaths: readonly string[];
  private readonly readScopes: readonly string[];
  private readonly repoRoot: string;
  private readonly runCommand: (
    request: CommandRequest
  ) => Promise<CommandExecution>;
  private readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  private readonly writeScopes: readonly string[];

  private constructor(
    config: UtilityToolBrokerConfig,
    deps: UtilityToolDependencies,
    canonicalRoot: string
  ) {
    this.allowedTools = new Set(
      config.allowedTools ??
        UTILITY_TOOL_DEFINITIONS.map((tool) => tool.function.name)
    );
    this.definitions = UTILITY_TOOL_DEFINITIONS.filter((tool) =>
      this.allowedTools.has(tool.function.name)
    );
    this.repoRoot = canonicalRoot;
    this.artifactDir = resolve(canonicalRoot, config.artifactDir);
    this.readScopes = config.readScopes.map(normalizeRequestedPath);
    this.writeScopes = config.writeScopes.map(normalizeRequestedPath);
    this.protectedPaths = [
      ...DEFAULT_PROTECTED_PATHS,
      ...(config.protectedPaths ?? []),
    ].map(normalizeRequestedPath);
    this.commandAllowlist =
      config.commandAllowlist ?? DEFAULT_COMMAND_ALLOWLIST;
    this.commandCwds = (config.commandCwds ?? config.readScopes).map(
      normalizeRequestedPath
    );
    this.commandCwdsAreExact = config.commandCwds !== undefined;
    this.exactCommand = config.exactCommand
      ? [...config.exactCommand]
      : undefined;
    this.exactWriteScopes = config.exactWriteScopes ?? false;
    if (config.exactRead === null) {
      this.exactRead = null;
    } else if (config.exactRead) {
      this.exactRead = {
        ...config.exactRead,
        path: normalizeRequestedPath(config.exactRead.path),
      };
    }
    this.outputBoundary = config.outputBoundary
      ? { ...config.outputBoundary }
      : undefined;
    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    this.runCommand = deps.runCommand ?? runUtilityCommand;
    this.sourceEnv = deps.sourceEnv ?? process.env;
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
  }

  static async create(
    config: UtilityToolBrokerConfig,
    deps: UtilityToolDependencies = {}
  ): Promise<UtilityToolBroker> {
    const canonicalRoot = await realpath(config.repoRoot);
    const commandAllowlist =
      config.commandAllowlist ??
      (await loadUtilityCommandAllowlist(canonicalRoot));
    const broker = new UtilityToolBroker(
      { ...config, commandAllowlist },
      deps,
      canonicalRoot
    );
    await broker.validateConfiguration();
    return broker;
  }

  async execute(call: UtilityToolCall): Promise<UtilityToolResult> {
    const startedAt = this.now();
    try {
      const data = applyOutputBoundary(
        await this.dispatch(call),
        this.outputBoundary
      );
      return {
        ...data,
        durationMs: Math.max(0, this.now() - startedAt),
        ok: true,
        tool: call.name,
      };
    } catch (error) {
      const policyError =
        error instanceof ToolPolicyError
          ? error
          : new ToolPolicyError(
              "tool_failed",
              error instanceof Error ? error.message : "Unknown tool failure"
            );
      return {
        durationMs: Math.max(0, this.now() - startedAt),
        error: { code: policyError.code, message: policyError.message },
        ok: false,
        tool: call.name,
      };
    }
  }

  async applyPatchProposal(
    input: GuardedPatchApplyInput
  ): Promise<GuardedPatchApplyResult> {
    if (!SHA256_HEX_RE.test(input.expectedPatchSha256)) {
      throw new ToolPolicyError(
        "patch_denied",
        "Expected patch SHA-256 is invalid"
      );
    }
    if (!SHA256_HEX_RE.test(input.expectedManifestSha256)) {
      throw new ToolPolicyError(
        "patch_denied",
        "Expected manifest SHA-256 is invalid"
      );
    }
    const patchArtifact = await this.resolveArtifact(input.patchPath, ".patch");
    const manifestArtifact = await this.resolveArtifact(
      input.manifestPath,
      ".json"
    );
    const patch = await readFile(patchArtifact.absolute, "utf8");
    if (Buffer.byteLength(patch) > this.limits.maxPatchBytes) {
      throw new ToolPolicyError(
        "output_limit",
        "Patch exceeds the configured size limit"
      );
    }
    const patchSha256 = hash(patch);
    if (patchSha256 !== input.expectedPatchSha256.toLowerCase()) {
      throw new ToolPolicyError(
        "patch_drift",
        "Patch artifact hash does not match the expected SHA-256"
      );
    }
    const manifestText = await readFile(manifestArtifact.absolute, "utf8");
    const manifestSha256 = hash(manifestText);
    if (manifestSha256 !== input.expectedManifestSha256.toLowerCase()) {
      throw new ToolPolicyError(
        "patch_drift",
        "Patch manifest hash does not match the recorded SHA-256"
      );
    }
    const manifest = this.parsePatchManifest(manifestText);
    const manifestPatch = await this.resolveArtifact(
      manifest.patchPath,
      ".patch"
    );
    if (manifestPatch.absolute !== patchArtifact.absolute) {
      throw new ToolPolicyError(
        "patch_denied",
        "Patch manifest does not reference the selected artifact"
      );
    }
    const targetPaths = await this.validatedPatchTargets(patch);
    const manifestPreimages = await this.validatedImages(
      manifest.preimages,
      "preimage"
    );
    if (
      JSON.stringify(targetPaths) !==
      JSON.stringify(manifestPreimages.map((image) => image.path))
    ) {
      throw new ToolPolicyError(
        "patch_denied",
        "Patch targets do not match the proposal manifest"
      );
    }

    if (input.existingApplication) {
      const existing = input.existingApplication;
      if (
        existing.patchSha256 !== patchSha256 ||
        existing.patchPath !== patchArtifact.relative ||
        existing.manifestSha256 !== manifestSha256 ||
        existing.manifestPath !== manifestArtifact.relative
      ) {
        throw new ToolPolicyError(
          "patch_drift",
          "A different patch application is already recorded for this job"
        );
      }
      await this.assertImagesMatch(existing.postimages, "postimage");
      return { application: existing, status: "already-applied" };
    }

    await this.assertImagesMatch(manifestPreimages, "preimage");
    await this.runGitApply(patchArtifact.relative, true);
    // Recheck after git's applicability probe so concurrent byte drift cannot
    // pass only because the earlier proposal snapshot happened to match.
    await this.assertImagesMatch(manifestPreimages, "preimage");
    await this.runGitApply(patchArtifact.relative, false);
    const postimages = await Promise.all(
      targetPaths.map((path) => this.currentImage(path))
    );
    return {
      application: {
        appliedAt: new Date(this.now()).toISOString(),
        appliedBy: input.appliedBy,
        manifestPath: manifestArtifact.relative,
        manifestSha256,
        patchPath: patchArtifact.relative,
        patchSha256,
        postimages,
        preimages: manifestPreimages,
      },
      status: "applied",
    };
  }

  private async resolveArtifact(
    requested: string,
    extension: string
  ): Promise<{ absolute: string; relative: string }> {
    if (!(isAbsolute(requested) && requested.endsWith(extension))) {
      throw new ToolPolicyError(
        "patch_denied",
        "Patch artifact path is invalid"
      );
    }
    const requestedStat = await lstat(requested).catch(() => undefined);
    if (!requestedStat?.isFile() || requestedStat.isSymbolicLink()) {
      throw new ToolPolicyError(
        "patch_denied",
        "Patch artifact must be a regular non-symlink file"
      );
    }
    const canonical = await realpath(requested);
    if (
      !(
        isContained(this.repoRoot, canonical) &&
        isContained(this.artifactDir, canonical)
      )
    ) {
      throw new ToolPolicyError(
        "patch_denied",
        "Patch artifact escapes its job artifact directory"
      );
    }
    return {
      absolute: canonical,
      relative: relativePath(this.repoRoot, canonical),
    };
  }

  private parsePatchManifest(raw: string): PatchProposalManifest {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new ToolPolicyError(
        "patch_denied",
        "Patch proposal manifest is invalid"
      );
    }
    if (!(isRecord(parsed) && Array.isArray(parsed.preimages))) {
      throw new ToolPolicyError(
        "patch_denied",
        "Patch proposal manifest has an invalid shape"
      );
    }
    exactKeys(
      parsed,
      new Set(["createdAt", "patchPath", "preimages", "summary"]),
      "patch proposal manifest"
    );
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.patchPath !== "string" ||
      (parsed.summary !== undefined && typeof parsed.summary !== "string")
    ) {
      throw new ToolPolicyError(
        "patch_denied",
        "Patch proposal manifest fields are invalid"
      );
    }
    return parsed as unknown as PatchProposalManifest;
  }

  private async validatedPatchTargets(patch: string): Promise<string[]> {
    const targets = this.patchTargets(patch);
    const validated: string[] = [];
    for (const path of targets) {
      const target = await this.resolvePath(path, "write", false);
      if (
        this.exactWriteScopes &&
        !this.writeScopes.includes(target.relative)
      ) {
        throw new ToolPolicyError(
          "patch_denied",
          `Patch target is not an exact declared write file: ${target.relative}`
        );
      }
      validated.push(target.relative);
    }
    return [...new Set(validated)].sort();
  }

  private async validatedImages(
    values: unknown[],
    label: string
  ): Promise<UtilityFileImage[]> {
    const images: UtilityFileImage[] = [];
    for (const [index, value] of values.entries()) {
      if (
        !isRecord(value) ||
        typeof value.path !== "string" ||
        !(
          value.sha256 === null ||
          (typeof value.sha256 === "string" && SHA256_HEX_RE.test(value.sha256))
        )
      ) {
        throw new ToolPolicyError(
          "patch_denied",
          `${label}[${index}] is invalid`
        );
      }
      exactKeys(value, new Set(["path", "sha256"]), `${label}[${index}]`);
      const target = await this.resolvePath(value.path, "write", false);
      images.push({
        path: target.relative,
        sha256:
          typeof value.sha256 === "string" ? value.sha256.toLowerCase() : null,
      });
    }
    const sorted = images.sort((left, right) =>
      left.path.localeCompare(right.path)
    );
    if (new Set(sorted.map((image) => image.path)).size !== sorted.length) {
      throw new ToolPolicyError(
        "patch_denied",
        `${label} contains duplicate paths`
      );
    }
    return sorted;
  }

  private async currentImage(path: string): Promise<UtilityFileImage> {
    const target = await this.resolvePath(path, "write", false);
    const content = await readFile(target.absolute).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    return { path: target.relative, sha256: content ? hash(content) : null };
  }

  private async assertImagesMatch(
    expected: readonly UtilityFileImage[],
    label: string
  ): Promise<void> {
    for (const image of expected) {
      const current = await this.currentImage(image.path);
      if (current.sha256 !== image.sha256) {
        throw new ToolPolicyError(
          "patch_drift",
          `${label} drift detected: ${image.path}`
        );
      }
    }
  }

  private async runGitApply(
    patchPath: string,
    checkOnly: boolean
  ): Promise<void> {
    const result = await this.runCommand({
      argv: [
        "git",
        "apply",
        ...(checkOnly ? ["--check"] : []),
        "--whitespace=nowarn",
        "--",
        patchPath,
      ],
      cwd: this.repoRoot,
      env: scrubUtilityEnvironment(this.sourceEnv),
      maxOutputBytes: this.limits.maxOutputBytes,
      timeoutMs: this.limits.timeoutMs,
    });
    if (result.timedOut) {
      throw new ToolPolicyError(
        "timeout",
        "Guarded patch application timed out"
      );
    }
    if (result.truncated) {
      throw new ToolPolicyError(
        "output_limit",
        "Guarded patch application output exceeded its limit"
      );
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr
        .replace(ANSI_SGR_RE, "")
        .trim()
        .slice(0, 1000);
      const message = checkOnly
        ? "Patch is malformed or no longer applies cleanly"
        : "Patch application failed";
      throw new ToolPolicyError(
        "patch_conflict",
        detail ? `${message}: ${detail}` : message
      );
    }
  }

  private async validateConfiguration(): Promise<void> {
    if (!(this.readScopes.length > 0)) {
      throw new ToolPolicyError(
        "invalid_policy",
        "At least one read scope is required"
      );
    }
    if (this.outputBoundary && !outputBoundaryIsValid(this.outputBoundary)) {
      throw new ToolPolicyError(
        "invalid_policy",
        "Output boundary is malformed or exceeds 500 lines"
      );
    }
    if (!isContained(this.repoRoot, this.artifactDir)) {
      throw new ToolPolicyError(
        "invalid_policy",
        "Artifact directory escapes repository"
      );
    }
    await this.assertRealContainment(dirname(this.artifactDir));
    for (const scope of [
      ...this.readScopes,
      ...this.writeScopes,
      ...this.commandCwds,
    ]) {
      if (this.isProtected(scope)) {
        throw new ToolPolicyError(
          "invalid_policy",
          `Declared scope is protected: ${scope}`
        );
      }
    }
    if (this.exactRead && !this.readScopes.includes(this.exactRead.path)) {
      throw new ToolPolicyError(
        "invalid_policy",
        "Exact read path must be one of the declared read scopes"
      );
    }
  }

  private assertExactRead(args: Record<string, unknown>): void {
    if (this.exactRead === undefined) {
      return;
    }
    if (this.exactRead === null) {
      throw new ToolPolicyError(
        "command_denied",
        "This file-read profile has no valid exact read boundary"
      );
    }
    const expected = this.exactRead as unknown as Record<string, unknown>;
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(args).sort();
    if (
      JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
      expectedKeys.some((key) => args[key] !== expected[key])
    ) {
      throw new ToolPolicyError(
        "command_denied",
        "Read arguments do not match the exact classified range"
      );
    }
  }

  private async dispatch(
    call: UtilityToolCall
  ): Promise<Omit<UtilityToolResult, "durationMs" | "ok" | "tool">> {
    if (!this.allowedTools.has(call.name)) {
      throw new ToolPolicyError(
        "tool_denied",
        `Tool is outside this request's execution profile: ${call.name}`
      );
    }
    switch (call.name) {
      case "search_repo":
        return { data: await this.searchRepo(requireRecord(call.arguments)) };
      case "read_file":
        return { data: await this.readFileTool(requireRecord(call.arguments)) };
      case "count_lines":
        return { data: await this.countLines(requireRecord(call.arguments)) };
      case "list_files":
        return { data: await this.listFiles(requireRecord(call.arguments)) };
      case "git_status":
        return this.gitStatus(requireRecord(call.arguments));
      case "git_diff":
        return this.gitDiff(requireRecord(call.arguments));
      case "git_inspect":
        return this.gitInspect(requireRecord(call.arguments));
      case "run_check":
        return this.runCheck(requireRecord(call.arguments));
      case "propose_patch":
        return this.proposePatch(requireRecord(call.arguments));
      default:
        throw new ToolPolicyError(
          "unknown_tool",
          `Unknown utility tool: ${call.name}`
        );
    }
  }

  private isProtected(path: string): boolean {
    return (
      isUtilityProtectedPath(path) ||
      this.protectedPaths.some((protectedPath) => inScope(path, protectedPath))
    );
  }

  private assertScope(path: string, mode: "read" | "write"): void {
    if (this.isProtected(path)) {
      throw new ToolPolicyError(
        "path_denied",
        `Protected path denied: ${path}`
      );
    }
    const scopes = mode === "read" ? this.readScopes : this.writeScopes;
    if (!scopes.some((scope) => inScope(path, scope))) {
      const shown = scopes.slice(0, 4);
      const allowed = `${shown.join(", ")}${scopes.length > shown.length ? ` (+${scopes.length - shown.length} more)` : ""}`;
      throw new ToolPolicyError(
        "scope_denied",
        `Path is outside declared ${mode} scope: ${path}. Allowed ${mode} scope(s): ${allowed || "none"}. Retry only inside a listed scope or return CONTEXT_INSUFFICIENT.`
      );
    }
    if (
      mode === "write" &&
      DEPENDENCY_FILES.has(basename(path).toLowerCase())
    ) {
      throw new ToolPolicyError(
        "path_denied",
        `Dependency file denied: ${path}`
      );
    }
  }

  private async assertRealContainment(target: string): Promise<string> {
    let cursor = target;
    const missingSegments: string[] = [];
    while (true) {
      try {
        const canonical = await realpath(cursor);
        const resolved = resolve(canonical, ...missingSegments);
        if (!isContained(this.repoRoot, resolved)) {
          throw new ToolPolicyError(
            "path_denied",
            "Path resolves outside repository"
          );
        }
        return resolved;
      } catch (error) {
        if (error instanceof ToolPolicyError) {
          throw error;
        }
        if (!isRecord(error) || error.code !== "ENOENT") {
          throw new ToolPolicyError(
            "path_denied",
            "Cannot resolve repository path"
          );
        }
        const parent = dirname(cursor);
        if (parent === cursor) {
          throw new ToolPolicyError(
            "path_denied",
            "Cannot resolve repository path"
          );
        }
        missingSegments.unshift(basename(cursor));
        cursor = parent;
      }
    }
  }

  private async resolvePath(
    requested: string,
    mode: "read" | "write",
    mustExist: boolean
  ): Promise<{ absolute: string; relative: string }> {
    const lexicalRelative = normalizeRequestedPath(requested);
    this.assertScope(lexicalRelative, mode);
    const absolute = resolve(this.repoRoot, lexicalRelative);
    if (!isContained(this.repoRoot, absolute)) {
      throw new ToolPolicyError(
        "path_denied",
        `Path escapes repository: ${requested}`
      );
    }
    const canonical = mustExist
      ? await realpath(absolute).catch(() => {
          throw new ToolPolicyError(
            "not_found",
            `Path does not exist: ${requested}`
          );
        })
      : await this.assertRealContainment(absolute);
    if (!isContained(this.repoRoot, canonical)) {
      throw new ToolPolicyError(
        "path_denied",
        `Path resolves outside repository: ${requested}`
      );
    }
    const canonicalRelative = relativePath(this.repoRoot, canonical);
    this.assertScope(canonicalRelative, mode);
    return { absolute: canonical, relative: canonicalRelative };
  }

  private async missingReadPathCandidates(
    requested: string
  ): Promise<string[]> {
    const requestedName = basename(normalizeRequestedPath(requested));
    const candidates: string[] = [];
    const pending = [...this.readScopes];
    const visited = new Set<string>();
    while (
      pending.length > 0 &&
      visited.size < this.limits.maxSearchFiles &&
      candidates.length < 3
    ) {
      const lexical = normalizeRequestedPath(pending.shift() ?? ".");
      if (visited.has(lexical) || this.isProtected(lexical)) {
        continue;
      }
      visited.add(lexical);
      const inspected = await this.inspectMissingReadPath(
        lexical,
        requestedName,
        Math.max(0, this.limits.maxSearchFiles - visited.size - pending.length)
      );
      if (inspected.candidate) {
        candidates.push(inspected.candidate);
      }
      pending.push(...inspected.children);
    }
    return [...new Set(candidates)].sort();
  }

  private async inspectMissingReadPath(
    lexical: string,
    requestedName: string,
    maxChildren: number
  ): Promise<{ candidate?: string; children: string[] }> {
    this.assertScope(lexical, "read");
    const absolute = resolve(this.repoRoot, lexical);
    const stat = await lstat(absolute).catch(() => undefined);
    if (!stat || stat.isSymbolicLink()) {
      return { children: [] };
    }
    if (stat.isFile()) {
      return basename(lexical) === requestedName
        ? { candidate: lexical, children: [] }
        : { children: [] };
    }
    if (!stat.isDirectory()) {
      return { children: [] };
    }
    const entries = await readdir(absolute, { withFileTypes: true });
    return {
      children: entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, maxChildren)
        .map((entry) =>
          lexical === "." ? entry.name : `${lexical}/${entry.name}`
        ),
    };
  }

  private async resolveReadTarget(
    requested: string
  ): Promise<{ absolute: string; relative: string }> {
    try {
      return await this.resolvePath(requested, "read", true);
    } catch (error) {
      if (!(error instanceof ToolPolicyError) || error.code !== "not_found") {
        throw error;
      }
      const candidates = await this.missingReadPathCandidates(requested);
      const suggestion =
        candidates.length > 0
          ? ` In-scope candidate${candidates.length === 1 ? "" : "s"}: ${candidates.join(", ")}`
          : "";
      throw new ToolPolicyError(
        "not_found",
        `Path does not exist: ${requested}.${suggestion}`
      );
    }
  }

  private async resolveCommandCwd(
    requested: string
  ): Promise<{ absolute: string; relative: string }> {
    const lexical = normalizeRequestedPath(requested);
    const cwdIsDeclared = this.commandCwdsAreExact
      ? this.commandCwds.includes(lexical)
      : this.commandCwds.some((scope) => inScope(lexical, scope));
    if (this.isProtected(lexical) || !cwdIsDeclared) {
      throw new ToolPolicyError(
        "scope_denied",
        `Command cwd is outside its exact declared scope: ${requested}`
      );
    }
    const absolute = resolve(this.repoRoot, lexical);
    const canonical = await realpath(absolute).catch(() => {
      throw new ToolPolicyError(
        "not_found",
        `Command cwd does not exist: ${requested}`
      );
    });
    if (!isContained(this.repoRoot, canonical)) {
      throw new ToolPolicyError(
        "path_denied",
        `Command cwd resolves outside repository: ${requested}`
      );
    }
    const canonicalRelative = relativePath(this.repoRoot, canonical);
    const canonicalIsDeclared = this.commandCwdsAreExact
      ? this.commandCwds.includes(canonicalRelative)
      : this.commandCwds.some((scope) => inScope(canonicalRelative, scope));
    if (!canonicalIsDeclared) {
      throw new ToolPolicyError(
        "scope_denied",
        `Command cwd resolves outside its exact declared scope: ${requested}`
      );
    }
    return { absolute: canonical, relative: canonicalRelative };
  }

  private async searchRepo(
    args: Record<string, unknown>
  ): Promise<SearchMatch[]> {
    const query = requireString(args, "query");
    const regex = optionalBoolean(args, "regex") ?? false;
    const caseSensitive = optionalBoolean(args, "caseSensitive") ?? false;
    const requestedMax = optionalPositiveInteger(args, "maxResults");
    const maxResults = Math.min(
      requestedMax ?? this.limits.maxSearchResults,
      this.limits.maxSearchResults
    );
    const requestedPaths =
      optionalStringArray(args, "paths") ?? this.readScopes;
    const matcher = regex
      ? new RegExp(query, caseSensitive ? "" : "i")
      : undefined;
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: SearchMatch[] = [];
    let filesSeen = 0;

    // This is a bounded depth-first walk; keeping its limit checks together makes
    // the security boundary easier to audit than distributing mutable counters.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded security walk
    const visit = async (requestedPath: string): Promise<void> => {
      if (
        matches.length >= maxResults ||
        filesSeen >= this.limits.maxSearchFiles
      ) {
        return;
      }
      if (await this.isExactNewWriteTarget(requestedPath)) {
        return;
      }
      let target: { absolute: string; relative: string };
      try {
        target = await this.resolvePath(requestedPath, "read", true);
      } catch (error) {
        if (!(error instanceof ToolPolicyError) || error.code !== "not_found") {
          throw error;
        }

        // A safely contained absent search boundary has zero matches. Resolve it
        // again without the existence requirement so scope, protected-path,
        // symlink, and real-containment checks still run before absence is
        // accepted. If the path appeared during that check, search it normally.
        const absentTarget = await this.resolvePath(
          requestedPath,
          "read",
          false
        );
        try {
          await lstat(absentTarget.absolute);
        } catch (statError) {
          if (isRecord(statError) && statError.code === "ENOENT") {
            return;
          }
          throw new ToolPolicyError(
            "path_denied",
            `Cannot inspect repository path: ${requestedPath}`
          );
        }
        target = await this.resolvePath(requestedPath, "read", true);
      }
      const stat = await lstat(target.absolute);
      if (stat.isSymbolicLink()) {
        return;
      }
      if (stat.isDirectory()) {
        const entries = await readdir(target.absolute, { withFileTypes: true });
        for (const entry of entries) {
          if (
            matches.length >= maxResults ||
            filesSeen >= this.limits.maxSearchFiles
          ) {
            break;
          }
          const child = `${target.relative === "." ? "" : `${target.relative}/`}${entry.name}`;
          if (this.isProtected(child) || entry.isSymbolicLink()) {
            continue;
          }
          await visit(child);
        }
        return;
      }
      if (!stat.isFile()) {
        return;
      }
      filesSeen += 1;
      if (stat.size > this.limits.maxFileBytes) {
        return;
      }
      const content = await readFile(target.absolute, "utf8").catch(() => "");
      if (content.includes("\0")) {
        return;
      }
      const lines = content.split(LINE_BREAK);
      for (const [index, line] of lines.entries()) {
        const found = matcher
          ? matcher.test(line)
          : (caseSensitive ? line : line.toLowerCase()).includes(needle);
        if (found) {
          matches.push({ line: index + 1, path: target.relative, text: line });
          if (matches.length >= maxResults) {
            break;
          }
        }
      }
    };

    for (const path of requestedPaths) {
      await visit(path);
      if (
        matches.length >= maxResults ||
        filesSeen >= this.limits.maxSearchFiles
      ) {
        break;
      }
    }
    if (
      Buffer.byteLength(JSON.stringify(matches)) > this.limits.maxOutputBytes
    ) {
      throw new ToolPolicyError(
        "output_limit",
        "Search results exceed output limit"
      );
    }
    return matches;
  }

  private async isExactNewWriteTarget(requested: string): Promise<boolean> {
    if (!this.exactWriteScopes) {
      return false;
    }
    const lexical = normalizeRequestedPath(requested);
    if (!this.writeScopes.includes(lexical)) {
      return false;
    }
    this.assertScope(lexical, "read");
    const absolute = resolve(this.repoRoot, lexical);
    const canonical = await this.assertRealContainment(absolute);
    const canonicalRelative = relativePath(this.repoRoot, canonical);
    if (canonicalRelative !== lexical) {
      return false;
    }
    const stat = await lstat(absolute).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    return stat === undefined;
  }

  private async readFileTool(args: Record<string, unknown>): Promise<{
    content: string;
    endLine: number;
    nextStartLine?: number;
    path: string;
    requestedEndLine?: number;
    startLine: number;
    truncated?: boolean;
  }> {
    this.assertExactRead(args);
    exactArgumentKeys(
      args,
      new Set(["endLine", "lastLines", "path", "startLine"]),
      "read_file arguments"
    );
    const requested = requireString(args, "path");
    const target = await this.resolveReadTarget(requested);
    const stat = await lstat(target.absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ToolPolicyError(
        "path_denied",
        "Only regular files can be read"
      );
    }
    if (stat.size > this.limits.maxFileBytes) {
      throw new ToolPolicyError(
        "output_limit",
        "File exceeds the configured read limit"
      );
    }
    const content = await readFile(target.absolute, "utf8");
    if (content.includes("\0")) {
      throw new ToolPolicyError("path_denied", "Binary files cannot be read");
    }
    const lines = content.length === 0 ? [] : content.split(LINE_BREAK);
    if (lines.at(-1) === "") {
      lines.pop();
    }
    const range = resolveUtilityReadRange(
      args,
      lines.length,
      this.exactRead !== undefined
    );
    const { endLine, oversized, requestedEndLine, startLine, truncated } =
      range;
    const selected = lines.slice(startLine - 1, endLine).join("\n");
    if (Buffer.byteLength(selected) > this.limits.maxOutputBytes) {
      throw new ToolPolicyError(
        "output_limit",
        "Selected file range exceeds output limit"
      );
    }
    return {
      content: selected,
      endLine,
      ...(truncated ? { nextStartLine: endLine + 1 } : {}),
      path: target.relative,
      ...(oversized ? { requestedEndLine } : {}),
      startLine,
      ...(oversized ? { truncated } : {}),
    };
  }

  private async listFiles(args: Record<string, unknown>): Promise<{
    entries: { name: string; path: string; type: string }[];
    path: string;
    truncated: boolean;
  }> {
    exactArgumentKeys(
      args,
      new Set(["includeHidden", "path"]),
      "list_files arguments"
    );
    const requested = requireString(args, "path");
    const lexical = normalizeRequestedPath(requested);
    this.assertScope(lexical, "read");
    const lexicalStat = await lstat(resolve(this.repoRoot, lexical)).catch(
      () => undefined
    );
    if (lexicalStat?.isSymbolicLink()) {
      throw new ToolPolicyError(
        "path_denied",
        "Directory listings cannot follow symbolic links"
      );
    }
    const target = await this.resolvePath(requested, "read", true);
    const stat = await lstat(target.absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ToolPolicyError(
        "path_denied",
        "Only directories can be listed"
      );
    }
    const includeHidden = optionalBoolean(args, "includeHidden") ?? false;
    const candidates = (await readdir(target.absolute, { withFileTypes: true }))
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .map((entry) => {
        const path = `${target.relative === "." ? "" : `${target.relative}/`}${entry.name}`;
        return {
          entry: {
            name: entry.name,
            path,
            type: directoryEntryType(entry),
          },
          protected: this.isProtected(path),
        };
      })
      .filter((candidate) => !candidate.protected)
      .map((candidate) => candidate.entry)
      .sort((left, right) => left.name.localeCompare(right.name));
    const entries: { name: string; path: string; type: string }[] = [];
    let truncated = candidates.length > this.limits.maxListEntries;
    for (const entry of candidates.slice(0, this.limits.maxListEntries)) {
      const next = [...entries, entry];
      const prospective = {
        entries: next,
        path: target.relative,
        truncated: next.length < candidates.length,
      };
      if (
        Buffer.byteLength(JSON.stringify(prospective)) >
        this.limits.maxOutputBytes
      ) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
    if (entries.length < candidates.length) {
      truncated = true;
    }
    const data = { entries, path: target.relative, truncated };
    if (Buffer.byteLength(JSON.stringify(data)) > this.limits.maxOutputBytes) {
      throw new ToolPolicyError(
        "output_limit",
        "Directory listing metadata exceeds output limit"
      );
    }
    return data;
  }

  private async countLines(args: Record<string, unknown>): Promise<{
    files: { lines: number; path: string }[];
  }> {
    exactArgumentKeys(args, new Set(["paths"]), "count_lines arguments");
    const requestedPaths = optionalStringArray(args, "paths");
    if (!(requestedPaths && requestedPaths.length > 0)) {
      throw new ToolPolicyError(
        "invalid_arguments",
        "paths must contain at least one file"
      );
    }
    if (requestedPaths.length > MAX_LINE_COUNT_FILES) {
      throw new ToolPolicyError(
        "invalid_arguments",
        `paths exceeds the ${MAX_LINE_COUNT_FILES}-file limit`
      );
    }
    const lexicalPaths = requestedPaths.map(normalizeRequestedPath);
    if (new Set(lexicalPaths).size !== lexicalPaths.length) {
      throw new ToolPolicyError(
        "invalid_arguments",
        "paths contains duplicate files"
      );
    }

    const files: { lines: number; path: string }[] = [];
    const canonicalPaths = new Set<string>();
    for (const requestedPath of lexicalPaths) {
      const target = await this.resolvePath(requestedPath, "read", true);
      if (canonicalPaths.has(target.absolute)) {
        throw new ToolPolicyError(
          "invalid_arguments",
          "paths resolves to duplicate files"
        );
      }
      canonicalPaths.add(target.absolute);
      const stat = await lstat(target.absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ToolPolicyError(
          "path_denied",
          "Only regular files can be counted"
        );
      }
      if (stat.size > this.limits.maxFileBytes) {
        throw new ToolPolicyError(
          "output_limit",
          "File exceeds the configured read limit"
        );
      }
      const content = await readFile(target.absolute);
      let lines = 0;
      for (const byte of content) {
        if (byte === 0x0a) {
          lines += 1;
        }
      }
      files.push({ lines, path: target.relative });
    }
    return { files };
  }

  private gitExclusions(): string[] {
    return [
      ":(exclude)**/.env*",
      ":(exclude)**/*.key",
      ":(exclude)**/*.p12",
      ":(exclude)**/*.pem",
      ":(exclude)**/.npmrc",
      ...UTILITY_PROTECTED_GIT_GLOBS.map(
        (pattern) => `:(exclude,glob,icase)${pattern}`
      ),
      ...this.protectedPaths.map((path) => `:(exclude)${path}`),
    ];
  }

  private async runBounded(
    argv: readonly string[],
    cwd: string,
    extraEnv: Readonly<Record<string, string>> = {}
  ): Promise<CommandExecution> {
    const result = await this.runCommand({
      argv,
      cwd,
      env: { ...scrubUtilityEnvironment(this.sourceEnv), ...extraEnv },
      maxOutputBytes: this.limits.maxOutputBytes,
      timeoutMs: this.limits.timeoutMs,
    });
    if (result.timedOut) {
      throw new ToolPolicyError(
        "timeout",
        "Command exceeded the configured time limit"
      );
    }
    if (
      result.truncated ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >
        this.limits.maxOutputBytes
    ) {
      throw new ToolPolicyError(
        "output_limit",
        "Command exceeded the configured output limit"
      );
    }
    return result;
  }

  private commandResult(
    result: CommandExecution
  ): Omit<UtilityToolResult, "durationMs" | "ok" | "tool"> {
    return {
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  private async resolveGitCommit(
    ref: string,
    label: "baseRef" | "headRef"
  ): Promise<string> {
    const result = await this.runBounded(
      ["git", "rev-parse", "--verify", `${ref}^{commit}`],
      this.repoRoot
    );
    const sha = result.stdout.trim();
    if (result.exitCode !== 0 || !RESOLVED_COMMIT_HASH_RE.test(sha)) {
      throw new ToolPolicyError(
        "tool_failed",
        `Unable to resolve ${label} to a literal commit SHA`
      );
    }
    return sha.toLowerCase();
  }

  private async resolveGitDiffExecution(
    selection: UtilityGitDiffSelection,
    declaredPaths: readonly string[]
  ): Promise<UtilityGitDiffExecution> {
    if (!selection.baseRef) {
      return {
        query: {
          mode: selection.staged ? "diff-index" : "diff-worktree",
          paths: [...declaredPaths],
        },
      };
    }
    const baseRef = await this.resolveGitCommit(selection.baseRef, "baseRef");
    const headRef = await this.resolveGitCommit(
      selection.headRef ?? "HEAD",
      "headRef"
    );
    return {
      query: {
        baseRef,
        headRef,
        mode: "diff-range",
        paths: [...declaredPaths],
        rangeOperator: "...",
      },
      range: `${baseRef}...${headRef}`,
    };
  }

  private async gitStatus(
    args: Record<string, unknown>
  ): Promise<Omit<UtilityToolResult, "durationMs" | "ok" | "tool">> {
    if (Object.keys(args).length > 0) {
      throw new ToolPolicyError(
        "invalid_arguments",
        "git_status accepts no arguments"
      );
    }
    const paths = this.readScopes.length > 0 ? [...this.readScopes] : ["."];
    const result = await this.runBounded(
      [
        "git",
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
        "--",
        ...paths,
        ...this.gitExclusions(),
      ],
      this.repoRoot
    );
    const evidenceResult = await this.runBounded(
      [
        "git",
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--renames",
        "--",
        ...paths,
      ],
      this.repoRoot
    );
    if (evidenceResult.exitCode !== 0) {
      throw new ToolPolicyError(
        "tool_failed",
        "Authoritative Git status inventory failed"
      );
    }
    return {
      ...this.commandResult(result),
      scopeAudit: buildUtilityScopeAuditEvidence(
        { mode: "status", paths },
        parseGitStatusScopeRecords(evidenceResult.stdout)
      ),
    };
  }

  private async gitDiff(
    args: Record<string, unknown>
  ): Promise<Omit<UtilityToolResult, "durationMs" | "ok" | "tool">> {
    const selection = utilityGitDiffSelection(args, this.readScopes);
    const safePaths: string[] = [];
    for (const path of selection.paths) {
      const target = await this.resolvePath(path, "read", false);
      safePaths.push(target.relative);
    }
    const declaredPaths = [...this.readScopes];
    const execution = await this.resolveGitDiffExecution(
      selection,
      declaredPaths
    );
    const result = await this.runBounded(
      [
        "git",
        "diff",
        "--no-ext-diff",
        ...(selection.check ? ["--check"] : []),
        ...(selection.nameOnly ? ["--name-only"] : []),
        ...(selection.staged ? ["--cached"] : []),
        ...(execution.range ? [execution.range] : []),
        "--",
        ...safePaths,
        ...this.gitExclusions(),
      ],
      this.repoRoot
    );
    const evidenceResult = await this.runBounded(
      [
        "git",
        "diff",
        "--no-ext-diff",
        "--name-status",
        "-z",
        "-M",
        "-C",
        "--find-copies-harder",
        ...(selection.staged ? ["--cached"] : []),
        ...(execution.range ? [execution.range] : []),
        "--",
        ...declaredPaths,
      ],
      this.repoRoot
    );
    if (evidenceResult.exitCode !== 0) {
      throw new ToolPolicyError(
        "tool_failed",
        "Authoritative Git diff inventory failed"
      );
    }
    return {
      ...this.commandResult(result),
      scopeAudit: buildUtilityScopeAuditEvidence(
        execution.query,
        parseGitDiffScopeRecords(evidenceResult.stdout, selection.surface)
      ),
    };
  }

  private async gitInspect(
    args: Record<string, unknown>
  ): Promise<Omit<UtilityToolResult, "durationMs" | "ok" | "tool">> {
    const action = requireString(args, "action");
    let argv = gitInspectNoArgArgv(action, args);
    if (argv) {
      // The helper validated that these actions carry no hidden arguments.
    } else if (action === "resolve-ref") {
      exactArgumentKeys(args, new Set(["action", "ref"]), "git_inspect");
      argv = [
        "git",
        "rev-parse",
        "--verify",
        `${requireBoundedGitRef(args)}^{commit}`,
      ];
    } else if (action === "object-type") {
      exactArgumentKeys(args, new Set(["action", "ref"]), "git_inspect");
      argv = ["git", "cat-file", "-t", requireBoundedGitRef(args)];
    } else if (action === "branch-list") {
      exactArgumentKeys(args, new Set(["action", "pattern"]), "git_inspect");
      const pattern = requireString(args, "pattern");
      if (!GIT_BRANCH_PATTERN_RE.test(pattern) || pattern.startsWith("-")) {
        throw new ToolPolicyError(
          "invalid_arguments",
          "pattern must be a bounded literal branch pattern"
        );
      }
      argv = ["git", "branch", "--all", "--list", pattern];
    } else if (action === "log") {
      argv = gitInspectLogArgv(args);
    } else if (action === "show-stat") {
      exactArgumentKeys(
        args,
        new Set(["action", "includeMetadata", "ref"]),
        "git_inspect"
      );
      const includeMetadata = optionalBoolean(args, "includeMetadata") ?? true;
      argv = [
        "git",
        "show",
        "--no-ext-diff",
        "--stat",
        includeMetadata ? "--format=fuller" : "--format=",
        requireBoundedGitRef(args),
        "--",
        ".",
        ...this.gitExclusions(),
      ];
    } else {
      throw new ToolPolicyError(
        "invalid_arguments",
        "git_inspect action is unsupported"
      );
    }
    return this.commandResult(await this.runBounded(argv, this.repoRoot));
  }

  private assertCommandAllowed(argv: readonly string[]): {
    pathArgsStart: number;
    policy: UtilityCommandPolicy;
  } {
    if (argv.length === 0 || argv.length > this.limits.maxCommandArgs) {
      throw new ToolPolicyError(
        "command_denied",
        "Command argv length is not allowed"
      );
    }
    if (
      argv.some(
        (arg) =>
          !arg || SHELL_META.test(arg) || DANGEROUS_COMMAND_OPTIONS.has(arg)
      )
    ) {
      throw new ToolPolicyError(
        "command_denied",
        "Shell syntax or dangerous option denied"
      );
    }
    if (
      argv[0].includes("/") ||
      argv[0].includes("\\") ||
      SHELL_EXECUTABLES.has(argv[0].toLowerCase())
    ) {
      throw new ToolPolicyError(
        "command_denied",
        "Shells and executable paths are denied"
      );
    }
    for (const policy of this.commandAllowlist) {
      if (policy.executable !== argv[0]) {
        continue;
      }
      for (const prefix of policy.prefixes) {
        if (prefix.every((value, index) => argv[index + 1] === value)) {
          return { pathArgsStart: prefix.length + 1, policy };
        }
      }
    }
    throw new ToolPolicyError(
      "command_denied",
      `Command is not allowlisted: ${argv[0]}`
    );
  }

  private assertExactCommand(argv: readonly string[]): void {
    if (!this.exactCommand) {
      return;
    }
    const matches =
      argv.length === this.exactCommand.length &&
      argv.every((argument, index) => argument === this.exactCommand?.[index]);
    if (!matches) {
      throw new ToolPolicyError(
        "command_denied",
        "Command does not match the exact classified argv"
      );
    }
  }

  private async resolveCheckTarget(path: string, cwd: string): Promise<string> {
    const target = await this.resolvePath(path, "read", true);
    const stat = await lstat(target.absolute);
    if (!stat.isFile()) {
      throw new ToolPolicyError(
        "path_denied",
        `Check target must be a file: ${path}`
      );
    }
    if (stat.size > this.limits.maxFileBytes) {
      throw new ToolPolicyError(
        "output_limit",
        `Check target exceeds the configured file limit: ${path}`
      );
    }
    return relativePath(cwd, target.absolute);
  }

  private async runCheck(
    args: Record<string, unknown>
  ): Promise<Omit<UtilityToolResult, "durationMs" | "ok" | "tool">> {
    const argv = optionalStringArray(args, "argv");
    if (!argv) {
      throw new ToolPolicyError(
        "invalid_arguments",
        "argv must be a string array"
      );
    }
    this.assertExactCommand(argv);
    const { pathArgsStart, policy } = this.assertCommandAllowed(argv);
    const requestedPaths = argv.slice(pathArgsStart);
    if (
      requestedPaths.length === 0 ||
      requestedPaths.length > 4 ||
      requestedPaths.some((value) => value.startsWith("-"))
    ) {
      throw new ToolPolicyError(
        "command_denied",
        "A focused check requires one or more scoped file paths and no options"
      );
    }
    const cwdRequest = optionalString(args, "cwd") ?? ".";
    const cwd = await this.resolveCommandCwd(cwdRequest);
    const cwdStat = await lstat(cwd.absolute);
    if (!cwdStat.isDirectory()) {
      throw new ToolPolicyError(
        "path_denied",
        "Command cwd must be a directory"
      );
    }
    const safeArgv = argv.slice(0, pathArgsStart);
    if (policy.requireLocalBinary) {
      let searchDir = cwd.absolute;
      let canonicalBinary: string | undefined;
      while (isContained(this.repoRoot, searchDir)) {
        const localBinary = resolve(
          searchDir,
          "node_modules",
          ".bin",
          policy.requireLocalBinary
        );
        canonicalBinary = await realpath(localBinary).catch(() => undefined);
        if (canonicalBinary || searchDir === this.repoRoot) {
          break;
        }
        searchDir = dirname(searchDir);
      }
      if (!canonicalBinary) {
        throw new ToolPolicyError(
          "command_denied",
          `Required local binary is unavailable: ${policy.requireLocalBinary}`
        );
      }
      if (!isContained(this.repoRoot, canonicalBinary)) {
        throw new ToolPolicyError(
          "command_denied",
          "Required local binary resolves outside repository"
        );
      }
      await access(canonicalBinary, fsConstants.X_OK).catch(() => {
        throw new ToolPolicyError(
          "command_denied",
          `Required local binary is not executable: ${policy.requireLocalBinary}`
        );
      });
    }
    for (const path of requestedPaths) {
      safeArgv.push(await this.resolveCheckTarget(path, cwd.absolute));
    }
    const result = await this.runBounded(
      safeArgv,
      cwd.absolute,
      policy.executable === "npx"
        ? { NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_YES: "false" }
        : {}
    );
    return this.commandResult(result);
  }

  private patchTargets(patch: string): string[] {
    if (FORBIDDEN_PATCH_OPERATION.test(patch)) {
      throw new ToolPolicyError(
        "patch_denied",
        "Deletes, renames, modes, and binary patches are denied"
      );
    }
    const targets = new Set<string>();
    for (const line of patch.split(LINE_BREAK)) {
      if (!line.startsWith("+++ ")) {
        continue;
      }
      const raw = line.slice(4).split("\t", 1)[0];
      if (raw === "/dev/null") {
        throw new ToolPolicyError("patch_denied", "File deletion is denied");
      }
      targets.add(raw.startsWith("b/") ? raw.slice(2) : raw);
    }
    if (targets.size === 0) {
      throw new ToolPolicyError(
        "invalid_arguments",
        "Patch has no file targets"
      );
    }
    return [...targets];
  }

  private async proposePatch(
    args: Record<string, unknown>
  ): Promise<Omit<UtilityToolResult, "durationMs" | "ok" | "tool">> {
    const patch = requireString(args, "patch");
    const summary = optionalString(args, "summary");
    if (Buffer.byteLength(patch) > this.limits.maxPatchBytes) {
      throw new ToolPolicyError(
        "output_limit",
        "Patch exceeds the configured size limit"
      );
    }
    const targets = this.patchTargets(patch);
    const preimages: PatchPreimage[] = [];
    for (const path of targets) {
      const target = await this.resolvePath(path, "write", false);
      if (
        this.exactWriteScopes &&
        !this.writeScopes.includes(target.relative)
      ) {
        throw new ToolPolicyError(
          "patch_denied",
          `Patch target is not an exact declared write file: ${target.relative}`
        );
      }
      const content = await readFile(target.absolute).catch(
        (error: unknown) => {
          const code = isRecord(error) ? error.code : undefined;
          if (code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      );
      preimages.push({
        path: target.relative,
        sha256: content ? hash(content) : null,
      });
    }

    await mkdir(this.artifactDir, { recursive: true });
    const canonicalArtifactDir = await realpath(this.artifactDir);
    if (!isContained(this.repoRoot, canonicalArtifactDir)) {
      throw new ToolPolicyError(
        "path_denied",
        "Artifact directory resolves outside repository"
      );
    }
    const id = this.id().replace(/[^A-Za-z0-9_-]/g, "-");
    const patchPath = resolve(canonicalArtifactDir, `${id}.patch`);
    const manifestPath = resolve(canonicalArtifactDir, `${id}.json`);
    const manifest: PatchProposalManifest = {
      createdAt: new Date(this.now()).toISOString(),
      patchPath,
      preimages,
      ...(summary === undefined ? {} : { summary }),
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(patchPath, patch, { encoding: "utf8", flag: "wx" });
    try {
      await this.runGitApply(relative(this.repoRoot, patchPath), true);
    } catch (error) {
      await unlink(patchPath).catch(() => undefined);
      throw error;
    }
    await writeFile(manifestPath, manifestText, {
      encoding: "utf8",
      flag: "wx",
    });
    return {
      artifact: {
        manifestPath,
        manifestSha256: hash(manifestText),
        path: patchPath,
        sha256: hash(patch),
      },
      data: { preimages, summary, targets },
    };
  }
}

export const createUtilityToolBroker = (
  config: UtilityToolBrokerConfig,
  deps: UtilityToolDependencies = {}
): Promise<UtilityToolBroker> => UtilityToolBroker.create(config, deps);
