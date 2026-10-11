// r9 (T3): the server's config, rebind rule, lease sweep, lease observation,
// route mount and server filesystem for every supervisor as an A2A V2
// recipient. The T1 lease store is faked; the locator resolver is the real one
// over a scratch home.

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type A2AV2Config,
  type A2AV2EnrollmentOutcome,
  ConfiguredA2AV2SessionEnrollment,
  configuredA2AV2RebindAuthority,
  createLoopOrchestrationFetchHandler,
  createOrchestrationSweep,
  createSupervisorEndpointLeaseObserver,
  parseLoopOrchestrationConfig,
  SupervisorEndpointLeaseEnrollment,
  type SupervisorEndpointLeaseObservation,
  serverSupervisorEndpointFs,
} from "../../src/loop/loop-orchestration-server";
import {
  createSupervisorEndpointLocatorResolver,
  type SupervisorEndpointLeaseStore,
  type SupervisorEndpointLeaseV2,
  supervisorEndpointRoots,
} from "../../src/loop/supervisor-endpoint-lease";
import type { SupervisorSessionDescriptorV2 } from "../../src/loop/supervisor-session-v2";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
const scratch = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "r9-t3-server-")));
  roots.push(root);
  return root;
};

const supervisors = [
  {
    mailbox: "/Users/example/.loop/mailbox/harness.jsonl",
    principal: "principal:harness",
    supervisorId: "supervisor:harness",
    tokenEnv: "LOOP_TOKEN_HARNESS",
  },
  {
    mailbox: "/Users/example/.loop/mailbox/harvto.jsonl",
    principal: "principal:harvto",
    supervisorId: "supervisor:harvto",
    tokenEnv: "LOOP_TOKEN_HARVTO",
  },
  {
    manifestPath: "/Users/example/.loop/runs/repo/1/manifest.json",
    principal: "principal:runner",
    seat: "codex",
    supervisorId: "supervisor:runner",
    tokenEnv: "LOOP_TOKEN_RUNNER",
  },
];

const section = (extra: Record<string, unknown> = {}) => ({
  databaseUrlEnv: "LOOP_A2A_V2_DATABASE_URL",
  endpointRef: "endpoint:loop-run",
  policy: {
    claimTimeoutMs: 60_000,
    escalationTimeoutMs: 120_000,
    maxDeliveryAttempts: 3,
    retryDelayMs: 1000,
  },
  principal: "principal:harness",
  routePath: "/a2a/v2",
  sessionTtlMs: 60_000,
  tenant: "tenant:local",
  ...extra,
});

const config = (a2aV2: unknown) => ({
  a2aV2,
  address: "127.0.0.1:7233",
  buildId: "loop-orchestration.v1",
  grants: [
    {
      from: "supervisor:harvto",
      operations: ["receive"],
      principal: "principal:harvto",
      to: "supervisor:harness",
    },
  ],
  hostname: "127.0.0.1",
  identity: "loop-orchestration@local",
  namespace: "default",
  port: 7321,
  schema: "loop-orchestration-server.v1",
  stateDir: "/private/tmp/loop-orchestration-state",
  supervisors,
  taskQueue: "loop-orchestration",
});

