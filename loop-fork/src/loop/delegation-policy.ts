import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type {
  UtilityCapability,
  UtilityRequestKind,
  UtilityRouteRequestInput,
} from "./task-router";
import type { Agent } from "./types";
import { isUtilityProtectedPath } from "./utility-path-policy";

export type UtilityDelegationMode = "enforce" | "observe" | "off";
export type DelegationDisposition =
  | "auto-routed"
  | "explicit-routed"
  | "missed-candidate"
  | "observed-candidate"
  | "route-failed"
  | "skipped-candidate";

export type DelegationOperation =
  | "focused-check"
  | "git-diff"
  | "git-status"
  | "large-read"
  | "scoped-glob"
  | "scoped-search"
  | "source-slice"
  | "tool-use";

export interface DelegationTelemetryEvent {
  agent: Agent;
  at: string;
  disposition: DelegationDisposition;
  fingerprint: string;
  operation: DelegationOperation | UtilityRequestKind;
  reason: string;
  source: "bridge" | "claude-hook" | "codex-app-server";
  taskId?: string;
}

export interface DelegationToolIntent {
  agent: Agent;
  cwd: string;
  repoRoot: string;
  toolInput: unknown;
  toolName: string;
  toolUseId?: string;
}

export interface EligibleDelegationIntent {
  fingerprint: string;
  operation: DelegationOperation;
  reason: string;
  request: UtilityRouteRequestInput;
}

export interface ExemptDelegationIntent {
  fingerprint: string;
  reason: string;
}

export type DelegationClassification =
  | ({ eligible: true } & EligibleDelegationIntent)
  | ({ eligible: false } & ExemptDelegationIntent);

export const DELEGATION_EVENTS_FILE = "delegation.jsonl";

const MAX_COMMAND_LENGTH = 2000;
const MAX_PATTERN_LENGTH = 256;
const MAX_SCOPES = 4;
const LARGE_READ_MIN_LINES = 200;
const MAX_SOURCE_SLICE_LINES = 500;
const SHELL_META = new Set([";", "&", "|", "`", "$", "<", ">"]);
const LEADING_CURRENT_DIR_RE = /^\.\//;
const TRAILING_SLASH_RE = /\/$/;
const GLOB_META_RE = /[?*[\]{}]/;
const WHITESPACE_RE = /\s/;
const DIFF_CONTEXT_RE = /^-U\d{1,3}$/;
const SOURCE_SLICE_RE = /^(\d+),(\d+)p$/;
const DIGITS_RE = /^\d+$/;
const SECRET_VALUE =
  /(?:sk-[A-Za-z0-9_-]{16,}|bearer\s+[A-Za-z0-9._-]{16,}|(?:api[_-]?key|password|secret|token)\s*[=:]\s*[^\s]{8,})/i;
const DEPENDENCY_BASENAME = new Set([
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asPositiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;

const normalizedRelative = (value: string): string =>
  value
    .replaceAll("\\", "/")
    .replace(LEADING_CURRENT_DIR_RE, "")
    .replace(TRAILING_SLASH_RE, "");

const isGovernedOrProtectedPath = (path: string): boolean => {
  const normalized = normalizedRelative(path);
  return (
    !normalized ||
    isUtilityProtectedPath(normalized) ||
    DEPENDENCY_BASENAME.has(basename(normalized).toLowerCase())
  );
};

const safeScope = (
  repoRoot: string,
  cwd: string,
  value: string,
  allowRoot = false
): string | undefined => {
  const root = resolve(repoRoot);
  const target = resolve(isAbsolute(value) ? value : join(cwd, value));
  const rel = normalizedRelative(relative(root, target));
  if (rel === "" && allowRoot) {
    return ".";
  }
  if (!rel || isGovernedOrProtectedPath(rel)) {
    return undefined;
  }
  return rel;
};

const fingerprint = (intent: DelegationToolIntent): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        agent: intent.agent,
        cwd: resolve(intent.cwd),
        input: intent.toolInput,
        tool: intent.toolName,
        toolUseId: intent.toolUseId,
      })
    )
    .digest("hex");

