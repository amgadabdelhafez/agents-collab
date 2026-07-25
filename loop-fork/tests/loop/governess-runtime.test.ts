import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGovernessRuntimeAdapter,
  defaultGovernessDeps,
  freshRunState,
  loadGovernessState,
  saveGovernessState,
} from "../../src/loop/governess";
import {
  governessHandoffFile,
  readGovernessHandoffBundle,
} from "../../src/loop/governess-handoff";
import {
  prepareGovernessControl,
  readGovernessJournal,
  transitionGovernessControl,
} from "../../src/loop/governess-journal";
import { decideGovernessPolicy } from "../../src/loop/governess-policy";
import {
  governessDoctor,
  inspectGovernessJournal,
  replayGovernessJournal,
} from "../../src/loop/governess-replay";
import type { GovernessConfig } from "../../src/loop/governess";
import {
  driverLeaseIsCurrent,
  explicitAgentState,
  nextLifecycleEvent,
} from "../../src/loop/governess-runtime";
import {
  LEGACY_GOVERNESS_STATE_FILE,
  LEGACY_GOVERNESS_SUBCOMMAND,
  migrateLegacyGovernessState,
  normalizeLegacyGovernessArgs,
  withLegacyGovernessEnv,
} from "../../src/loop/legacy-governess-compat";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "governess-runtime-"));

test("policy separates observations, safe controls, confirmations, and forbidden work", () => {
  expect(
    decideGovernessPolicy("observe-runtime", { fenceCurrent: false })
  ).toMatchObject({ allowed: true, class: "observe" });
  expect(
    decideGovernessPolicy("nudge", {
      fenceCurrent: true,
      targetSafe: true,
    })
  ).toMatchObject({ allowed: true, class: "safe-automatic" });
  expect(
    decideGovernessPolicy("nudge", {
      fenceCurrent: false,
      targetSafe: true,
    })
  ).toMatchObject({ allowed: false, reason: "stale governess epoch" });
  expect(
    decideGovernessPolicy("handover-loop", {
      confirmed: false,
      fenceCurrent: true,
    })
  ).toMatchObject({ allowed: false, class: "require-confirmation" });
  expect(
    decideGovernessPolicy("handover-loop", {
      confirmed: true,
      fenceCurrent: true,
    })
  ).toMatchObject({ allowed: true, class: "require-confirmation" });
  expect(
    decideGovernessPolicy("commit", { fenceCurrent: true })
  ).toMatchObject({ allowed: false, class: "forbidden" });
});

test("runtime state and lifecycle sequence are explicit", () => {
  expect(explicitAgentState("working", true)).toBe("working");
  expect(explicitAgentState("waiting-human", true)).toBe("input-required");
  expect(explicitAgentState("limited", true)).toBe("blocked");
  expect(explicitAgentState("working", false)).toBe("exited");
  const first = nextLifecycleEvent(undefined, {
    agent: "codex",
    at: "2026-07-25T00:00:00.000Z",
    epoch: 7,
    state: "working",
  });
  const second = nextLifecycleEvent(first, {
    agent: "codex",
    at: "2026-07-25T00:00:01.000Z",
    epoch: 7,
    state: "handover-ready",
  });
  expect([first.sequence, second.sequence]).toEqual([1, 2]);
  expect(
    driverLeaseIsCurrent(
      {
        epoch: 7,
        expiresAt: "2026-07-25T00:01:00.000Z",
        holder: "codex",
      },
      7,
      Date.parse("2026-07-25T00:00:30.000Z")
    )
  ).toBe(true);
  expect(
    driverLeaseIsCurrent(
      {
        epoch: 6,
        expiresAt: "2026-07-25T00:01:00.000Z",
        holder: "codex",
      },
      7,
      Date.parse("2026-07-25T00:00:30.000Z")
    )
  ).toBe(false);
  expect(driverLeaseIsCurrent(undefined, undefined, Date.now())).toBe(false);
});

