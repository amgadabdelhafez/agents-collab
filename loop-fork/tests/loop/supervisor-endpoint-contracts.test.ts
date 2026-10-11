import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { TaskState } from "@a2a-js/sdk";
import {
  A2A_V2_ROUTE_ERROR_STATUS,
  A2A_V2_SESSION_REQUEST_SCHEMAS,
  a2aV2MessageStatusPath,
  a2aV2SessionRoutePath,
  a2aV2SupervisorIngressPath,
  a2aV2TaskStateName,
  a2aV2WorkResultCompleted,
  matchA2AV2Route,
  parseA2AV2SessionRequest,
} from "../../src/loop/a2a-v2-routes-contract";
import {
  createSupervisorEndpointLocatorResolver,
  decideSupervisorEndpointLeaseClaim,
  decideSupervisorEndpointLeaseFence,
  parseSupervisorEndpointLocator,
  requireLoopbackCodexRemoteUrl,
  resolveSupervisorEndpointLocator,
  resolveSupervisorEndpointRun,
  SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA,
  type SupervisorEndpointFs,
  type SupervisorEndpointLeaseV2,
  type SupervisorEndpointLocator,
  SupervisorEndpointLocatorError,
  type SupervisorEndpointLocatorRefusal,
  supervisorEndpointContainedRealpath,
  supervisorEndpointDescriptorIdentity,
  supervisorEndpointLeaseExpiresAt,
  supervisorEndpointLeaseState,
  supervisorEndpointLocatorDigest,
  supervisorEndpointLocatorRefused,
  supervisorEndpointRoots,
  supervisorEndpointRunDir,
  supervisorEndpointSessionDir,
} from "../../src/loop/supervisor-endpoint-lease";
import {
  decideSupervisorEndpointRoute,
  SUPERVISOR_ENDPOINT_REASONS,
  supervisorEndpointBridgeRoute,
  supervisorEndpointLocatorRefusedOutcome,
  supervisorEndpointSeatScope,
  supervisorEndpointUndeliverable,
} from "../../src/loop/supervisor-message-v2-endpoint-contract";

const NOW = new Date("2026-10-11T12:00:00.000Z");

const lease = (
  overrides: Partial<SupervisorEndpointLeaseV2> = {}
): SupervisorEndpointLeaseV2 => ({
  descriptorId: `supervisor-session-descriptor:v2:${"a".repeat(64)}`,
  descriptorRevision: 1,
  epoch: 3,
  expiresAt: "2026-10-11T12:01:00.000Z",
  holderRef: "loop-run:run-a",
  kind: "loop-run",
  locator: { kind: "loop-run", repoId: "repo-a", runId: "7", seat: "claude" },
  principal: "principal:seat-a",
  recipient: "supervisor:a",
  releasedAt: null,
  schema: SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA,
  tenantId: "tenant-a",
  ...overrides,
});

describe("lease state", () => {
  test("live, expired at the boundary, released", () => {
    expect(supervisorEndpointLeaseState(lease(), NOW)).toBe("live");
    expect(
      supervisorEndpointLeaseState(lease({ expiresAt: NOW.toISOString() }), NOW)
    ).toBe("expired");
    expect(
      supervisorEndpointLeaseState(
        lease({ releasedAt: "2026-10-11T11:59:00.000Z" }),
        NOW
      )
    ).toBe("released");
  });

  test("expiry is now plus a bounded ttl", () => {
    expect(supervisorEndpointLeaseExpiresAt(NOW, 30_000)).toBe(
      "2026-10-11T12:00:30.000Z"
    );
    expect(() => supervisorEndpointLeaseExpiresAt(NOW, 999)).toThrow();
    expect(() => supervisorEndpointLeaseExpiresAt(NOW, 86_400_001)).toThrow();
  });
});

