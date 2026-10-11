import { describe, expect, test } from "bun:test";
import { TaskState } from "@a2a-js/sdk";
import {
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
  decideSupervisorEndpointLeaseClaim,
  decideSupervisorEndpointLeaseFence,
  parseSupervisorEndpointLocator,
  SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA,
  type SupervisorEndpointLeaseV2,
  supervisorEndpointDescriptorIdentity,
  supervisorEndpointLeaseExpiresAt,
  supervisorEndpointLeaseState,
  supervisorEndpointLocatorDigest,
} from "../../src/loop/supervisor-endpoint-lease";
import {
  decideSupervisorEndpointRoute,
  SUPERVISOR_ENDPOINT_REASONS,
  supervisorEndpointBridgeRoute,
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
  locator: { kind: "loop-run", runDir: "/runs/a", seat: "claude" },
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
        runDir: "/runs/a",
        seat: "codex",
      })
    ).toEqual({ kind: "loop-run", runDir: "/runs/a", seat: "codex" });
    expect(
      parseSupervisorEndpointLocator({
        kind: "claude-channel",
        sessionDir: "/sessions/x",
      })
    ).toEqual({ kind: "claude-channel", sessionDir: "/sessions/x" });
    expect(
      parseSupervisorEndpointLocator({
        kind: "codex-thread",
        remoteUrl: "ws://127.0.0.1:4500",
        threadId: "thread-1",
      })
    ).toEqual({
      kind: "codex-thread",
      remoteUrl: "ws://127.0.0.1:4500",
      threadId: "thread-1",
    });
  });

  for (const [label, value] of [
    ["unknown kind", { kind: "tmux", runDir: "/r" }],
    ["extra key", { kind: "claude-channel", sessionDir: "/s", extra: 1 }],
    ["relative dir", { kind: "claude-channel", sessionDir: "s" }],
    ["unnormalized dir", { kind: "claude-channel", sessionDir: "/a/../s" }],
    ["trailing slash", { kind: "claude-channel", sessionDir: "/s/" }],
    ["nul byte", { kind: "claude-channel", sessionDir: "/s\0x" }],
    [
      "overlong dir",
      { kind: "claude-channel", sessionDir: `/${"d".repeat(4096)}` },
    ],
    [
      "username only",
      { kind: "codex-thread", remoteUrl: "ws://u@127.0.0.1:1", threadId: "t" },
    ],
    [
      "password only",
      { kind: "codex-thread", remoteUrl: "ws://:p@127.0.0.1:1", threadId: "t" },
    ],
    [
      "fragment",
      { kind: "codex-thread", remoteUrl: "ws://127.0.0.1:1/#x", threadId: "t" },
    ],
    [
      "respelled url",
      { kind: "codex-thread", remoteUrl: "WS://127.0.0.1:1", threadId: "t" },
    ],
    ["bad seat", { kind: "loop-run", runDir: "/r", seat: "supervisor" }],
    [
      "remote host",
      { kind: "codex-thread", remoteUrl: "ws://10.0.0.1:1", threadId: "t" },
    ],
    [
      "localhost name",
      { kind: "codex-thread", remoteUrl: "ws://localhost:1", threadId: "t" },
    ],
    [
      "http scheme",
      { kind: "codex-thread", remoteUrl: "http://127.0.0.1:1", threadId: "t" },
    ],
    [
      "credentials",
      {
        kind: "codex-thread",
        remoteUrl: "ws://u:p@127.0.0.1:1",
        threadId: "t",
      },
    ],
    [
      "query",
      {
        kind: "codex-thread",
        remoteUrl: "ws://127.0.0.1:1/?a=1",
        threadId: "t",
      },
    ],
  ] as const) {
    test(`refuses ${label}`, () => {
      expect(() => parseSupervisorEndpointLocator(value)).toThrow();
    });
  }

  test("digest ignores key order and differs by locator", () => {
    const a = supervisorEndpointLocatorDigest({
      kind: "loop-run",
      runDir: "/runs/a",
      seat: "claude",
    });
    const reordered = supervisorEndpointLocatorDigest({
      seat: "claude",
      runDir: "/runs/a",
      kind: "loop-run",
    } as never);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(a);
    expect(
      supervisorEndpointLocatorDigest({
        kind: "loop-run",
        runDir: "/runs/a",
        seat: "codex",
      })
    ).not.toBe(a);
  });

  test("descriptor identity per kind; a Codex sessionRef must name its thread", () => {
    const codex = {
      kind: "codex-thread",
      remoteUrl: "ws://127.0.0.1:4500",
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
        { kind: "claude-channel", sessionDir: "/s" },
        "session:abc"
      ).provider
    ).toBe("claude-code");
    expect(() =>
      supervisorEndpointDescriptorIdentity(
        { kind: "claude-channel", sessionDir: "/s" },
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
        runDir: "/runs/a",
        seat: "codex",
      })
    ).toEqual({ runDir: "/runs/a", target: "codex" });
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
    locator: { kind: "claude-channel", sessionDir: "/sessions/x" },
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
