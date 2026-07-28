/**
 * `loop ledger` — per-loop outcome rollup.
 *
 * Answers the question the loop has never been able to answer without forensic
 * reconstruction: what did each chartered loop cost, and what did it produce?
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildLedgerRecord,
  readLedgerRecord,
  writeLedgerRecord,
} from "./ledger-record";
import {
  isOutcomeClass,
  type LedgerRecord,
  OUTCOME_CLASSES,
  type OutcomeClass,
} from "./ledger-types";
import {
  buildManifestPath,
  readRunManifest,
  resolveRepoId,
  resolveStorageRoot,
} from "./run-state";

export const LEDGER_SUBCOMMAND = "ledger";

const RUN_INDEX_RE = /^\d+$/;
const MS_PER_HOUR = 3_600_000;
const USD_PAD = 10;

export interface LedgerCliOptions {
  backfill: boolean;
  classify?: { outcomeClass: OutcomeClass; runId: string };
  json: boolean;
  repoId?: string;
}

const usage = (): string =>
  [
    "Usage: loop ledger [--repo <repoId>] [--json] [--backfill]",
    "       loop ledger --classify <runId> <outcome-class>",
    `outcome classes: ${OUTCOME_CLASSES.join(", ")}`,
  ].join("\n");

export const parseLedgerArgs = (argv: string[]): LedgerCliOptions => {
  const options: LedgerCliOptions = { backfill: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--backfill") {
      options.backfill = true;
    } else if (arg === "--repo") {
      i += 1;
      options.repoId = argv[i];
    } else if (arg === "--classify") {
      const runId = argv[i + 1];
      const cls = argv[i + 2];
      if (!(runId && cls && isOutcomeClass(cls))) {
        throw new Error(usage());
      }
      options.classify = { outcomeClass: cls, runId };
      i += 2;
    } else {
      throw new Error(usage());
    }
  }
  return options;
};

const listRunIds = (repoDir: string): string[] => {
  if (!existsSync(repoDir)) {
    return [];
  }
  try {
    return readdirSync(repoDir)
      .filter((name) => RUN_INDEX_RE.test(name))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  } catch {
    return [];
  }
};

/**
 * Rebuilds records for historical runs from their manifests. Git stats are
 * skipped when the run's worktree no longer exists, so a backfilled record is
 * cost-complete but may be commit-blind; that is recorded honestly rather than
 * guessed.
 */
export const backfillRepo = (repoDir: string): LedgerRecord[] => {
  const written: LedgerRecord[] = [];
  for (const runId of listRunIds(repoDir)) {
    const runDir = join(repoDir, runId);
    if (readLedgerRecord(runDir)) {
      continue;
    }
    const manifest = readRunManifest(buildManifestPath(runDir));
    if (!manifest) {
      continue;
    }
    const sessionIds = [
      manifest.claudeSessionId,
      manifest.codexThreadId,
    ].filter((id) => id.length > 0);
    const worktreeGone = !existsSync(manifest.cwd);
    const record = buildLedgerRecord(
      {
        createdAt: manifest.createdAt,
        cwd: manifest.cwd,
        endedAt: manifest.updatedAt,
        finalState: manifest.state,
        repoId: manifest.repoId,
        runId: manifest.runId,
        sessionIds,
      },
      worktreeGone ? { collectGit: () => emptyGit(), collectPrs: () => [] } : {}
    );
    writeLedgerRecord(runDir, record);
    written.push(record);
  }
  return written;
};

const emptyGit = () => ({
  commits: 0,
  deletions: 0,
  docsCommits: 0,
  filesChanged: 0,
  insertions: 0,
});

export const loadRepoRecords = (repoDir: string): LedgerRecord[] => {
  const records: LedgerRecord[] = [];
  for (const runId of listRunIds(repoDir)) {
    const record = readLedgerRecord(join(repoDir, runId));
    if (record) {
      records.push(record);
    }
  }
  return records;
};

export interface LedgerRollup {
  byOutcome: Record<string, { count: number; usd: number }>;
  directUsd: number;
  docsCommits: number;
  records: LedgerRecord[];
  totalCommits: number;
  totalHours: number;
  unclassified: number;
  windowedUsd: number;
}

