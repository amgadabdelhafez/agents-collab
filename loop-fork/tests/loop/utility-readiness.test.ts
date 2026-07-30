import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UTILITY_AU_PAIR_TIER,
  UTILITY_DIRECT_TIER,
  UTILITY_NANNY_TIER,
} from "../../src/loop/utility-execution-tier";
import {
  readUtilityDispatchReadiness,
  utilityInferenceCircuitOpen,
} from "../../src/loop/utility-readiness";

const NOW = Date.parse("2026-07-30T04:40:00.000Z");

const fixture = (
  input: {
    epoch?: number;
    modifiedAt?: number;
    usage?: Record<string, unknown>[];
  } = {}
): string => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-readiness-"));
  mkdirSync(join(runDir, "utility"), { recursive: true });
  const epoch = input.epoch ?? 71;
  const statePath = join(runDir, "governess-state.json");
  writeFileSync(statePath, JSON.stringify({ governessEpoch: epoch, tick: 9 }));
  writeFileSync(join(runDir, "utility", "epoch"), String(epoch));
  const modifiedAt = input.modifiedAt ?? NOW;
  utimesSync(statePath, modifiedAt / 1000, modifiedAt / 1000);
  if (input.usage) {
    writeFileSync(
      join(runDir, "utility", "usage.jsonl"),
      `${input.usage.map((record) => JSON.stringify(record)).join("\n")}\n`
    );
  }
  return runDir;
};

test("Direct readiness requires only the fresh matching dispatcher lease", () => {
  const runDir = fixture();
  expect(
    readUtilityDispatchReadiness(runDir, UTILITY_DIRECT_TIER, NOW)
  ).toEqual(expect.objectContaining({ ready: true, reason: "ready" }));
  rmSync(runDir, { force: true, recursive: true });
});

test("missing, stale, and mismatched dispatcher evidence fails open", () => {
  const missing = mkdtempSync(join(tmpdir(), "loop-readiness-missing-"));
  expect(
    readUtilityDispatchReadiness(missing, UTILITY_DIRECT_TIER, NOW).reason
  ).toBe("dispatcher-missing");
  expect(
    readUtilityDispatchReadiness(missing, UTILITY_DIRECT_TIER, Number.NaN)
      .reason
  ).toBe("dispatcher-malformed");

  const stale = fixture({ modifiedAt: NOW - 45_001 });
  expect(
    readUtilityDispatchReadiness(stale, UTILITY_DIRECT_TIER, NOW).reason
  ).toBe("dispatcher-stale");

  const mismatch = fixture({ epoch: 72 });
  writeFileSync(join(mismatch, "utility", "epoch"), "73");
  expect(
    readUtilityDispatchReadiness(mismatch, UTILITY_DIRECT_TIER, NOW).reason
  ).toBe("dispatcher-epoch-mismatch");

  for (const path of [missing, stale, mismatch]) {
    rmSync(path, { force: true, recursive: true });
  }
});

test("Nanny readiness needs a recent real model completion", () => {
  const unknown = fixture();
  expect(
    readUtilityDispatchReadiness(unknown, UTILITY_NANNY_TIER, NOW)
  ).toEqual({ ready: false, reason: "inference-unknown" });

  const ready = fixture({
    usage: [
      {
        at: "2026-07-30T04:39:30.000Z",
        modelCalls: 2,
        status: "completed",
        tierId: UTILITY_NANNY_TIER,
      },
    ],
  });
  expect(readUtilityDispatchReadiness(ready, UTILITY_NANNY_TIER, NOW)).toEqual(
    expect.objectContaining({ ready: true, reason: "ready" })
  );

  rmSync(unknown, { force: true, recursive: true });
  rmSync(ready, { force: true, recursive: true });
});

test("selected-tier failures open a short routing circuit", () => {
  const runDir = fixture({
    usage: [
      {
        at: "2026-07-30T04:39:10.000Z",
        modelCalls: 1,
        status: "completed",
        tierId: UTILITY_AU_PAIR_TIER,
      },
      {
        at: "2026-07-30T04:39:30.000Z",
        modelCalls: 1,
        status: "failed",
        tierId: UTILITY_AU_PAIR_TIER,
      },
    ],
  });
  expect(
    readUtilityDispatchReadiness(runDir, UTILITY_AU_PAIR_TIER, NOW).reason
  ).toBe("inference-failed");
  expect(utilityInferenceCircuitOpen(runDir, UTILITY_AU_PAIR_TIER, NOW)).toBe(
    true
  );
  expect(
    utilityInferenceCircuitOpen(runDir, UTILITY_AU_PAIR_TIER, NOW + 60_001)
  ).toBe(false);
  rmSync(runDir, { force: true, recursive: true });
});

test("expired success is stale and cannot authorize an automatic denial", () => {
  const runDir = fixture({
    usage: [
      {
        at: "2026-07-30T04:34:59.999Z",
        modelCalls: 3,
        status: "context-insufficient",
        tierId: UTILITY_NANNY_TIER,
      },
    ],
  });
  expect(
    readUtilityDispatchReadiness(runDir, UTILITY_NANNY_TIER, NOW).reason
  ).toBe("inference-stale");
  rmSync(runDir, { force: true, recursive: true });
});
