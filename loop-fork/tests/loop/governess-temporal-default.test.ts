// fix8: the governess Temporal journal is ON by default.
//
//   default    — with no LOOP_GOVERNESS_TEMPORAL_* set, the address and
//                namespace come from the orchestration config and the queue is
//                loop-governess-<host>.
//   opt-out    — LOOP_GOVERNESS_TEMPORAL=off keeps the file journal even with a
//                config (and with explicit settings) present.
//   missing    — an absent or unusable config is "off" with a reason, never an
//                error.
//   preflight  — an unreachable server or an unknown namespace is reported as
//                GovernessTemporalUnreachableError within the bound; a real
//                local server with the right namespace connects.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  connectGovernessTemporalJournal,
  GovernessTemporalUnreachableError,
  governessHostTaskQueue,
  orchestrationConfigPathFromEnv,
  resolveGovernessTemporalConfig,
} from "../../src/loop/governess-temporal-journal";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const orchestrationConfig = (value: unknown): string => {
  const root = mkdtempSync(join(tmpdir(), "fix8-orch-config-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
    { mode: 0o600 }
  );
  return path;
};

const LIVE_SHAPE = {
  address: "192.0.2.10:7233",
  namespace: "harness",
  schema: "loop-orchestration-server.v1",
  taskQueue: "loop-orchestration",
};

describe("default: derived from the orchestration config", () => {
  test("address and namespace from the config, queue loop-governess-<host>", () => {
    const path = orchestrationConfig(LIVE_SHAPE);
    expect(
      resolveGovernessTemporalConfig(
        { LOOP_ORCHESTRATION_CONFIG: path },
        { hostname: () => "SweetMac14.local" }
      )
    ).toEqual({
      config: {
        address: "192.0.2.10:7233",
        namespace: "harness",
        taskQueue: "loop-governess-sweetmac14",
      },
      configPath: path,
      kind: "configured",
      source: "orchestration-config",
    });
  });

  test("the default path is ~/.loop/orchestration/config.json under HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "fix8-home-"));
    roots.push(home);
    expect(orchestrationConfigPathFromEnv({ HOME: home })).toBe(
      join(home, ".loop", "orchestration", "config.json")
    );
    const read: string[] = [];
    resolveGovernessTemporalConfig(
      { HOME: home },
      {
        readFile: (path) => {
          read.push(path);
          return JSON.stringify(LIVE_SHAPE);
        },
      }
    );
    expect(read).toEqual([join(home, ".loop", "orchestration", "config.json")]);
  });

  test("LOOP_GOVERNESS_TEMPORAL_TASK_QUEUE overrides the per-host queue", () => {
    const path = orchestrationConfig(LIVE_SHAPE);
    const resolved = resolveGovernessTemporalConfig({
      LOOP_GOVERNESS_TEMPORAL_TASK_QUEUE: "loop-governess-pinned",
      LOOP_ORCHESTRATION_CONFIG: path,
    });
    expect(resolved.kind === "configured" && resolved.config.taskQueue).toBe(
      "loop-governess-pinned"
    );
  });

  test("explicit address and namespace win over the config", () => {
    const path = orchestrationConfig(LIVE_SHAPE);
    expect(
      resolveGovernessTemporalConfig({
        LOOP_GOVERNESS_TEMPORAL_ADDRESS: "127.0.0.1:7233",
        LOOP_GOVERNESS_TEMPORAL_NAMESPACE: "default",
        LOOP_ORCHESTRATION_CONFIG: path,
      })
    ).toEqual({
      config: {
        address: "127.0.0.1:7233",
        namespace: "default",
        taskQueue: "loop-governess",
      },
      kind: "configured",
      source: "env",
    });
    expect(() =>
      resolveGovernessTemporalConfig({
        LOOP_GOVERNESS_TEMPORAL_ADDRESS: "127.0.0.1:7233",
        LOOP_ORCHESTRATION_CONFIG: path,
      })
    ).toThrow("needs both");
  });

  test("the host label is the first DNS label, lower-cased and sanitised", () => {
    expect(governessHostTaskQueue("SweetMac14.local")).toBe(
      "loop-governess-sweetmac14"
    );
    expect(governessHostTaskQueue("Amgad's MacBook_Pro.lan")).toBe(
      "loop-governess-amgad-s-macbook-pro"
    );
    expect(governessHostTaskQueue("")).toBe("loop-governess-host");
  });
});

