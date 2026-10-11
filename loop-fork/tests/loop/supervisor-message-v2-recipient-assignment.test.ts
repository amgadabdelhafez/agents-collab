import { expect, test } from "bun:test";
import {
  type SupervisorEndpointLeaseResolution,
  type SupervisorEndpointLeaseV2,
  SupervisorEndpointLocatorError,
} from "../../src/loop/supervisor-endpoint-lease";
import {
  createSupervisorMessageV2RecipientAssignmentResolver,
  createSupervisorMessageV2RecipientReachability,
} from "../../src/loop/supervisor-message-v2-recipient-assignment";
import type { SupervisorSessionDescriptorV2 } from "../../src/loop/supervisor-session-v2";

test("recipient assignment joins configured identity, durable workflow, and ready sender-scoped session", async () => {
  const scope = { tenantId: "tenant:one", principal: "principal:sender" };
  let reads = 0;
  let ready = true;
  let current = true;
  const resolve = createSupervisorMessageV2RecipientAssignmentResolver({
    tenantId: scope.tenantId,
    principalForRecipient: (recipient) =>
      recipient === "supervisor:seat" ? "principal:seat" : undefined,
    ledger: {
      recipientAssignment: ({ recipient, workflowId }) => {
        reads++;
        return Promise.resolve(
          recipient === "supervisor:seat" && workflowId === "workflow:owned"
            ? scope
            : undefined
        );
      },
    },
    sessions: {
      current: () =>
        Promise.resolve(
          current
            ? ({
                ...scope,
                recipient: "supervisor:seat",
              } as SupervisorSessionDescriptorV2)
            : undefined
        ),
      assertReady: () =>
        ready ? Promise.resolve(undefined) : Promise.reject(new Error("stale")),
    },
  });
  const input = {
    identity: { principal: "principal:seat", supervisorId: "supervisor:seat" },
    workflowId: "workflow:owned",
  };
  expect(
    await resolve({
      ...input,
      identity: { ...input.identity, principal: "principal:foreign" },
    })
  ).toBeUndefined();
  expect(reads).toBe(0);
  expect(
    await resolve({ ...input, workflowId: "workflow:foreign" })
  ).toBeUndefined();
  expect(await resolve(input)).toEqual(scope);
  ready = false;
  expect(await resolve(input)).toBeUndefined();
  ready = true;
  current = false;
  expect(await resolve(input)).toBeUndefined();
});

// r9: the lease rule, with a fake of the T1 lease reader.
const SENDER_SCOPE = { tenantId: "tenant:one", principal: "principal:sender" };
const SEAT_SCOPE = { tenantId: "tenant:one", principal: "principal:seat" };
const SEAT = "supervisor:seat";
const LEASE_LOCATOR = {
  kind: "loop-run" as const,
  repoId: "repo-1",
  runId: "run-1",
  seat: "claude" as const,
};

const leaseRow = (
  state: "expired" | "live" | "released",
  overrides: Partial<SupervisorEndpointLeaseV2> = {}
): SupervisorEndpointLeaseV2 => ({
  descriptorId: "descriptor:seat",
  descriptorRevision: 1,
  epoch: 3,
  expiresAt:
    state === "expired"
      ? "2026-10-10T00:00:00.000Z"
      : "2026-10-12T00:00:00.000Z",
  holderRef: "holder:one",
  kind: "loop-run",
  locator: LEASE_LOCATOR,
  principal: SEAT_SCOPE.principal,
  recipient: SEAT,
  releasedAt: state === "released" ? "2026-10-10T00:00:00.000Z" : null,
  schema: "supervisor-endpoint-lease.v2",
  tenantId: SEAT_SCOPE.tenantId,
  ...overrides,
});

