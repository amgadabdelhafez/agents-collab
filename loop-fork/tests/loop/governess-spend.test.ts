import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSpendJournal,
  burnUsdPerHour,
  evaluateSpend,
  readBillableSpendUsd,
  recordSpendSample,
  resolveSpendConfig,
  type SpendConfig,
  type SpendSample,
  spendEscalations,
} from "../../src/loop/governess-spend";

const MS_PER_HOUR = 3_600_000;

const tempRunDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spend-watch-"));
  mkdirSync(join(dir, "utility"), { recursive: true });
  return dir;
};

const writeUsageJsonl = (runDir: string, lines: string[]): void => {
  writeFileSync(join(runDir, "utility", "usage.jsonl"), lines.join("\n"));
};

const usageLine = (jobId: string, cost: number): string =>
  JSON.stringify({ jobId, model: "test/model", usage: { cost } });

const config = (overrides: Partial<SpendConfig> = {}): SpendConfig => ({
  alertUsd: 5,
  killUsd: 25,
  mode: "enforce",
  noticeUsd: 2,
  runawayUsdPerHour: 20,
  runawayWindowMs: 10 * 60_000,
  ...overrides,
});

// A window of samples whose slope is `usdPerHour`, long enough to be measurable.
const rampHistory = (
  usdPerHour: number,
  endUsd: number,
  windowMs = 10 * 60_000
): SpendSample[] => {
  const nowMs = 1_000_000_000;
  const spanUsd = (usdPerHour * windowMs) / MS_PER_HOUR;
  return [
    { atMs: nowMs - windowMs, billableUsd: Math.max(0, endUsd - spanUsd) },
    { atMs: nowMs, billableUsd: endUsd },
  ];
};

const snapshot = (billableUsd: number, attributedUsd = 0) => ({
  attributedUsd,
  billableUsd,
  jobs: 1,
});

describe("resolveSpendConfig", () => {
  test("defaults to observe mode so nothing can be killed out of the box", () => {
    const resolved = resolveSpendConfig({});
    expect(resolved.mode).toBe("observe");
    expect(resolved.noticeUsd).toBeGreaterThan(0);
    expect(resolved.alertUsd).toBeGreaterThan(resolved.noticeUsd);
    expect(resolved.killUsd).toBeGreaterThan(resolved.alertUsd);
  });

  test("reads thresholds and mode from the environment", () => {
    const resolved = resolveSpendConfig({
      LOOP_SPEND_ALERT_USD: "9",
      LOOP_SPEND_KILL_USD: "40",
      LOOP_SPEND_MODE: "enforce",
      LOOP_SPEND_NOTICE_USD: "3",
      LOOP_SPEND_RUNAWAY_USD_PER_HOUR: "50",
    });
    expect(resolved.mode).toBe("enforce");
    expect(resolved.noticeUsd).toBe(3);
    expect(resolved.alertUsd).toBe(9);
    expect(resolved.killUsd).toBe(40);
    expect(resolved.runawayUsdPerHour).toBe(50);
  });

  test("falls back to observe for an unrecognised mode", () => {
    expect(resolveSpendConfig({ LOOP_SPEND_MODE: "yolo" }).mode).toBe(
      "observe"
    );
    expect(resolveSpendConfig({ LOOP_SPEND_MODE: "" }).mode).toBe("observe");
  });

  test("ignores non-positive and malformed threshold overrides", () => {
    const resolved = resolveSpendConfig({
      LOOP_SPEND_KILL_USD: "-5",
      LOOP_SPEND_NOTICE_USD: "abc",
    });
    const defaults = resolveSpendConfig({});
    expect(resolved.noticeUsd).toBe(defaults.noticeUsd);
    expect(resolved.killUsd).toBe(defaults.killUsd);
  });
});

