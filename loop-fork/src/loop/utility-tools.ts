import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
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

export type UtilityToolName =
  | "search_repo"
  | "read_file"
  | "git_status"
  | "git_diff"
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
}

export interface UtilityToolLimits {
  maxCommandArgs: number;
  maxFileBytes: number;
  maxOutputBytes: number;
  maxPatchBytes: number;
  maxSearchFiles: number;
  maxSearchResults: number;
  timeoutMs: number;
}

export interface UtilityToolBrokerConfig {
  artifactDir: string;
  commandAllowlist?: readonly UtilityCommandPolicy[];
  limits?: Partial<UtilityToolLimits>;
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

const DEFAULT_LIMITS: UtilityToolLimits = {
  maxCommandArgs: 24,
  maxFileBytes: 128 * 1024,
  maxOutputBytes: 64 * 1024,
  maxPatchBytes: 256 * 1024,
  maxSearchFiles: 500,
  maxSearchResults: 100,
  timeoutMs: 60_000,
};

const DEFAULT_COMMAND_ALLOWLIST: readonly UtilityCommandPolicy[] = [
  { executable: "bun", prefixes: [["test"]] },
];

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
const SECRET_BASENAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|ed25519)|secrets?(?:\..*)?|.*\.(?:key|p12|pem))$/i;
const PROTECTED_SEGMENTS = new Set([".aws", ".git", ".gnupg", ".ssh"]);
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
const DEFAULT_PROTECTED_PATHS = [
  "specs/constitution.md",
  "docs/architecture/invariants.md",
] as const;

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
      description: "Read a bounded line range from a declared repository file.",
      parameters: objectSchema(
        {
          endLine: { minimum: 1, type: "integer" },
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
      name: "git_status",
      description: "Return bounded porcelain status for declared read scopes.",
      parameters: objectSchema({}),
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Return a bounded git diff for declared paths.",
      parameters: objectSchema({
        paths: { items: { type: "string" }, type: "array" },
        staged: { type: "boolean" },
      }),
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

const isSecretPath = (path: string): boolean => {
  const segments = path.toLowerCase().split("/");
  return (
    segments.some((segment) => PROTECTED_SEGMENTS.has(segment)) ||
    segments.some((segment) => SECRET_BASENAME.test(segment))
  );
};

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

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

export class UtilityToolBroker {
  readonly definitions = UTILITY_TOOL_DEFINITIONS;
  private readonly artifactDir: string;
  private readonly commandAllowlist: readonly UtilityCommandPolicy[];
  private readonly id: () => string;
  private readonly limits: UtilityToolLimits;
  private readonly now: () => number;
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
    const broker = new UtilityToolBroker(config, deps, canonicalRoot);
    await broker.validateConfiguration();
    return broker;
  }

  async execute(call: UtilityToolCall): Promise<UtilityToolResult> {
    const startedAt = this.now();
    try {
      const data = await this.dispatch(call);
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

  private async validateConfiguration(): Promise<void> {
    if (!(this.readScopes.length > 0)) {
      throw new ToolPolicyError(
        "invalid_policy",
        "At least one read scope is required"
      );
    }
    if (!isContained(this.repoRoot, this.artifactDir)) {
      throw new ToolPolicyError(
        "invalid_policy",
        "Artifact directory escapes repository"
      );
    }
    await this.assertRealContainment(dirname(this.artifactDir));
    for (const scope of [...this.readScopes, ...this.writeScopes]) {
      if (this.isProtected(scope)) {
        throw new ToolPolicyError(
          "invalid_policy",
          `Declared scope is protected: ${scope}`
        );
      }
    }
  }

  private async dispatch(
    call: UtilityToolCall
  ): Promise<Omit<UtilityToolResult, "durationMs" | "ok" | "tool">> {
    switch (call.name) {
      case "search_repo":
        return { data: await this.searchRepo(requireRecord(call.arguments)) };
      case "read_file":
        return { data: await this.readFileTool(requireRecord(call.arguments)) };
      case "git_status":
        return this.gitStatus(requireRecord(call.arguments));
      case "git_diff":
        return this.gitDiff(requireRecord(call.arguments));
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
      isSecretPath(path) ||
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
      throw new ToolPolicyError(
        "scope_denied",
        `Path is outside declared ${mode} scope: ${path}`
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
    while (true) {
      try {
        const canonical = await realpath(cursor);
        if (!isContained(this.repoRoot, canonical)) {
          throw new ToolPolicyError(
            "path_denied",
            "Path resolves outside repository"
          );
        }
        return canonical;
      } catch (error) {
        if (error instanceof ToolPolicyError) {
          throw error;
        }
        const parent = dirname(cursor);
        if (parent === cursor) {
          throw new ToolPolicyError(
            "path_denied",
            "Cannot resolve repository path"
          );
        }
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
      : await this.assertRealContainment(absolute).then(() => absolute);
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
      const target = await this.resolvePath(requestedPath, "read", true);
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
    return matches;
  }

  private async readFileTool(args: Record<string, unknown>): Promise<{
    content: string;
    endLine: number;
    path: string;
    startLine: number;
  }> {
    const target = await this.resolvePath(
      requireString(args, "path"),
      "read",
      true
    );
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
    const lines = content.split(LINE_BREAK);
    const startLine = optionalPositiveInteger(args, "startLine") ?? 1;
    const requestedEnd =
      optionalPositiveInteger(args, "endLine") ?? lines.length;
    const endLine = Math.min(requestedEnd, lines.length);
    if (startLine > endLine && lines.length > 0) {
      throw new ToolPolicyError(
        "invalid_arguments",
        "startLine exceeds endLine"
      );
    }
    const selected = lines.slice(startLine - 1, endLine).join("\n");
    if (Buffer.byteLength(selected) > this.limits.maxOutputBytes) {
      throw new ToolPolicyError(
        "output_limit",
        "Selected file range exceeds output limit"
      );
    }
    return { content: selected, endLine, path: target.relative, startLine };
  }

  private gitExclusions(): string[] {
    return [
      ":(exclude)**/.env*",
      ":(exclude)**/*.key",
      ":(exclude)**/*.p12",
      ":(exclude)**/*.pem",
      ":(exclude)**/.npmrc",
      ...this.protectedPaths.map((path) => `:(exclude)${path}`),
    ];
  }

  private async runBounded(
    argv: readonly string[],
    cwd: string
  ): Promise<CommandExecution> {
    const result = await this.runCommand({
      argv,
      cwd,
      env: scrubUtilityEnvironment(this.sourceEnv),
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

  private async gitStatus(
    args: Record<string, unknown>
  ): Promise<Omit<UtilityToolResult, "durationMs" | "ok" | "tool">> {
    if (Object.keys(args).length > 0) {
      throw new ToolPolicyError(
        "invalid_arguments",
        "git_status accepts no arguments"
      );
    }
    const paths = this.readScopes.length > 0 ? this.readScopes : ["."];
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
    return this.commandResult(result);
  }

  private async gitDiff(
    args: Record<string, unknown>
  ): Promise<Omit<UtilityToolResult, "durationMs" | "ok" | "tool">> {
    const paths = optionalStringArray(args, "paths") ?? this.readScopes;
    const staged = optionalBoolean(args, "staged") ?? false;
    const safePaths: string[] = [];
    for (const path of paths) {
      const target = await this.resolvePath(path, "read", false);
      safePaths.push(target.relative);
    }
    const result = await this.runBounded(
      [
        "git",
        "diff",
        "--no-ext-diff",
        ...(staged ? ["--cached"] : []),
        "--",
        ...safePaths,
        ...this.gitExclusions(),
      ],
      this.repoRoot
    );
    return this.commandResult(result);
  }

  private assertCommandAllowed(argv: readonly string[]): number {
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
          return prefix.length + 1;
        }
      }
    }
    throw new ToolPolicyError(
      "command_denied",
      `Command is not allowlisted: ${argv[0]}`
    );
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
    const pathArgsStart = this.assertCommandAllowed(argv);
    const requestedPaths = argv.slice(pathArgsStart);
    if (
      requestedPaths.length === 0 ||
      requestedPaths.some((value) => value.startsWith("-"))
    ) {
      throw new ToolPolicyError(
        "command_denied",
        "A focused check requires one or more scoped file paths and no options"
      );
    }
    const cwdRequest = optionalString(args, "cwd") ?? ".";
    const cwd = await this.resolvePath(cwdRequest, "read", true);
    const cwdStat = await lstat(cwd.absolute);
    if (!cwdStat.isDirectory()) {
      throw new ToolPolicyError(
        "path_denied",
        "Command cwd must be a directory"
      );
    }
    const safeArgv = argv.slice(0, pathArgsStart);
    for (const path of requestedPaths) {
      const target = await this.resolvePath(path, "read", true);
      const stat = await lstat(target.absolute);
      if (!stat.isFile()) {
        throw new ToolPolicyError(
          "path_denied",
          `Check target must be a file: ${path}`
        );
      }
      safeArgv.push(relativePath(cwd.absolute, target.absolute));
    }
    const result = await this.runBounded(safeArgv, cwd.absolute);
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
    await writeFile(patchPath, patch, { encoding: "utf8", flag: "wx" });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return {
      artifact: { manifestPath, path: patchPath, sha256: hash(patch) },
      data: { preimages, summary, targets },
    };
  }
}

export const createUtilityToolBroker = (
  config: UtilityToolBrokerConfig,
  deps: UtilityToolDependencies = {}
): Promise<UtilityToolBroker> => UtilityToolBroker.create(config, deps);