describe("opt-out", () => {
  test.each([
    "off",
    "OFF",
    "0",
    "false",
    "no",
    "disabled",
  ])("LOOP_GOVERNESS_TEMPORAL=%s keeps the file journal, even with a config and explicit settings", (value) => {
    const path = orchestrationConfig(LIVE_SHAPE);
    let reads = 0;
    expect(
      resolveGovernessTemporalConfig(
        {
          LOOP_GOVERNESS_TEMPORAL: value,
          LOOP_GOVERNESS_TEMPORAL_ADDRESS: "127.0.0.1:7233",
          LOOP_GOVERNESS_TEMPORAL_NAMESPACE: "default",
          LOOP_ORCHESTRATION_CONFIG: path,
        },
        {
          readFile: () => {
            reads += 1;
            return JSON.stringify(LIVE_SHAPE);
          },
        }
      )
    ).toEqual({ kind: "off", reason: `LOOP_GOVERNESS_TEMPORAL=${value}` });
    expect(reads).toBe(0);
  });

  test("any other value of the switch leaves the default on", () => {
    const path = orchestrationConfig(LIVE_SHAPE);
    expect(
      resolveGovernessTemporalConfig({
        LOOP_GOVERNESS_TEMPORAL: "on",
        LOOP_ORCHESTRATION_CONFIG: path,
      }).kind
    ).toBe("configured");
  });
});

describe("missing or unusable config: off with a reason, never an error", () => {
  test("absent", () => {
    const path = join(tmpdir(), `fix8-absent-${process.pid}`, "config.json");
    expect(
      resolveGovernessTemporalConfig({ LOOP_ORCHESTRATION_CONFIG: path })
    ).toEqual({
      kind: "off",
      reason: `orchestration config ${path} is absent`,
    });
  });

  test("not JSON", () => {
    const path = orchestrationConfig("{ not json");
    expect(
      resolveGovernessTemporalConfig({ LOOP_ORCHESTRATION_CONFIG: path })
    ).toEqual({
      kind: "off",
      reason: `orchestration config ${path} is not JSON`,
    });
  });

  test.each([
    ["wrong schema", { ...LIVE_SHAPE, schema: "something-else" }],
    ["no address", { ...LIVE_SHAPE, address: undefined }],
    ["bad namespace", { ...LIVE_SHAPE, namespace: "has space" }],
  ])("%s", (_label, value) => {
    const path = orchestrationConfig(value);
    expect(
      resolveGovernessTemporalConfig({ LOOP_ORCHESTRATION_CONFIG: path })
    ).toEqual({
      kind: "off",
      reason: `orchestration config ${path} names no usable Temporal address and namespace`,
    });
  });
});

describe("preflight", () => {
  test("an address nothing listens on is unreachable within the bound", async () => {
    const started = Date.now();
    const failure = await connectGovernessTemporalJournal(
      { address: "127.0.0.1:1", namespace: "harness", taskQueue: "q" },
      "repo-fix8",
      500
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(GovernessTemporalUnreachableError);
    expect(String(failure)).toContain("127.0.0.1:1/harness is unreachable");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  let environment: TestWorkflowEnvironment | undefined;
  afterAll(async () => {
    await environment?.teardown();
  });

  test("a real server: the configured namespace connects, an unknown one is unreachable", async () => {
    environment = await TestWorkflowEnvironment.createLocal();
    const address = environment.address;
    const client = await connectGovernessTemporalJournal(
      { address, namespace: "default", taskQueue: "fix8-preflight" },
      "repo-fix8",
      3000
    );
    expect(client.workflowId("1")).toBe(
      "governess-beat:v2:repo-fix8:1:fix8-preflight"
    );
    await client.close();
    const failure = await connectGovernessTemporalJournal(
      { address, namespace: "no-such-namespace", taskQueue: "q" },
      "repo-fix8",
      3000
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(GovernessTemporalUnreachableError);
  }, 120_000);
});