test("r9 config: the recipient is optional, and a named one is still r8's Loop binding", () => {
  const parsed = parseLoopOrchestrationConfig(config(section()));
  expect(parsed.a2aV2?.recipient).toBeUndefined();
  expect(parsed.a2aV2).not.toHaveProperty("recipient");
  expect(parsed.a2aV2?.principal).toBe("principal:harness");
  // Named: it must be a supervisor with a manifestPath, exactly as in r8.
  expect(
    parseLoopOrchestrationConfig(
      config(section({ recipient: "supervisor:runner" }))
    ).a2aV2?.recipient
  ).toBe("supervisor:runner");
  expect(() =>
    parseLoopOrchestrationConfig(
      config(section({ recipient: "supervisor:harness" }))
    )
  ).toThrow("orchestration a2aV2 recipient is not a Loop binding");
  expect(() =>
    parseLoopOrchestrationConfig(
      config(section({ recipient: "supervisor:nobody" }))
    )
  ).toThrow("orchestration a2aV2 recipient is not a Loop binding");
  expect(() =>
    parseLoopOrchestrationConfig(config(section({ recipient: "harness" })))
  ).toThrow("orchestration a2aV2 recipient is invalid");
  // The control principal must still be a configured supervisor's.
  expect(() =>
    parseLoopOrchestrationConfig(
      config(section({ principal: "principal:nobody" }))
    )
  ).toThrow("orchestration a2aV2 principal is not configured");
  // No new keys: an unknown one is refused as before.
  expect(() =>
    parseLoopOrchestrationConfig(config(section({ supervisors: [] })))
  ).toThrow("orchestration a2aV2 has invalid fields");
});

const descriptor = (
  overrides: Partial<SupervisorSessionDescriptorV2>
): SupervisorSessionDescriptorV2 => ({
  descriptorId: "descriptor:harvto",
  endpointDigest: "a".repeat(64),
  endpointRef: "endpoint:loop-run",
  expiresAt: "2026-10-12T00:00:00.000Z",
  issuedAt: "2026-10-11T00:00:00.000Z",
  principal: "principal:harvto",
  provider: "claude-code",
  recipient: "supervisor:harvto",
  revision: 1,
  schema: "supervisor-session-descriptor.v2",
  sessionRef: "session:s1",
  tenantId: "tenant:local",
  ...overrides,
});

test("r9 rebind rule: a lease-backed descriptor rebinds only in its seat's own scope, from endpoint:<kind> to endpoint:<kind>", () => {
  const a2a = parseLoopOrchestrationConfig(
    config(
      section({
        endpointRef: "endpoint:codex-app-server",
        recipient: "supervisor:runner",
      })
    )
  ).a2aV2 as A2AV2Config;
  const principalFor = (recipient: string) =>
    supervisors.find((entry) => entry.supervisorId === recipient)?.principal;
  const authority = configuredA2AV2RebindAuthority(
    a2a,
    ["supervisor:runner"],
    principalFor
  );
  const decide = (
    current: SupervisorSessionDescriptorV2,
    next: SupervisorSessionDescriptorV2,
    principal: string,
    tenantId = "tenant:local"
  ) =>
    authority.decide({ current, next, trustedScope: { principal, tenantId } })
      .allowed;
  const seat = descriptor({});
  // A claim moving harvto from a Loop run to a Codex thread: the provider
  // changes with the kind.
  expect(
    decide(
      seat,
      descriptor({
        endpointRef: "endpoint:codex-thread",
        provider: "codex-app-server",
        revision: 2,
      }),
      "principal:harvto"
    )
  ).toBe(true);
  // Not in another principal's scope, not another tenant, not to a non-lease
  // endpoint, not another descriptor or recipient.
  expect(decide(seat, descriptor({ revision: 2 }), "principal:harness")).toBe(
    false
  );
  expect(
    decide(
      seat,
      descriptor({ revision: 2 }),
      "principal:harvto",
      "tenant:other"
    )
  ).toBe(false);
  expect(
    decide(
      seat,
      descriptor({ endpointRef: "endpoint:evil", revision: 2 }),
      "principal:harvto"
    )
  ).toBe(false);
  expect(
    decide(
      seat,
      descriptor({ descriptorId: "descriptor:other", revision: 2 }),
      "principal:harvto"
    )
  ).toBe(false);
  expect(
    decide(
      seat,
      descriptor({ principal: "principal:harness", revision: 2 }),
      "principal:harvto"
    )
  ).toBe(false);
  // Defense in depth: the store reads `current` by the trusted scope, so its
  // principal is the seat's in practice. A current descriptor that names
  // another principal (a foreign or corrupt row) is still never taken over,
  // even when the scope and the next descriptor are the seat's own.
  expect(
    decide(
      descriptor({ principal: "principal:harness" }),
      descriptor({ revision: 2 }),
      "principal:harvto"
    )
  ).toBe(false);
  // r8's rule is unchanged for r8's descriptor ...
  const r8 = descriptor({
    descriptorId: "descriptor:runner",
    endpointRef: "endpoint:codex-app-server",
    principal: "principal:harness",
    provider: "codex-app-server",
    recipient: "supervisor:runner",
  });
  expect(decide(r8, { ...r8, revision: 2 }, "principal:harness")).toBe(true);
  // ... but never rebinds a lease-backed descriptor back to r8's endpoint.
  const leased = descriptor({
    descriptorId: "descriptor:runner",
    endpointRef: "endpoint:codex-thread",
    principal: "principal:harness",
    provider: "codex-app-server",
    recipient: "supervisor:runner",
  });
  expect(
    decide(
      leased,
      { ...leased, endpointRef: "endpoint:codex-app-server", revision: 2 },
      "principal:harness"
    )
  ).toBe(false);
  // A claim in the seat's own scope may take over r8's descriptor there.
  const ownScope = descriptor({
    descriptorId: "descriptor:runner",
    endpointRef: "endpoint:codex-app-server",
    principal: "principal:runner",
    provider: "codex-app-server",
    recipient: "supervisor:runner",
  });
  expect(
    decide(
      ownScope,
      { ...ownScope, endpointRef: "endpoint:loop-run", revision: 2 },
      "principal:runner"
    )
  ).toBe(true);
  // Without the seat principal binding (r8 composition), only r8's rule.
  expect(
    configuredA2AV2RebindAuthority(a2a).decide({
      current: seat,
      next: descriptor({ revision: 2 }),
      trustedScope: { principal: "principal:harvto", tenantId: "tenant:local" },
    }).allowed
  ).toBe(false);
});

