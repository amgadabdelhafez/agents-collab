import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityReader, ModelUsageRow } from "../../src/loop/ledger-cost";
import {
  autoOutcomeClass,
  buildCost,
  buildLedgerRecord,
  collectGitStats,
  collectPrNumbers,
  findCharter,
  readLedgerRecord,
  writeLedgerRecord,
} from "../../src/loop/ledger-record";
import type { LedgerGit } from "../../src/loop/ledger-types";

const git = (over: Partial<LedgerGit> = {}): LedgerGit => ({
  commits: 0,
  deletions: 0,
  docsCommits: 0,
  filesChanged: 0,
  insertions: 0,
  ...over,
});

const fakeGitRunner =
  (responses: Record<string, string>) => (args: string[]) => {
    const key = args.join(" ");
    const stdout = responses[key];
    return stdout === undefined
      ? { exitCode: 1, stdout: "" }
      : { exitCode: 0, stdout };
  };

describe("autoOutcomeClass", () => {
  test("never auto-declares landed even with many commits", () => {
    // Landing is a human judgement; inferring it from commits is the exact
    // measurement error this record exists to prevent.
    expect(autoOutcomeClass("completed", git({ commits: 40 }))).toBe(
      "unclassified"
    );
  });

  test("marks a run with no commits as abandoned", () => {
    expect(autoOutcomeClass("stopped", git())).toBe("abandoned");
  });

  test("marks a failed run as abandoned", () => {
    expect(autoOutcomeClass("failed", git({ commits: 5 }))).toBe("abandoned");
  });
});

describe("collectGitStats", () => {
  test("parses commits, shortstat and docs-only commits", () => {
    const runner = fakeGitRunner({
      "rev-parse --abbrev-ref HEAD": "loop56/base",
      "rev-parse HEAD": "abc123",
      "rev-list main..HEAD": "sha1\nsha2",
      "diff --shortstat main...HEAD":
        " 7 files changed, 120 insertions(+), 30 deletions(-)",
      "show --pretty=format: --name-only sha1": "docs/a.md\nREADME.md",
      "show --pretty=format: --name-only sha2": "src/app.ts",
    });
    const stats = collectGitStats("/tmp/x", "main", runner);
    expect(stats.commits).toBe(2);
    expect(stats.docsCommits).toBe(1);
    expect(stats.filesChanged).toBe(7);
    expect(stats.insertions).toBe(120);
    expect(stats.deletions).toBe(30);
    expect(stats.branch).toBe("loop56/base");
  });

  test("returns zeroes when git fails (worktree removed)", () => {
    const stats = collectGitStats("/tmp/gone", "main", fakeGitRunner({}));
    expect(stats.commits).toBe(0);
    expect(stats.branch).toBeUndefined();
  });
});

describe("collectPrNumbers", () => {
  test("extracts unique sorted pr refs from commit subjects", () => {
    const runner = fakeGitRunner({
      "log --pretty=format:%s main..HEAD":
        "feat: thing (#12)\nfix: other (#7)\nchore: dup (#12)",
    });
    expect(collectPrNumbers("/tmp/x", "main", runner)).toEqual([7, 12]);
  });

  test("returns an empty list when there are no refs", () => {
    const runner = fakeGitRunner({
      "log --pretty=format:%s main..HEAD": "feat: no refs here",
    });
    expect(collectPrNumbers("/tmp/x", "main", runner)).toEqual([]);
  });
});

describe("findCharter", () => {
  test("matches the charter by repo label and run id and hashes it", () => {
    const home = mkdtempSync(join(tmpdir(), "ledger-home-"));
    const dir = join(home, ".loop", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "harvto-loop56.md"), "# Ship the AR try-on\nbody");
    const charter = findCharter("harvto-b1e274e66299", "56", home);
    expect(charter.title).toBe("Ship the AR try-on");
    expect(charter.sha256).toHaveLength(64);
  });

  test("matches suffixed charters such as workorder variants", () => {
    const home = mkdtempSync(join(tmpdir(), "ledger-home-"));
    const dir = join(home, ".loop", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "harvto-loop31-workorder-2.md"), "# Replay\n");
    expect(findCharter("harvto-abc123456789", "31", home).title).toBe("Replay");
  });

  test("returns empty when no charter exists", () => {
    const home = mkdtempSync(join(tmpdir(), "ledger-home-"));
    expect(findCharter("harvto-abc123456789", "99", home)).toEqual({});
  });
});

const reader = (
  direct: ModelUsageRow[],
  windowIds: string[],
  windowRows: ModelUsageRow[]
): ActivityReader => ({
  close: () => undefined,
  readMode: "readonly",
  sessionsInWindow: () => windowIds,
  usageForSessions: (ids) => (ids.includes("claude-1") ? direct : windowRows),
});