describe("claim decision", () => {
  test("a first claim starts at epoch 1", () => {
    expect(
      decideSupervisorEndpointLeaseClaim(undefined, { holderRef: "h:1" }, NOW)
    ).toEqual({ allowed: true, nextEpoch: 1, tookOver: false });
  });

  test("a live lease of another holder refuses without takeover", () => {
    expect(
      decideSupervisorEndpointLeaseClaim(lease(), { holderRef: "h:other" }, NOW)
    ).toEqual({
      allowed: false,
      current: {
        epoch: 3,
        expiresAt: "2026-10-11T12:01:00.000Z",
        holderRef: "loop-run:run-a",
        state: "live",
      },
    });
  });

  test("takeover evicts a live holder and bumps the epoch", () => {
    expect(
      decideSupervisorEndpointLeaseClaim(
        lease(),
        { holderRef: "h:other", takeover: true },
        NOW
      )
    ).toEqual({ allowed: true, nextEpoch: 4, tookOver: true });
  });

  test("the same holder, an expired or a released lease are claimable", () => {
    expect(
      decideSupervisorEndpointLeaseClaim(
        lease(),
        { holderRef: "loop-run:run-a" },
        NOW
      )
    ).toEqual({ allowed: true, nextEpoch: 4, tookOver: false });
    expect(
      decideSupervisorEndpointLeaseClaim(
        lease({ expiresAt: "2026-10-11T11:00:00.000Z" }),
        { holderRef: "h:other" },
        NOW
      )
    ).toEqual({ allowed: true, nextEpoch: 4, tookOver: false });
    expect(
      decideSupervisorEndpointLeaseClaim(
        lease({ releasedAt: "2026-10-11T11:00:00.000Z" }),
        { holderRef: "h:other" },
        NOW
      )
    ).toEqual({ allowed: true, nextEpoch: 4, tookOver: false });
  });
});

test("an exhausted epoch refuses rather than wrapping", () => {
  expect(() =>
    decideSupervisorEndpointLeaseClaim(
      lease({ epoch: Number.MAX_SAFE_INTEGER }),
      { holderRef: "loop-run:run-a" },
      NOW
    )
  ).toThrow("lease epoch is exhausted");
});

describe("fence decision", () => {
  const fence = { epoch: 3, holderRef: "loop-run:run-a" };
  test("matching fence on an unreleased lease, even expired, is ok", () => {
    expect(decideSupervisorEndpointLeaseFence(lease(), fence)).toBe("ok");
    expect(
      decideSupervisorEndpointLeaseFence(
        lease({ expiresAt: "2026-10-11T11:00:00.000Z" }),
        fence
      )
    ).toBe("ok");
  });

  test("absent, stale epoch, other holder, released", () => {
    expect(decideSupervisorEndpointLeaseFence(undefined, fence)).toBe("absent");
    expect(decideSupervisorEndpointLeaseFence(lease({ epoch: 4 }), fence)).toBe(
      "epoch-mismatch"
    );
    expect(
      decideSupervisorEndpointLeaseFence(lease({ holderRef: "h:other" }), fence)
    ).toBe("holder-mismatch");
    expect(
      decideSupervisorEndpointLeaseFence(
        lease({ releasedAt: "2026-10-11T11:00:00.000Z" }),
        fence
      )
    ).toBe("released");
  });
});