const START = Date.parse("2026-10-11T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(START + offsetMs).toISOString();

const lease = (
  recipient: string,
  overrides: Partial<SupervisorEndpointLeaseV2> = {}
): SupervisorEndpointLeaseV2 => ({
  descriptorId: `descriptor:${recipient}`,
  descriptorRevision: 1,
  epoch: 4,
  expiresAt: iso(60_000),
  holderRef: `holder:${recipient.slice("supervisor:".length)}`,
  kind: "loop-run",
  locator: {
    kind: "loop-run",
    repoId: "repo-1",
    runId: "run-1",
    seat: "claude",
  },
  principal: supervisors.find((entry) => entry.supervisorId === recipient)
    ?.principal as string,
  recipient,
  releasedAt: null,
  schema: "supervisor-endpoint-lease.v2",
  tenantId: "tenant:local",
  ...overrides,
});

const sweepFixture = (rows: SupervisorEndpointLeaseV2[]) => {
  const clock = { offsetMs: 0 };
  const calls: { input: unknown; operation: string }[] = [];
  const observations = new Map<string, SupervisorEndpointLeaseObservation>();
  const observed: string[] = [];
  const logs: string[] = [];
  const results: { release?: unknown; renew?: unknown } = {};
  let listFailure: Error | undefined;
  const leases: Pick<
    SupervisorEndpointLeaseStore,
    "list" | "release" | "renew"
  > = {
    list: (tenantId) =>
      listFailure
        ? Promise.reject(listFailure)
        : Promise.resolve(rows.filter(() => tenantId === "tenant:local")),
    release: (input) => {
      calls.push({ input, operation: "release" });
      return Promise.resolve(
        (results.release ?? {
          changed: true,
          lease: rows[0],
          status: "released",
        }) as never
      );
    },
    renew: (input) => {
      calls.push({ input, operation: "renew" });
      return Promise.resolve(
        (results.renew ?? {
          descriptor: {},
          lease: rows[0],
          status: "renewed",
        }) as never
      );
    },
  };
  const enrollment = new SupervisorEndpointLeaseEnrollment({
    leases,
    log: (line) => logs.push(line),
    now: () => iso(clock.offsetMs),
    observe: (row) => {
      observed.push(row.recipient);
      return Promise.resolve(observations.get(row.recipient) ?? "live");
    },
    principalForRecipient: (recipient) =>
      supervisors.find((entry) => entry.supervisorId === recipient)?.principal,
    sessionTtlMs: 60_000,
    tenant: "tenant:local",
  });
  return {
    calls,
    clock,
    enrollment,
    failList: (error: Error | undefined) => {
      listFailure = error;
    },
    logs,
    observations,
    observed,
    results,
  };
};

test("lease sweep renews a live lease with its stored fence only once less than half the TTL remains, in the seat's scope", async () => {
  const f = sweepFixture([lease("supervisor:harvto")]);
  expect(await f.enrollment.maintain()).toEqual([
    { recipient: "supervisor:harvto", state: "unchanged" },
  ]);
  expect(f.calls).toEqual([]);
  // Throttled: a second tick inside the pass interval does nothing at all.
  f.clock.offsetMs = 1000;
  expect(await f.enrollment.maintain()).toEqual([]);
  expect(f.observed).toEqual(["supervisor:harvto"]);
  // 31s later less than half the TTL remains: renewed with the same fence.
  f.clock.offsetMs = 31_000;
  expect(await f.enrollment.maintain()).toEqual([
    { recipient: "supervisor:harvto", state: "enrolled" },
  ]);
  expect(f.calls).toEqual([
    {
      input: {
        fence: { epoch: 4, holderRef: "holder:harvto" },
        recipient: "supervisor:harvto",
        scope: { principal: "principal:harvto", tenantId: "tenant:local" },
        ttlMs: 60_000,
      },
      operation: "renew",
    },
  ]);
});

test("lease sweep lets the TTL lapse when the session is not observed live, reports the seat not enrolled, and releases a lease whose run ended", async () => {
  const f = sweepFixture([
    lease("supervisor:harvto"),
    lease("supervisor:harness", { expiresAt: iso(-5000) }),
  ]);
  f.observations.set("supervisor:harvto", "unavailable");
  f.observations.set("supervisor:harness", "unavailable");
  const outcomes = await f.enrollment.maintain();
  expect(outcomes.map((outcome) => [outcome.recipient, outcome.state])).toEqual(
    [
      ["supervisor:harvto", "failed"],
      ["supervisor:harness", "failed"],
    ]
  );
  expect(
    outcomes.map((outcome) =>
      outcome.state === "failed" ? (outcome.error as Error).message : ""
    )
  ).toEqual([
    "recipient endpoint is not ready",
    "recipient endpoint is not ready",
  ]);
  // Nothing renewed: the TTL lapses.
  expect(f.calls).toEqual([]);
  expect(f.enrollment.notEnrolled()).toEqual([
    "supervisor:harness",
    "supervisor:harvto",
  ]);
  // Since the failure, or since the expiry of an already-expired lease.
  expect(f.enrollment.notEnrolledSince("supervisor:harvto")).toBe(START);
  expect(f.enrollment.notEnrolledSince("supervisor:harness")).toBe(
    START - 5000
  );
  // harvto's run ended: released with its own fence; harness comes back live
  // and, though expired, is renewed (expiry alone never fences).
  f.observations.set("supervisor:harvto", "terminal");
  f.observations.set("supervisor:harness", "live");
  f.clock.offsetMs = 10_000;
  expect(await f.enrollment.maintain()).toEqual([
    { recipient: "supervisor:harvto", state: "released" },
    { recipient: "supervisor:harness", state: "enrolled" },
  ]);
  expect(f.calls.map((call) => call.operation)).toEqual(["release", "renew"]);
  expect(f.calls[0]?.input).toEqual({
    fence: { epoch: 4, holderRef: "holder:harvto" },
    recipient: "supervisor:harvto",
    scope: { principal: "principal:harvto", tenantId: "tenant:local" },
  });
  expect(f.enrollment.notEnrolled()).toEqual([]);
});

test("lease sweep never acts on a row of an unconfigured supervisor, a foreign principal, another tenant or a released lease; a fenced renew waits for the next pass", async () => {
  const f = sweepFixture([
    lease("supervisor:stranger", { principal: "principal:stranger" }),
    lease("supervisor:harvto", {
      expiresAt: iso(1000),
      principal: "principal:harness",
    }),
    lease("supervisor:harness", {
      expiresAt: iso(1000),
      tenantId: "tenant:other",
    }),
    lease("supervisor:runner", { expiresAt: iso(1000), releasedAt: iso(-1) }),
  ]);
  expect(await f.enrollment.maintain()).toEqual([]);
  expect(f.observed).toEqual([]);
  expect(f.calls).toEqual([]);
  const g = sweepFixture([
    lease("supervisor:harvto", { expiresAt: iso(1000) }),
  ]);
  g.results.renew = { reason: "epoch-mismatch", status: "fenced" };
  expect(await g.enrollment.maintain()).toEqual([
    { recipient: "supervisor:harvto", state: "deferred" },
  ]);
  g.results.renew = { reason: "not-contained", status: "locator-refused" };
  g.clock.offsetMs = 10_000;
  const [refused] = await g.enrollment.maintain();
  expect(refused?.state).toBe("failed");
  expect(refused?.state === "failed" && (refused.error as Error).message).toBe(
    "recipient endpoint locator refused"
  );
});

test("lease sweep: an unobservable kind is left to its holder; a store that cannot list is logged once per change and fails no seat", async () => {
  const f = sweepFixture([
    lease("supervisor:harvto", { expiresAt: iso(1000) }),
  ]);
  f.observations.set("supervisor:harvto", "unobserved");
  expect(await f.enrollment.maintain()).toEqual([
    { recipient: "supervisor:harvto", state: "unchanged" },
  ]);
  expect(f.calls).toEqual([]);
  f.failList(new Error("lease store down"));
  for (const offsetMs of [10_000, 20_000]) {
    f.clock.offsetMs = offsetMs;
    expect(await f.enrollment.maintain()).toEqual([]);
  }
  expect(f.logs).toEqual([
    "orchestration A2A V2 endpoint lease sweep failed: lease store down",
  ]);
  // Its expiry passed while unobserved: now it is not enrolled since then.
  f.failList(undefined);
  f.clock.offsetMs = 30_000;
  const [expired] = await f.enrollment.maintain();
  expect(expired?.state).toBe("failed");
  expect(f.enrollment.notEnrolledSince("supervisor:harvto")).toBe(START + 1000);
});

test("lease renewal on demand (the recipient route's catch-up): an expired lease of a live session is renewed with its own fence; anything else is left to the pass", async () => {
  const f = sweepFixture([
    lease("supervisor:harvto", { expiresAt: iso(-500) }),
    lease("supervisor:harness"),
    lease("supervisor:runner", { expiresAt: iso(-500), releasedAt: iso(-1) }),
    lease("supervisor:stranger", {
      expiresAt: iso(-500),
      principal: "principal:stranger",
    }),
  ]);
  // The renewal lagged behind the TTL; the session is observed live.
  expect(await f.enrollment.renewIfLive("supervisor:harvto")).toBe(true);
  expect(f.calls).toEqual([
    {
      input: {
        fence: { epoch: 4, holderRef: "holder:harvto" },
        recipient: "supervisor:harvto",
        scope: { principal: "principal:harvto", tenantId: "tenant:local" },
        ttlMs: 60_000,
      },
      operation: "renew",
    },
  ]);
  // A live lease needs nothing; a released one, an unconfigured supervisor's
  // and a session not observed live are not renewed.
  expect(await f.enrollment.renewIfLive("supervisor:harness")).toBe(true);
  expect(await f.enrollment.renewIfLive("supervisor:runner")).toBe(false);
  expect(await f.enrollment.renewIfLive("supervisor:stranger")).toBe(false);
  f.observations.set("supervisor:harvto", "unavailable");
  expect(await f.enrollment.renewIfLive("supervisor:harvto")).toBe(false);
  f.observations.set("supervisor:harvto", "terminal");
  expect(await f.enrollment.renewIfLive("supervisor:harvto")).toBe(false);
  expect(f.calls.map((call) => call.operation)).toEqual(["renew"]);
  // A fenced renewal (a newer claim) is no live lease; nor is a store error.
  f.observations.set("supervisor:harvto", "live");
  f.results.renew = { reason: "epoch-mismatch", status: "fenced" };
  expect(await f.enrollment.renewIfLive("supervisor:harvto")).toBe(false);
  f.failList(new Error("lease store down"));
  expect(await f.enrollment.renewIfLive("supervisor:harvto")).toBe(false);
  // Nothing was reported or released on demand.
  expect(f.logs).toEqual([]);
  expect(f.enrollment.notEnrolled()).toEqual([]);
});

test("the orchestration sweep clears a seat a lease release or an r8 hand-over removed, and r8's enrollment leaves a leased seat alone", async () => {
  const outcomes: A2AV2EnrollmentOutcome[][] = [
    [
      {
        error: new Error("down"),
        recipient: "supervisor:harvto",
        state: "failed",
      },
    ],
    [{ recipient: "supervisor:harvto", state: "released" }],
    [
      {
        error: new Error("down"),
        recipient: "supervisor:runner",
        state: "failed",
      },
    ],
    [{ recipient: "supervisor:runner", state: "leased" }],
  ];
  const notEnrolled: (readonly string[])[] = [];
  const logs: string[] = [];
  const sweep = createOrchestrationSweep({
    enrollment: { maintain: () => Promise.resolve(outcomes.shift() ?? []) },
    log: (line) => logs.push(line),
    reconcilers: [],
    setHealthy: () => undefined,
    setNotEnrolled: (seats) => notEnrolled.push(seats),
  });
  for (let tick = 0; tick < 4; tick += 1) {
    await sweep();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(notEnrolled.slice(1)).toEqual([
    ["supervisor:harvto"],
    [],
    ["supervisor:runner"],
    [],
  ]);
  expect(logs).toContain(
    "orchestration A2A V2 endpoint lease released for supervisor:harvto"
  );
  // r8's enrollment: a seat with a lease row is the lease's now.
  let storeCalls = 0;
  const service = {
    currentSession: () => {
      storeCalls += 1;
      return Promise.resolve(undefined);
    },
    rebindSession: () => Promise.reject(new Error("unexpected")),
    registerSession: () => Promise.reject(new Error("unexpected")),
  };
  const held = new Set(["supervisor:runner"]);
  const r8 = new ConfiguredA2AV2SessionEnrollment({
    config: parseLoopOrchestrationConfig(
      config(section({ recipient: "supervisor:runner" }))
    ).a2aV2 as A2AV2Config,
    directory: { resolve: () => Promise.resolve(undefined) },
    leaseHeld: (recipient) => Promise.resolve(held.has(recipient)),
    now: () => iso(0),
    recipients: ["supervisor:runner"],
    service,
  });
  expect(await r8.maintain()).toEqual([
    { recipient: "supervisor:runner", state: "leased" },
  ]);
  expect(storeCalls).toBe(0);
  expect(r8.notEnrolled()).toEqual([]);
  // Without a lease row r8 enrolls it as before (here: not running).
  held.clear();
  const [failed] = await r8.maintain();
  expect(failed?.state).toBe("failed");
});

/** A scratch server home with runs in each state, for the real resolver. */
const observerFixture = () => {
  const home = scratch();
  const run = (runId: string, manifest: Record<string, unknown>) => {
    const dir = join(home, ".loop", "runs", "repo-1", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        createdAt: "2026-10-11T00:00:00.000Z",
        cwd: home,
        mode: "paired",
        pid: 1,
        repoId: "repo-1",
        runId,
        updatedAt: "2026-10-11T00:00:00.000Z",
        ...manifest,
      })
    );
    return dir;
  };
  run("run-live", {
    a2aSupervisorId: "supervisor:harvto",
    state: "working",
    status: "running",
  });
  run("run-done", {
    a2aSupervisorId: "supervisor:harvto",
    state: "stopped",
    status: "stopped",
  });
  run("run-other", {
    a2aSupervisorId: "supervisor:harness",
    state: "working",
    status: "running",
  });
  const outside = join(home, "outside");
  mkdirSync(outside);
  writeFileSync(
    join(outside, "manifest.json"),
    JSON.stringify({
      a2aSupervisorId: "supervisor:harvto",
      repoId: "repo-1",
      runId: "run-link",
    })
  );
  symlinkSync(outside, join(home, ".loop", "runs", "repo-1", "run-link"));
  mkdirSync(join(home, ".loop", "sessions", "harvto", "chan-1"), {
    recursive: true,
  });
  const resolveLocator = createSupervisorEndpointLocatorResolver({
    fs: serverSupervisorEndpointFs,
    roots: supervisorEndpointRoots(home),
  });
  return { home, resolveLocator, run };
};