describe("readBillableSpendUsd", () => {
  test("sums the latest usage event per job", () => {
    const runDir = tempRunDir();
    writeUsageJsonl(runDir, [
      usageLine("a", 0.1),
      usageLine("b", 0.25),
      usageLine("c", 0.05),
    ]);
    expect(readBillableSpendUsd(runDir).billableUsd).toBeCloseTo(0.4, 6);
    expect(readBillableSpendUsd(runDir).jobs).toBe(3);
  });

  test("does not double count when a job reports progress repeatedly", () => {
    const runDir = tempRunDir();
    writeUsageJsonl(runDir, [
      usageLine("a", 0.1),
      usageLine("a", 0.3),
      usageLine("a", 0.55),
    ]);
    const result = readBillableSpendUsd(runDir);
    expect(result.billableUsd).toBeCloseTo(0.55, 6);
    expect(result.jobs).toBe(1);
  });

  test("tolerates malformed lines and missing costs", () => {
    const runDir = tempRunDir();
    writeUsageJsonl(runDir, [
      "not json at all",
      JSON.stringify({ jobId: "a" }),
      JSON.stringify({ usage: { cost: 9 } }),
      usageLine("b", 0.2),
      "",
    ]);
    expect(readBillableSpendUsd(runDir).billableUsd).toBeCloseTo(0.2, 6);
  });

  test("returns zero when the run has no utility journal", () => {
    const result = readBillableSpendUsd(join(tempRunDir(), "absent"));
    expect(result.billableUsd).toBe(0);
    expect(result.jobs).toBe(0);
  });

  test("ignores negative costs rather than crediting the run", () => {
    const runDir = tempRunDir();
    writeUsageJsonl(runDir, [usageLine("a", -10), usageLine("b", 0.5)]);
    expect(readBillableSpendUsd(runDir).billableUsd).toBeCloseTo(0.5, 6);
  });
});

describe("burnUsdPerHour", () => {
  test("measures the slope across the window", () => {
    expect(burnUsdPerHour(rampHistory(30, 10), 10 * 60_000)).toBeCloseTo(30, 4);
  });

  test("is zero without two samples", () => {
    expect(burnUsdPerHour([], 60_000)).toBe(0);
    expect(burnUsdPerHour([{ atMs: 1, billableUsd: 5 }], 60_000)).toBe(0);
  });

  test("is zero when spend is flat", () => {
    const history: SpendSample[] = [
      { atMs: 0, billableUsd: 12 },
      { atMs: 600_000, billableUsd: 12 },
    ];
    expect(burnUsdPerHour(history, 600_000)).toBe(0);
  });

  test("drops samples older than the window", () => {
    const history: SpendSample[] = [
      { atMs: 0, billableUsd: 0 },
      { atMs: 10 * MS_PER_HOUR, billableUsd: 100 },
      { atMs: 10 * MS_PER_HOUR + 600_000, billableUsd: 101 },
    ];
    // Only the last two samples are in a 10-minute window: $1 in 10 min = $6/hr.
    expect(burnUsdPerHour(history, 600_000)).toBeCloseTo(6, 4);
  });
});

describe("recordSpendSample", () => {
  test("appends and prunes to the retention window", () => {
    let history: SpendSample[] = [];
    for (let index = 0; index < 200; index += 1) {
      history = recordSpendSample(history, index * 1000, index * 0.01);
    }
    expect(history.length).toBeLessThanOrEqual(120);
    expect(history.at(-1)?.billableUsd).toBeCloseTo(1.99, 6);
  });
});

describe("evaluateSpend levels", () => {
  test("stays ok below the notice threshold", () => {
    const decision = evaluateSpend(snapshot(1), config(), []);
    expect(decision.level).toBe("ok");
    expect(decision.killRequested).toBe(false);
  });

  test("notices at the notice threshold", () => {
    expect(evaluateSpend(snapshot(2), config(), []).level).toBe("notice");
  });

  test("alerts at the alert threshold", () => {
    expect(evaluateSpend(snapshot(5.5), config(), []).level).toBe("alert");
  });
});

describe("evaluateSpend runaway guard", () => {
  test("one expensive but steady job does not kill", () => {
    // $30 cumulative — over killUsd — but only $4/hr: a big legitimate job.
    const decision = evaluateSpend(snapshot(30), config(), rampHistory(4, 30));
    expect(decision.level).toBe("alert");
    expect(decision.killRequested).toBe(false);
    expect(decision.enforced).toBe(false);
  });

  test("a fast burn under the kill threshold does not kill", () => {
    const decision = evaluateSpend(snapshot(6), config(), rampHistory(500, 6));
    expect(decision.level).toBe("alert");
    expect(decision.killRequested).toBe(false);
  });

  test("kills only when cumulative and burn are both past threshold", () => {
    const decision = evaluateSpend(snapshot(40), config(), rampHistory(90, 40));
    expect(decision.level).toBe("runaway");
    expect(decision.killRequested).toBe(true);
    expect(decision.enforced).toBe(true);
    expect(decision.reason).toContain("runaway");
  });

  test("does not kill before the burn window has enough history", () => {
    const decision = evaluateSpend(snapshot(40), config(), [
      { atMs: 1_000_000_000, billableUsd: 40 },
    ]);
    expect(decision.killRequested).toBe(false);
  });
});

