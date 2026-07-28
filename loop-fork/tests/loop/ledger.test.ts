import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backfillRepo,
  formatRollup,
  loadRepoRecords,
  parseLedgerArgs,
  summarize,
} from "../../src/loop/ledger";
import { readLedgerRecord } from "../../src/loop/ledger-record";
import type { LedgerRecord } from "../../src/loop/ledger-types";
import { isOutcomeClass } from "../../src/loop/ledger-types";

const record = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  charter: {},
  cost: {
    basis: "usage-tracker-catalog",
    direct: {
      scope: "direct",
      sessions: 1,
      tokens: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        total: 0,
      },
      usd: 10,
    },
    unpricedModels: [],
    windowed: {
      scope: "windowed",
      sessions: 2,
      tokens: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        total: 0,
      },
      usd: 5,
    },
  },
  createdAt: "2026-07-27T00:00:00.000Z",
  cwd: "/tmp/x",
  durationMs: 3_600_000,
  endedAt: "2026-07-27T01:00:00.000Z",
  finalState: "completed",
  git: {
    commits: 4,
    deletions: 0,
    docsCommits: 2,
    filesChanged: 3,
    insertions: 10,
  },
  outcomeClass: "unclassified",
  outcomeClassSource: "auto",
  prs: [],
  repoId: "harvto-b1e274e66299",
  runId: "1",
  schemaVersion: 1,
  startedAt: "2026-07-27T00:00:00.000Z",
  ...over,
});

describe("parseLedgerArgs", () => {
  test("parses flags", () => {
    const opts = parseLedgerArgs(["--json", "--backfill", "--repo", "abc"]);
    expect(opts.json).toBe(true);
    expect(opts.backfill).toBe(true);
    expect(opts.repoId).toBe("abc");
  });

  test("parses a classify request", () => {
    const opts = parseLedgerArgs(["--classify", "56", "landed"]);
    expect(opts.classify).toEqual({ outcomeClass: "landed", runId: "56" });
  });

  test("rejects an unknown outcome class", () => {
    expect(() => parseLedgerArgs(["--classify", "56", "shipped"])).toThrow();
  });

  test("rejects unknown flags", () => {
    expect(() => parseLedgerArgs(["--wat"])).toThrow();
  });
});

describe("isOutcomeClass", () => {
  test("accepts known classes and rejects others", () => {
    expect(isOutcomeClass("evidence-stopped")).toBe(true);
    expect(isOutcomeClass("nope")).toBe(false);
  });
});

describe("summarize", () => {
  test("keeps direct and windowed spend separate", () => {
    const rollup = summarize([record(), record({ runId: "2" })]);
    expect(rollup.directUsd).toBe(20);
    expect(rollup.windowedUsd).toBe(10);
    expect(rollup.totalCommits).toBe(8);
    expect(rollup.docsCommits).toBe(4);
    expect(rollup.totalHours).toBe(2);
  });

  test("groups spend by outcome class", () => {
    const rollup = summarize([
      record({ outcomeClass: "landed" }),
      record({ outcomeClass: "refuted", runId: "2" }),
      record({ outcomeClass: "refuted", runId: "3" }),
    ]);
    expect(rollup.byOutcome.refuted?.count).toBe(2);
    expect(rollup.byOutcome.refuted?.usd).toBe(30);
    expect(rollup.unclassified).toBe(0);
  });

  test("handles an empty set", () => {
    const rollup = summarize([]);
    expect(rollup.records).toHaveLength(0);
    expect(rollup.directUsd).toBe(0);
  });
});

describe("formatRollup", () => {
  test("renders n/a when cost is unavailable", () => {
    const bare = record();
    bare.cost.direct.usd = undefined;
    bare.cost.windowed.usd = undefined;
    const text = formatRollup(summarize([bare]));
    expect(text).toContain("n/a");
  });

  test("prompts for classification when runs are unclassified", () => {
    const text = formatRollup(summarize([record()]));
    expect(text).toContain("--classify");
  });
});

const writeManifest = (
  repoDir: string,
  runId: string,
  over: Record<string, unknown> = {}
): void => {
  const runDir = join(repoDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      claudeSessionId: "",
      codexThreadId: "",
      createdAt: "2026-07-27T00:00:00.000Z",
      cwd: "/tmp/definitely-not-here",
      mode: "paired",
      pid: 1,
      repoId: "harvto-b1e274e66299",
      runId,
      state: "completed",
      status: "done",
      updatedAt: "2026-07-27T01:00:00.000Z",
      ...over,
    })
  );
};

describe("backfillRepo", () => {
  test("creates records from historical manifests", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ledger-repo-"));
    writeManifest(repoDir, "1");
    writeManifest(repoDir, "2");
    const written = backfillRepo(repoDir);
    expect(written).toHaveLength(2);
    expect(readLedgerRecord(join(repoDir, "1"))?.runId).toBe("1");
    expect(loadRepoRecords(repoDir)).toHaveLength(2);
  });

  test("is idempotent and does not overwrite existing records", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ledger-repo-"));
    writeManifest(repoDir, "1");
    backfillRepo(repoDir);
    expect(backfillRepo(repoDir)).toHaveLength(0);
  });

  test("skips run dirs without a manifest", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ledger-repo-"));
    mkdirSync(join(repoDir, "9"), { recursive: true });
    expect(backfillRepo(repoDir)).toHaveLength(0);
  });

  test("records zero commits when the worktree is gone", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ledger-repo-"));
    writeManifest(repoDir, "1");
    const [written] = backfillRepo(repoDir);
    expect(written?.git.commits).toBe(0);
    expect(written?.outcomeClass).toBe("abandoned");
  });
});
