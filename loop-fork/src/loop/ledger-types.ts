/**
 * Per-loop outcome ("ROI") record types.
 *
 * The loop already records COST-shaped operational state in `manifest.json`.
 * It records no OUTCOME state at all, which is why loop ROI has previously had
 * to be reconstructed forensically. These types define the missing half.
 */

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_FILE = "outcome.json";

/**
 * How a chartered loop actually ended.
 *
 * Deliberately NOT inferred from commit count alone: a loop that produces only
 * documentation commits has not "landed" anything, and treating it as landed is
 * the exact measurement error this record exists to prevent.
 */
export type OutcomeClass =
  | "abandoned"
  | "evidence-stopped"
  | "landed"
  | "refuted"
  | "unclassified";

export const OUTCOME_CLASSES: readonly OutcomeClass[] = [
  "abandoned",
  "evidence-stopped",
  "landed",
  "refuted",
  "unclassified",
];

export const isOutcomeClass = (value: string): value is OutcomeClass =>
  (OUTCOME_CLASSES as readonly string[]).includes(value);

/** Whether the class was declared by a human/agent or guessed by the tool. */
export type OutcomeClassSource = "auto" | "declared";

/**
 * Charters live in `~/.loop/prompts/*.md`, outside git and unversioned. We pin
 * the path plus a content hash so a later edit to the charter is detectable
 * rather than silently rewriting history.
 */
export interface LedgerCharter {
  path?: string;
  sha256?: string;
  title?: string;
}

export interface LedgerGit {
  branch?: string;
  commits: number;
  deletions: number;
  docsCommits: number;
  filesChanged: number;
  headSha?: string;
  insertions: number;
}

/** Token totals for one attribution scope. */
export interface LedgerTokens {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

/**
 * `direct` = sessions named in the run manifest (the two driver sessions).
 * `windowed` = sessions in the same repo that began inside the run window but
 * are not named by any manifest (subagents, utility workers). Windowed is a
 * heuristic and is always reported separately, never silently merged.
 */
export type LedgerCostScope = "direct" | "windowed";

export interface LedgerCostBucket {
  scope: LedgerCostScope;
  sessions: number;
  tokens: LedgerTokens;
  /** Omitted entirely when pricing is unavailable — never defaulted to 0. */
  usd?: number;
}

/**
 * `readonly` is a normal locking read. `immutable` is a no-lock read used when
 * a plain read-only open fails, which it does against a live WAL database with
 * no shared-memory file. Immutable reads cannot disturb the writer but can
 * observe a torn snapshot, so the mode is recorded rather than hidden.
 */
export type LedgerReadMode = "immutable" | "readonly";

export interface LedgerCost {
  /** How usd was derived, or why it is absent. */
  basis:
    | "unavailable-no-catalog"
    | "unavailable-no-database"
    | "unavailable-query-failed"
    | "usage-tracker-catalog";
  catalogPath?: string;
  direct: LedgerCostBucket;
  readMode?: LedgerReadMode;
  /** Model buckets carrying tokens that no catalog rate covered. */
  unpricedModels: string[];
  windowed: LedgerCostBucket;
}

export interface LedgerRecord {
  charter: LedgerCharter;
  cost: LedgerCost;
  createdAt: string;
  cwd: string;
  durationMs: number;
  endedAt: string;
  finalState: string;
  git: LedgerGit;
  goal?: string;
  /** Which customer-facing milestone this loop served, if declared. */
  milestone?: string;
  outcomeClass: OutcomeClass;
  outcomeClassSource: OutcomeClassSource;
  prs: number[];
  repoId: string;
  runId: string;
  schemaVersion: number;
  startedAt: string;
}
