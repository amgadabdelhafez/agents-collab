// RETIRED (gov-6).
//
// This file used to boot DbosSupervisorMessageReplayRuntime and replay the
// frozen corpus through DBOS. gov-6 moves replay onto Temporal workflow history,
// so the DBOS runtime is unwired here — that execution was this cluster's only
// caller outside itself.
//
// The file is kept, not deleted, and repurposed as the retirement guard: it now
// proves the DBOS cluster stays unwired and that its source survives intact for
// the gov-7 cutover, which is the slice authorized to delete it. The two
// non-DBOS-executing invariants the old suite carried (canonical modules stay
// free of vendor types, and the SDK version stays pinned) are preserved below.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// path -> a symbol that only the file's original body contains, so the guard
// fails if a marker ever replaces the code instead of annotating it.
const RETIRED_DBOS_SOURCES: [string, string][] = [
  ["src/loop/dbos-replay-runtime.ts", "DbosSupervisorMessageReplayRuntime"],
  ["src/loop/dbos-replay-worker.ts", "registerDbosWorkflow"],
  ["src/loop/dbos-workflow.ts", "@dbos-inc/dbos-sdk"],
];

describe("DBOS cluster retirement (gov-6)", () => {
  test("keeps the retired DBOS sources present and marked, not deleted", async () => {
    for (const [path, survivingSymbol] of RETIRED_DBOS_SOURCES) {
      const source = await readFile(path, "utf8");
      expect(source).toContain("RETIRED (gov-6)");
      expect(source).toContain("gov-7");
      // The marker must annotate real code, never replace it.
      expect(source.split("\n").length).toBeGreaterThan(50);
      expect(source).toContain(survivingSymbol);
    }
  });

  test("leaves the DBOS cluster unwired from live code and tests", async () => {
    // dbos-workflow-port.ts is not on gov-6's retire list but is now reachable
    // only from retired code. Flagged here, deleted by nobody before gov-7.
    const port = await readFile("src/loop/dbos-workflow-port.ts", "utf8");
    expect(port).toContain("@dbos-inc/dbos-sdk");

    const liveEntryPoints = ["src/cli.ts", "src/loop/temporal-workflow.ts"];
    for (const path of liveEntryPoints) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("dbos-replay-runtime");
      expect(source).not.toContain("dbos-replay-worker");
      expect(source).not.toContain("dbos-workflow");
    }

    // This suite must not import the retired runtime back in. Checked by
    // scanning its own import section rather than the whole file, which would
    // match this assertion's own text.
    const self = await readFile(
      "tests/loop/dbos-workflow-port.test.ts",
      "utf8"
    );
    const imports = self
      .split("\n")
      .filter((line) => line.startsWith("import "))
      .join("\n");
    expect(imports).not.toContain("dbos-replay-runtime");
  });

  test("keeps vendor types out of canonical workflow and fixture modules", async () => {
    const canonicalPaths = [
      "src/loop/workflow-port.ts",
      "src/loop/in-memory-workflow-port.ts",
      "src/loop/supervisor-message-workflow.ts",
      "src/loop/supervisor-message-coordinator.ts",
      "src/loop/workflow-replay-corpus.ts",
      "src/loop/supervisor-message-replay-fixtures.ts",
      // gov-6 adds the governess beat to the same canonical tier.
      "src/loop/governess-journal-core.ts",
      "src/loop/governess-beat-workflow.ts",
    ];
    for (const path of canonicalPaths) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("@dbos-inc/");
      expect(source).not.toContain("@temporalio/");
    }
  });

  test("pins one exact stable DBOS SDK version", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["@dbos-inc/dbos-sdk"]).toBe("4.27.6");
  });
});