describe("locators", () => {
  test("accepts each kind", () => {
    expect(
      parseSupervisorEndpointLocator({
        kind: "loop-run",
        repoId: "agents-collab-fa87e8608224",
        runId: "12",
        seat: "codex",
      })
    ).toEqual({
      kind: "loop-run",
      repoId: "agents-collab-fa87e8608224",
      runId: "12",
      seat: "codex",
    });
    expect(
      parseSupervisorEndpointLocator({
        kind: "claude-channel",
        sessionId: "0b5f2c3e-1d2a-4f6b-9c1e-2a3b4c5d6e7f",
      })
    ).toEqual({
      kind: "claude-channel",
      sessionId: "0b5f2c3e-1d2a-4f6b-9c1e-2a3b4c5d6e7f",
    });
    expect(
      parseSupervisorEndpointLocator({
        kind: "codex-thread",
        repoId: "repo-a",
        runId: "7",
        threadId: "thread-1",
      })
    ).toEqual({
      kind: "codex-thread",
      repoId: "repo-a",
      runId: "7",
      threadId: "thread-1",
    });
  });

  const run = {
    kind: "loop-run",
    repoId: "repo-a",
    runId: "7",
    seat: "claude",
  };
  const chan = { kind: "claude-channel", sessionId: "sess-1" };
  const codex = {
    kind: "codex-thread",
    repoId: "repo-a",
    runId: "7",
    threadId: "t",
  };
  for (const [label, value] of [
    ["unknown kind", { kind: "tmux", repoId: "repo-a", runId: "7" }],
    ["extra key", { ...chan, extra: 1 }],
    ["legacy runDir path", { kind: "loop-run", runDir: "/r", seat: "claude" }],
    ["runDir beside ids", { ...run, runDir: "/r" }],
    ["legacy sessionDir path", { kind: "claude-channel", sessionDir: "/s" }],
    ["sessionDir beside id", { ...chan, sessionDir: "/s" }],
    [
      "legacy remoteUrl",
      { kind: "codex-thread", remoteUrl: "ws://127.0.0.1:1", threadId: "t" },
    ],
    ["remoteUrl beside ids", { ...codex, remoteUrl: "ws://127.0.0.1:1" }],
    ["bad seat", { ...run, seat: "supervisor" }],
    ["repoId ..", { ...run, repoId: ".." }],
    ["repoId traversal", { ...run, repoId: "../other" }],
    ["repoId absolute", { ...run, repoId: "/etc" }],
    ["repoId slash", { ...run, repoId: "a/b" }],
    ["repoId dot", { ...run, repoId: "a.b" }],
    ["repoId uppercase", { ...run, repoId: "Repo" }],
    ["repoId leading dash", { ...run, repoId: "-a" }],
    ["repoId overlong", { ...run, repoId: "a".repeat(129) }],
    ["runId ..", { ...run, runId: ".." }],
    ["runId traversal", { ...run, runId: "../../x" }],
    ["runId absolute", { ...run, runId: "/7" }],
    ["runId backslash", { ...run, runId: "7\\..\\x" }],
    ["runId nul", { ...run, runId: "7\0" }],
    ["runId number", { ...run, runId: 7 }],
    ["runId empty", { ...run, runId: "" }],
    ["sessionId ..", { ...chan, sessionId: ".." }],
    ["sessionId traversal", { ...chan, sessionId: "../b/sess-1" }],
    ["sessionId absolute", { ...chan, sessionId: "/tmp/x" }],
    ["sessionId dot", { ...chan, sessionId: ".hidden" }],
    ["sessionId overlong", { ...chan, sessionId: "s".repeat(129) }],
    ["codex repoId traversal", { ...codex, repoId: "../x" }],
    ["codex runId traversal", { ...codex, runId: "../x" }],
    ["codex bad threadId", { ...codex, threadId: "/t" }],
  ] as const) {
    test(`refuses ${label}`, () => {
      expect(() => parseSupervisorEndpointLocator(value)).toThrow();
    });
  }

  test("digest ignores key order and differs by locator", () => {
    const a = supervisorEndpointLocatorDigest({
      kind: "loop-run",
      repoId: "repo-a",
      runId: "7",
      seat: "claude",
    });
    const reordered = supervisorEndpointLocatorDigest({
      seat: "claude",
      runId: "7",
      repoId: "repo-a",
      kind: "loop-run",
    } as never);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(a);
    expect(
      supervisorEndpointLocatorDigest({
        kind: "loop-run",
        repoId: "repo-a",
        runId: "7",
        seat: "codex",
      })
    ).not.toBe(a);
  });

  test("descriptor identity per kind; a Codex sessionRef must name its thread", () => {
    const codex = {
      kind: "codex-thread",
      repoId: "repo-a",
      runId: "7",
      threadId: "thread-1",
    } as const;
    expect(
      supervisorEndpointDescriptorIdentity(codex, "session:thread-1")
    ).toEqual({
      endpointDigest: supervisorEndpointLocatorDigest(codex),
      endpointRef: "endpoint:codex-thread",
      provider: "codex-app-server",
      sessionRef: "session:thread-1",
    });
    expect(() =>
      supervisorEndpointDescriptorIdentity(codex, "session:thread-2")
    ).toThrow();
    expect(
      supervisorEndpointDescriptorIdentity(
        { kind: "claude-channel", sessionId: "abc" },
        "session:abc"
      ).provider
    ).toBe("claude-code");
    expect(() =>
      supervisorEndpointDescriptorIdentity(
        { kind: "claude-channel", sessionId: "abc" },
        "abc"
      )
    ).toThrow();
  });
});

describe("endpoint routing", () => {
  test("one table for readiness, delivery and assignment", () => {
    const live = { lease: lease(), state: "live" } as const;
    const expired = { lease: lease(), state: "expired" } as const;
    const released = { lease: lease(), state: "released" } as const;
    const none = { state: "none" } as const;
    expect(decideSupervisorEndpointRoute(live, false)).toBe("endpoint");
    expect(decideSupervisorEndpointRoute(live, true)).toBe("endpoint");
    expect(decideSupervisorEndpointRoute(expired, true)).toBe("defer");
    expect(decideSupervisorEndpointRoute(released, true)).toBe("mailbox");
    expect(decideSupervisorEndpointRoute(none, true)).toBe("mailbox");
    expect(decideSupervisorEndpointRoute(released, false)).toBe("none");
    expect(decideSupervisorEndpointRoute(none, false)).toBe("none");
  });

  test("undeliverable routes are transient with fixed reasons", () => {
    expect(supervisorEndpointUndeliverable("defer")).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.leaseExpired,
      status: "transient-failure",
    });
    expect(supervisorEndpointUndeliverable("none")).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
      status: "transient-failure",
    });
  });

  test("bridge route and seat scope", () => {
    expect(
      supervisorEndpointBridgeRoute({
        kind: "loop-run",
        manifestPath: "/home/u/.loop/runs/repo-a/7/manifest.json",
        runDir: "/home/u/.loop/runs/repo-a/7",
        seat: "codex",
      })
    ).toEqual({ runDir: "/home/u/.loop/runs/repo-a/7", target: "codex" });
    const principals = (id: string) =>
      id === "supervisor:a" ? "principal:seat-a" : undefined;
    expect(
      supervisorEndpointSeatScope(
        { principal: "principal:sender", tenantId: "tenant-a" },
        "supervisor:a",
        principals
      )
    ).toEqual({ principal: "principal:seat-a", tenantId: "tenant-a" });
    expect(
      supervisorEndpointSeatScope(
        { principal: "principal:sender", tenantId: "tenant-a" },
        "supervisor:b",
        principals
      )
    ).toBeUndefined();
  });
});