const request = (
  intent: DelegationToolIntent,
  operation: DelegationOperation,
  kind: UtilityRequestKind,
  objective: string,
  acceptanceCriteria: string[],
  readScope: string[],
  requiredCapabilities: UtilityCapability[]
): EligibleDelegationIntent => ({
  fingerprint: fingerprint(intent),
  operation,
  reason: operation,
  request: {
    acceptanceCriteria,
    authority: {},
    ...(intent.toolUseId
      ? { idempotencyKey: `auto:${intent.agent}:${intent.toolUseId}` }
      : {}),
    kind,
    objective,
    readScope,
    requester: intent.agent,
    requiredCapabilities,
    risk: "low",
    writeScope: [],
  },
});

const exempt = (
  intent: DelegationToolIntent,
  reason: string
): ExemptDelegationIntent => ({ fingerprint: fingerprint(intent), reason });

const classifyRead = (
  intent: DelegationToolIntent,
  input: Record<string, unknown>
): DelegationClassification => {
  const file = asString(input.file_path ?? input.filePath ?? input.path);
  if (!file) {
    return { eligible: false, ...exempt(intent, "read-without-file") };
  }
  const scope = safeScope(intent.repoRoot, intent.cwd, file);
  if (!scope) {
    return { eligible: false, ...exempt(intent, "governed-or-unsafe-path") };
  }
  const limit = asPositiveInteger(input.limit);
  if (limit !== undefined && limit < LARGE_READ_MIN_LINES) {
    return { eligible: false, ...exempt(intent, "small-context-read") };
  }
  const offset = asPositiveInteger(input.offset) ?? 1;
  const requested = limit ?? LARGE_READ_MIN_LINES;
  return {
    eligible: true,
    ...request(
      intent,
      "large-read",
      "inspect",
      `Inspect ${scope} starting at line ${offset} for up to ${requested} lines and return only the evidence needed by the requester.`,
      [`Return a concise finding with exact line references from ${scope}.`],
      [scope],
      ["inspect"]
    ),
  };
};

const classifyGrep = (
  intent: DelegationToolIntent,
  input: Record<string, unknown>
): DelegationClassification => {
  const pattern = asString(input.pattern);
  const path = asString(input.path);
  if (
    !pattern ||
    pattern.length > MAX_PATTERN_LENGTH ||
    SECRET_VALUE.test(pattern) ||
    !path
  ) {
    return {
      eligible: false,
      ...exempt(intent, "unbounded-or-sensitive-search"),
    };
  }
  const scope = safeScope(intent.repoRoot, intent.cwd, path);
  if (!scope) {
    return { eligible: false, ...exempt(intent, "governed-or-unsafe-path") };
  }
  return {
    eligible: true,
    ...request(
      intent,
      "scoped-search",
      "inspect",
      `Search ${scope} for the pattern ${JSON.stringify(pattern)} and summarize the relevant matches.`,
      [
        "Return matching paths and exact line references without changing files.",
      ],
      [scope],
      ["inspect"]
    ),
  };
};

const fixedGlobScope = (pattern: string): string | undefined => {
  const wildcard = pattern.search(GLOB_META_RE);
  const fixed = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
  const slash = fixed.lastIndexOf("/");
  return slash < 0 ? undefined : fixed.slice(0, slash);
};

const classifyGlob = (
  intent: DelegationToolIntent,
  input: Record<string, unknown>
): DelegationClassification => {
  const pattern = asString(input.pattern);
  const base =
    asString(input.path) ?? (pattern ? fixedGlobScope(pattern) : undefined);
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || !base) {
    return { eligible: false, ...exempt(intent, "glob-without-bounded-base") };
  }
  const scope = safeScope(intent.repoRoot, intent.cwd, base);
  if (!scope) {
    return { eligible: false, ...exempt(intent, "governed-or-unsafe-path") };
  }
  return {
    eligible: true,
    ...request(
      intent,
      "scoped-glob",
      "inspect",
      `List repository files under ${scope} matching ${JSON.stringify(pattern)} and report only relevant paths.`,
      [
        "Return a bounded matching path list without reading protected content.",
      ],
      [scope],
      ["inspect"]
    ),
  };
};

