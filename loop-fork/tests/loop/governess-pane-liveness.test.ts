import { expect, test } from "bun:test";
import {
  GOVERNESS_LIVENESS_FILE,
  GOVERNESS_RESTART_LIMIT,
  GOVERNESS_RESTART_WINDOW_MS,
  type GovernessPaneLivenessDeps,
  type GovernessPaneLivenessEvent,
  governessRespawnPaneArgs,
  handleGovernessPaneDied,
  parseGovernessPaneDiedArgs,
} from "../../src/loop/governess-pane-liveness";
import {
  createRunManifest,
  type RunManifest,
  setRunManifestState,
} from "../../src/loop/run-state";

const NOW = new Date("2026-07-29T20:30:00.000Z");
const input = {
  pane: "%42",
  runDir: "/tmp/loop-run-42",
  session: "repo-loop-42",
};

const activeManifest = (): RunManifest => ({
  ...createRunManifest(
    {
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "42",
      status: "running",
      tmuxSession: input.session,
    },
    "2026-07-29T20:00:00.000Z"
  ),
  tmuxPaneGoverness: input.pane,
});

const eventLine = (
  at: string,
  event: GovernessPaneLivenessEvent["event"] = "respawn-attempt"
): string =>
  JSON.stringify({
    at,
    event,
    pane: input.pane,
    pid: 999,
    session: input.session,
  });

const setup = (
  overrides: Partial<GovernessPaneLivenessDeps> = {}
): {
  deps: GovernessPaneLivenessDeps;
  events: GovernessPaneLivenessEvent[];
  respawns: string[];
} => {
  const events: GovernessPaneLivenessEvent[] = [];
  const respawns: string[] = [];
  const deps: GovernessPaneLivenessDeps = {
    appendEvent: (_path, event) => {
      events.push(event);
      return true;
    },
    inspectPane: () => ({
      dead: true,
      id: input.pane,
      session: input.session,
    }),
    now: () => NOW,
    readJournal: () => ({ ok: true, text: "" }),
    readManifest: () => activeManifest(),
    respawnPane: (pane) => {
      respawns.push(pane);
      return true;
    },
    ...overrides,
  };
  return { deps, events, respawns };
};

test("respawns an exact active dead Governess pane and journals both edges", () => {
  const fixture = setup();

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome).toEqual({
    action: "respawned",
    attemptsInWindow: 1,
    reason: "respawned",
  });
  expect(fixture.respawns).toEqual([input.pane]);
  expect(fixture.events.map((event) => event.event)).toEqual([
    "respawn-attempt",
    "respawned",
  ]);
  expect(fixture.events.every((event) => event.pane === input.pane)).toBe(true);
  expect(fixture.events.every((event) => event.session === input.session)).toBe(
    true
  );
});

test.each([
  "completed",
  "failed",
  "stopped",
] as const)("spares a %s run during intentional or terminal teardown", (state) => {
  const fixture = setup({
    readManifest: () => setRunManifestState(activeManifest(), state),
  });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome.action).toBe("spared");
  expect(outcome.reason).toBe("run-inactive-or-ownership-mismatch");
  expect(fixture.respawns).toEqual([]);
  expect(fixture.events).toEqual([]);
});

test.each([
  ["missing manifest", undefined],
  ["session mismatch", { ...activeManifest(), tmuxSession: "other-loop-42" }],
  ["pane mismatch", { ...activeManifest(), tmuxPaneGoverness: "%99" }],
] as const)("spares %s before inspecting tmux", (_label, manifest) => {
  let inspections = 0;
  const fixture = setup({
    inspectPane: () => {
      inspections += 1;
      return { dead: true, id: input.pane, session: input.session };
    },
    readManifest: () => manifest,
  });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome.action).toBe("spared");
  expect(inspections).toBe(0);
  expect(fixture.respawns).toEqual([]);
});

test.each([
  ["missing pane", undefined],
  ["live pane", { dead: false, id: input.pane, session: input.session }],
  ["wrong pane id", { dead: true, id: "%99", session: input.session }],
  ["wrong session", { dead: true, id: input.pane, session: "other" }],
] as const)("spares a %s tmux target", (_label, snapshot) => {
  const fixture = setup({ inspectPane: () => snapshot });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome.action).toBe("spared");
  expect(outcome.reason).toBe("session-pane-missing-or-live");
  expect(fixture.respawns).toEqual([]);
});