const leaseFixture = () => {
  const state: {
    descriptor: SupervisorSessionDescriptorV2 | undefined;
    legacy: boolean;
    mailbox: boolean;
    ready: boolean;
    refuse: boolean;
    resolution: SupervisorEndpointLeaseResolution;
    storeDown: boolean;
  } = {
    descriptor: {
      ...SEAT_SCOPE,
      descriptorId: "descriptor:seat",
      recipient: SEAT,
    } as SupervisorSessionDescriptorV2,
    legacy: false,
    mailbox: false,
    ready: true,
    refuse: false,
    resolution: { lease: leaseRow("live"), state: "live" },
    storeDown: false,
  };
  const scopesAsked: unknown[] = [];
  const resolved: unknown[] = [];
  const options = {
    endpoints: {
      hasMailbox: (recipient: string) => recipient === SEAT && state.mailbox,
      leases: {
        list: () => Promise.resolve([]),
        resolve: (tenantId: string, recipient: string) =>
          state.storeDown
            ? Promise.reject(new Error("lease store down"))
            : Promise.resolve(
                tenantId === SEAT_SCOPE.tenantId && recipient === SEAT
                  ? state.resolution
                  : ({ state: "none" } as const)
              ),
      },
      get legacySeats() {
        return new Set(state.legacy ? [SEAT] : []);
      },
      resolveLocator: (locator: unknown, recipient: string) => {
        resolved.push({ locator, recipient });
        if (state.refuse) {
          throw new SupervisorEndpointLocatorError("not-contained");
        }
        return {
          kind: "loop-run" as const,
          manifestPath: "/server/home/.loop/runs/repo-1/run-1/manifest.json",
          runDir: "/server/home/.loop/runs/repo-1/run-1",
          seat: "claude" as const,
        };
      },
    },
    principalForRecipient: (recipient: string) =>
      recipient === SEAT ? SEAT_SCOPE.principal : undefined,
    sessions: {
      current: (scope: unknown) => {
        scopesAsked.push(scope);
        return Promise.resolve(state.descriptor);
      },
      assertReady: (scope: unknown) => {
        scopesAsked.push(scope);
        return state.ready
          ? Promise.resolve(undefined)
          : Promise.reject(new Error("stale"));
      },
    },
    tenantId: SEAT_SCOPE.tenantId,
  };
  return { options, resolved, scopesAsked, state };
};

test("r9 recipient reachability follows the one routing table: a live lease needs its seat-scope descriptor ready and its locator still resolving", async () => {
  const { options, resolved, scopesAsked, state } = leaseFixture();
  const reachable = createSupervisorMessageV2RecipientReachability(options);
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(true);
  // The seat's own scope, never the sender's.
  expect(scopesAsked).toEqual([SEAT_SCOPE, SEAT_SCOPE]);
  // The stored locator was re-resolved for this recipient.
  expect(resolved).toEqual([{ locator: LEASE_LOCATOR, recipient: SEAT }]);
  state.ready = false;
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
  state.ready = true;
  // A descriptor the lease did not register (or another seat's) is refused.
  state.descriptor = {
    ...SEAT_SCOPE,
    descriptorId: "descriptor:other",
    recipient: SEAT,
  } as SupervisorSessionDescriptorV2;
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
  state.descriptor = {
    ...SENDER_SCOPE,
    descriptorId: "descriptor:seat",
    recipient: SEAT,
  } as SupervisorSessionDescriptorV2;
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
  state.descriptor = undefined;
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
  state.descriptor = {
    ...SEAT_SCOPE,
    descriptorId: "descriptor:seat",
    recipient: SEAT,
  } as SupervisorSessionDescriptorV2;
  // SECURITY: a stored locator that no longer resolves is not reachable,
  // and a live lease never falls through to the mailbox.
  state.refuse = true;
  state.mailbox = true;
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
  state.refuse = false;
  state.mailbox = false;
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(true);
  // A lease row of another recipient never vouches for this one.
  state.resolution = {
    lease: leaseRow("live", { recipient: "supervisor:other" }),
    state: "live",
  };
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
});

test("r9 recipient reachability: released or no lease is mailbox-held only with a mailbox; an expired lease defers; a store outage is not reachable", async () => {
  const { options, scopesAsked, state } = leaseFixture();
  const reachable = createSupervisorMessageV2RecipientReachability(options);
  for (const resolution of [
    { lease: leaseRow("released"), state: "released" as const },
    { state: "none" as const },
  ]) {
    state.resolution = resolution;
    state.mailbox = false;
    expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
    state.mailbox = true;
    expect(await reachable(SENDER_SCOPE, SEAT)).toBe(true);
  }
  // Mailbox-held mode reads no session at all.
  expect(scopesAsked).toEqual([]);
  state.resolution = { lease: leaseRow("expired"), state: "expired" };
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
  state.resolution = { lease: leaseRow("live"), state: "live" };
  state.storeDown = true;
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
});

test("r9 recipient reachability keeps r8's sender-scope rule for an r8 seat with no lease row, and moves it to the lease rule once it has one", async () => {
  const { options, scopesAsked, state } = leaseFixture();
  const reachable = createSupervisorMessageV2RecipientReachability(options);
  state.legacy = true;
  state.resolution = { state: "none" };
  state.descriptor = {
    ...SENDER_SCOPE,
    descriptorId: "descriptor:r8",
    recipient: SEAT,
  } as SupervisorSessionDescriptorV2;
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(true);
  expect(scopesAsked).toEqual([SENDER_SCOPE, SENDER_SCOPE]);
  // r8's store error still propagates, as it always has.
  const failing = createSupervisorMessageV2RecipientReachability({
    ...options,
    sessions: {
      ...options.sessions,
      current: () => Promise.reject(new Error("session store down")),
    },
  });
  await expect(failing(SENDER_SCOPE, SEAT)).rejects.toThrow(
    "session store down"
  );
  // With a lease row the r8 descriptor no longer counts.
  state.resolution = { lease: leaseRow("released"), state: "released" };
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
  // Without the endpoints port at all, every seat is r8's.
  const r8Only = createSupervisorMessageV2RecipientReachability({
    ...options,
    endpoints: undefined,
  });
  expect(await r8Only(SENDER_SCOPE, SEAT)).toBe(true);
});