// A literal shell-token scanner is intentionally explicit: every state branch
// is a safety boundary and collapsing it would make quoting rules harder to
// audit.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: auditable tokenizer state machine
const literalArgv = (command: string): string[] | undefined => {
  if (
    !command ||
    command.length > MAX_COMMAND_LENGTH ||
    SECRET_VALUE.test(command)
  ) {
    return undefined;
  }
  const argv: string[] = [];
  let token = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  const push = () => {
    if (token) {
      argv.push(token);
      token = "";
    }
  };
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      continue;
    }
    if (char === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (quote === undefined && SHELL_META.has(char)) {
      return undefined;
    }
    if (quote === "double" && (char === "$" || char === "`")) {
      return undefined;
    }
    if (WHITESPACE_RE.test(char) && quote === undefined) {
      push();
      continue;
    }
    if (char === "\0" || char === "\n" || char === "\r") {
      return undefined;
    }
    token += char;
  }
  if (escaped || quote !== undefined) {
    return undefined;
  }
  push();
  return argv.length > 0 ? argv : undefined;
};

const scopesFrom = (
  intent: DelegationToolIntent,
  values: string[]
): string[] | undefined => {
  if (values.length === 0 || values.length > MAX_SCOPES) {
    return undefined;
  }
  const scopes = values.map((value) =>
    safeScope(intent.repoRoot, intent.cwd, value)
  );
  return scopes.every(Boolean) ? (scopes as string[]) : undefined;
};

const classifyGit = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  if (argv[0] !== "git") {
    return undefined;
  }
  if (
    argv[1] === "status" &&
    argv
      .slice(2)
      .every((arg) =>
        ["--short", "--porcelain", "--branch", "-sb"].includes(arg)
      )
  ) {
    return {
      eligible: true,
      ...request(
        intent,
        "git-status",
        "inspect",
        "Return bounded porcelain repository status and summarize changed paths.",
        ["Report repository status without changing the worktree."],
        ["."],
        ["inspect"]
      ),
    };
  }
  if (argv[1] !== "diff") {
    return undefined;
  }
  const separator = argv.indexOf("--", 2);
  if (separator < 0) {
    return {
      eligible: false,
      ...exempt(intent, "git-diff-without-path-scope"),
    };
  }
  const flags = argv.slice(2, separator);
  if (
    flags.some(
      (flag) =>
        !(
          [
            "--stat",
            "--cached",
            "--staged",
            "--name-only",
            "--name-status",
          ].includes(flag) || DIFF_CONTEXT_RE.test(flag)
        )
    )
  ) {
    return {
      eligible: false,
      ...exempt(intent, "unsupported-git-diff-option"),
    };
  }
  const scopes = scopesFrom(intent, argv.slice(separator + 1));
  if (!scopes) {
    return {
      eligible: false,
      ...exempt(intent, "git-diff-without-safe-scope"),
    };
  }
  const normalizedArgv = [...argv.slice(0, separator + 1), ...scopes];
  return {
    eligible: true,
    ...request(
      intent,
      "git-diff",
      "inspect",
      `Inspect the git diff requested by ${JSON.stringify(normalizedArgv)} for ${scopes.join(", ")} and summarize the material changes.`,
      [
        "Return a bounded diff summary with path evidence and do not change files.",
      ],
      scopes,
      ["inspect"]
    ),
  };
};