test("lease observation re-resolves the stored locator on every pass under the server's own roots, reads the run's state, and asks the kind's probe", async () => {
  const f = observerFixture();
  const observe = createSupervisorEndpointLeaseObserver({
    resolveLocator: f.resolveLocator,
  });
  const at = (runId: string) =>
    lease("supervisor:harvto", {
      locator: { kind: "loop-run", repoId: "repo-1", runId, seat: "claude" },
    });
  expect(await observe(at("run-live"))).toBe("live");
  expect(await observe(at("run-done"))).toBe("terminal");
  // SECURITY: a symlinked run dir, another supervisor's run, a missing run.
  expect(await observe(at("run-link"))).toBe("unavailable");
  expect(await observe(at("run-other"))).toBe("unavailable");
  expect(await observe(at("run-missing"))).toBe("unavailable");
  // Re-resolved every time: the live run now names another supervisor.
  f.run("run-live", {
    a2aSupervisorId: "supervisor:harness",
    state: "working",
    status: "running",
  });
  expect(await observe(at("run-live"))).toBe("unavailable");
  // A Claude channel session has no run: without a probe it is unobserved.
  const channel = lease("supervisor:harvto", {
    kind: "claude-channel",
    locator: { kind: "claude-channel", sessionId: "chan-1" },
  });
  expect(await observe(channel)).toBe("unobserved");
  expect(
    await observe(
      lease("supervisor:harness", {
        kind: "claude-channel",
        locator: { kind: "claude-channel", sessionId: "chan-1" },
      })
    )
  ).toBe("unavailable");
  // With a probe, the probe decides liveness (and a throwing probe is unavailable).
  let ready: boolean | Error = true;
  const probed = createSupervisorEndpointLeaseObserver({
    probe: () =>
      ready instanceof Error ? Promise.reject(ready) : Promise.resolve(ready),
    resolveLocator: f.resolveLocator,
  });
  expect(await probed(channel)).toBe("live");
  ready = false;
  expect(await probed(channel)).toBe("unavailable");
  ready = new Error("probe exploded");
  expect(await probed(channel)).toBe("unavailable");
  // A run that ended is terminal before any probe.
  ready = true;
  expect(await probed(at("run-done"))).toBe("terminal");
});