test.each([
  ["unreadable", { ok: false, text: "" }, "restart-journal-unreadable"],
  ["malformed", { ok: true, text: "not-json\n" }, "restart-journal-invalid"],
  [
    "wrong schema",
    { ok: true, text: '{"event":"respawn-attempt"}\n' },
    "restart-journal-invalid",
  ],
] as const)("fails closed for %s restart evidence", (_label, journal, reason) => {
  const fixture = setup({ readJournal: () => journal });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome).toEqual({
    action: "suppressed",
    attemptsInWindow: 0,
    reason,
  });
  expect(fixture.respawns).toEqual([]);
});

test("suppresses the fourth attempt inside the rolling restart window", () => {
  const recent = Array.from({ length: GOVERNESS_RESTART_LIMIT }, (_, index) =>
    eventLine(new Date(NOW.getTime() - index * 30_000).toISOString())
  ).join("\n");
  const fixture = setup({
    readJournal: () => ({ ok: true, text: `${recent}\n` }),
  });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome).toEqual({
    action: "suppressed",
    attemptsInWindow: GOVERNESS_RESTART_LIMIT,
    reason: "restart-budget",
  });
  expect(fixture.respawns).toEqual([]);
  expect(fixture.events.map((event) => event.event)).toEqual(["suppressed"]);
});

test("permits a new attempt after prior attempts leave the rolling window", () => {
  const old = Array.from({ length: GOVERNESS_RESTART_LIMIT }, (_, index) =>
    eventLine(
      new Date(
        NOW.getTime() - GOVERNESS_RESTART_WINDOW_MS - 1000 - index
      ).toISOString()
    )
  ).join("\n");
  const fixture = setup({
    readJournal: () => ({ ok: true, text: `${old}\n` }),
  });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome.action).toBe("respawned");
  expect(outcome.attemptsInWindow).toBe(1);
  expect(fixture.respawns).toEqual([input.pane]);
});

test("revalidates manifest ownership immediately before respawn", () => {
  let reads = 0;
  const fixture = setup({
    readManifest: () => {
      reads += 1;
      return reads === 1
        ? activeManifest()
        : setRunManifestState(activeManifest(), "stopped");
    },
  });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome.reason).toBe("ownership-changed-before-respawn");
  expect(fixture.respawns).toEqual([]);
  expect(fixture.events).toEqual([]);
});

test("revalidates dead pane state immediately before respawn", () => {
  let inspections = 0;
  const fixture = setup({
    inspectPane: () => {
      inspections += 1;
      return {
        dead: inspections === 1,
        id: input.pane,
        session: input.session,
      };
    },
  });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome.reason).toBe("pane-changed-before-respawn");
  expect(fixture.respawns).toEqual([]);
  expect(fixture.events).toEqual([]);
});

test("does not respawn when the attempt cannot be made durable", () => {
  const fixture = setup({ appendEvent: () => false });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome).toEqual({
    action: "failed",
    attemptsInWindow: 0,
    reason: "restart-attempt-not-durable",
  });
  expect(fixture.respawns).toEqual([]);
});

test("records a failed tmux respawn after consuming one attempt", () => {
  const fixture = setup({ respawnPane: () => false });

  const outcome = handleGovernessPaneDied(input, fixture.deps);

  expect(outcome).toEqual({
    action: "failed",
    attemptsInWindow: 1,
    reason: "tmux-respawn-failed",
  });
  expect(fixture.events.map((event) => event.event)).toEqual([
    "respawn-attempt",
    "respawn-failed",
  ]);
});

test("accepts canonical hook arguments and rejects ambiguous targets", () => {
  expect(
    parseGovernessPaneDiedArgs([input.runDir, input.session, input.pane])
  ).toEqual(input);
  expect(
    parseGovernessPaneDiedArgs([
      input.runDir,
      input.session,
      `${input.session}:0.2`,
    ]).pane
  ).toBe(`${input.session}:0.2`);
  expect(() =>
    parseGovernessPaneDiedArgs(["relative", input.session, input.pane])
  ).toThrow("Usage: loop __governess-pane-died");
  expect(() =>
    parseGovernessPaneDiedArgs([input.runDir, input.session, "other:0.2"])
  ).toThrow("Usage: loop __governess-pane-died");
});

test("respawn argv reuses tmux's recorded pane command", () => {
  expect(governessRespawnPaneArgs(input.pane)).toEqual([
    "respawn-pane",
    "-k",
    "-t",
    input.pane,
  ]);
  expect(governessRespawnPaneArgs(input.pane)).not.toContain("__governess");
});

test("journal path remains run-owned", () => {
  expect(`${input.runDir}/${GOVERNESS_LIVENESS_FILE}`).toBe(
    "/tmp/loop-run-42/governess-liveness.jsonl"
  );
});