const classifyFocusedCheck = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  let pathArgs: string[] | undefined;
  if (argv[0] === "bun" && argv[1] === "test") {
    pathArgs = argv.slice(2);
  } else if (argv[0] === "npx" && argv[1] === "vitest" && argv[2] === "run") {
    pathArgs = argv.slice(3);
  }
  if (!pathArgs) {
    return undefined;
  }
  if (pathArgs.some((arg) => arg.startsWith("-"))) {
    return { eligible: false, ...exempt(intent, "focused-check-has-options") };
  }
  const scopes = scopesFrom(intent, pathArgs);
  if (!scopes) {
    return {
      eligible: false,
      ...exempt(intent, "focused-check-without-safe-scope"),
    };
  }
  const commandPrefix =
    argv[0] === "bun" ? ["bun", "test"] : ["npx", "vitest", "run"];
  const normalizedArgv = [...commandPrefix, ...scopes];
  return {
    eligible: true,
    ...request(
      intent,
      "focused-check",
      "command",
      `Run the literal focused check ${JSON.stringify(normalizedArgv)} and report its exit status and concise evidence.`,
      [
        "Run exactly the scoped check through run_check and report a successful exit or blocker.",
      ],
      scopes,
      ["bounded-command", "focused-verify"]
    ),
  };
};

const classifyRg = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  if (argv[0] !== "rg") {
    return undefined;
  }
  const allowedFlags = new Set([
    "-F",
    "-i",
    "-n",
    "--fixed-strings",
    "--ignore-case",
    "--line-number",
  ]);
  let index = 1;
  while (index < argv.length && allowedFlags.has(argv[index] ?? "")) {
    index += 1;
  }
  if (argv[index] === "--") {
    index += 1;
  }
  const pattern = argv[index];
  const pathArgs = argv.slice(index + 1);
  if (
    !pattern ||
    pattern.length > MAX_PATTERN_LENGTH ||
    SECRET_VALUE.test(pattern)
  ) {
    return {
      eligible: false,
      ...exempt(intent, "unbounded-or-sensitive-search"),
    };
  }
  const scopes = scopesFrom(intent, pathArgs);
  if (!scopes) {
    return { eligible: false, ...exempt(intent, "search-without-safe-scope") };
  }
  const normalizedArgv = [...argv.slice(0, index + 1), ...scopes];
  return {
    eligible: true,
    ...request(
      intent,
      "scoped-search",
      "inspect",
      `Perform the bounded repository search requested by ${JSON.stringify(normalizedArgv)} under ${scopes.join(", ")} and summarize relevant matches.`,
      [
        "Return matching paths and exact line references without changing files.",
      ],
      scopes,
      ["inspect"]
    ),
  };
};

const classifySourceSlice = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  let start: number | undefined;
  let end: number | undefined;
  let file: string | undefined;
  if (argv[0] === "sed" && argv[1] === "-n" && argv.length === 4) {
    const match = SOURCE_SLICE_RE.exec(argv[2] ?? "");
    if (match) {
      start = Number(match[1]);
      end = Number(match[2]);
      file = argv[3];
    }
  } else if (
    argv[0] === "head" &&
    argv[1] === "-n" &&
    argv.length === 4 &&
    DIGITS_RE.test(argv[2] ?? "")
  ) {
    const count = Number(argv[2]);
    start = 1;
    end = count;
    file = argv[3];
  }
  if (start === undefined || end === undefined || !file) {
    return undefined;
  }
  if (start < 1 || end < start || end - start + 1 > MAX_SOURCE_SLICE_LINES) {
    return { eligible: false, ...exempt(intent, "source-slice-out-of-bounds") };
  }
  const scope = safeScope(intent.repoRoot, intent.cwd, file);
  if (!scope) {
    return { eligible: false, ...exempt(intent, "governed-or-unsafe-path") };
  }
  return {
    eligible: true,
    ...request(
      intent,
      "source-slice",
      "inspect",
      `Inspect ${scope} for the requested bounded source slice (${start}-${end}) and return concise relevant evidence.`,
      [`Return exact line references from ${scope} without changing files.`],
      [scope],
      ["inspect"]
    ),
  };
};