test("control journal is idempotent and replayable", () => {
  const journalFile = join(tempDir(), "control.jsonl");
  const input = {
    action: "nudge" as const,
    agent: "codex" as const,
    at: "2026-07-25T00:00:00.000Z",
    epoch: 4,
    idempotencyKey: "4:nudge:codex:payload",
    payload: "status?",
    policyClass: "safe-automatic" as const,
  };
  const prepared = prepareGovernessControl(journalFile, input);
  expect(prepareGovernessControl(journalFile, input).controlId).toBe(
    prepared.controlId
  );
  transitionGovernessControl(
    journalFile,
    prepared.controlId,
    "dispatched",
    "2026-07-25T00:00:01.000Z"
  );
  expect(replayGovernessJournal(readGovernessJournal(journalFile)).ok).toBe(
    false
  );
  transitionGovernessControl(
    journalFile,
    prepared.controlId,
    "completed",
    "2026-07-25T00:00:02.000Z"
  );
  const records = readGovernessJournal(journalFile);
  expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
  expect(replayGovernessJournal(records)).toMatchObject({
    controls: 1,
    latestEpoch: 4,
    ok: true,
  });

  const observation = prepareGovernessControl(journalFile, {
    action: "observe-runtime",
    agent: "codex",
    at: "2026-07-25T00:00:03.000Z",
    epoch: 4,
    idempotencyKey: "4:probe:codex:1",
    payload: JSON.stringify({ alive: true, state: "working" }),
    policyClass: "observe",
  });
  transitionGovernessControl(
    journalFile,
    observation.controlId,
    "completed",
    "2026-07-25T00:00:04.000Z"
  );
  expect(
    readGovernessJournal(journalFile).find(
      (record) => record.controlId === observation.controlId
    )?.payload
  ).toBe(JSON.stringify({ alive: true, state: "working" }));
});

test("missing or malformed control journals fail closed", () => {
  const dir = tempDir();
  const missing = join(dir, "missing.jsonl");
  expect(inspectGovernessJournal(missing)).toMatchObject({ ok: false });
  const malformed = join(dir, "malformed.jsonl");
  writeFileSync(malformed, "{not-json}\n");
  expect(() => readGovernessJournal(malformed)).toThrow("line 1");
  expect(inspectGovernessJournal(malformed)).toMatchObject({ ok: false });
  const doctor = governessDoctor("missing", dir, tempDir()) as {
    journal: { ok: boolean };
    ok: boolean;
  };
  expect(doctor.ok).toBe(false);
  expect(doctor.journal.ok).toBe(false);
});

test("runtime adapter rejects a stale control envelope", async () => {
  const config = {
    agents: [],
    epoch: 7,
    logFile: join(tempDir(), "governess.jsonl"),
  } as unknown as GovernessConfig;
  const deps = {
    ...defaultGovernessDeps(),
    fenceCurrent: () => true,
  };
  const adapter = createGovernessRuntimeAdapter(config, deps, {
    agent: "codex",
    hookFile: "missing",
    pane: "missing",
  });
  await expect(
    adapter.sendControl({
      action: "message",
      controlId: "control-1",
      epoch: 6,
      message: "should not send",
      target: "codex",
    })
  ).rejects.toThrow("stale or invalid");
});

test("two-phase handoff accepts only a matching ready bundle", () => {
  const runDir = tempDir();
  const file = governessHandoffFile(runDir, 9, "claude");
  mkdirSync(join(runDir, "handoff", "9"), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      agent: "claude",
      blockers: [],
      checks: ["bun test"],
      dirtyFiles: ["src/loop/governess.ts"],
      epoch: 9,
      gitHead: "abc123",
      next: "resume from checkpoint",
      status: "ready",
      summary: "finished atomic step",
    })
  );
  expect(readGovernessHandoffBundle(file, "claude", 9)?.status).toBe("ready");
  expect(readGovernessHandoffBundle(file, "codex", 9)).toBeUndefined();
  expect(readGovernessHandoffBundle(file, "claude", 10)).toBeUndefined();
});

test("stale governess state cannot overwrite a newer epoch", () => {
  const stateFile = join(tempDir(), "governess-state.json");
  const current = freshRunState();
  current.governessEpoch = 20;
  saveGovernessState(stateFile, current);
  const stale = freshRunState();
  stale.governessEpoch = 19;
  stale.summary = "stale write";
  saveGovernessState(stateFile, stale);
  expect(loadGovernessState(stateFile)?.governessEpoch).toBe(20);
  expect(loadGovernessState(stateFile)?.summary).toBe("");
});

test("legacy compatibility maps inputs without leaking them into canonical state", () => {
  const oldFlag = `--${LEGACY_GOVERNESS_SUBCOMMAND.slice(2)}`;
  expect(normalizeLegacyGovernessArgs([oldFlag])).toEqual(["--governess"]);
  const oldPrefix = LEGACY_GOVERNESS_SUBCOMMAND.slice(2).toUpperCase();
  const oldEnv = `LOOP_${oldPrefix}_IDLE`;
  expect(withLegacyGovernessEnv({ [oldEnv]: "45" }).LOOP_GOVERNESS_IDLE).toBe(
    "45"
  );

  const runDir = tempDir();
  const legacyFile = join(runDir, LEGACY_GOVERNESS_STATE_FILE);
  const canonicalFile = join(runDir, "governess-state.json");
  writeFileSync(legacyFile, JSON.stringify({ marker: "legacy" }));
  migrateLegacyGovernessState(runDir, canonicalFile);
  expect(JSON.parse(readFileSync(canonicalFile, "utf8"))).toEqual({
    marker: "legacy",
  });
});
