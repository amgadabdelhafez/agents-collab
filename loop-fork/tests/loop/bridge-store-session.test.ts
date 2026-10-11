import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_SERVER } from "../../src/loop/bridge-constants";
import {
  BRIDGE_SESSION_FILE,
  BRIDGE_SESSION_SCHEMA,
  readBridgeSessionRecord,
  readBridgeStatus,
  writeBridgeSessionRecord,
} from "../../src/loop/bridge-store";
import {
  probeClaudeChannelReadiness,
  publishClaudeChannelReadiness,
} from "../../src/loop/claude-channel-readiness";
import { createRunManifest, writeRunManifest } from "../../src/loop/run-state";

let root = "";
let sessionDir = "";

const identity = {
  claudeChannelServer: "loop-bridge-alpha",
  claudeSessionId: "0b5f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
};

const writeRaw = (dir: string, value: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, BRIDGE_SESSION_FILE),
    typeof value === "string" ? value : JSON.stringify(value)
  );
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-session-")));
  sessionDir = join(root, "sessions", "alpha", "sess-1");
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

test("a directory with no manifest takes its channel identity from session.json", () => {
  writeBridgeSessionRecord(sessionDir, identity);
  const status = readBridgeStatus(sessionDir);
  expect(status.claudeSessionId).toBe(identity.claudeSessionId);
  expect(status.claudeChannelServer).toBe(identity.claudeChannelServer);
  // No run, no Codex remote, no tmux: the fallback adds identity only.
  expect(status.runId).toBe("");
  expect(status.codexRemoteUrl).toBe("");
  expect(status.hasCodexRemote).toBe(false);
  expect(status.hasTmuxSession).toBe(false);
  // Owner-only and complete.
  expect(
    statSync(join(sessionDir, BRIDGE_SESSION_FILE)).mode.toString(8).slice(-3)
  ).toBe("600");
  expect(
    JSON.parse(readFileSync(join(sessionDir, BRIDGE_SESSION_FILE), "utf8"))
  ).toEqual({ ...identity, schema: BRIDGE_SESSION_SCHEMA });
});

test("a run directory answers from its manifest and ignores any session.json", () => {
  const runDir = join(root, "runs", "repo-1", "1");
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest(
      {
        claudeSessionId: "run-claude-session",
        cwd: root,
        mode: "paired",
        pid: process.pid,
        repoId: "repo-1",
        runId: "1",
        state: "working",
      },
      "2026-10-11T10:00:00.000Z"
    )
  );
  writeBridgeSessionRecord(runDir, identity);
  const status = readBridgeStatus(runDir);
  expect(status.claudeSessionId).toBe("run-claude-session");
  expect(status.claudeChannelServer).not.toBe(identity.claudeChannelServer);
  expect(status.runId).toBe("1");
  // A run whose manifest has no Claude session yet does not borrow one.
  writeRunManifest(
    join(runDir, "manifest.json"),
    createRunManifest(
      {
        cwd: root,
        mode: "paired",
        pid: process.pid,
        repoId: "repo-1",
        runId: "1",
        state: "working",
      },
      "2026-10-11T10:00:00.000Z"
    )
  );
  expect(readBridgeStatus(runDir).claudeSessionId).toBe("");
});

test("no manifest and no session record keeps the old empty identity", () => {
  mkdirSync(sessionDir, { recursive: true });
  const status = readBridgeStatus(sessionDir);
  expect(status.claudeSessionId).toBe("");
  expect(status.claudeChannelServer).toBe(BRIDGE_SERVER);
});

test("a symlinked session.json is never followed", () => {
  const elsewhere = join(root, "elsewhere");
  writeRaw(elsewhere, { ...identity, schema: BRIDGE_SESSION_SCHEMA });
  mkdirSync(sessionDir, { recursive: true });
  symlinkSync(
    join(elsewhere, BRIDGE_SESSION_FILE),
    join(sessionDir, BRIDGE_SESSION_FILE)
  );
  expect(readBridgeSessionRecord(sessionDir)).toBeUndefined();
  expect(readBridgeStatus(sessionDir).claudeSessionId).toBe("");
});

test("malformed, oversized, wrong-schema or non-file records are ignored", () => {
  const cases: unknown[] = [
    "{not json",
    [],
    { ...identity },
    { ...identity, schema: "loop-bridge-session.v0" },
    {
      ...identity,
      claudeSessionId: "../escape",
      schema: BRIDGE_SESSION_SCHEMA,
    },
    { ...identity, claudeSessionId: "", schema: BRIDGE_SESSION_SCHEMA },
    { ...identity, claudeSessionId: 7, schema: BRIDGE_SESSION_SCHEMA },
    {
      ...identity,
      claudeChannelServer: "loop bridge",
      schema: BRIDGE_SESSION_SCHEMA,
    },
    { ...identity, claudeChannelServer: null, schema: BRIDGE_SESSION_SCHEMA },
    {
      ...identity,
      padding: "x".repeat(20_000),
      schema: BRIDGE_SESSION_SCHEMA,
    },
  ];
  for (const value of cases) {
    writeRaw(sessionDir, value);
    expect(readBridgeSessionRecord(sessionDir)).toBeUndefined();
  }
  // Extra keys within the size bound are tolerated; only the identity is read.
  writeRaw(sessionDir, { ...identity, pid: 1, schema: BRIDGE_SESSION_SCHEMA });
  expect(readBridgeSessionRecord(sessionDir)).toEqual({
    ...identity,
    schema: BRIDGE_SESSION_SCHEMA,
  });
  // A directory named session.json is not a record.
  rmSync(join(sessionDir, BRIDGE_SESSION_FILE));
  mkdirSync(join(sessionDir, BRIDGE_SESSION_FILE));
  expect(readBridgeSessionRecord(sessionDir)).toBeUndefined();
});

test("writing refuses an invalid identity", () => {
  expect(() =>
    writeBridgeSessionRecord(sessionDir, {
      ...identity,
      claudeSessionId: "a/b",
    })
  ).toThrow("bridge session identity is invalid");
  expect(() =>
    writeBridgeSessionRecord(sessionDir, {
      ...identity,
      claudeChannelServer: "",
    })
  ).toThrow("bridge session identity is invalid");
});

test("the bridge's own channel readiness works in a session directory", () => {
  writeBridgeSessionRecord(sessionDir, identity);
  publishClaudeChannelReadiness(sessionDir, identity);
  const bridgeCommand = `loop __bridge-mcp ${sessionDir} claude`;
  expect(
    probeClaudeChannelReadiness(sessionDir, {
      commandForPid: () => bridgeCommand,
    })
  ).toBe(true);
  // Another directory's bridge process is not this session's channel.
  expect(
    probeClaudeChannelReadiness(sessionDir, {
      commandForPid: () => `loop __bridge-mcp ${root} claude`,
    })
  ).toBe(false);
  // A record naming another Claude session voids the readiness file.
  writeBridgeSessionRecord(sessionDir, {
    ...identity,
    claudeSessionId: "another-session",
  });
  expect(
    probeClaudeChannelReadiness(sessionDir, {
      commandForPid: () => bridgeCommand,
    })
  ).toBe(false);
});