test("r9 recipient assignment joins the configured identity, the durable assignment and the lease rule", async () => {
  const { options, state } = leaseFixture();
  const resolve = createSupervisorMessageV2RecipientAssignmentResolver({
    ...options,
    ledger: {
      recipientAssignment: ({ recipient, workflowId }) =>
        Promise.resolve(
          recipient === SEAT && workflowId === "workflow:owned"
            ? SENDER_SCOPE
            : undefined
        ),
    },
  });
  const input = {
    identity: { principal: SEAT_SCOPE.principal, supervisorId: SEAT },
    workflowId: "workflow:owned",
  };
  expect(await resolve(input)).toEqual(SENDER_SCOPE);
  state.resolution = { lease: leaseRow("expired"), state: "expired" };
  expect(await resolve(input)).toBeUndefined();
  state.resolution = { state: "none" };
  state.mailbox = true;
  expect(await resolve(input)).toEqual(SENDER_SCOPE);
  expect(
    await resolve({
      ...input,
      identity: { ...input.identity, principal: "principal:foreign" },
    })
  ).toBeUndefined();
});

test("r9 recipient reachability: an expired lease whose session the server observes live is renewed now and then judged live; one it cannot renew stays unreachable", async () => {
  const { options, state } = leaseFixture();
  const renewals: string[] = [];
  let renews = true;
  const reachable = createSupervisorMessageV2RecipientReachability({
    ...options,
    endpoints: {
      ...options.endpoints,
      leases: options.endpoints.leases,
      get legacySeats() {
        return options.endpoints.legacySeats;
      },
      renewExpiredLease: (recipient: string) => {
        renewals.push(recipient);
        if (renews) {
          state.resolution = { lease: leaseRow("live"), state: "live" };
        }
        return Promise.resolve(renews);
      },
    },
  });
  // The sweep's renewal lagged: the lease reads expired, the session is live.
  state.resolution = { lease: leaseRow("expired"), state: "expired" };
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(true);
  expect(renewals).toEqual([SEAT]);
  // Renewed, it is still the whole live rule: an unready seat is refused.
  state.resolution = { lease: leaseRow("expired"), state: "expired" };
  state.ready = false;
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
  state.ready = true;
  // A session the server does not observe live is not renewed: refused.
  renews = false;
  state.resolution = { lease: leaseRow("expired"), state: "expired" };
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
  // Only an expired lease is renewed on demand.
  renewals.length = 0;
  for (const resolution of [
    { lease: leaseRow("live"), state: "live" as const },
    { lease: leaseRow("released"), state: "released" as const },
    { state: "none" as const },
  ]) {
    state.resolution = resolution;
    await reachable(SENDER_SCOPE, SEAT);
  }
  expect(renewals).toEqual([]);
});

test("r9 recipient reachability: a check that a renewal of the same lease raced is made once more on the renewed lease, and only then", async () => {
  const { options, state } = leaseFixture();
  let readinessChecks = 0;
  // The first readiness check fails as the sweep's renewal lands under it.
  let failFirst = true;
  let renewal: Partial<SupervisorEndpointLeaseV2> = { descriptorRevision: 2 };
  const reachable = createSupervisorMessageV2RecipientReachability({
    ...options,
    sessions: {
      ...options.sessions,
      assertReady: () => {
        readinessChecks++;
        if (failFirst) {
          failFirst = false;
          state.resolution = {
            lease: leaseRow("live", renewal),
            state: "live",
          };
          return Promise.reject(
            new Error("recipient endpoint identity changed")
          );
        }
        return state.ready
          ? Promise.resolve(undefined)
          : Promise.reject(new Error("stale"));
      },
    },
  });
  expect(await reachable(SENDER_SCOPE, SEAT)).toBe(true);
  expect(readinessChecks).toBe(2);
  // Once only: the renewed lease's own failure is final.
  for (const [change, ready] of [
    [{ descriptorRevision: 2 }, false],
    // No renewal landed (same revision), or a new claim (another epoch).
    [{}, true],
    [{ descriptorRevision: 2, epoch: 4 }, true],
  ] as const) {
    state.resolution = { lease: leaseRow("live"), state: "live" };
    state.ready = ready;
    renewal = change;
    failFirst = true;
    readinessChecks = 0;
    expect(await reachable(SENDER_SCOPE, SEAT)).toBe(false);
    expect(readinessChecks).toBe(
      change.descriptorRevision && !("epoch" in change) ? 2 : 1
    );
  }
});
