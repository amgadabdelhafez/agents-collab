import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
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
  UtilityExecutionProfile,
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
  | "git-inspect"
  | "git-status"
  | "large-read"
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
const SHELL_META = new Set([";", "&", "|", "`", "$", "<", ">", "(", ")"]);
const LEADING_CURRENT_DIR_RE = /^\.\//;
const TRAILING_SLASH_RE = /\/$/;
const GLOB_META_RE = /[?*[\]{}]/;
const WHITESPACE_RE = /\s/;
const SOURCE_SLICE_RE = /^(\d+),(\d+)p$/;
const DIGITS_RE = /^\d+$/;
const FILTER_COUNT_FLAG_RE = /^-\d+$/;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const GIT_BRANCH_PATTERN_RE = /^[A-Za-z0-9._/*?-]{1,128}$/;
const EXECUTION_PROFILE_BY_OPERATION: Partial<
  Record<DelegationOperation, UtilityExecutionProfile>
> = {
  "git-diff": "git-diff",
  "git-inspect": "git-inspect",
  "git-status": "git-status",
  "large-read": "file-read",
  "scoped-search": "search",
  "source-slice": "file-read",
};
const STDERR_TO_NULL = ">/dev/null";
const GREP_ALLOWED_KEYS = new Set([
  "pattern",
  "path",
  "-i",
  "-n",
  "output_mode",
]);
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

const MAX_SYMLINK_HOPS = 64;

const isWithin = (root: string, target: string): boolean => {
  if (target === root) {
    return true;
  }
  const rel = relative(root, target);
  return (
    rel.length > 0 && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)
  );
};

// Physically resolve an absolute path the way the kernel does: walk it one
// component at a time, applying `..` against the already-resolved (real)
// parent. This is deliberately NOT `realpathSync`, which on some platforms
// collapses `link/..` lexically before following the symlink and so cannot see
// a `link/..` escape. When `rejectWithin` is set, any symlink component whose
// path lies inside it (an in-repo symlink) is REFUSED rather than followed:
// its target is unverifiable/mutable (TOCTOU) and refusing it collapses the
// whole class of symlink-plus-`..` escapes. Symlinks above `rejectWithin`
// (e.g. macOS /var -> /private/var) are still followed to canonicalize the
// prefix. A missing component does not stop the walk — a later `..` can return
// to a real in-repo symlink, so resolution continues. Returns undefined on a
// refused/looping/unreadable symlink so every caller fails closed.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: auditable path walker
const physicalResolve = (
  startAbs: string,
  rejectWithin?: string
): string | undefined => {
  if (!isAbsolute(startAbs)) {
    return undefined;
  }
  const parentOf = (path: string): string => {
    const cut = path.lastIndexOf("/");
    return cut > 0 ? path.slice(0, cut) : "";
  };
  const queue = startAbs.split("/").filter((part) => part.length > 0);
  let resolved = "";
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      resolved = parentOf(resolved);
      continue;
    }
    const candidate = `${resolved}/${part}`;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        return undefined;
      }
      // This component does not exist; keep walking (a later `..` may return to
      // a real in-repo symlink) rather than trusting the rest as literal.
      resolved = candidate;
      continue;
    }
    if (stat.isSymbolicLink()) {
      if (rejectWithin && isWithin(rejectWithin, candidate)) {
        return undefined;
      }
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        return undefined;
      }
      let link: string;
      try {
        link = readlinkSync(candidate);
      } catch {
        return undefined;
      }
      if (isAbsolute(link)) {
        resolved = "";
      }
      queue.unshift(...link.split("/").filter((part2) => part2.length > 0));
    } else {
      resolved = candidate;
    }
  }
  return resolved || "/";
};

// Rejects a target that exists but is not a regular file (directory, FIFO,
// socket, device): read_file can only line-read a regular file.
const isExistingNonFile = (target: string): boolean => {
  try {
    return !statSync(target).isFile();
  } catch {
    return false;
  }
};

const safeScope = (
  repoRoot: string,
  cwd: string,
  value: string,
  allowRoot = false,
  requireFile = false
): string | undefined => {
  // A leading `~` is never expanded by node's path resolution, so a raw tilde
  // path would masquerade as an in-repo scope while the real shell reads $HOME.
  // Brace/glob metacharacters are not expanded here either; a backslash is a
  // literal path char on POSIX but normalizedRelative rewrites it to `/`, so a
  // validated `link\x` would be returned as the symlink-traversing `link/x`; an
  // empty value is meaningless. All fail closed before any filesystem access.
  if (
    !value ||
    value.startsWith("~") ||
    value.includes("\\") ||
    GLOB_META_RE.test(value)
  ) {
    return undefined;
  }
  // Canonicalize the root fully (following symlinks — it is trusted). Build the
  // absolute target WITHOUT lexically collapsing `..` and resolve it physically,
  // refusing to traverse any symlink INSIDE the canonical root: an in-repo
  // symlink's target is unverifiable/mutable, and refusing it closes the whole
  // symlink-plus-`..` escape class. Symlinks above the root (macOS
  // /var -> /private/var) are still followed so a genuine in-repo path resolves.
  const root = physicalResolve(resolve(repoRoot));
  if (!root) {
    return undefined;
  }
  const rawTarget = isAbsolute(value) ? value : `${resolve(cwd)}/${value}`;
  const target = physicalResolve(rawTarget, root);
  if (!target) {
    return undefined;
  }
  // read_file can only line-read a regular file, so single-file readers reject a
  // directory / FIFO / socket / device target.
  if (requireFile && isExistingNonFile(target)) {
    return undefined;
  }
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
): EligibleDelegationIntent => {
  const executionProfile = EXECUTION_PROFILE_BY_OPERATION[operation];
  return {
    fingerprint: fingerprint(intent),
    operation,
    reason: operation,
    request: {
      acceptanceCriteria,
      authority: {},
      ...(executionProfile ? { executionProfile } : {}),
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
  };
};

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
  const scope = safeScope(intent.repoRoot, intent.cwd, file, false, true);
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
  // The broker search_repo does only a plain text search. Any modal parameter
  // that changes the evidence kind (output_mode/-c/-l) or narrows scope
  // (glob/type/head_limit/context lines) cannot be honored, so a delegated
  // request would misrepresent the query — fail closed. Only a plain content
  // search (optionally case-insensitive / with line numbers) is delegable.
  const hasUnsupportedModifier = Object.keys(input).some(
    (key) =>
      !GREP_ALLOWED_KEYS.has(key) &&
      input[key] !== undefined &&
      input[key] !== false
  );
  if (
    hasUnsupportedModifier ||
    (input.output_mode !== undefined && input.output_mode !== "content")
  ) {
    return { eligible: false, ...exempt(intent, "grep-modifier-unsupported") };
  }
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

type ShellToken =
  | { kind: "word"; value: string }
  | { kind: "pipe" }
  | { kind: "and" }
  | { kind: "quiet-stderr" };

// A literal shell-token scanner is intentionally explicit: every state branch
// is a safety boundary and collapsing it would make quoting rules harder to
// audit. Only three operator forms are recognized — a single `|`, `&&`, and a
// trailing-token `2>/dev/null` — everything else fails closed.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: auditable tokenizer state machine
const literalTokens = (command: string): ShellToken[] | undefined => {
  if (
    !command ||
    command.length > MAX_COMMAND_LENGTH ||
    SECRET_VALUE.test(command)
  ) {
    return undefined;
  }
  const tokens: ShellToken[] = [];
  let token = "";
  let tokenQuoted = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  const push = () => {
    // A quoted token counts as a word even when empty (e.g. `''`), so an empty
    // argument is never silently dropped.
    if (token || tokenQuoted) {
      tokens.push({ kind: "word", value: token });
      token = "";
    }
    tokenQuoted = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    // Reject raw control characters before anything else, including before the
    // escaped branch, so a backslash-newline cannot smuggle a literal newline
    // into a token and defeat the single-command guarantee.
    if (char === "\0" || char === "\n" || char === "\r") {
      return undefined;
    }
    if (escaped) {
      // Inside double quotes bash keeps the backslash unless it precedes
      // $ ` " \ (newline is already rejected above); before an ordinary char
      // the backslash is literal, so preserve it and let safeScope reject the
      // resulting path rather than silently searching a different one.
      if (
        quote === "double" &&
        char !== "$" &&
        char !== "`" &&
        char !== '"' &&
        char !== "\\"
      ) {
        token += "\\";
      }
      token += char;
      tokenQuoted = true;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      tokenQuoted = true;
      continue;
    }
    if (char === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      tokenQuoted = true;
      continue;
    }
    if (quote === undefined && char === "|") {
      if (command[index + 1] === "|") {
        return undefined;
      }
      push();
      tokens.push({ kind: "pipe" });
      continue;
    }
    if (quote === undefined && char === "&") {
      if (command[index + 1] !== "&") {
        return undefined;
      }
      push();
      tokens.push({ kind: "and" });
      index += 1;
      continue;
    }
    if (
      quote === undefined &&
      char === ">" &&
      token === "2" &&
      !tokenQuoted &&
      command.startsWith(STDERR_TO_NULL, index) &&
      (index + STDERR_TO_NULL.length === command.length ||
        WHITESPACE_RE.test(command[index + STDERR_TO_NULL.length] as string))
    ) {
      token = "";
      tokenQuoted = false;
      tokens.push({ kind: "quiet-stderr" });
      index += STDERR_TO_NULL.length - 1;
      continue;
    }
    // An unquoted `#` at a word boundary begins a comment; bash ignores the
    // rest of the line, so we stop tokenizing rather than fabricate scopes
    // from the comment text.
    if (quote === undefined && char === "#" && token === "" && !tokenQuoted) {
      break;
    }
    if (quote === undefined && SHELL_META.has(char)) {
      return undefined;
    }
    if (quote === "double" && (char === "$" || char === "`")) {
      return undefined;
    }
    if (quote === undefined && WHITESPACE_RE.test(char)) {
      // Only space and tab split a word under bash's default IFS. Other JS \s
      // characters (NBSP, U+2028, U+FEFF, …) are literal to bash, so splitting
      // on them would mis-scope the command — fail closed instead.
      if (char === " " || char === "\t") {
        push();
        continue;
      }
      return undefined;
    }
    if (quote === undefined && GLOB_META_RE.test(char)) {
      // Unquoted brace/glob metacharacters ({ } * ? [ ]) are expanded by bash
      // before the command runs, producing different or extra arguments the
      // classifier never sees (e.g. `rg {x,/etc/hosts} src` reads /etc/hosts
      // via the pattern slot, which is not scope-checked). Fail closed; a
      // literal metacharacter must be quoted or escaped.
      return undefined;
    }
    token += char;
  }
  if (escaped || quote !== undefined) {
    return undefined;
  }
  push();
  return tokens.length > 0 ? tokens : undefined;
};

const wordValues = (tokens: ShellToken[]): string[] | undefined => {
  const words: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "word") {
      return undefined;
    }
    words.push(token.value);
  }
  return words;
};

const splitTokens = (
  tokens: ShellToken[],
  kind: "and" | "pipe"
): ShellToken[][] => {
  const segments: ShellToken[][] = [[]];
  for (const token of tokens) {
    if (token.kind === kind) {
      segments.push([]);
    } else {
      segments.at(-1)?.push(token);
    }
  }
  return segments;
};

interface OutputFilter {
  cmd: "head" | "tail";
  count?: number;
}

// `head`/`tail` only bound how much output is shown, so they can be carried
// into an inspect request as an evidence limit. `wc -l` (and any other
// aggregate) is deliberately not a filter: it changes the *kind* of evidence
// from matches to a count, which a downstream acceptance check could not
// distinguish from a dropped filter. A zero bound is degenerate.
const parseOutputFilter = (tokens: ShellToken[]): OutputFilter | undefined => {
  const words = wordValues(tokens);
  if (!words || words.length === 0) {
    return undefined;
  }
  const [name, ...rest] = words;
  if (name !== "head" && name !== "tail") {
    return undefined;
  }
  if (rest.length === 0) {
    return { cmd: name };
  }
  let count: number | undefined;
  if (rest.length === 1 && FILTER_COUNT_FLAG_RE.test(rest[0] ?? "")) {
    count = Number((rest[0] ?? "").slice(1));
  } else if (
    rest.length === 2 &&
    rest[0] === "-n" &&
    DIGITS_RE.test(rest[1] ?? "")
  ) {
    count = Number(rest[1]);
  } else {
    return undefined;
  }
  return count >= 1 ? { cmd: name, count } : undefined;
};

const describeOutputFilter = (filter: OutputFilter): string => {
  const edge = filter.cmd === "head" ? "first" : "last";
  return filter.count === undefined
    ? `${edge} lines`
    : `${edge} ${filter.count} lines`;
};

interface SafeCompound {
  argv: string[];
  cdTarget?: string;
  filter?: OutputFilter;
}

// Structural parse of `[cd <path> &&] base [2>/dev/null] [| filter]`. Every
// other compound shape returns undefined so classifyBash keeps failing closed.
const decomposeSafeCompound = (
  tokens: ShellToken[]
): SafeCompound | undefined => {
  const chained = splitTokens(tokens, "and");
  if (chained.length > 2) {
    return undefined;
  }
  let cdTarget: string | undefined;
  let rest = chained[0] ?? [];
  if (chained.length === 2) {
    const lead = wordValues(chained[0] ?? []);
    if (
      !lead ||
      lead.length !== 2 ||
      lead[0] !== "cd" ||
      !lead[1] ||
      // `cd -` is $OLDPWD and `cd -<opt>` is an option, neither a literal path.
      lead[1].startsWith("-") ||
      GLOB_META_RE.test(lead[1])
    ) {
      return undefined;
    }
    cdTarget = lead[1];
    rest = chained[1] ?? [];
  }
  const piped = splitTokens(rest, "pipe");
  if (piped.length > 2) {
    return undefined;
  }
  let filter: OutputFilter | undefined;
  if (piped.length === 2) {
    filter = parseOutputFilter(piped[1] ?? []);
    if (!filter) {
      return undefined;
    }
  }
  let base = piped[0] ?? [];
  if (base.at(-1)?.kind === "quiet-stderr") {
    base = base.slice(0, -1);
  }
  const argv = wordValues(base);
  if (!argv || argv.length === 0) {
    return undefined;
  }
  return {
    argv,
    ...(cdTarget === undefined ? {} : { cdTarget }),
    ...(filter === undefined ? {} : { filter }),
  };
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

type GitInspectionAction =
  | "branch-list"
  | "log"
  | "object-type"
  | "resolve-ref"
  | "show-stat";

interface GitInspectionQuery {
  action: GitInspectionAction;
  includeMetadata?: boolean;
  limit?: number;
  outputBound?: string;
  pattern?: string;
  ref?: string;
}

const safeGitRef = (value: string | undefined): value is string =>
  Boolean(value && GIT_REF_RE.test(value) && !value.includes(".."));

const parseGitShowInspection = (
  argv: readonly string[]
): GitInspectionQuery | undefined => {
  let includeMetadata = true;
  let sawStat = false;
  let ref: string | undefined;
  for (const arg of argv.slice(2)) {
    if (arg === "--stat") {
      sawStat = true;
    } else if (arg === "--format=") {
      // An explicitly empty format is safe and means stat-only output.
      includeMetadata = false;
    } else if (!ref && safeGitRef(arg)) {
      ref = arg;
    } else {
      return undefined;
    }
  }
  return sawStat && ref
    ? { action: "show-stat", includeMetadata, ref }
    : undefined;
};

const parseGitLogInspection = (
  argv: readonly string[]
): GitInspectionQuery | undefined => {
  let limit: number | undefined;
  let oneline = false;
  let ref: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--oneline") {
      oneline = true;
    } else if (FILTER_COUNT_FLAG_RE.test(arg)) {
      limit = Number(arg.slice(1));
    } else if (arg === "-n" && DIGITS_RE.test(argv[index + 1] ?? "")) {
      limit = Number(argv[index + 1]);
      index += 1;
    } else if (!ref && safeGitRef(arg)) {
      ref = arg;
    } else {
      return undefined;
    }
  }
  return oneline && ref && limit && limit <= 50
    ? { action: "log", limit, ref }
    : undefined;
};

const parseGitInspection = (
  argv: readonly string[]
): GitInspectionQuery | undefined => {
  if (argv[0] !== "git") {
    return undefined;
  }
  if (argv[1] === "rev-parse" && argv.length === 3 && safeGitRef(argv[2])) {
    return { action: "resolve-ref", ref: argv[2] };
  }
  if (
    argv[1] === "cat-file" &&
    argv[2] === "-t" &&
    argv.length === 4 &&
    safeGitRef(argv[3])
  ) {
    return { action: "object-type", ref: argv[3] };
  }
  if (
    argv[1] === "branch" &&
    (argv[2] === "-a" || argv[2] === "--all") &&
    argv[3] === "--list" &&
    argv.length === 5 &&
    GIT_BRANCH_PATTERN_RE.test(argv[4] ?? "") &&
    !argv[4]?.startsWith("-")
  ) {
    return { action: "branch-list", pattern: argv[4] };
  }
  if (argv[1] === "show") {
    return parseGitShowInspection(argv);
  }
  return argv[1] === "log" ? parseGitLogInspection(argv) : undefined;
};

const parseGitInspectionSegment = (
  tokens: ShellToken[]
): GitInspectionQuery | undefined => {
  const piped = splitTokens(tokens, "pipe");
  if (piped.length > 2) {
    return undefined;
  }
  const filter =
    piped.length === 2 ? parseOutputFilter(piped[1] ?? []) : undefined;
  if (piped.length === 2 && !filter) {
    return undefined;
  }
  let base = piped[0] ?? [];
  if (base.at(-1)?.kind === "quiet-stderr") {
    base = base.slice(0, -1);
  }
  const argv = wordValues(base);
  const query = argv ? parseGitInspection(argv) : undefined;
  if (!query) {
    return undefined;
  }
  return filter
    ? { ...query, outputBound: describeOutputFilter(filter) }
    : query;
};

const classifyGitInspectionChain = (
  intent: DelegationToolIntent,
  tokens: ShellToken[]
): DelegationClassification | undefined => {
  const segments = splitTokens(tokens, "and");
  if (segments.length < 2 || segments.length > 4) {
    return undefined;
  }
  const queries = segments.map(parseGitInspectionSegment);
  if (queries.some((query) => !query)) {
    return undefined;
  }
  return {
    eligible: true,
    ...request(
      intent,
      "git-inspect",
      "inspect",
      `Inspect repository metadata for these exact bounded queries: ${JSON.stringify(queries)}.`,
      [
        "Return the requested Git metadata in order without changing the repository.",
      ],
      ["."],
      ["inspect"]
    ),
  };
};

const classifyGit = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  if (argv[0] !== "git") {
    return undefined;
  }
  const inspection = parseGitInspection(argv);
  if (inspection) {
    return {
      eligible: true,
      ...request(
        intent,
        "git-inspect",
        "inspect",
        `Inspect repository metadata for this exact bounded query: ${JSON.stringify(inspection)}.`,
        ["Return the requested Git metadata without changing the repository."],
        ["."],
        ["inspect"]
      ),
    };
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
  // Only flags the git_diff broker tool can reproduce. --stat, --name-status,
  // and -U<n> have no broker capability, so the worker would silently return a
  // different evidence kind; reject them rather than mis-satisfy.
  if (
    flags.some(
      (flag) => !["--cached", "--staged", "--name-only"].includes(flag)
    )
  ) {
    return {
      eligible: false,
      ...exempt(intent, "unsupported-git-diff-option"),
    };
  }
  const pathspecs = argv.slice(separator + 1);
  if (pathspecs.some((spec) => spec.startsWith(":"))) {
    // A git magic pathspec (:(exclude), :!, :/) is not a literal path; it can
    // widen the diff to everything *except* the named path, leaking governed
    // files past the declared readScope. Fail closed.
    return { eligible: false, ...exempt(intent, "git-diff-magic-pathspec") };
  }
  const scopes = scopesFrom(intent, pathspecs);
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
  } else if (argv[index]?.startsWith("-")) {
    // An unrecognized flag (e.g. --pre runs an arbitrary program per file) is
    // never the search pattern; reject rather than granting its argument as a
    // read scope. The `--` separator above still allows a literal `-pattern`.
    return { eligible: false, ...exempt(intent, "unsupported-rg-option") };
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
  if (pathArgs.some((arg) => arg.startsWith("-"))) {
    return { eligible: false, ...exempt(intent, "unsupported-rg-option") };
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
  const scope = safeScope(intent.repoRoot, intent.cwd, file, false, true);
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
  const tokens = command ? literalTokens(command) : undefined;
  const gitInspectionChain = tokens
    ? classifyGitInspectionChain(intent, tokens)
    : undefined;
  if (gitInspectionChain) {
    return gitInspectionChain;
  }
  const compound = tokens ? decomposeSafeCompound(tokens) : undefined;
  if (!compound) {
    return { eligible: false, ...exempt(intent, "compound-or-unsafe-command") };
  }
  let scoped = intent;
  if (compound.cdTarget) {
    const rel = safeScope(intent.repoRoot, intent.cwd, compound.cdTarget, true);
    if (!rel) {
      return { eligible: false, ...exempt(intent, "cd-without-safe-scope") };
    }
    scoped = {
      ...intent,
      cwd:
        rel === "."
          ? resolve(intent.repoRoot)
          : join(resolve(intent.repoRoot), rel),
    };
  }
  const argv = compound.argv;
  if (argv[0]?.includes("/") || argv[0]?.includes("\\")) {
    return {
      eligible: false,
      ...exempt(intent, "executable-path-not-allowed"),
    };
  }
  // Every delegable operation is inspect-kind: its read scope fully captures
  // what the worker touches, so a folded `cd` is safe. No command-kind shape is
  // delegated (a test runner needs a cwd that UtilityRouteRequest cannot carry).
  const classified = classifyGit(scoped, argv) ??
    classifyRg(scoped, argv) ??
    classifySourceSlice(scoped, argv) ?? {
      eligible: false,
      ...exempt(scoped, "command-not-in-delegation-grammar"),
    };
  if (!classified.eligible) {
    return classified;
  }
  // Carry an output-limiting filter into the delegated request so the worker
  // honors the same bound the operator asked for instead of dropping it.
  if (compound.filter) {
    const bound = describeOutputFilter(compound.filter);
    return {
      ...classified,
      request: {
        ...classified.request,
        objective: `${classified.request.objective} Limit the returned evidence to the ${bound}.`,
        acceptanceCriteria: [
          ...classified.request.acceptanceCriteria,
          `Bound the returned evidence to the ${bound}.`,
        ],
      },
    };
  }
  return classified;
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
  // Glob is intentionally not delegable: no broker tool can list files by glob
  // (search_repo is text-only; run_check allowlists only bun test / npx vitest),
  // so a scoped-glob request could never be satisfied. It falls through to the
  // fail-closed default below.
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
