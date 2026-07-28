/**
 * Builds the per-loop outcome record written at wind-down.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runGit as runGitCommand } from "./git";
import type { ActivityReader, PricingCatalog } from "./ledger-cost";
import {
  buildCostBucket,
  openActivityDb,
  readPricingCatalog,
  unavailableCost,
} from "./ledger-cost";
import {
  LEDGER_FILE,
  LEDGER_SCHEMA_VERSION,
  type LedgerCharter,
  type LedgerCost,
  type LedgerGit,
  type LedgerRecord,
  type OutcomeClass,
  type OutcomeClassSource,
} from "./ledger-types";

const US_PER_MS = 1000;
const DOCS_PATH_RE = /^(docs\/|.*\.md$|specs\/)/;
const CHARTER_TITLE_RE = /^#\s+(.+)$/m;
const REPO_ID_HASH_RE = /-[0-9a-f]{12}$/;
const PR_REF_RE = /#(\d{1,6})\b/g;
const MAX_PR_NUMBER = 999_999;

export const promptsDir = (home = homedir()): string =>
  join(home, ".loop", "prompts");

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Charters are stored as `~/.loop/prompts/<label>-loop<runId>.md` by
 * convention, but nothing in the manifest records which file was used. We match
 * on that convention and hash the contents so later edits are detectable.
 */
export const findCharter = (
  repoId: string,
  runId: string,
  home = homedir()
): LedgerCharter => {
  const dir = promptsDir(home);
  if (!existsSync(dir)) {
    return {};
  }
  const label = repoId.replace(REPO_ID_HASH_RE, "");
  const wanted = `${label}-loop${runId}`;
  let match: string | undefined;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const stem = name.slice(0, -3);
      if (stem === wanted || stem.startsWith(`${wanted}-`)) {
        match = name;
        break;
      }
    }
  } catch {
    return {};
  }
  if (!match) {
    return {};
  }
  const path = join(dir, match);
  try {
    const text = readFileSync(path, "utf8");
    return {
      path,
      sha256: sha256(text),
      title: CHARTER_TITLE_RE.exec(text)?.[1]?.trim(),
    };
  } catch {
    return { path };
  }
};

type GitRunner = (args: string[]) => { exitCode: number; stdout: string };

const gitLines = (git: GitRunner, args: string[]): string[] => {
  const result = git(args);
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.split("\n").filter((line) => line.trim().length > 0);
};

const gitValue = (git: GitRunner, args: string[]): string | undefined => {
  const result = git(args);
  return result.exitCode === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
};

const countDocsCommits = (git: GitRunner, range: string): number => {
  let docs = 0;
  for (const sha of gitLines(git, ["rev-list", range])) {
    const files = gitLines(git, [
      "show",
      "--pretty=format:",
      "--name-only",
      sha,
    ]);
    if (files.length > 0 && files.every((f) => DOCS_PATH_RE.test(f))) {
      docs += 1;
    }
  }
  return docs;
};

const DELETIONS_RE = /(\d+) deletion/;
const FILES_CHANGED_RE = /(\d+) files? changed/;
const INSERTIONS_RE = /(\d+) insertion/;

const parseShortstat = (
  text: string | undefined
): { deletions: number; filesChanged: number; insertions: number } => {
  const grab = (re: RegExp): number => {
    const m = text ? re.exec(text) : null;
    return m ? Number.parseInt(m[1] as string, 10) : 0;
  };
  return {
    deletions: grab(DELETIONS_RE),
    filesChanged: grab(FILES_CHANGED_RE),
    insertions: grab(INSERTIONS_RE),
  };
};

/**
 * Commit/diff stats for the run, measured against the base branch. Returns
 * zeroes rather than throwing when the worktree is already gone.
 */
export const collectGitStats = (
  cwd: string,
  baseBranch = "main",
  runGit: GitRunner = (args) => runGitCommand(cwd, args, "ignore")
): LedgerGit => {
  const branch = gitValue(runGit, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headSha = gitValue(runGit, ["rev-parse", "HEAD"]);
  const range = `${baseBranch}..HEAD`;
  const commits = gitLines(runGit, ["rev-list", range]).length;
  const stat = parseShortstat(
    gitValue(runGit, ["diff", "--shortstat", `${baseBranch}...HEAD`])
  );
  return {
    ...(branch ? { branch } : {}),
    commits,
    deletions: stat.deletions,
    docsCommits: commits > 0 ? countDocsCommits(runGit, range) : 0,
    filesChanged: stat.filesChanged,
    ...(headSha ? { headSha } : {}),
    insertions: stat.insertions,
  };
};

export const collectPrNumbers = (
  cwd: string,
  baseBranch = "main",
  runGit: GitRunner = (args) => runGitCommand(cwd, args, "ignore")
): number[] => {
  const found = new Set<number>();
  for (const subject of gitLines(runGit, [
    "log",
    "--pretty=format:%s",
    `${baseBranch}..HEAD`,
  ])) {
    for (const match of subject.matchAll(PR_REF_RE)) {
      const value = Number.parseInt(match[1] as string, 10);
      if (Number.isInteger(value) && value > 0 && value <= MAX_PR_NUMBER) {
        found.add(value);
      }
    }
  }
  return [...found].sort((a, b) => a - b);
};

/**
 * Conservative auto-classification.
 *
 * This never returns "landed". Whether work landed in a way that served a
 * customer is a judgement the tool cannot make from git history — inferring it
 * from commit counts is precisely how 47%-documentation output got recorded as
 * progress. Auto only distinguishes "produced nothing" from "needs a human
 * call"; "landed", "refuted" and "evidence-stopped" must be declared.
 */
export const autoOutcomeClass = (
  finalState: string,
  git: LedgerGit
): OutcomeClass => {
  if (finalState === "failed") {
    return "abandoned";
  }
  if (git.commits === 0) {
    return "abandoned";
  }
  return "unclassified";
};

export interface BuildLedgerInput {
  createdAt: string;
  cwd: string;
  endedAt?: string;
  finalState: string;
  milestone?: string;
  outcomeClass?: OutcomeClass;
  repoId: string;
  runId: string;
  sessionIds: string[];
}

export interface LedgerCostDeps {
  catalog?: PricingCatalog;
  /** Overrides the activity.db location; mainly for tests. */
  dbPath?: string;
  reader?: ActivityReader;
}

const toMicros = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms * US_PER_MS : 0;
};