describe("evaluateSpend money-stream separation", () => {
  test("subscription spend alone never kills at any magnitude", () => {
    const decision = evaluateSpend(
      snapshot(0, 100_000),
      config(),
      rampHistory(0, 0)
    );
    expect(decision.killRequested).toBe(false);
    expect(decision.enforced).toBe(false);
    expect(decision.snapshot.attributedUsd).toBe(100_000);
  });

  test("attributed spend is reported but excluded from the kill maths", () => {
    const decision = evaluateSpend(
      snapshot(1, 9000),
      config(),
      rampHistory(0, 1)
    );
    expect(decision.level).toBe("ok");
    expect(decision.snapshot.billableUsd).toBe(1);
  });
});

describe("evaluateSpend dry-run modes", () => {
  const runaway = rampHistory(90, 40);

  test("observe mode reports the kill but never enforces", () => {
    const decision = evaluateSpend(
      snapshot(40),
      config({ mode: "observe" }),
      runaway
    );
    expect(decision.level).toBe("runaway");
    expect(decision.killRequested).toBe(true);
    expect(decision.enforced).toBe(false);
    expect(decision.wouldKill).toBe(true);
  });

  test("alert mode also refuses to enforce", () => {
    const decision = evaluateSpend(
      snapshot(40),
      config({ mode: "alert" }),
      runaway
    );
    expect(decision.enforced).toBe(false);
    expect(decision.wouldKill).toBe(true);
  });

  test("no mode enforces at absurd magnitudes except enforce", () => {
    for (const mode of ["observe", "alert"] as const) {
      const decision = evaluateSpend(
        snapshot(1_000_000),
        config({ mode }),
        rampHistory(100_000, 1_000_000)
      );
      expect(decision.enforced).toBe(false);
    }
  });
});

describe("spendEscalations", () => {
  test("escalates notice and alert once each per run", () => {
    const notified = {};
    const first = evaluateSpend(snapshot(2.5), config(), []);
    expect(spendEscalations(first, notified, "run-1")).toHaveLength(1);
    expect(spendEscalations(first, notified, "run-1")).toHaveLength(0);

    const second = evaluateSpend(snapshot(6), config(), []);
    const alerts = spendEscalations(second, notified, "run-1");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.priority).toBe("high");
    expect(spendEscalations(second, notified, "run-1")).toHaveLength(0);
  });

  test("a runaway escalates urgently", () => {
    const decision = evaluateSpend(snapshot(40), config(), rampHistory(90, 40));
    const events = spendEscalations(decision, {}, "run-2");
    const runaway = events.find((event) => event.priority === "urgent");
    expect(runaway).toBeDefined();
    expect(runaway?.kind).toBe("budget");
    expect(runaway?.message).toContain("run-2");
  });

  test("observe-mode escalations say they are observing, not killing", () => {
    const decision = evaluateSpend(
      snapshot(40),
      config({ mode: "observe" }),
      rampHistory(90, 40)
    );
    const events = spendEscalations(decision, {}, "run-3");
    const urgent = events.find((event) => event.priority === "urgent");
    expect(urgent?.message.toLowerCase()).toContain("observe");
  });

  test("emits nothing while spend is ok", () => {
    expect(
      spendEscalations(evaluateSpend(snapshot(0), config(), []), {}, "r")
    ).toHaveLength(0);
  });
});

describe("appendSpendJournal", () => {
  test("writes one line per evaluation and no secrets", () => {
    const runDir = tempRunDir();
    const decision = evaluateSpend(
      snapshot(3, 12),
      config(),
      rampHistory(5, 3)
    );
    appendSpendJournal(runDir, decision, 1_700_000_000_000);
    appendSpendJournal(runDir, decision, 1_700_000_060_000);
    const text = readFileSync(join(runDir, "spend-watch.jsonl"), "utf8");
    const lines = text.split("\n").filter((line) => line.trim());
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.billableUsd).toBeCloseTo(3, 6);
    expect(parsed.attributedUsd).toBeCloseTo(12, 6);
    expect(parsed.level).toBe("notice");
    expect(parsed.mode).toBe("enforce");
    expect(text.toLowerCase()).not.toContain("secret");
    expect(text.toLowerCase()).not.toContain("bearer");
    expect(text.toLowerCase()).not.toContain("token");
  });

  test("does not create a run directory that does not exist", () => {
    const runDir = join(tempRunDir(), "not-a-real-run");
    const decision = evaluateSpend(snapshot(1), config(), []);
    appendSpendJournal(runDir, decision, 1);
    expect(existsSync(runDir)).toBe(false);
  });

  test("journalling never throws on an unwritable run directory", () => {
    const decision = evaluateSpend(snapshot(1), config(), []);
    expect(() =>
      appendSpendJournal("/proc/definitely/not/writable", decision, 1)
    ).not.toThrow();
  });
});