describe("route contract", () => {
  const routePath = "/a2a/v2";

  test("paths round-trip through the matcher", () => {
    expect(
      matchA2AV2Route(routePath, a2aV2SessionRoutePath(routePath, "renew"))
    ).toEqual({ method: "POST", operation: "renew", route: "session" });
    expect(a2aV2SupervisorIngressPath(routePath, "supervisor:x.y")).toBe(
      "/a2a/v2/supervisors/x.y"
    );
    expect(matchA2AV2Route(routePath, "/a2a/v2/supervisors/x.y")).toEqual({
      method: "POST",
      route: "supervisor-ingress",
      supervisorId: "supervisor:x.y",
    });
    const status = a2aV2MessageStatusPath(routePath, "msg:1");
    expect(status).toBe("/a2a/v2/messages/msg%3A1");
    expect(matchA2AV2Route(routePath, status)).toEqual({
      messageId: "msg:1",
      method: "GET",
      route: "message-status",
    });
  });

  for (const pathname of [
    "/a2a/v2",
    "/a2a/v2/recipient",
    "/a2a/v2/seats/codex",
    "/a2a/v2/sessions/claim/",
    "/a2a/v2/sessions/steal",
    "/a2a/v2/supervisors/",
    "/a2a/v2/supervisors/X",
    "/a2a/v2/supervisors/a/b",
    "/a2a/v2/messages/a%2Fb",
    "/a2a/v2/messages/%E0%A4%A",
    "/other/sessions/claim",
  ]) {
    test(`does not match ${pathname}`, () => {
      expect(matchA2AV2Route(routePath, pathname)).toBeUndefined();
    });
  }

  test("task state names and completion", () => {
    expect(a2aV2TaskStateName(undefined)).toBeNull();
    expect(a2aV2TaskStateName(TaskState.TASK_STATE_COMPLETED)).toBe(
      "TASK_STATE_COMPLETED"
    );
    expect(a2aV2WorkResultCompleted("TASK_STATE_COMPLETED")).toBe(true);
    expect(a2aV2WorkResultCompleted("TASK_STATE_SUBMITTED")).toBe(false);
    expect(a2aV2WorkResultCompleted(null)).toBe(false);
  });
});