const failingReader = (): ActivityReader => ({
  close: () => undefined,
  readMode: "immutable",
  sessionsInWindow: () => undefined,
  usageForSessions: () => undefined,
});

const usageRow = (over: Partial<ModelUsageRow> = {}): ModelUsageRow => ({
  cacheRead: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  input: 0,
  model: "claude-opus-5",
  output: 0,
  provider: "claude",
  reasoning: 0,
  ...over,
});

describe("buildCost", () => {
  const input = {
    createdAt: "2026-07-27T00:00:00.000Z",
    cwd: "/Users/amgad/harvto",
    endedAt: "2026-07-27T02:00:00.000Z",
    finalState: "completed",
    repoId: "harvto-b1e274e66299",
    runId: "56",
    sessionIds: ["claude-1"],
  };

  test("separates manifest-named sessions from windowed subagent sessions", () => {
    const cost = buildCost(input, {
      reader: reader(
        [usageRow({ input: 1000 })],
        ["sub-a", "sub-b"],
        [usageRow({ input: 500 })]
      ),
    });
    expect(cost.direct.sessions).toBe(1);
    expect(cost.direct.tokens.input).toBe(1000);
    expect(cost.windowed.sessions).toBe(2);
    expect(cost.windowed.tokens.input).toBe(500);
  });

  test("excludes manifest sessions from the windowed bucket", () => {
    const cost = buildCost(input, {
      reader: reader([usageRow()], ["claude-1"], [usageRow()]),
    });
    expect(cost.windowed.sessions).toBe(0);
  });

  test("reports missing database without fabricating cost", () => {
    const cost = buildCost(input, { dbPath: "/nope/no-activity.db" });
    expect(cost.basis).toBe("unavailable-no-database");
    expect(cost.direct.usd).toBeUndefined();
    expect(cost.direct.tokens.total).toBe(0);
  });

  test("refuses to report zero cost when the query fails", () => {
    // A failed sqlite read must never look like a free run.
    const cost = buildCost(input, { reader: failingReader() });
    expect(cost.basis).toBe("unavailable-query-failed");
    expect(cost.direct.usd).toBeUndefined();
    expect(cost.readMode).toBe("immutable");
  });

  test("records which read mode was used", () => {
    const cost = buildCost(input, { reader: reader([], [], []) });
    expect(cost.readMode).toBe("readonly");
  });

  test("omits usd but keeps tokens when the catalog is missing", () => {
    const cost = buildCost(input, {
      catalog: undefined,
      reader: reader([usageRow({ input: 42 })], [], []),
    });
    // A reader with no catalog must still report token volume.
    expect(cost.direct.tokens.input).toBe(42);
  });
});

describe("buildLedgerRecord", () => {
  test("builds a record and round-trips it through disk", () => {
    const home = mkdtempSync(join(tmpdir(), "ledger-home-"));
    const runDir = mkdtempSync(join(tmpdir(), "ledger-run-"));
    const record = buildLedgerRecord(
      {
        createdAt: "2026-07-27T00:00:00.000Z",
        cwd: "/tmp/x",
        endedAt: "2026-07-27T02:00:00.000Z",
        finalState: "completed",
        repoId: "harvto-b1e274e66299",
        runId: "56",
        sessionIds: [],
      },
      {
        collectGit: () => git({ commits: 3, docsCommits: 3 }),
        collectPrs: () => [42],
        home,
        reader: reader([], [], []),
      }
    );
    expect(record.durationMs).toBe(7_200_000);
    expect(record.outcomeClass).toBe("unclassified");
    expect(record.outcomeClassSource).toBe("auto");
    expect(record.prs).toEqual([42]);
    writeLedgerRecord(runDir, record);
    expect(readLedgerRecord(runDir)?.runId).toBe("56");
  });

  test("honours a declared outcome class", () => {
    const home = mkdtempSync(join(tmpdir(), "ledger-home-"));
    const record = buildLedgerRecord(
      {
        createdAt: "2026-07-27T00:00:00.000Z",
        cwd: "/tmp/x",
        finalState: "stopped",
        milestone: "ar-tryon-public",
        outcomeClass: "refuted",
        repoId: "r-abc123456789",
        runId: "1",
        sessionIds: [],
      },
      {
        collectGit: () => git(),
        collectPrs: () => [],
        home,
        reader: reader([], [], []),
      }
    );
    expect(record.outcomeClass).toBe("refuted");
    expect(record.outcomeClassSource).toBe("declared");
    expect(record.milestone).toBe("ar-tryon-public");
  });

  test("returns undefined for a run dir with no record", () => {
    expect(
      readLedgerRecord(mkdtempSync(join(tmpdir(), "empty-")))
    ).toBeUndefined();
  });
});