export const summarize = (records: LedgerRecord[]): LedgerRollup => {
  const byOutcome: Record<string, { count: number; usd: number }> = {};
  let directUsd = 0;
  let windowedUsd = 0;
  let totalCommits = 0;
  let docsCommits = 0;
  let totalMs = 0;
  for (const record of records) {
    const usd = (record.cost.direct.usd ?? 0) + (record.cost.windowed.usd ?? 0);
    const entry = byOutcome[record.outcomeClass] ?? { count: 0, usd: 0 };
    entry.count += 1;
    entry.usd += usd;
    byOutcome[record.outcomeClass] = entry;
    directUsd += record.cost.direct.usd ?? 0;
    windowedUsd += record.cost.windowed.usd ?? 0;
    totalCommits += record.git.commits;
    docsCommits += record.git.docsCommits;
    totalMs += record.durationMs;
  }
  return {
    byOutcome,
    directUsd,
    docsCommits,
    records,
    totalCommits,
    totalHours: totalMs / MS_PER_HOUR,
    unclassified: byOutcome.unclassified?.count ?? 0,
    windowedUsd,
  };
};

const money = (value: number): string => `$${value.toFixed(2)}`;

export const formatRollup = (rollup: LedgerRollup): string => {
  const lines: string[] = [];
  lines.push(
    `run  outcome           commits  docs  ${"direct".padStart(USD_PAD)}  ${"windowed".padStart(USD_PAD)}`
  );
  for (const record of rollup.records) {
    const direct = record.cost.direct.usd;
    const windowed = record.cost.windowed.usd;
    lines.push(
      [
        record.runId.padStart(3),
        record.outcomeClass.padEnd(17),
        String(record.git.commits).padStart(7),
        String(record.git.docsCommits).padStart(5),
        (direct === undefined ? "n/a" : money(direct)).padStart(USD_PAD),
        (windowed === undefined ? "n/a" : money(windowed)).padStart(USD_PAD),
      ].join(" ")
    );
  }
  lines.push("");
  lines.push(
    `${rollup.records.length} runs | ${rollup.totalCommits} commits (${rollup.docsCommits} docs-only) | ${rollup.totalHours.toFixed(1)}h`
  );
  lines.push(
    `direct ${money(rollup.directUsd)} + windowed ${money(rollup.windowedUsd)} = ${money(rollup.directUsd + rollup.windowedUsd)}`
  );
  for (const [cls, entry] of Object.entries(rollup.byOutcome).sort()) {
    lines.push(`  ${cls.padEnd(17)} ${entry.count} runs  ${money(entry.usd)}`);
  }
  if (rollup.unclassified > 0) {
    lines.push(
      `\n${rollup.unclassified} run(s) unclassified — declare with: loop ledger --classify <runId> <class>`
    );
  }
  return lines.join("\n");
};

const classifyRun = (
  repoDir: string,
  runId: string,
  outcomeClass: OutcomeClass
): boolean => {
  const runDir = join(repoDir, runId);
  const record = readLedgerRecord(runDir);
  if (!record) {
    return false;
  }
  writeLedgerRecord(runDir, {
    ...record,
    outcomeClass,
    outcomeClassSource: "declared",
  });
  return true;
};

export const runLedgerCommand = (
  argv: string[],
  cwd: string = process.cwd(),
  home: string = homedir()
): number => {
  const options = parseLedgerArgs(argv);
  const repoId = options.repoId ?? resolveRepoId(cwd);
  const repoDir = join(resolveStorageRoot(home), repoId);
  if (!existsSync(repoDir)) {
    console.error(`[loop] no run history for repo ${repoId}`);
    return 1;
  }
  if (options.classify) {
    const ok = classifyRun(
      repoDir,
      options.classify.runId,
      options.classify.outcomeClass
    );
    if (!ok) {
      console.error(
        `[loop] no outcome record for run ${options.classify.runId}; run 'loop ledger --backfill' first`
      );
      return 1;
    }
    console.log(
      `[loop] run ${options.classify.runId} classified ${options.classify.outcomeClass}`
    );
    return 0;
  }
  if (options.backfill) {
    const written = backfillRepo(repoDir);
    console.log(`[loop] backfilled ${written.length} outcome record(s)`);
  }
  const rollup = summarize(loadRepoRecords(repoDir));
  if (rollup.records.length === 0) {
    console.error(
      `[loop] no outcome records for ${repoId}; run 'loop ledger --backfill'`
    );
    return 1;
  }
  console.log(
    options.json ? JSON.stringify(rollup, null, 2) : formatRollup(rollup)
  );
  return 0;
};