describe("session request parser", () => {
  const claim = {
    holderRef: "claude-session:abc",
    locator: { kind: "claude-channel", sessionId: "abc" },
    schema: A2A_V2_SESSION_REQUEST_SCHEMAS.claim,
    sessionRef: "session:abc",
    supervisorId: "supervisor:x",
  };

  test("claim, renew and release decode strictly", () => {
    expect(
      parseA2AV2SessionRequest("claim", { ...claim, takeover: true })
    ).toEqual({ ...claim, takeover: true } as never);
    expect(
      parseA2AV2SessionRequest("renew", {
        epoch: 2,
        holderRef: "h:1",
        schema: A2A_V2_SESSION_REQUEST_SCHEMAS.renew,
        supervisorId: "supervisor:x",
        ttlMs: 60_000,
      })
    ).toEqual({
      epoch: 2,
      holderRef: "h:1",
      schema: A2A_V2_SESSION_REQUEST_SCHEMAS.renew,
      supervisorId: "supervisor:x",
      ttlMs: 60_000,
    });
  });

  for (const [label, operation, value] of [
    ["unknown key", "claim", { ...claim, extra: true }],
    ["wrong schema", "claim", { ...claim, schema: "x" }],
    ["renew schema on claim", "renew", claim],
    ["bad sessionRef", "claim", { ...claim, sessionRef: "abc" }],
    ["bad takeover", "claim", { ...claim, takeover: "yes" }],
    ["bad ttl", "claim", { ...claim, ttlMs: 10 }],
    ["bad supervisor", "claim", { ...claim, supervisorId: "x" }],
    [
      "path locator",
      "claim",
      { ...claim, locator: { kind: "claude-channel", sessionDir: "/etc" } },
    ],
    [
      "url locator",
      "claim",
      {
        ...claim,
        locator: {
          kind: "codex-thread",
          remoteUrl: "ws://evil.example:1",
          threadId: "t",
        },
      },
    ],
    [
      "traversal locator",
      "claim",
      {
        ...claim,
        locator: {
          kind: "loop-run",
          repoId: "..",
          runId: "..",
          seat: "claude",
        },
      },
    ],
    [
      "ttl on release",
      "release",
      {
        epoch: 1,
        holderRef: "h:1",
        schema: A2A_V2_SESSION_REQUEST_SCHEMAS.release,
        supervisorId: "supervisor:x",
        ttlMs: 60_000,
      },
    ],
    [
      "zero epoch",
      "release",
      {
        epoch: 0,
        holderRef: "h:1",
        schema: A2A_V2_SESSION_REQUEST_SCHEMAS.release,
        supervisorId: "supervisor:x",
      },
    ],
  ] as const) {
    test(`refuses ${label}`, () => {
      expect(() => parseA2AV2SessionRequest(operation, value)).toThrow();
    });
  }
});

