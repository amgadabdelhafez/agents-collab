import { expect, test } from "bun:test";
import {
  type AgentLivenessInput,
  type AgentLivenessState,
  initLivenessState,
  updateLiveness,
} from "../../src/loop/governess-detect";

// Fixed synthetic clock. Every timestamp below is derived from this base so the
// tests never depend on real wall-clock time.
const BASE_MS = Date.parse("2026-07-03T00:00:00.000Z");
const IDLE_MS = 30_000;

const iso = (offsetMs: number): string =>
  new Date(BASE_MS + offsetMs).toISOString();

const input = (
  paneHash: string,
  lastEventTs?: string
): AgentLivenessInput => ({ agent: "claude", paneHash, lastEventTs });

test("initLivenessState seeds a stable-since-now state with no event", () => {
  const state = initLivenessState("claude", BASE_MS, "hash-0");
  expect(state).toEqual({
    agent: "claude",
    paneHash: "hash-0",
    paneStableSinceMs: BASE_MS,
    lastEventTs: undefined,
  });
});

test("initLivenessState defaults paneHash to an empty string", () => {
  const state = initLivenessState("codex", BASE_MS);
  expect(state.paneHash).toBe("");
});

test("active: pane hash changes each tick is never suspect", () => {
  let state: AgentLivenessState = initLivenessState("claude", BASE_MS, "h0");
  // Events are stale, but a constantly changing pane keeps paneStable false.
  const staleEvent = iso(-IDLE_MS * 10);
  for (let tick = 1; tick <= 4; tick++) {
    const nowMs = BASE_MS + tick * IDLE_MS * 2;
    const result = updateLiveness(
      state,
      input(`h${tick}`, staleEvent),
      nowMs,
      IDLE_MS
    );
    expect(result.liveness.paneStable).toBe(false);
    expect(result.liveness.suspect).toBe(false);
    state = result.state;
  }
});

test("idle events but a still-changing pane is not suspect", () => {
  const state = initLivenessState("claude", BASE_MS, "h0");
  const nowMs = BASE_MS + IDLE_MS * 5;
  // lastEventTs is well older than idle -> eventsStale, but pane just changed.
  const { liveness } = updateLiveness(
    state,
    input("h1", iso(0)),
    nowMs,
    IDLE_MS
  );
  expect(liveness.lastEventAgeMs).toBe(IDLE_MS * 5);
  expect(liveness.paneStable).toBe(false);
  expect(liveness.suspect).toBe(false);
});

test("stuck: stale events and an unchanged pane for the idle window is suspect", () => {
  const state = initLivenessState("claude", BASE_MS, "frozen");
  const nowMs = BASE_MS + IDLE_MS; // pane unchanged for exactly the idle window
  const { liveness } = updateLiveness(
    state,
    input("frozen", iso(-IDLE_MS)),
    nowMs,
    IDLE_MS
  );
  expect(liveness.paneStable).toBe(true);
  expect(liveness.lastEventAgeMs).toBe(IDLE_MS * 2);
  expect(liveness.suspect).toBe(true);
});

test("recovered: a pane-hash change resets stability and clears suspect", () => {
  const initial = initLivenessState("claude", BASE_MS, "frozen");

  const stuckAt = BASE_MS + IDLE_MS;
  const stuck = updateLiveness(
    initial,
    input("frozen", iso(-IDLE_MS)),
    stuckAt,
    IDLE_MS
  );
  expect(stuck.liveness.suspect).toBe(true);

  // Next tick: pane hash changes -> paneStableSinceMs resets to now.
  const recoverAt = stuckAt + IDLE_MS;
  const recovered = updateLiveness(
    stuck.state,
    input("moved", iso(-IDLE_MS)),
    recoverAt,
    IDLE_MS
  );
  expect(recovered.state.paneStableSinceMs).toBe(recoverAt);
  expect(recovered.liveness.paneStable).toBe(false);
  expect(recovered.liveness.suspect).toBe(false);
});

test("no events ever with a stable pane yields infinite age and stale events", () => {
  const state = initLivenessState("claude", BASE_MS, "frozen");
  const nowMs = BASE_MS + IDLE_MS * 3;
  const { liveness } = updateLiveness(
    state,
    input("frozen"),
    nowMs,
    IDLE_MS
  );
  expect(liveness.lastEventAgeMs).toBe(Number.POSITIVE_INFINITY);
  expect(liveness.lastEventAgeMs >= IDLE_MS).toBe(true);
  expect(liveness.paneStable).toBe(true);
  expect(liveness.suspect).toBe(true);
});

test("an unparseable event timestamp is treated as infinitely old", () => {
  const state = initLivenessState("claude", BASE_MS, "frozen");
  const { liveness } = updateLiveness(
    state,
    input("frozen", "not-a-real-timestamp"),
    BASE_MS + IDLE_MS,
    IDLE_MS
  );
  expect(liveness.lastEventAgeMs).toBe(Number.POSITIVE_INFINITY);
});

test("a future event timestamp clamps the age to zero", () => {
  const state = initLivenessState("claude", BASE_MS, "frozen");
  const { liveness } = updateLiveness(
    state,
    input("frozen", iso(IDLE_MS)),
    BASE_MS,
    IDLE_MS
  );
  expect(liveness.lastEventAgeMs).toBe(0);
});

test("a later input event timestamp overrides the carried-over one", () => {
  const state = initLivenessState("claude", BASE_MS, "frozen");
  const first = updateLiveness(
    state,
    input("frozen", iso(0)),
    BASE_MS + IDLE_MS,
    IDLE_MS
  );
  // No lastEventTs on this tick -> carry the previous one forward.
  const carried = updateLiveness(
    first.state,
    input("frozen"),
    BASE_MS + IDLE_MS * 2,
    IDLE_MS
  );
  expect(carried.state.lastEventTs).toBe(iso(0));
  expect(carried.liveness.lastEventAgeMs).toBe(IDLE_MS * 2);
});