const classifyBash = (
  intent: DelegationToolIntent,
  input: Record<string, unknown>
): DelegationClassification => {
  const command = asString(input.command);
  const argv = command ? literalArgv(command) : undefined;
  if (!argv) {
    return { eligible: false, ...exempt(intent, "compound-or-unsafe-command") };
  }
  if (argv[0]?.includes("/") || argv[0]?.includes("\\")) {
    return {
      eligible: false,
      ...exempt(intent, "executable-path-not-allowed"),
    };
  }
  return (
    classifyGit(intent, argv) ??
    classifyFocusedCheck(intent, argv) ??
    classifyRg(intent, argv) ??
    classifySourceSlice(intent, argv) ?? {
      eligible: false,
      ...exempt(intent, "command-not-in-delegation-grammar"),
    }
  );
};

export const classifyDelegationIntent = (
  intent: DelegationToolIntent
): DelegationClassification => {
  const input = isRecord(intent.toolInput) ? intent.toolInput : {};
  if (intent.toolName === "Read") {
    return classifyRead(intent, input);
  }
  if (intent.toolName === "Grep") {
    return classifyGrep(intent, input);
  }
  if (intent.toolName === "Glob") {
    return classifyGlob(intent, input);
  }
  if (intent.toolName === "Bash" || intent.toolName === "exec_command") {
    return classifyBash(intent, input);
  }
  return { eligible: false, ...exempt(intent, "tool-not-enforceable") };
};

export const resolveUtilityDelegationMode = (
  value: string | undefined
): UtilityDelegationMode => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "observe") {
    return normalized;
  }
  return normalized === undefined ||
    normalized === "" ||
    normalized === "enforce"
    ? "enforce"
    : "observe";
};

export const delegationEventsPath = (runDir: string): string =>
  join(runDir, "utility", DELEGATION_EVENTS_FILE);

export const appendDelegationEvent = (
  runDir: string,
  event: DelegationTelemetryEvent
): void => {
  if (
    readDelegationEvents(runDir).some(
      (existing) =>
        existing.disposition === event.disposition &&
        existing.fingerprint === event.fingerprint &&
        existing.taskId === event.taskId
    )
  ) {
    return;
  }
  const path = delegationEventsPath(runDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
};

export const readDelegationEvents = (
  runDir: string
): DelegationTelemetryEvent[] => {
  try {
    return readFileSync(delegationEventsPath(runDir), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as DelegationTelemetryEvent;
          return event && typeof event === "object" ? [event] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

export const makeDelegationEvent = (
  input: Omit<DelegationTelemetryEvent, "at">,
  at = new Date().toISOString()
): DelegationTelemetryEvent => ({ ...input, at });

export const hashDelegationFingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const recordCodexAppServerDelegationCandidate = (
  runDir: string,
  repoRoot: string,
  params: unknown,
  at = new Date().toISOString(),
  append: typeof appendDelegationEvent = appendDelegationEvent
): boolean => {
  const envelope = isRecord(params) ? params : {};
  const item = isRecord(envelope.item) ? envelope.item : {};
  if (item.type !== "commandExecution") {
    return false;
  }
  const command = asString(item.command);
  const cwd = asString(item.cwd) ?? repoRoot;
  if (!command) {
    return false;
  }
  const classification = classifyDelegationIntent({
    agent: "codex",
    cwd,
    repoRoot,
    toolInput: { command },
    toolName: "exec_command",
    ...(asString(item.id) ? { toolUseId: asString(item.id) } : {}),
  });
  if (!classification.eligible) {
    return false;
  }
  append(
    runDir,
    makeDelegationEvent(
      {
        agent: "codex",
        disposition: "missed-candidate",
        fingerprint: classification.fingerprint,
        operation: classification.operation,
        reason: "codex-tool-hook-unavailable",
        source: "codex-app-server",
      },
      at
    )
  );
  return true;
};