describe("SECURITY: server-side locator resolution", () => {
  // Real filesystem fixtures: symlinks and realpath are what is under test.
  let home = "";
  let outside = "";
  const fs: SupervisorEndpointFs = {
    readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
    realpath: (path) => realpathSync(path),
  };
  const roots = () => supervisorEndpointRoots(home);
  const SUP = "supervisor:a";
  const manifest = (overrides: Record<string, unknown> = {}) => ({
    a2aSupervisorId: SUP,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    codexThreadId: "thread-1",
    repoId: "repo-a",
    runId: "7",
    ...overrides,
  });
  const writeRun = (
    repoId: string,
    runId: string,
    body: unknown = manifest({ repoId, runId })
  ): string => {
    const dir = join(roots().runsRoot, repoId, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      typeof body === "string" ? body : JSON.stringify(body)
    );
    return dir;
  };
  const refusal = (fn: () => unknown): SupervisorEndpointLocatorRefusal => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(SupervisorEndpointLocatorError);
      const reason = (error as SupervisorEndpointLocatorError).reason;
      // Fixed message: no path, URL or id of the fixture leaks into it.
      expect((error as Error).message).toBe(
        `endpoint locator refused: ${reason}`
      );
      return reason;
    }
    throw new Error("expected a locator refusal");
  };
  const resolve = (locator: unknown, supervisorId = SUP) =>
    resolveSupervisorEndpointLocator(locator, {
      fs,
      roots: roots(),
      supervisorId,
    });
  const loopRun = (repoId = "repo-a", runId = "7") =>
    ({ kind: "loop-run", repoId, runId, seat: "claude" }) as const;
  const codexThread = (threadId = "thread-1", runId = "7") =>
    ({ kind: "codex-thread", repoId: "repo-a", runId, threadId }) as const;

  beforeAll(() => {
    // Under the hermetic scratch TMPDIR; on macOS this root is itself behind
    // the /var -> /private/var symlink, which a root is allowed to be.
    const base = mkdtempSync(join(tmpdir(), "r9-locators-"));
    home = join(base, "home");
    outside = join(base, "outside");
    mkdirSync(home);
    mkdirSync(outside);
    writeRun("repo-a", "7");
    mkdirSync(join(roots().sessionsRoot, "a", "sess-1"), { recursive: true });
    mkdirSync(join(roots().sessionsRoot, "b", "sess-b"), { recursive: true });
    // A run directory that is a symlink out of the root.
    mkdirSync(join(outside, "run"), { recursive: true });
    writeFileSync(
      join(outside, "run", "manifest.json"),
      JSON.stringify(manifest({ runId: "escape" }))
    );
    symlinkSync(
      join(outside, "run"),
      join(roots().runsRoot, "repo-a", "escape")
    );
    // An in-root alias of another run.
    symlinkSync(
      join(roots().runsRoot, "repo-a", "7"),
      join(roots().runsRoot, "repo-a", "alias")
    );
    // A session directory that is a symlink out of the root.
    mkdirSync(join(outside, "sess"), { recursive: true });
    symlinkSync(
      join(outside, "sess"),
      join(roots().sessionsRoot, "a", "sess-x")
    );
    // A real run directory whose manifest is a symlink out of the root.
    mkdirSync(join(roots().runsRoot, "repo-a", "8"), { recursive: true });
    writeFileSync(
      join(outside, "manifest.json"),
      JSON.stringify(manifest({ runId: "8" }))
    );
    symlinkSync(
      join(outside, "manifest.json"),
      join(roots().runsRoot, "repo-a", "8", "manifest.json")
    );
  });

  afterAll(() => {
    if (home) {
      rmSync(join(home, ".."), { force: true, recursive: true });
    }
  });

  test("roots come from the server home only, canonical and absolute", () => {
    expect(supervisorEndpointRoots("/home/u")).toEqual({
      runsRoot: "/home/u/.loop/runs",
      sessionsRoot: "/home/u/.loop/sessions",
    });
    for (const bad of ["", "home/u", "/home/u/", "/home/../u", "/h\0"]) {
      expect(() => supervisorEndpointRoots(bad)).toThrow();
    }
    expect(
      supervisorEndpointRunDir(supervisorEndpointRoots("/h"), {
        repoId: "repo-a",
        runId: "7",
      })
    ).toBe("/h/.loop/runs/repo-a/7");
    expect(
      supervisorEndpointSessionDir(
        supervisorEndpointRoots("/h"),
        "supervisor:x.y",
        "sess-1"
      )
    ).toBe("/h/.loop/sessions/x.y/sess-1");
    expect(() =>
      supervisorEndpointRunDir(supervisorEndpointRoots("/h"), {
        repoId: "..",
        runId: "7",
      })
    ).toThrow();
    expect(() =>
      supervisorEndpointSessionDir(supervisorEndpointRoots("/h"), "x", "s")
    ).toThrow();
  });

  test("a Loop run resolves to its contained, real run directory", () => {
    const real = realpathSync(join(roots().runsRoot, "repo-a", "7"));
    expect(resolve(loopRun())).toEqual({
      kind: "loop-run",
      manifestPath: join(real, "manifest.json"),
      runDir: real,
      seat: "claude",
    });
  });

  test("a Claude channel resolves under the lease's own supervisor only", () => {
    expect(resolve({ kind: "claude-channel", sessionId: "sess-1" })).toEqual({
      kind: "claude-channel",
      sessionDir: realpathSync(join(roots().sessionsRoot, "a", "sess-1")),
    });
    // Another supervisor's session id is not reachable from supervisor:a.
    expect(
      refusal(() => resolve({ kind: "claude-channel", sessionId: "sess-b" }))
    ).toBe("unresolved");
    // ...and supervisor:a's session is not reachable as supervisor:b.
    expect(
      refusal(() =>
        resolve({ kind: "claude-channel", sessionId: "sess-1" }, "supervisor:b")
      )
    ).toBe("unresolved");
  });

  test("traversal and absolute ids are refused before any path is built", () => {
    for (const locator of [
      { kind: "loop-run", repoId: "..", runId: "..", seat: "claude" },
      { kind: "loop-run", repoId: "repo-a", runId: "../7", seat: "claude" },
      { kind: "loop-run", repoId: "/etc", runId: "7", seat: "claude" },
      { kind: "claude-channel", sessionId: "../b/sess-b" },
      { kind: "claude-channel", sessionId: "/tmp" },
      { kind: "claude-channel", sessionDir: "/etc" },
      { kind: "codex-thread", repoId: "repo-a", runId: "..", threadId: "t" },
    ]) {
      expect(refusal(() => resolve(locator))).toBe("invalid");
    }
    expect(refusal(() => resolve(loopRun(), "x"))).toBe("invalid");
    expect(
      refusal(() => resolve({ kind: "claude-channel", sessionId: "s" }, "x"))
    ).toBe("invalid");
    expect(refusal(() => resolve(loopRun(), "supervisor:../a"))).toBe(
      "invalid"
    );
  });

  test("symlink escape and in-root aliases are refused", () => {
    expect(refusal(() => resolve(loopRun("repo-a", "escape")))).toBe(
      "not-contained"
    );
    expect(refusal(() => resolve(loopRun("repo-a", "alias")))).toBe(
      "not-contained"
    );
    expect(
      refusal(() => resolve({ kind: "claude-channel", sessionId: "sess-x" }))
    ).toBe("not-contained");
    expect(refusal(() => resolve(loopRun("repo-a", "8")))).toBe(
      "not-contained"
    );
  });

  test("a symlinked root is allowed; containment is against its real path", () => {
    const linkedHome = `${home}-link`;
    symlinkSync(home, linkedHome);
    try {
      expect(
        resolveSupervisorEndpointLocator(loopRun(), {
          fs,
          roots: supervisorEndpointRoots(linkedHome),
          supervisorId: SUP,
        })
      ).toMatchObject({
        runDir: realpathSync(join(roots().runsRoot, "repo-a", "7")),
      });
    } finally {
      rmSync(linkedHome);
    }
  });

  test("contained realpath refuses unsafe segments itself", () => {
    for (const segments of [[], [".."], ["a", "."], ["a/b"], ["/a"], [""]]) {
      expect(
        refusal(() =>
          supervisorEndpointContainedRealpath(fs, roots().runsRoot, segments)
        )
      ).toBe("invalid");
    }
    expect(() =>
      supervisorEndpointContainedRealpath(fs, "relative/root", ["a"])
    ).toThrow();
  });

  test("absent runs and unreadable manifests are unresolved", () => {
    expect(refusal(() => resolve(loopRun("repo-a", "404")))).toBe("unresolved");
    expect(refusal(() => resolve(loopRun("repo-z", "7")))).toBe("unresolved");
    writeRun("repo-a", "garbled", "{not json");
    expect(refusal(() => resolve(loopRun("repo-a", "garbled")))).toBe(
      "unresolved"
    );
    mkdirSync(join(roots().runsRoot, "repo-a", "empty"), { recursive: true });
    expect(refusal(() => resolve(loopRun("repo-a", "empty")))).toBe(
      "unresolved"
    );
  });

  test("a manifest must name this repo, this run and the claiming supervisor", () => {
    for (const [runId, body] of [
      ["f1", manifest({ a2aSupervisorId: "supervisor:b", runId: "f1" })],
      ["f2", manifest({ a2aSupervisorId: undefined, runId: "f2" })],
      ["f3", manifest({ repoId: "repo-b", runId: "f3" })],
      ["f4", manifest({ runId: "other" })],
      ["f5", ["not", "an", "object"]],
      ["f6", null],
    ] as const) {
      writeRun("repo-a", runId, body);
      expect(refusal(() => resolve(loopRun("repo-a", runId)))).toBe(
        "foreign-manifest"
      );
      expect(refusal(() => resolve(codexThread("thread-1", runId)))).toBe(
        "foreign-manifest"
      );
    }
    // A manifest naming an invalid id cannot be claimed by that id either.
    writeRun(
      "repo-a",
      "bad-id",
      manifest({ a2aSupervisorId: "x", runId: "bad-id" })
    );
    expect(() =>
      resolveSupervisorEndpointRun(
        fs,
        roots(),
        { repoId: "repo-a", runId: "bad-id" },
        "x"
      )
    ).toThrow("recipient is invalid");
  });

  test("a Codex thread dials only the manifest's loopback URL", () => {
    const real = realpathSync(join(roots().runsRoot, "repo-a", "7"));
    expect(resolve(codexThread())).toEqual({
      kind: "codex-thread",
      remoteUrl: "ws://127.0.0.1:4500",
      runDir: real,
      threadId: "thread-1",
    });
    expect(refusal(() => resolve(codexThread("thread-2")))).toBe(
      "thread-mismatch"
    );
    writeRun(
      "repo-a",
      "u1",
      manifest({ codexRemoteUrl: undefined, runId: "u1" })
    );
    expect(refusal(() => resolve(codexThread("thread-1", "u1")))).toBe(
      "remote-url-refused"
    );
    writeRun(
      "repo-a",
      "u2",
      manifest({ codexRemoteUrl: "ws://evil.example:4500", runId: "u2" })
    );
    expect(refusal(() => resolve(codexThread("thread-1", "u2")))).toBe(
      "remote-url-refused"
    );
  });

  for (const url of [
    "ws://127.0.0.1:4500",
    "ws://127.0.0.1:4500/",
    "ws://localhost:1",
    "ws://localhost:65535",
  ]) {
    test(`accepts loopback ${url}`, () => {
      expect(requireLoopbackCodexRemoteUrl(url)).toBe(url);
    });
  }

  for (const value of [
    // Non-loopback and hostnames.
    "ws://10.0.0.1:4500",
    "ws://192.168.1.18:7233",
    "ws://evil.example:4500",
    "ws://127.0.0.1.nip.io:4500",
    "ws://localhost.:4500",
    "ws://localhost.evil.example:4500",
    "ws://LOCALHOST:4500",
    // IPv6 and IPv6-mapped IPv4.
    "ws://[::1]:4500",
    "ws://[::ffff:127.0.0.1]:4500",
    "ws://[::ffff:7f00:1]:4500",
    "ws://[0:0:0:0:0:ffff:127.0.0.1]:4500",
    // Spellings URL parsing would normalize to 127.0.0.1.
    "ws://2130706433:4500",
    "ws://0x7f000001:4500",
    "ws://0177.0.0.1:4500",
    "ws://127.1:4500",
    "ws://127.0.0.1%2e:4500",
    "WS://127.0.0.1:4500",
    // The port must be explicit, decimal and in range.
    "ws://127.0.0.1",
    "ws://127.0.0.1:",
    "ws://127.0.0.1:0",
    "ws://127.0.0.1:04500",
    "ws://127.0.0.1:65536",
    "ws://127.0.0.1:99999",
    // Schemes other than plain ws.
    "wss://127.0.0.1:4500",
    "http://127.0.0.1:4500",
    "ws+unix://127.0.0.1:4500",
    // Userinfo that moves the real host, and credentials.
    "ws://127.0.0.1:4500@evil.example:80",
    "ws://u:p@127.0.0.1:4500",
    "ws://u@localhost:4500",
    // Redirect carriers: path, query, fragment, traversal.
    "ws://127.0.0.1:4500/redirect",
    "ws://127.0.0.1:4500/?next=ws://evil.example:1",
    "ws://127.0.0.1:4500#ws://evil.example:1",
    "ws://127.0.0.1:4500/../evil",
    "ws://127.0.0.1:4500//evil.example",
    // Whitespace and control characters.
    " ws://127.0.0.1:4500",
    "xws://127.0.0.1:4500",
    "ws://127.0.0.1:4500 ",
    "ws://127.0.0.1:4500\n",
    "ws://127.0.0.1:4500\0",
    // Not a string.
    undefined,
    null,
    4500,
    { href: "ws://127.0.0.1:4500" },
    // An object that stringifies to an accepted URL is still not a string.
    { toString: () => "ws://127.0.0.1:4500" },
  ]) {
    test(`refuses Codex remote URL ${JSON.stringify(value)}`, () => {
      expect(refusal(() => requireLoopbackCodexRemoteUrl(value))).toBe(
        "remote-url-refused"
      );
    });
  }

  test("every resolve re-validates: nothing is cached from the claim", () => {
    const resolver = createSupervisorEndpointLocatorResolver({
      fs,
      roots: roots(),
    });
    writeRun("repo-a", "r1", manifest({ runId: "r1" }));
    const locator: SupervisorEndpointLocator = codexThread("thread-1", "r1");
    expect(resolver(locator, SUP)).toMatchObject({
      remoteUrl: "ws://127.0.0.1:4500",
    });
    // The run is reassigned to another supervisor after the claim.
    writeRun(
      "repo-a",
      "r1",
      manifest({ a2aSupervisorId: "supervisor:b", runId: "r1" })
    );
    expect(refusal(() => resolver(locator, SUP))).toBe("foreign-manifest");
    // The manifest's URL is rewritten to a remote host.
    writeRun(
      "repo-a",
      "r1",
      manifest({ codexRemoteUrl: "ws://10.0.0.9:4500", runId: "r1" })
    );
    expect(refusal(() => resolver(locator, SUP))).toBe("remote-url-refused");
    // The run directory is swapped for a symlink out of the root.
    rmSync(join(roots().runsRoot, "repo-a", "r1"), { recursive: true });
    symlinkSync(join(outside, "run"), join(roots().runsRoot, "repo-a", "r1"));
    expect(refusal(() => resolver(locator, SUP))).toBe("not-contained");
    // The resolver refuses non-canonical roots at construction.
    expect(() =>
      createSupervisorEndpointLocatorResolver({
        fs,
        roots: { runsRoot: "runs", sessionsRoot: "/s" },
      })
    ).toThrow();
    expect(() =>
      createSupervisorEndpointLocatorResolver({
        fs,
        roots: { runsRoot: "/r", sessionsRoot: "/s/../x" },
      })
    ).toThrow();
  });

  test("store results and routes carry the refusal without detail", () => {
    expect(
      supervisorEndpointLocatorRefused(
        new SupervisorEndpointLocatorError("not-contained")
      )
    ).toEqual({ reason: "not-contained", status: "locator-refused" });
    expect(supervisorEndpointLocatorRefused(new Error("/secret/path"))).toEqual(
      { reason: "invalid", status: "locator-refused" }
    );
    expect(A2A_V2_ROUTE_ERROR_STATUS["locator-refused"]).toBe(403);
    expect(supervisorEndpointLocatorRefusedOutcome).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.locatorRefused,
      status: "transient-failure",
    });
  });
});