/**
 * Attributes cost in two explicitly separated scopes. `direct` covers the
 * sessions the manifest names. `windowed` covers sessions that started inside
 * the run window under the same working directory but are named nowhere —
 * subagents and utility workers. Windowed is a heuristic and stays separate.
 */
export const buildCost = (
  input: BuildLedgerInput,
  deps: LedgerCostDeps = {}
): LedgerCost => {
  const reader = deps.reader ?? openActivityDb(deps.dbPath);
  if (!reader) {
    return unavailableCost("unavailable-no-database");
  }
  const catalog = deps.catalog ?? readPricingCatalog();
  try {
    const directRows = reader.usageForSessions(input.sessionIds);
    const startUs = toMicros(input.createdAt);
    const endUs = toMicros(input.endedAt ?? new Date().toISOString());
    const named = new Set(input.sessionIds);
    const windowIds = reader
      .sessionsInWindow(startUs, endUs, [input.cwd])
      ?.filter((id) => !named.has(id));
    const windowRows = windowIds
      ? reader.usageForSessions(windowIds)
      : undefined;
    // A failed query is not a zero-cost run. Refuse to report either.
    if (!(directRows && windowIds && windowRows)) {
      return {
        ...unavailableCost("unavailable-query-failed"),
        readMode: reader.readMode,
      };
    }
    const direct = buildCostBucket(
      "direct",
      input.sessionIds.length,
      directRows,
      catalog
    );
    const windowed = buildCostBucket(
      "windowed",
      windowIds.length,
      windowRows,
      catalog
    );
    return {
      basis: catalog ? "usage-tracker-catalog" : "unavailable-no-catalog",
      ...(catalog ? { catalogPath: catalog.path } : {}),
      direct: direct.bucket,
      readMode: reader.readMode,
      unpricedModels: [
        ...new Set([...direct.unpricedModels, ...windowed.unpricedModels]),
      ].sort(),
      windowed: windowed.bucket,
    };
  } finally {
    if (!deps.reader) {
      reader.close();
    }
  }
};

export interface BuildLedgerDeps extends LedgerCostDeps {
  collectGit?: (cwd: string) => LedgerGit;
  collectPrs?: (cwd: string) => number[];
  home?: string;
}

export const buildLedgerRecord = (
  input: BuildLedgerInput,
  deps: BuildLedgerDeps = {}
): LedgerRecord => {
  const endedAt = input.endedAt ?? new Date().toISOString();
  const git = (deps.collectGit ?? ((cwd: string) => collectGitStats(cwd)))(
    input.cwd
  );
  const prs = (deps.collectPrs ?? ((cwd: string) => collectPrNumbers(cwd)))(
    input.cwd
  );
  const charter = findCharter(
    input.repoId,
    input.runId,
    deps.home ?? homedir()
  );
  const declared = input.outcomeClass;
  const outcomeClass = declared ?? autoOutcomeClass(input.finalState, git);
  const outcomeClassSource: OutcomeClassSource = declared ? "declared" : "auto";
  const startMs = Date.parse(input.createdAt);
  const endMs = Date.parse(endedAt);
  return {
    charter,
    cost: buildCost({ ...input, endedAt }, deps),
    createdAt: input.createdAt,
    cwd: input.cwd,
    durationMs:
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
        ? endMs - startMs
        : 0,
    endedAt,
    finalState: input.finalState,
    git,
    ...(charter.title ? { goal: charter.title } : {}),
    ...(input.milestone ? { milestone: input.milestone } : {}),
    outcomeClass,
    outcomeClassSource,
    prs,
    repoId: input.repoId,
    runId: input.runId,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    startedAt: input.createdAt,
  };
};

export const ledgerPath = (runDir: string): string => join(runDir, LEDGER_FILE);

export const writeLedgerRecord = (
  runDir: string,
  record: LedgerRecord
): void => {
  writeFileSync(
    ledgerPath(runDir),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
};

export const readLedgerRecord = (runDir: string): LedgerRecord | undefined => {
  const path = ledgerPath(runDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LedgerRecord;
    return typeof parsed?.runId === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
};
