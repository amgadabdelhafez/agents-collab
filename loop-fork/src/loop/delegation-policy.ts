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
  UtilityGitInspectionRequest,
  UtilityOutputRequest,
  UtilityReadPlanStep,
  UtilityReadRequest,
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

export type DelegationSkipCategory =
  | "actionable-miss"
  | "intentional-retain"
  | "unsafe-reject";

export type DelegationOperation =
  | "directory-list"
  | "focused-check"
  | "git-diff"
  | "git-inspect"
  | "git-status"
  | "large-read"
  | "line-count"
  | "read-plan"
  | "scoped-search"
  | "source-slice"
  | "tool-use";

export interface DelegationTelemetryEvent {
  agent: Agent;
  at: string;
  category?: DelegationSkipCategory;
  disposition: DelegationDisposition;
  fingerprint: string;
  operation: DelegationOperation | UtilityRequestKind;
  reason: string;
  source: "bridge" | "claude-hook" | "codex-app-server" | "codex-hook";
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
const MAX_WORKSPACE_HINT_PREFIX = 1024;
const MAX_PATTERN_LENGTH = 256;
const MAX_SCOPES = 4;
const MAX_LINE_COUNT_FILES = 8;
const MAX_READ_PLAN_SCOPES = 12;
const MAX_READ_PLAN_STEPS = 8;
const MAX_READ_PLAN_LABEL_STAGES = 6;
const MAX_READ_PLAN_TOTAL_STAGES = 14;
const LARGE_READ_MIN_LINES = 200;
const MAX_SOURCE_SLICE_LINES = 500;
const SHELL_META = new Set([";", "&", "|", "`", "$", "<", ">", "(", ")"]);
const LEADING_CURRENT_DIR_RE = /^\.\//;
const TRAILING_SLASH_RE = /\/$/;
const GLOB_META_RE = /[?*[\]{}]/;
const WHITESPACE_RE = /\s/;
const SOURCE_SLICE_RE = /^(\d+),(\d+)p$/;
const AWK_PREFIX_SLICE_RE = /^NR\s*<=\s*(\d+)$/;
const AWK_RANGE_SLICE_RE = /^NR\s*>=\s*(\d+)\s*&&\s*NR\s*<=\s*(\d+)$/;
const REGEX_META_RE = /[\\.^$|?*+()[\]{}]/;
const PRESENTATION_LITERAL_META_RE = /[\\.^$?*+()[\]{}]/;
const DIGITS_RE = /^\d+$/;
const FILTER_COUNT_FLAG_RE = /^-\d+$/;
const GREP_COMMAND_FLAGS_RE = /^-[Finr]+$/;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const GIT_BRANCH_PATTERN_RE = /^[A-Za-z0-9._/*?-]{1,128}$/;
const EXECUTION_PROFILE_BY_OPERATION: Partial<
  Record<DelegationOperation, UtilityExecutionProfile>
> = {
  "directory-list": "file-list",
  "focused-check": "focused-check",
  "git-diff": "git-diff",
  "git-inspect": "git-inspect",
  "git-status": "git-status",
  "large-read": "file-read",
  "read-plan": "read-plan",
  "scoped-search": "search",
  "source-slice": "file-read",
};
const STDERR_TO_NULL = ">/dev/null";
const STDERR_TO_STDOUT = ">&1";
const STDERR_BOUNDARY_RE = /[;&|\s]/;
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
const physicalResolve = (
  startAbs: string,
  rejectWithin?: string
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: auditable path walker
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

const isExistingRegularFile = (target: string): boolean => {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
};

const isExistingNonDirectory = (target: string): boolean => {
  try {
    return !statSync(target).isDirectory();
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

const withExecutionPlan = (
  classified: EligibleDelegationIntent,
  executionPlan: UtilityReadPlanStep[]
): EligibleDelegationIntent => ({
  ...classified,
  request: { ...classified.request, executionPlan },
});

const withExecutionGit = (
  classified: EligibleDelegationIntent,
  executionGit: UtilityGitInspectionRequest
): EligibleDelegationIntent => ({
  ...classified,
  request: { ...classified.request, executionGit },
});

const readPlanStep = (
  executionProfile: UtilityReadPlanStep["executionProfile"],
  objective: string,
  readScope: string[],
  executionRead?: UtilityReadRequest,
  executionOutput?: UtilityOutputRequest
): UtilityReadPlanStep => ({
  executionProfile,
  objective,
  readScope,
  ...(executionRead ? { executionRead } : {}),
  ...(executionOutput ? { executionOutput } : {}),
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
  if (
    requested > MAX_SOURCE_SLICE_LINES ||
    !Number.isSafeInteger(offset + requested - 1)
  ) {
    return { eligible: false, ...exempt(intent, "large-read-out-of-bounds") };
  }
  const classified = request(
    intent,
    "large-read",
    "inspect",
    `Inspect ${scope} starting at line ${offset} for up to ${requested} lines and return only the evidence needed by the requester.`,
    [`Return a concise finding with exact line references from ${scope}.`],
    [scope],
    ["inspect"]
  );
  return {
    eligible: true,
    ...classified,
    request: {
      ...classified.request,
      executionRead: {
        endLine: offset + requested - 1,
        path: scope,
        startLine: offset,
      },
    },
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
  | { kind: "sequence" }
  | { kind: "merge-stderr" }
  | { kind: "quiet-stderr" };

// A literal shell-token scanner is intentionally explicit: every state branch
// is a safety boundary and collapsing it would make quoting rules harder to
// audit. Only a single `|`, `&&`, `;`, trailing-token `2>/dev/null`, and
// trailing-token `2>&1` are recognized. The classifier still has to prove the
// resulting structure is broker-satisfiable; every other operator fails closed.
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
    if (quote === undefined && char === ";") {
      push();
      tokens.push({ kind: "sequence" });
      continue;
    }
    if (
      quote === undefined &&
      char === ">" &&
      token === "2" &&
      !tokenQuoted &&
      command.startsWith(STDERR_TO_STDOUT, index) &&
      (index + STDERR_TO_STDOUT.length === command.length ||
        STDERR_BOUNDARY_RE.test(
          command[index + STDERR_TO_STDOUT.length] as string
        ))
    ) {
      token = "";
      tokenQuoted = false;
      tokens.push({ kind: "merge-stderr" });
      index += STDERR_TO_STDOUT.length - 1;
      continue;
    }
    if (
      quote === undefined &&
      char === ">" &&
      token === "2" &&
      !tokenQuoted &&
      command.startsWith(STDERR_TO_NULL, index) &&
      (index + STDERR_TO_NULL.length === command.length ||
        STDERR_BOUNDARY_RE.test(
          command[index + STDERR_TO_NULL.length] as string
        ))
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
  kind: "and" | "pipe" | "sequence"
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

interface ReadStageTokens {
  segments: ShellToken[][];
  separators: Array<"and" | "sequence">;
}

const splitReadStageTokens = (tokens: ShellToken[]): ReadStageTokens => {
  const segments: ShellToken[][] = [[]];
  const separators: ReadStageTokens["separators"] = [];
  for (const token of tokens) {
    if (token.kind === "and" || token.kind === "sequence") {
      separators.push(token.kind);
      segments.push([]);
    } else {
      segments.at(-1)?.push(token);
    }
  }
  return { segments, separators };
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
  return count >= 1 && count <= MAX_SOURCE_SLICE_LINES
    ? { cmd: name, count }
    : undefined;
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
  excludeLines?: string[];
  filter?: OutputFilter;
  includeLines?: string[];
  stderr?: "merge" | "omit";
  stripAnsi?: boolean;
}

const literalPresentationAlternatives = (
  pattern: string
): string[] | undefined => {
  const alternatives = pattern.split("|");
  if (
    alternatives.length < 1 ||
    alternatives.length > 16 ||
    alternatives.some(
      (part) =>
        part.length < 1 ||
        part.length > 80 ||
        PRESENTATION_LITERAL_META_RE.test(part)
    )
  ) {
    return undefined;
  }
  return alternatives;
};

const parsePresentationGrep = (
  tokens: ShellToken[]
): Pick<SafeCompound, "excludeLines" | "includeLines"> | undefined => {
  const words = wordValues(tokens);
  if (!words || words[0] !== "grep") {
    return undefined;
  }
  let index = 1;
  let exclude = false;
  if (words[index]?.startsWith("-")) {
    const flags = (words[index] as string).slice(1);
    if (!flags || [...flags].some((flag) => !["E", "a", "v"].includes(flag))) {
      return undefined;
    }
    exclude = flags.includes("v");
    index += 1;
  }
  if (words.length !== index + 1) {
    return undefined;
  }
  const alternatives = literalPresentationAlternatives(words[index] ?? "");
  if (!alternatives) {
    return undefined;
  }
  return exclude
    ? { excludeLines: alternatives }
    : { includeLines: alternatives };
};

const isAnsiStripSed = (tokens: ShellToken[]): boolean => {
  const words = wordValues(tokens);
  if (!words || words[0] !== "sed") {
    return false;
  }
  const expression = words[1] === "-e" ? words[2] : words[1];
  const expectedLength = words[1] === "-e" ? 3 : 2;
  return (
    words.length === expectedLength &&
    (expression === "s/\\x1b\\[[0-9;]*m//g" ||
      expression === "s/\\x1B\\[[0-9;]*m//g")
  );
};

const splitCompoundCwd = (
  tokens: ShellToken[]
): { cdTarget?: string; rest: ShellToken[] } | undefined => {
  const chained = splitTokens(tokens, "and");
  if (chained.length === 1) {
    return { rest: chained[0] ?? [] };
  }
  if (chained.length !== 2) {
    return undefined;
  }
  const lead = wordValues(chained[0] ?? []);
  const cdTarget = lead?.[1];
  if (
    lead?.length !== 2 ||
    lead[0] !== "cd" ||
    !cdTarget ||
    cdTarget.startsWith("-") ||
    GLOB_META_RE.test(cdTarget)
  ) {
    return undefined;
  }
  return { cdTarget, rest: chained[1] ?? [] };
};

const parsePresentationPipeline = (
  stages: ShellToken[][]
): Omit<SafeCompound, "argv" | "cdTarget" | "stderr"> | undefined => {
  const presentation: Omit<SafeCompound, "argv" | "cdTarget" | "stderr"> = {};
  for (const [offset, stage] of stages.entries()) {
    const terminal = offset === stages.length - 1;
    const parsedFilter = parseOutputFilter(stage);
    const parsedGrep = parsePresentationGrep(stage);
    const passthrough = wordValues(stage);
    if (parsedFilter && terminal && !presentation.filter) {
      presentation.filter = parsedFilter;
    } else if (
      passthrough?.length === 1 &&
      passthrough[0] === "cat" &&
      terminal
    ) {
      // `cat` is an explicit no-op often used to force stream consumption.
    } else if (isAnsiStripSed(stage) && !presentation.stripAnsi) {
      presentation.stripAnsi = true;
    } else if (
      parsedGrep?.includeLines &&
      !presentation.includeLines &&
      !presentation.excludeLines
    ) {
      presentation.includeLines = parsedGrep.includeLines;
    } else if (
      parsedGrep?.excludeLines &&
      !presentation.excludeLines &&
      !presentation.includeLines
    ) {
      presentation.excludeLines = parsedGrep.excludeLines;
    } else {
      return undefined;
    }
  }
  return presentation;
};

// Structural parse of `[cd <path> &&] base [2>/dev/null]` followed by at
// most three bounded presentation stages. The presentation pipeline is
// persisted as broker metadata and never handed to a shell.
const decomposeSafeCompound = (
  tokens: ShellToken[]
): SafeCompound | undefined => {
  const scoped = splitCompoundCwd(tokens);
  if (!scoped) {
    return undefined;
  }
  const piped = splitTokens(scoped.rest, "pipe");
  if (piped.length > 4) {
    return undefined;
  }
  const presentation = parsePresentationPipeline(piped.slice(1));
  if (!presentation) {
    return undefined;
  }
  let base = piped[0] ?? [];
  const stderrToken = base.at(-1)?.kind;
  let stderr: SafeCompound["stderr"];
  if (stderrToken === "quiet-stderr" || stderrToken === "merge-stderr") {
    base = base.slice(0, -1);
    stderr = stderrToken === "merge-stderr" ? "merge" : "omit";
  }
  const argv = wordValues(base);
  if (!argv || argv.length === 0) {
    return undefined;
  }
  return {
    argv,
    ...presentation,
    ...(scoped.cdTarget === undefined ? {} : { cdTarget: scoped.cdTarget }),
    ...(stderr ? { stderr } : {}),
  };
};

const literalCdTarget = (tokens: ShellToken[]): string | undefined => {
  const lead = wordValues(tokens);
  if (
    !lead ||
    lead.length !== 2 ||
    lead[0] !== "cd" ||
    !lead[1] ||
    lead[1].startsWith("-") ||
    GLOB_META_RE.test(lead[1])
  ) {
    return undefined;
  }
  return lead[1];
};

const literalLeadingCdTarget = (tokens: ShellToken[]): string | undefined => {
  const stages = splitReadStageTokens(tokens);
  return stages.separators[0] === "and"
    ? literalCdTarget(stages.segments[0] ?? [])
    : undefined;
};

// Workspace recovery must not require the command remainder to be supported.
// Scan only through the first unquoted `&&`, then run the normal literal lexer
// over that prefix. This recovers a workspace hint for later authoritative Git
// worktree verification without granting any execution authority to the rest.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: auditable quote-aware prefix scanner
const literalLeadingCdPrefixTarget = (command: string): string | undefined => {
  if (!command) {
    return undefined;
  }
  let quote: "single" | "double" | undefined;
  let escaped = false;
  const scanLength = Math.min(command.length, MAX_WORKSPACE_HINT_PREFIX);
  for (let index = 0; index < scanLength; index += 1) {
    const char = command[index] as string;
    if (char === "\0" || char === "\n" || char === "\r") {
      return undefined;
    }
    if (escaped) {
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
    if (quote === undefined && char === "&" && command[index + 1] === "&") {
      const prefix = literalTokens(command.slice(0, index));
      return prefix ? literalCdTarget(prefix) : undefined;
    }
  }
  return undefined;
};

const isShellDelegationTool = (toolName: string): boolean =>
  toolName === "Bash" ||
  toolName === "shell_command" ||
  toolName === "exec_command";

export const delegationExecutionCwd = (
  cwd: string,
  toolName: string,
  toolInput: unknown
): string | undefined => {
  if (!isShellDelegationTool(toolName)) {
    return cwd;
  }
  const input = isRecord(toolInput) ? toolInput : {};
  const workdir = asString(input.workdir);
  if (!workdir) {
    return cwd;
  }
  if (
    workdir.includes("\0") ||
    workdir.includes("\n") ||
    workdir.includes("\r") ||
    GLOB_META_RE.test(workdir)
  ) {
    return undefined;
  }
  return resolve(cwd, workdir);
};

export const delegationWorkspaceHint = (
  cwd: string,
  toolName: string,
  toolInput: unknown
): string | undefined => {
  if (!isShellDelegationTool(toolName)) {
    return undefined;
  }
  const input = isRecord(toolInput) ? toolInput : {};
  const executionCwd = delegationExecutionCwd(cwd, toolName, toolInput);
  if (!executionCwd) {
    return undefined;
  }
  const command = asString(input.command);
  const target = command ? literalLeadingCdPrefixTarget(command) : undefined;
  if (target) {
    return resolve(executionCwd, target);
  }
  return executionCwd === resolve(cwd) ? undefined : executionCwd;
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

interface GitInspectionQuery extends UtilityGitInspectionRequest {
  outputBound?: string;
}

const executableGitInspection = (
  query: GitInspectionQuery
): UtilityGitInspectionRequest => {
  const { outputBound: _outputBound, ...executionGit } = query;
  return executionGit;
};

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
  return oneline && limit && limit <= 50
    ? { action: "log", limit, ...(ref ? { ref } : {}) }
    : undefined;
};

const parseGitInspection = (
  argv: readonly string[]
): GitInspectionQuery | undefined => {
  if (argv[0] !== "git") {
    return undefined;
  }
  if (
    argv[1] === "branch" &&
    argv[2] === "--show-current" &&
    argv.length === 3
  ) {
    return { action: "current-branch" };
  }
  if (argv[1] === "worktree" && argv[2] === "list" && argv.length === 3) {
    return { action: "worktree-list" };
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
      ...withExecutionGit(
        request(
          intent,
          "git-inspect",
          "inspect",
          `Inspect repository metadata for this exact bounded query: ${JSON.stringify(inspection)}.`,
          [
            "Return the requested Git metadata without changing the repository.",
          ],
          ["."],
          ["inspect"]
        ),
        executableGitInspection(inspection)
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

const classifyFocusedCheck = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  const normalizedArgv = [...argv];
  let pathStart: number | undefined;
  let requiredPathCount: number | undefined;
  if (normalizedArgv[0] === "bun" && normalizedArgv[1] === "test") {
    pathStart = 2;
  } else if (
    normalizedArgv[0] === "npx" &&
    normalizedArgv[1] === "vitest" &&
    normalizedArgv[2] === "run"
  ) {
    pathStart = 3;
  } else if (normalizedArgv[0] === "node" && normalizedArgv[1] === "--check") {
    pathStart = 2;
    requiredPathCount = 1;
  } else {
    return undefined;
  }
  const requestedPaths = normalizedArgv.slice(pathStart);
  if (requestedPaths.length < 1) {
    return undefined;
  }
  if (
    requestedPaths.length > MAX_SCOPES ||
    (requiredPathCount !== undefined &&
      requestedPaths.length !== requiredPathCount) ||
    requestedPaths.some((path) => path.startsWith("-"))
  ) {
    return {
      eligible: false,
      ...exempt(intent, "focused-check-not-bounded"),
    };
  }
  const executionCwd = safeScope(
    intent.repoRoot,
    intent.repoRoot,
    intent.cwd,
    true
  );
  if (!executionCwd) {
    return {
      eligible: false,
      ...exempt(intent, "focused-check-without-safe-cwd"),
    };
  }
  const cwdPath =
    executionCwd === "."
      ? intent.repoRoot
      : join(intent.repoRoot, executionCwd);
  if (isExistingNonDirectory(cwdPath)) {
    return {
      eligible: false,
      ...exempt(intent, "focused-check-cwd-not-directory"),
    };
  }
  const testScopes = requestedPaths.map((path) =>
    safeScope(intent.repoRoot, intent.cwd, path, false, true)
  );
  if (testScopes.some((scope) => !scope)) {
    return {
      eligible: false,
      ...exempt(intent, "focused-check-without-safe-files"),
    };
  }
  const scopes = [executionCwd, ...(testScopes as string[])];
  const executionArgv = [
    ...normalizedArgv.slice(0, pathStart),
    ...(testScopes as string[]),
  ];
  const classified = request(
    intent,
    "focused-check",
    "command",
    `Run this exact focused local check as literal argv ${JSON.stringify(executionArgv)} from ${executionCwd}; invoke run_check once with that exact argv and cwd.`,
    [
      "Return the exact focused check exit status and a concise bounded failure summary without changing files.",
    ],
    scopes,
    ["bounded-command", "focused-verify"]
  );
  return {
    eligible: true,
    ...classified,
    request: {
      ...classified.request,
      executionArgv,
      executionCwd,
    },
  };
};

const classifyLineCount = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  if (argv[0] !== "wc") {
    return undefined;
  }
  if (argv[1] !== "-l") {
    return {
      eligible: false,
      ...exempt(intent, "command-not-in-delegation-grammar"),
    };
  }
  const requestedPaths = argv.slice(2);
  if (
    requestedPaths.length < 1 ||
    requestedPaths.length > MAX_LINE_COUNT_FILES ||
    requestedPaths.some((path) => path.startsWith("-"))
  ) {
    return {
      eligible: false,
      ...exempt(intent, "line-count-not-bounded"),
    };
  }
  const scopes = requestedPaths.map((path) =>
    safeScope(intent.repoRoot, intent.cwd, path, false, true)
  );
  if (scopes.some((scope) => !scope)) {
    return {
      eligible: false,
      ...exempt(intent, "line-count-without-safe-files"),
    };
  }
  const safeScopes = scopes as string[];
  if (
    safeScopes.some(
      (scope) => !isExistingRegularFile(join(intent.repoRoot, scope))
    )
  ) {
    return {
      eligible: false,
      ...exempt(intent, "line-count-target-not-file"),
    };
  }
  return {
    eligible: true,
    ...request(
      intent,
      "line-count",
      "inspect",
      `Count newline characters in these exact files using one count_lines call: ${JSON.stringify(safeScopes)}. Do not invoke run_check.`,
      [
        "Return one exact wc -l-compatible count per file without file contents.",
      ],
      safeScopes,
      ["inspect"]
    ),
  };
};

const classifyDirectoryList = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  if (argv[0] !== "ls") {
    return undefined;
  }
  const args = argv.slice(1);
  let includeHidden = false;
  if (args[0]?.startsWith("-")) {
    if (!["-a", "-l", "-la", "-al"].includes(args[0])) {
      return {
        eligible: false,
        ...exempt(intent, "unsupported-list-option"),
      };
    }
    includeHidden = args[0].includes("a");
    args.shift();
  }
  if (args.length > MAX_SCOPES || args.some((value) => value.startsWith("-"))) {
    return {
      eligible: false,
      ...exempt(intent, "directory-list-not-bounded"),
    };
  }
  const scopes = (args.length > 0 ? args : ["."]).map((value) =>
    safeScope(intent.repoRoot, intent.cwd, value, true)
  );
  if (scopes.some((scope) => !scope)) {
    return {
      eligible: false,
      ...exempt(intent, "directory-list-without-safe-scope"),
    };
  }
  const safeScopes = scopes as string[];
  if (
    safeScopes.some((scope) =>
      isExistingNonDirectory(
        scope === "." ? intent.repoRoot : join(intent.repoRoot, scope)
      )
    )
  ) {
    return {
      eligible: false,
      ...exempt(intent, "directory-list-target-not-directory"),
    };
  }
  const multiple = safeScopes.length > 1;
  const objective = multiple
    ? `List each directory in ${JSON.stringify(safeScopes)} once without recursion using list_files with includeHidden=${includeHidden}.`
    : `List the single directory ${safeScopes[0]} without recursion using list_files with includeHidden=${includeHidden}.`;
  const classified = request(
    intent,
    multiple ? "read-plan" : "directory-list",
    "inspect",
    objective,
    [
      "Return bounded nonrecursive listings in order without following symlinks.",
    ],
    safeScopes,
    ["inspect"]
  );
  return {
    eligible: true,
    ...(multiple
      ? withExecutionPlan(
          classified,
          safeScopes.map((scope) =>
            readPlanStep("file-list", objective, [scope])
          )
        )
      : classified),
  };
};

const classifyCatCommand = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  if (argv[0] !== "cat") {
    return undefined;
  }
  const args = argv.slice(1);
  if (args[0] === "-n") {
    args.shift();
  }
  if (
    args.length < 1 ||
    args.length > MAX_SCOPES ||
    args.some((value) => value.startsWith("-"))
  ) {
    return { eligible: false, ...exempt(intent, "file-read-not-bounded") };
  }
  const scopes = args.map((value) =>
    safeScope(intent.repoRoot, intent.cwd, value, false, true)
  );
  if (scopes.some((scope) => !scope)) {
    return {
      eligible: false,
      ...exempt(intent, "governed-or-unsafe-path"),
    };
  }
  const safeScopes = scopes as string[];
  const objective = `Read each file in ${JSON.stringify(safeScopes)} in order using bounded read_file calls${argv[1] === "-n" ? " and retain line references" : ""}.`;
  const classified = request(
    intent,
    "read-plan",
    "inspect",
    objective,
    ["Return only bounded file evidence without changing files."],
    safeScopes,
    ["inspect"]
  );
  return {
    eligible: true,
    ...withExecutionPlan(
      classified,
      safeScopes.map((scope) => readPlanStep("file-read", objective, [scope]))
    ),
  };
};

const escapeRegexLiteral = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GNU/BSD basic grep commonly spells alternation as `\|`. Accept only a
// bounded list of literal alternatives, with optional whole-line anchors, and
// translate it to the JavaScript regex used by search_repo. Every other regex
// feature remains reasoning/native-only so this never becomes a general regex
// grammar hidden behind grep.
const basicLiteralAlternation = (pattern: string): string | undefined => {
  if (!pattern.includes("\\|")) {
    return undefined;
  }
  const alternatives = pattern.split("\\|");
  if (
    alternatives.length < 2 ||
    alternatives.length > 16 ||
    alternatives.some((alternative) => alternative.length === 0)
  ) {
    return undefined;
  }
  const translated: string[] = [];
  for (const alternative of alternatives) {
    const anchoredStart = alternative.startsWith("^");
    const anchoredEnd = alternative.endsWith("$");
    const start = anchoredStart ? 1 : 0;
    const end = anchoredEnd ? -1 : undefined;
    const body = alternative.slice(start, end);
    if (!body || body.includes("\\") || body.length > 80) {
      return undefined;
    }
    translated.push(
      `${anchoredStart ? "^" : ""}${escapeRegexLiteral(body)}${anchoredEnd ? "$" : ""}`
    );
  }
  return `(?:${translated.join("|")})`;
};

interface GrepFlags {
  caseSensitive: boolean;
  fixed: boolean;
  index: number;
  lineNumbers: boolean;
}

const parseGrepFlags = (argv: string[]): GrepFlags | undefined => {
  let index = 1;
  let fixed = false;
  let caseSensitive = true;
  let lineNumbers = false;
  while (index < argv.length && argv[index]?.startsWith("-")) {
    const flag = argv[index] as string;
    if (flag === "--") {
      index += 1;
      break;
    }
    const longFlag = {
      "--fixed-strings": "F",
      "--ignore-case": "i",
      "--line-number": "n",
      "--recursive": "r",
    }[flag];
    if (!(longFlag || GREP_COMMAND_FLAGS_RE.test(flag))) {
      return undefined;
    }
    fixed ||= (longFlag ?? flag).includes("F");
    lineNumbers ||= (longFlag ?? flag).includes("n");
    caseSensitive &&= !(longFlag ?? flag).includes("i");
    index += 1;
  }
  return { caseSensitive, fixed, index, lineNumbers };
};

const classifyGrepCommand = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  if (argv[0] !== "grep") {
    return undefined;
  }
  const flags = parseGrepFlags(argv);
  if (!flags) {
    return {
      eligible: false,
      ...exempt(intent, "unsupported-grep-option"),
    };
  }
  const { caseSensitive, fixed, index, lineNumbers } = flags;
  const pattern = argv[index];
  const pathArgs = argv.slice(index + 1);
  if (pathArgs.some((value) => value.startsWith("-"))) {
    return {
      eligible: false,
      ...exempt(intent, "unsupported-grep-option"),
    };
  }
  if (pattern === "" && lineNumbers && pathArgs.length === 1) {
    const scope = safeScope(
      intent.repoRoot,
      intent.cwd,
      pathArgs[0] as string,
      false,
      true
    );
    if (!scope) {
      return {
        eligible: false,
        ...exempt(intent, "governed-or-unsafe-path"),
      };
    }
    const objective = `Read ${scope} with bounded read_file calls and retain exact line references.`;
    return {
      eligible: true,
      ...withExecutionPlan(
        request(
          intent,
          "read-plan",
          "inspect",
          objective,
          [`Return bounded line-referenced evidence from ${scope}.`],
          [scope],
          ["inspect"]
        ),
        [readPlanStep("file-read", objective, [scope])]
      ),
    };
  }
  const boundedAlternation =
    !fixed && pattern ? basicLiteralAlternation(pattern) : undefined;
  if (
    !pattern ||
    pattern.length > MAX_PATTERN_LENGTH ||
    SECRET_VALUE.test(pattern) ||
    (!fixed && REGEX_META_RE.test(pattern) && !boundedAlternation)
  ) {
    return {
      eligible: false,
      ...exempt(intent, "grep-pattern-not-literal"),
    };
  }
  const scopes = scopesFrom(intent, pathArgs);
  if (!scopes) {
    return {
      eligible: false,
      ...exempt(intent, "search-without-safe-scope"),
    };
  }
  const searchPattern = boundedAlternation ?? pattern;
  const regex = boundedAlternation !== undefined;
  return {
    eligible: true,
    ...request(
      intent,
      "scoped-search",
      "inspect",
      `Search for the ${regex ? "bounded literal-alternation regex" : "literal string"} ${JSON.stringify(searchPattern)} under ${JSON.stringify(scopes)} using search_repo with regex=${regex} and caseSensitive=${caseSensitive}.`,
      [
        "Return matching paths and exact line references without changing files.",
      ],
      scopes,
      ["inspect"]
    ),
  };
};

interface SourceSliceQuery {
  end: number;
  file: string;
  start: number;
  tail: boolean;
}

const parseSedOrHeadSlice = (argv: string[]): SourceSliceQuery | undefined => {
  if (argv[0] === "sed" && argv[1] === "-n" && argv.length === 4) {
    const match = SOURCE_SLICE_RE.exec(argv[2] ?? "");
    if (match) {
      return {
        end: Number(match[2]),
        file: argv[3] as string,
        start: Number(match[1]),
        tail: false,
      };
    }
  }
  if (
    argv[0] === "head" &&
    argv[1] === "-n" &&
    argv.length === 4 &&
    DIGITS_RE.test(argv[2] ?? "")
  ) {
    return {
      end: Number(argv[2]),
      file: argv[3] as string,
      start: 1,
      tail: false,
    };
  }
  if (
    argv[0] === "head" &&
    argv.length === 3 &&
    FILTER_COUNT_FLAG_RE.test(argv[1] ?? "")
  ) {
    return {
      end: Number((argv[1] as string).slice(1)),
      file: argv[2] as string,
      start: 1,
      tail: false,
    };
  }
  return undefined;
};

const parseAwkSlice = (argv: string[]): SourceSliceQuery | undefined => {
  if (argv[0] !== "awk" || argv.length !== 3) {
    return undefined;
  }
  const prefix = AWK_PREFIX_SLICE_RE.exec(argv[1] ?? "");
  if (prefix) {
    return {
      end: Number(prefix[1]),
      file: argv[2] as string,
      start: 1,
      tail: false,
    };
  }
  const range = AWK_RANGE_SLICE_RE.exec(argv[1] ?? "");
  return range
    ? {
        end: Number(range[2]),
        file: argv[2] as string,
        start: Number(range[1]),
        tail: false,
      }
    : undefined;
};

const parseTailSlice = (argv: string[]): SourceSliceQuery | undefined => {
  let count: number | undefined;
  let file: string | undefined;
  if (
    argv[0] === "tail" &&
    argv[1] === "-n" &&
    argv.length === 4 &&
    DIGITS_RE.test(argv[2] ?? "")
  ) {
    count = Number(argv[2]);
    file = argv[3];
  } else if (
    argv[0] === "tail" &&
    argv.length === 3 &&
    FILTER_COUNT_FLAG_RE.test(argv[1] ?? "")
  ) {
    count = Number(argv[1].slice(1));
    file = argv[2];
  }
  return count !== undefined && file
    ? { end: count, file, start: 1, tail: true }
    : undefined;
};

const classifySourceSlice = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined => {
  const query =
    parseSedOrHeadSlice(argv) ?? parseAwkSlice(argv) ?? parseTailSlice(argv);
  if (!query) {
    return undefined;
  }
  if (
    query.start < 1 ||
    query.end < query.start ||
    query.end - query.start + 1 > MAX_SOURCE_SLICE_LINES
  ) {
    return { eligible: false, ...exempt(intent, "source-slice-out-of-bounds") };
  }
  const scope = safeScope(intent.repoRoot, intent.cwd, query.file, false, true);
  if (!scope) {
    return { eligible: false, ...exempt(intent, "governed-or-unsafe-path") };
  }
  const classified = request(
    intent,
    "source-slice",
    "inspect",
    query.tail
      ? `Inspect the last ${query.end} lines of ${scope} using read_file with lastLines=${query.end} and return concise relevant evidence.`
      : `Inspect ${scope} for the requested bounded source slice (${query.start}-${query.end}) and return concise relevant evidence.`,
    [`Return exact line references from ${scope} without changing files.`],
    [scope],
    ["inspect"]
  );
  return {
    eligible: true,
    ...classified,
    request: {
      ...classified.request,
      executionRead: query.tail
        ? { lastLines: query.end, path: scope }
        : { endLine: query.end, path: scope, startLine: query.start },
    },
  };
};

const withCompoundOutputBoundary = (
  classified: EligibleDelegationIntent & { eligible: true },
  compound: SafeCompound
): DelegationClassification => {
  if (
    !(
      compound.excludeLines ||
      compound.filter ||
      compound.includeLines ||
      compound.stderr ||
      compound.stripAnsi
    )
  ) {
    return classified;
  }
  const bound = compound.filter
    ? describeOutputFilter(compound.filter)
    : undefined;
  return {
    ...classified,
    request: {
      ...classified.request,
      executionOutput: {
        ...(compound.excludeLines
          ? { excludeLines: compound.excludeLines }
          : {}),
        ...(compound.filter
          ? {
              lineLimit: compound.filter.count ?? 10,
              position: compound.filter.cmd,
            }
          : {}),
        ...(compound.includeLines
          ? { includeLines: compound.includeLines }
          : {}),
        ...(compound.stderr ? { stderr: compound.stderr } : {}),
        ...(compound.stripAnsi ? { stripAnsi: true } : {}),
      },
      ...(bound
        ? {
            objective: `${classified.request.objective} Limit the returned evidence to the ${bound}.`,
            acceptanceCriteria: [
              ...classified.request.acceptanceCriteria,
              `Bound the returned evidence to the ${bound}.`,
            ],
          }
        : {}),
    },
  };
};

const READ_PLAN_PROFILES = new Set<UtilityExecutionProfile>([
  "file-list",
  "file-read",
  "focused-check",
  "git-diff",
  "git-inspect",
  "git-status",
  "read-plan",
  "search",
]);

const classifyReadOnlyArgv = (
  intent: DelegationToolIntent,
  argv: string[]
): DelegationClassification | undefined =>
  classifyGit(intent, argv) ??
  classifyRg(intent, argv) ??
  classifyGrepCommand(intent, argv) ??
  classifyDirectoryList(intent, argv) ??
  classifyCatCommand(intent, argv) ??
  classifySourceSlice(intent, argv) ??
  classifyLineCount(intent, argv) ??
  classifyFocusedCheck(intent, argv);

const isLiteralEchoLabel = (tokens: ShellToken[]): boolean => {
  const words = wordValues(tokens);
  if (!(words?.[0] === "echo" && words.length <= 12)) {
    return false;
  }
  const label = words.slice(1);
  return (
    !label.some(
      (word) =>
        (word.startsWith("-") && !word.startsWith("---")) ||
        word.includes("$") ||
        word.includes("`")
    ) && label.join(" ").length <= 160
  );
};

interface ClassifiedReadPlanSegment {
  classification: EligibleDelegationIntent;
  steps: UtilityReadPlanStep[];
}

const classifyReadPlanSegment = (
  intent: DelegationToolIntent,
  segment: ShellToken[]
): ClassifiedReadPlanSegment | undefined => {
  const compound = decomposeSafeCompound(segment);
  if (!compound || compound.cdTarget) {
    return undefined;
  }
  const classified = classifyReadOnlyArgv(intent, compound.argv);
  if (!classified?.eligible) {
    return undefined;
  }
  const bounded = withCompoundOutputBoundary(classified, compound);
  if (!bounded.eligible) {
    return undefined;
  }
  const executionProfile = bounded.request.executionProfile;
  if (!(executionProfile && READ_PLAN_PROFILES.has(executionProfile))) {
    return undefined;
  }
  if (executionProfile === "read-plan") {
    if (
      compound.excludeLines ||
      compound.filter ||
      compound.includeLines ||
      compound.stderr ||
      compound.stripAnsi ||
      !bounded.request.executionPlan?.length
    ) {
      return undefined;
    }
    return {
      classification: bounded,
      steps: bounded.request.executionPlan,
    };
  }
  return {
    classification: bounded,
    steps: [
      {
        ...readPlanStep(
          executionProfile,
          bounded.request.objective,
          bounded.request.readScope,
          bounded.request.executionRead,
          bounded.request.executionOutput
        ),
        ...(bounded.request.executionArgv
          ? { executionArgv: [...bounded.request.executionArgv] }
          : {}),
        ...(bounded.request.executionCwd
          ? { executionCwd: bounded.request.executionCwd }
          : {}),
        ...(bounded.request.executionGit
          ? { executionGit: { ...bounded.request.executionGit } }
          : {}),
      },
    ],
  };
};

const classifyReadPlanSegments = (
  intent: DelegationToolIntent,
  segments: ShellToken[][]
):
  | {
      classifications: EligibleDelegationIntent[];
      executionPlan: UtilityReadPlanStep[];
    }
  | undefined => {
  const classifications: EligibleDelegationIntent[] = [];
  const executionPlan: UtilityReadPlanStep[] = [];
  let labelStages = 0;
  for (const segment of segments) {
    if (isLiteralEchoLabel(segment)) {
      labelStages += 1;
      if (labelStages > MAX_READ_PLAN_LABEL_STAGES) {
        return undefined;
      }
      continue;
    }
    const classified = classifyReadPlanSegment(intent, segment);
    if (!classified) {
      return undefined;
    }
    executionPlan.push(...classified.steps);
    classifications.push(classified.classification);
  }
  return { classifications, executionPlan };
};

const readPlanIntentAtCwd = (
  intent: DelegationToolIntent,
  cdTarget: string | undefined
): DelegationToolIntent | undefined => {
  if (!cdTarget) {
    return intent;
  }
  const rel = safeScope(intent.repoRoot, intent.cwd, cdTarget, true);
  if (!rel) {
    return undefined;
  }
  return {
    ...intent,
    cwd:
      rel === "."
        ? resolve(intent.repoRoot)
        : join(resolve(intent.repoRoot), rel),
  };
};

const classifyReadPlan = (
  intent: DelegationToolIntent,
  tokens: ShellToken[]
): DelegationClassification | undefined => {
  const stages = splitReadStageTokens(tokens);
  const cdTarget = literalLeadingCdTarget(tokens);
  const segments = cdTarget ? stages.segments.slice(1) : stages.segments;
  if (segments.length < 2 || segments.length > MAX_READ_PLAN_TOTAL_STAGES) {
    return undefined;
  }
  const scoped = readPlanIntentAtCwd(intent, cdTarget);
  if (!scoped) {
    return undefined;
  }
  const classified = classifyReadPlanSegments(scoped, segments);
  if (!classified) {
    return undefined;
  }
  const classifiedStages = classified.classifications;
  const { executionPlan } = classified;
  const scopes = [
    ...new Set(classifiedStages.flatMap((stage) => stage.request.readScope)),
  ];
  if (
    classifiedStages.length < 1 ||
    classifiedStages.length > MAX_READ_PLAN_STEPS ||
    executionPlan.length < 1 ||
    executionPlan.length > MAX_READ_PLAN_SCOPES ||
    scopes.length < 1 ||
    scopes.length > MAX_READ_PLAN_SCOPES
  ) {
    return undefined;
  }
  const includesFocusedCheck = executionPlan.some(
    (step) => step.executionProfile === "focused-check"
  );
  return {
    eligible: true,
    ...withExecutionPlan(
      request(
        intent,
        "read-plan",
        includesFocusedCheck ? "command" : "inspect",
        `Execute these ${classifiedStages.length} bounded ${includesFocusedCheck ? "inspection/check" : "read-only inspection"} stages in order using only their stage-scoped broker tools: ${JSON.stringify(classifiedStages.map((stage) => stage.request.objective))}.`,
        [
          `Return concise evidence for every stage in order without changing files${includesFocusedCheck ? "; run only the exact declared focused checks" : " or invoking commands"}.`,
        ],
        scopes,
        includesFocusedCheck
          ? ["inspect", "bounded-command", "focused-verify"]
          : ["inspect"]
      ),
      executionPlan
    ),
  };
};

const classifyBash = (
  intent: DelegationToolIntent,
  input: Record<string, unknown>
): DelegationClassification => {
  const command = asString(input.command);
  const tokens = command ? literalTokens(command) : undefined;
  const readPlan = tokens ? classifyReadPlan(intent, tokens) : undefined;
  if (readPlan) {
    return readPlan;
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
  const focusedCheck = classifyFocusedCheck(scoped, argv);
  if (!focusedCheck && (argv[0]?.includes("/") || argv[0]?.includes("\\"))) {
    return {
      eligible: false,
      ...exempt(intent, "executable-path-not-allowed"),
    };
  }
  const classified = focusedCheck ??
    classifyReadOnlyArgv(scoped, argv) ?? {
      eligible: false,
      ...exempt(scoped, "command-not-in-delegation-grammar"),
    };
  if (!classified.eligible) {
    return classified;
  }
  // Persist output semantics for broker enforcement instead of trusting the
  // worker model to reproduce a shell pipeline or stderr redirect.
  return withCompoundOutputBoundary(classified, compound);
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
  if (
    intent.toolName === "Bash" ||
    intent.toolName === "shell_command" ||
    intent.toolName === "exec_command"
  ) {
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

const INTENTIONAL_RETAIN_REASONS = new Set([
  "authority-needs-human",
  "review-needs-peer",
  "review-stays-with-requester",
  "risk-not-low",
  "small-context-read",
  "tool-not-enforceable",
  "unsupported-kind",
  "write-conflict",
]);
const ACTIONABLE_MISS_REASONS = new Set([
  "capability-unavailable",
  "command-not-in-delegation-grammar",
  "directory-list-not-bounded",
  "missing-governess-epoch",
  "routing-policy-invalid",
  "utility-unavailable",
]);

export const delegationSkipCategory = (
  disposition: DelegationDisposition,
  reason: string
): DelegationSkipCategory => {
  if (
    disposition === "missed-candidate" ||
    disposition === "observed-candidate" ||
    disposition === "route-failed" ||
    ACTIONABLE_MISS_REASONS.has(reason)
  ) {
    return "actionable-miss";
  }
  return INTENTIONAL_RETAIN_REASONS.has(reason)
    ? "intentional-retain"
    : "unsafe-reject";
};

export const makeDelegationEvent = (
  input: Omit<DelegationTelemetryEvent, "at">,
  at = new Date().toISOString()
): DelegationTelemetryEvent => ({
  ...input,
  ...(!input.category &&
  [
    "missed-candidate",
    "observed-candidate",
    "route-failed",
    "skipped-candidate",
  ].includes(input.disposition)
    ? { category: delegationSkipCategory(input.disposition, input.reason) }
    : {}),
  at,
});

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