test("the server's resolver filesystem reads a regular file only: never through a symlink, a FIFO or an oversized file", () => {
  const root = scratch();
  const file = join(root, "manifest.json");
  writeFileSync(file, JSON.stringify({ ok: true }));
  expect(serverSupervisorEndpointFs.readJson(file)).toEqual({ ok: true });
  expect(serverSupervisorEndpointFs.realpath(file)).toBe(file);
  symlinkSync(file, join(root, "link.json"));
  expect(() =>
    serverSupervisorEndpointFs.readJson(join(root, "link.json"))
  ).toThrow();
  const fifo = join(root, "fifo.json");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  // Opened non-blocking and refused before any read: this must not hang.
  expect(() => serverSupervisorEndpointFs.readJson(fifo)).toThrow(
    "endpoint file is not a regular file"
  );
  const big = join(root, "big.json");
  writeFileSync(big, `"${"x".repeat(1024 * 1024)}"`);
  expect(() => serverSupervisorEndpointFs.readJson(big)).toThrow(
    "endpoint file is not a regular file"
  );
  mkdirSync(join(root, "dir.json"));
  expect(() =>
    serverSupervisorEndpointFs.readJson(join(root, "dir.json"))
  ).toThrow();
  expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ ok: true }));
});

test("the fetch handler routes r9 paths to the all-supervisors route, answers 503 under a disabled plane's routePath, and leaves V1 and /healthz alone", async () => {
  const seen: string[] = [];
  const v1 = (request: Request) => {
    seen.push(`v1 ${new URL(request.url).pathname}`);
    return Promise.resolve(new Response("v1"));
  };
  const host = {
    httpHandler: () => v1,
    workerState: () => "RUNNING",
  } as never;
  const mounted = createLoopOrchestrationFetchHandler({
    a2aV2Service: {
      allSupervisorsRoute: {
        httpHandler: (request) => {
          seen.push(`r9 ${new URL(request.url).pathname}`);
          return Promise.resolve(new Response("r9"));
        },
        routePath: "/a2a/v2",
      },
      httpHandler: () => Promise.resolve(new Response("bare")),
      notEnrolledDeferral: () => ({
        boundMs: 1,
        deferredDeliveries: 0,
        notEnrolledFailures: 0,
        recipientsDeferred: 0,
      }),
      pathname: "/a2a/v2",
      readinessOutage: () => ({
        boundMs: 1,
        deferredDeliveries: 0,
        outageFailures: 0,
        recipientsDeferred: 0,
      }),
    },
    authenticator: { authenticate: () => undefined } as never,
    host,
    reconciliationHealthy: () => true,
  });
  for (const path of [
    "/a2a/v2/sessions/claim",
    "/a2a/v2/supervisors/harvto",
    "/a2a/v2/messages/supervisor-message%3Av2%3Aabc",
  ]) {
    expect(
      await (await mounted(new Request(`http://127.0.0.1${path}`))).text()
    ).toBe("r9");
  }
  // Not an r9 shape: the r8 routes and V1 as before.
  expect(
    await (await mounted(new Request("http://127.0.0.1/a2a/v2"))).text()
  ).toBe("bare");
  expect(
    await (
      await mounted(new Request("http://127.0.0.1/a2a/v2/sessions/claim/extra"))
    ).text()
  ).toBe("v1");
  expect(
    await (await mounted(new Request("http://127.0.0.1/api/v1/threads"))).text()
  ).toBe("v1");
  // Disabled by a fault: its routes answer 503; V1 and /healthz are unchanged.
  const disabled = createLoopOrchestrationFetchHandler({
    a2aV2DisabledRoutePath: () => "/a2a/v2",
    a2aV2State: () => ({ reason: "database-unreachable", state: "disabled" }),
    authenticator: { authenticate: () => undefined } as never,
    host,
    reconciliationHealthy: () => true,
  });
  for (const path of [
    "/a2a/v2",
    "/a2a/v2/sessions/claim",
    "/a2a/v2/recipient",
  ]) {
    const response = await disabled(
      new Request(`http://127.0.0.1${path}`, { method: "POST" })
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "v2-unavailable" },
    });
  }
  expect(
    await (await disabled(new Request("http://127.0.0.1/a2a/v2x"))).text()
  ).toBe("v1");
  expect(
    await (
      await disabled(new Request("http://127.0.0.1/api/v1/threads"))
    ).text()
  ).toBe("v1");
  const health = await (
    await disabled(new Request("http://127.0.0.1/healthz"))
  ).json();
  expect(health).toEqual({
    a2aV2: "disabled",
    a2aV2Reason: "database-unreachable",
    schema: "loop-orchestration-health.v1",
    state: "ready",
  });
});
