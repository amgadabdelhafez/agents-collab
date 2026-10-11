import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "bun";
import {
  type BridgeMessage,
  markBridgeMessage,
  readBridgeEvents,
  writeBridgeSessionRecord,
} from "../../src/loop/bridge-store";
import { createRunManifest } from "../../src/loop/run-state";
import {
  createSupervisorEndpointLocatorResolver,
  decideSupervisorEndpointLeaseClaim,
  decideSupervisorEndpointLeaseFence,
  type ResolvedSupervisorEndpoint,
  resolveSupervisorEndpointLease,
  SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA,
  type SupervisorEndpointLeaseClaimInput,
  type SupervisorEndpointLeaseClaimResult,
  type SupervisorEndpointLeaseReleaseInput,
  type SupervisorEndpointLeaseReleaseResult,
  type SupervisorEndpointLeaseRenewInput,
  type SupervisorEndpointLeaseRenewResult,
  type SupervisorEndpointLeaseResolution,
  type SupervisorEndpointLeaseStore,
  type SupervisorEndpointLeaseV2,
  type SupervisorEndpointLocator,
  type SupervisorEndpointLocatorResolver,
  supervisorEndpointDescriptorIdentity,
  supervisorEndpointLeaseExpiresAt,
  supervisorEndpointLeaseHolderSummary,
  supervisorEndpointLocatorRefused,
  supervisorEndpointRoots,
} from "../../src/loop/supervisor-endpoint-lease";
import type { SupervisorMessageV2DeliveryEnvelope } from "../../src/loop/supervisor-message-v2-contract";
import {
  SUPERVISOR_ENDPOINT_REASONS,
  type SupervisorEndpointKindAdapters,
} from "../../src/loop/supervisor-message-v2-endpoint-contract";
import {
  checkSupervisorEndpointLease,
  createClaudeChannelEndpointAdapter,
  createLoopRunEndpointAdapter,
  createSupervisorEndpointKindAdapters,
  createSupervisorEndpointMailboxPort,
  isSupervisorEndpointDescriptorRef,
  SupervisorEndpointDescriptorReadiness,
  SupervisorEndpointMessageV2Delivery,
  supervisorEndpointDescriptorMatchesLease,
} from "../../src/loop/supervisor-message-v2-endpoint-delivery";
import {
  SupervisorMessageV2NotEnrolledDeferral,
  SupervisorMessageV2ReadinessUnavailableError,
} from "../../src/loop/supervisor-message-v2-runtime";
import {
  deriveSupervisorSessionDescriptorV2Id,
  SUPERVISOR_SESSION_DESCRIPTOR_V2_SCHEMA,
  type SupervisorSessionDescriptorV2,
} from "../../src/loop/supervisor-session-v2";
import { LoopCodexSessionV2ProviderReadiness } from "../../src/loop/supervisor-session-v2-codex-readiness";

const TENANT = "tenant:alpha";
const SUP = "supervisor:alpha";
const SEAT_PRINCIPAL = "principal:alpha";
const OTHER_SUP = "supervisor:beta";
const SENDER_SCOPE = { principal: "principal:sender", tenantId: TENANT };
const TTL_MS = 60_000;
const REMOTE_URL = "ws://127.0.0.1:4500";
const THREAD = "thread-1";
const CLAUDE_SESSION = "claude-sess-1";
const CHANNEL_SESSION = "chan-sess-1";
const CHANNEL_SERVER = "loop-bridge-alpha";

const SEAT_PRINCIPALS = new Map([
  [SUP, SEAT_PRINCIPAL],
  [OTHER_SUP, "principal:beta"],
]);
const principalFor = (recipient: string): string | undefined =>
  SEAT_PRINCIPALS.get(recipient);

const key = (tenantId: string, recipient: string) =>
  `${tenantId}\n${recipient}`;

/**
 * An in-memory store implementing T1's `SupervisorEndpointLeaseStore`
 * contract with the shared decisions: claim resolves the input locator and
 * registers or rebinds the seat descriptor with the lease; renew re-resolves
 * the stored locator; release never resolves.
 */
class FakeLeaseStore implements SupervisorEndpointLeaseStore {
  readonly rows = new Map<string, SupervisorEndpointLeaseV2>();
  readonly descriptors = new Map<string, SupervisorSessionDescriptorV2>();
  failure: Error | undefined;
  resolveCalls = 0;
  readonly #clock: () => Date;
  readonly #resolveLocator: SupervisorEndpointLocatorResolver;

  constructor(
    clock: () => Date,
    resolveLocator: SupervisorEndpointLocatorResolver
  ) {
    this.#clock = clock;
    this.#resolveLocator = resolveLocator;
  }

  claim(
    input: SupervisorEndpointLeaseClaimInput
  ): Promise<SupervisorEndpointLeaseClaimResult> {
    try {
      this.#resolveLocator(input.locator, input.recipient);
    } catch (error) {
      return Promise.resolve(supervisorEndpointLocatorRefused(error));
    }
    const now = this.#clock();
    const current = this.rows.get(key(input.scope.tenantId, input.recipient));
    const decision = decideSupervisorEndpointLeaseClaim(current, input, now);
    if (!decision.allowed) {
      return Promise.resolve({ current: decision.current, status: "held" });
    }
    const expiresAt = supervisorEndpointLeaseExpiresAt(now, input.ttlMs);
    const descriptorKey = `${key(input.scope.tenantId, input.recipient)}\n${input.scope.principal}`;
    const previousDescriptor = this.descriptors.get(descriptorKey);
    const descriptor: SupervisorSessionDescriptorV2 = {
      descriptorId: deriveSupervisorSessionDescriptorV2Id(
        input.scope,
        input.recipient
      ),
      ...supervisorEndpointDescriptorIdentity(input.locator, input.sessionRef),
      expiresAt,
      issuedAt: now.toISOString(),
      principal: input.scope.principal,
      recipient: input.recipient,
      revision: (previousDescriptor?.revision ?? 0) + 1,
      schema: SUPERVISOR_SESSION_DESCRIPTOR_V2_SCHEMA,
      tenantId: input.scope.tenantId,
    };
    const lease: SupervisorEndpointLeaseV2 = {
      descriptorId: descriptor.descriptorId,
      descriptorRevision: descriptor.revision,
      epoch: decision.nextEpoch,
      expiresAt,
      holderRef: input.holderRef,
      kind: input.locator.kind,
      locator: input.locator,
      principal: input.scope.principal,
      recipient: input.recipient,
      releasedAt: null,
      schema: SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA,
      tenantId: input.scope.tenantId,
    };
    this.descriptors.set(descriptorKey, descriptor);
    this.rows.set(key(input.scope.tenantId, input.recipient), lease);
    return Promise.resolve({
      descriptor,
      lease,
      previous: current
        ? supervisorEndpointLeaseHolderSummary(current, now)
        : null,
      status: "claimed",
      tookOver: decision.tookOver,
    });
  }

  renew(
    input: SupervisorEndpointLeaseRenewInput
  ): Promise<SupervisorEndpointLeaseRenewResult> {
    const current = this.rows.get(key(input.scope.tenantId, input.recipient));
    const fence = decideSupervisorEndpointLeaseFence(current, input.fence);
    if (fence !== "ok" || !current) {
      return Promise.resolve({
        reason: fence === "ok" ? "absent" : fence,
        status: "fenced",
      });
    }
    try {
      this.#resolveLocator(current.locator, current.recipient);
    } catch (error) {
      return Promise.resolve(supervisorEndpointLocatorRefused(error));
    }
    const expiresAt = supervisorEndpointLeaseExpiresAt(
      this.#clock(),
      input.ttlMs
    );
    const descriptorKey = `${key(input.scope.tenantId, input.recipient)}\n${input.scope.principal}`;
    const descriptor = {
      ...(this.descriptors.get(descriptorKey) as SupervisorSessionDescriptorV2),
      expiresAt,
    };
    descriptor.revision += 1;
    const lease = {
      ...current,
      descriptorRevision: descriptor.revision,
      expiresAt,
    };
    this.descriptors.set(descriptorKey, descriptor);
    this.rows.set(key(input.scope.tenantId, input.recipient), lease);
    return Promise.resolve({ descriptor, lease, status: "renewed" });
  }

  release(
    input: SupervisorEndpointLeaseReleaseInput
  ): Promise<SupervisorEndpointLeaseReleaseResult> {
    const current = this.rows.get(key(input.scope.tenantId, input.recipient));
    const fence = decideSupervisorEndpointLeaseFence(current, input.fence);
    if (!current || (fence !== "ok" && fence !== "released")) {
      return Promise.resolve({
        reason: fence === "ok" || fence === "released" ? "absent" : fence,
        status: "fenced",
      });
    }
    if (fence === "released") {
      return Promise.resolve({
        changed: false,
        lease: current,
        status: "released",
      });
    }
    const lease = { ...current, releasedAt: this.#clock().toISOString() };
    this.rows.set(key(input.scope.tenantId, input.recipient), lease);
    return Promise.resolve({ changed: true, lease, status: "released" });
  }

  resolve(
    tenantId: string,
    recipient: string
  ): Promise<SupervisorEndpointLeaseResolution> {
    this.resolveCalls += 1;
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve(
      resolveSupervisorEndpointLease(
        this.rows.get(key(tenantId, recipient)),
        this.#clock()
      )
    );
  }

  list(tenantId: string): Promise<readonly SupervisorEndpointLeaseV2[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.tenantId === tenantId && row.releasedAt === null)
        .sort((left, right) => left.recipient.localeCompare(right.recipient))
    );
  }

  /** The seat descriptor, as PostgresSupervisorSessionV2Store.current. */
  current(
    scope: { principal: string; tenantId: string },
    recipient: string
  ): Promise<SupervisorSessionDescriptorV2 | undefined> {
    return Promise.resolve(
      this.descriptors.get(
        `${key(scope.tenantId, recipient)}\n${scope.principal}`
      )
    );
  }
}

let base = "";
let home = "";
let outside = "";
let mailboxRoot = "";
let clockMs = 0;
const clock = () => new Date(clockMs);

const roots = () => supervisorEndpointRoots(home);
const runDirOf = (repoId: string, runId: string) =>
  join(roots().runsRoot, repoId, runId);
const sessionDirOf = (slug: string, sessionId: string) =>
  join(roots().sessionsRoot, slug, sessionId);

const writeRun = (
  repoId: string,
  runId: string,
  overrides: Record<string, unknown> = {}
): string => {
  const dir = runDirOf(repoId, runId);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    ...createRunManifest(
      {
        claudeSessionId: CLAUDE_SESSION,
        codexRemoteUrl: REMOTE_URL,
        codexThreadId: THREAD,
        cwd: base,
        mode: "paired",
        pid: process.pid,
        primaryAgent: "claude",
        repoId,
        runId,
        state: "working",
        tmuxPaneLeft: "%1",
        tmuxPaneLeftAgent: "claude",
        tmuxPaneRight: "%2",
        tmuxPaneRightAgent: "codex",
      },
      "2026-10-11T11:00:00.000Z"
    ),
    a2aSupervisorId: SUP,
    ...overrides,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
};

const writeSession = (slug = "alpha", sessionId = CHANNEL_SESSION): string => {
  const dir = sessionDirOf(slug, sessionId);
  writeBridgeSessionRecord(dir, {
    claudeChannelServer: CHANNEL_SERVER,
    claudeSessionId: sessionId,
  });
  return dir;
};

const envelope = (
  overrides: Partial<SupervisorMessageV2DeliveryEnvelope> = {}
): SupervisorMessageV2DeliveryEnvelope => ({
  artifactRefs: [],
  body: "please review",
  deliveryAttempt: 1,
  deliveryId: "delivery-1",
  idempotencyKey: "idem-1",
  messageId: "message-1",
  principal: SENDER_SCOPE.principal,
  schema: "supervisor-message-delivery.v2",
  target: SUP,
  tenantId: TENANT,
  threadId: "thread-msg-1",
  workflowId: "supervisor-message-v2-wf-1",
  ...overrides,
});

interface Harness {
  adapters: SupervisorEndpointKindAdapters;
  claudeReadyDirs: Set<string>;
  codexDelivered: { entry: BridgeMessage; runDir: string }[];
  codexProbes: { remoteUrl: string; threadId: string }[];
  codexReady: boolean;
  delivery: SupervisorEndpointMessageV2Delivery;
  mailboxes: Map<string, string>;
  mailboxPath: string;
  resolved: ResolvedSupervisorEndpoint[];
  resolverCalls: number;
  store: FakeLeaseStore;
  wakes: string[];
}

const fsDeps = {
  readJson: (path: string) => JSON.parse(readFileSync(path, "utf8")),
  realpath: (path: string) => realpathSync(path),
};

const makeHarness = (
  options: {
    adapters?: Partial<SupervisorEndpointKindAdapters>;
    enrollment?: {
      notEnrolled(): readonly string[];
      notEnrolledSince(recipient: string): number | undefined;
    };
    mailbox?: boolean;
    wake?: (recipient: string) => Promise<void> | void;
  } = {}
): Harness => {
  const baseResolver = createSupervisorEndpointLocatorResolver({
    fs: fsDeps,
    roots: roots(),
  });
  const harness = {
    claudeReadyDirs: new Set<string>(),
    codexDelivered: [],
    codexProbes: [],
    codexReady: true,
    mailboxPath: join(mailboxRoot, "alpha.jsonl"),
    mailboxes: new Map<string, string>(),
    resolved: [],
    resolverCalls: 0,
    wakes: [],
  } as unknown as Harness;
  const resolveLocator: SupervisorEndpointLocatorResolver = (
    locator,
    supervisorId
  ) => {
    harness.resolverCalls += 1;
    const resolved = baseResolver(locator, supervisorId);
    harness.resolved.push(resolved);
    return resolved;
  };
  if (options.mailbox !== false) {
    harness.mailboxes.set(SUP, harness.mailboxPath);
  }
  harness.store = new FakeLeaseStore(clock, resolveLocator);
  harness.adapters = {
    ...createSupervisorEndpointKindAdapters({
      claudeProbe: (dir) => harness.claudeReadyDirs.has(dir),
      codexDeliver: (runDir, entry) => {
        harness.codexDelivered.push({ entry, runDir });
        markBridgeMessage(runDir, entry, "delivered", "test provider accepted");
        return Promise.resolve(true);
      },
      codexProbe: (remoteUrl, threadId) => {
        harness.codexProbes.push({ remoteUrl, threadId });
        return Promise.resolve(harness.codexReady);
      },
      loopRunRouteReady: () => true,
      now: () => clock().toISOString(),
    }),
    ...options.adapters,
  } as SupervisorEndpointKindAdapters;
  const directory = {
    resolveMailbox: (id: string) => harness.mailboxes.get(id),
  };
  harness.delivery = new SupervisorEndpointMessageV2Delivery({
    adapters: harness.adapters,
    enrollment: options.enrollment,
    leases: harness.store,
    mailbox: createSupervisorEndpointMailboxPort(directory, () =>
      clock().toISOString()
    ),
    mailboxes: directory,
    now: clock,
    principalForRecipient: principalFor,
    resolveLocator,
    sessions: {
      current: (scope, recipient) => harness.store.current(scope, recipient),
    },
    wake:
      options.wake ??
      ((recipient) => {
        harness.wakes.push(recipient);
      }),
  });
  return harness;
};

const claim = async (
  harness: Harness,
  locator: SupervisorEndpointLocator,
  sessionRef: string,
  recipient = SUP
) => {
  const result = await harness.store.claim({
    holderRef: "holder:one",
    locator,
    recipient,
    scope: { principal: principalFor(recipient) as string, tenantId: TENANT },
    sessionRef,
    ttlMs: TTL_MS,
  });
  if (result.status !== "claimed") {
    throw new Error(`claim refused: ${JSON.stringify(result)}`);
  }
  return result;
};

const LOOP_CLAUDE = {
  kind: "loop-run",
  repoId: "repo-a",
  runId: "7",
  seat: "claude",
} as const;
const LOOP_CODEX = { ...LOOP_CLAUDE, seat: "codex" } as const;
const CODEX_THREAD = {
  kind: "codex-thread",
  repoId: "repo-a",
  runId: "7",
  threadId: THREAD,
} as const;
const CHANNEL = { kind: "claude-channel", sessionId: CHANNEL_SESSION } as const;

const mailboxLines = (harness: Harness): unknown[] =>
  existsSync(harness.mailboxPath)
    ? readFileSync(harness.mailboxPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "r9-endpoint-delivery-"));
  home = join(base, "home");
  outside = join(base, "outside");
  mailboxRoot = join(base, "mailboxes");
  mkdirSync(home);
  mkdirSync(outside);
  mkdirSync(mailboxRoot);
  clockMs = Date.parse("2026-10-11T12:00:00.000Z");
  writeRun("repo-a", "7");
  writeSession();
});

afterEach(() => {
  rmSync(base, { force: true, recursive: true });
});

describe("routing: one rule for readiness and delivery", () => {
  test("no lease with a mailbox is ready-for-mailbox; delivery writes the mailbox then wakes", async () => {
    const harness = makeHarness();
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      state: "mailbox-ready",
    });
    expect(
      await harness.delivery.readiness.assertReady(SENDER_SCOPE, SUP)
    ).toEqual({ state: "mailbox-ready" });
    expect(await harness.delivery.deliver(envelope())).toEqual({
      status: "accepted",
    });
    expect(mailboxLines(harness)).toMatchObject([
      { delivery: "mailbox", idempotencyKey: "idem-1", target: SUP },
    ]);
    expect(harness.wakes).toEqual([SUP]);
    // A redelivery is deduplicated by idempotencyKey; the wake is a trigger.
    expect(await harness.delivery.deliver(envelope())).toEqual({
      status: "accepted",
    });
    expect(mailboxLines(harness)).toHaveLength(1);
    // A mailbox route never resolves a locator.
    expect(harness.resolverCalls).toBe(0);
  });

  test("no lease and no mailbox is unready and undeliverable", async () => {
    const harness = makeHarness({ mailbox: false });
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
      state: "unready",
    });
    await expect(
      harness.delivery.readiness.assertReady(SENDER_SCOPE, SUP)
    ).rejects.toThrow(SUPERVISOR_ENDPOINT_REASONS.noEndpoint);
    expect(await harness.delivery.deliver(envelope())).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
      status: "transient-failure",
    });
    expect(harness.wakes).toEqual([]);
  });

  test("an unconfigured recipient has no seat scope and no route", async () => {
    const harness = makeHarness();
    harness.mailboxes.set("supervisor:ghost", harness.mailboxPath);
    expect(
      await harness.delivery.readiness.readiness(
        SENDER_SCOPE,
        "supervisor:ghost"
      )
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
      state: "unready",
    });
    expect(
      await harness.delivery.deliver(envelope({ target: "supervisor:ghost" }))
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
      status: "transient-failure",
    });
    expect(mailboxLines(harness)).toEqual([]);
    expect(harness.store.resolveCalls).toBe(0);
  });

  test("a released lease falls back to the mailbox; a reclaim takes the endpoint back", async () => {
    const harness = makeHarness();
    const claimed = await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    expect(
      (await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)).state
    ).toBe("endpoint-ready");
    await harness.store.release({
      fence: { epoch: claimed.lease.epoch, holderRef: claimed.lease.holderRef },
      recipient: SUP,
      scope: { principal: SEAT_PRINCIPAL, tenantId: TENANT },
    });
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      state: "mailbox-ready",
    });
    expect(await harness.delivery.deliver(envelope())).toEqual({
      status: "accepted",
    });
    expect(mailboxLines(harness)).toHaveLength(1);
    expect(harness.codexDelivered).toEqual([]);
    const reclaimed = await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    expect(reclaimed.lease.epoch).toBe(claimed.lease.epoch + 1);
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      fence: { epoch: reclaimed.lease.epoch, holderRef: "holder:one" },
      kind: "codex-thread",
      state: "endpoint-ready",
    });
  });

  test("lookups use the seat scope, not the sender scope", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const seen: { principal: string; tenantId: string }[] = [];
    const current = harness.store.current.bind(harness.store);
    harness.store.current = (scope, recipient) => {
      seen.push(scope);
      return current(scope, recipient);
    };
    expect(
      (await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)).state
    ).toBe("endpoint-ready");
    expect(seen).toEqual([{ principal: SEAT_PRINCIPAL, tenantId: TENANT }]);
  });
});

describe("routing edges", () => {
  const direct = (
    harness: Harness,
    overrides: Partial<
      ConstructorParameters<typeof SupervisorEndpointMessageV2Delivery>[0]
    >
  ) =>
    new SupervisorEndpointMessageV2Delivery({
      adapters: harness.adapters,
      leases: harness.store,
      mailbox: createSupervisorEndpointMailboxPort({
        resolveMailbox: (id) => harness.mailboxes.get(id),
      }),
      mailboxes: { resolveMailbox: (id) => harness.mailboxes.get(id) },
      now: clock,
      principalForRecipient: principalFor,
      resolveLocator: () => {
        throw new Error("not used");
      },
      sessions: {
        current: (scope, recipient) => harness.store.current(scope, recipient),
      },
      ...overrides,
    });

  test("a mailbox write that throws is a fixed transient failure and no wake", async () => {
    const harness = makeHarness();
    const wakes: string[] = [];
    const delivery = direct(harness, {
      mailbox: {
        deliver: () => Promise.reject(new Error("EACCES /secret/mailbox")),
      },
      wake: (recipient) => {
        wakes.push(recipient);
      },
    });
    expect(await delivery.deliver(envelope())).toEqual({
      reason: "recipient mailbox write failed",
      status: "transient-failure",
    });
    expect(wakes).toEqual([]);
  });

  test("a mailbox directory that throws counts as no mailbox", async () => {
    const harness = makeHarness();
    const delivery = direct(harness, {
      mailboxes: {
        resolveMailbox: () => {
          throw new Error("directory exploded");
        },
      },
    });
    expect(await delivery.readiness.readiness(SENDER_SCOPE, SUP)).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
      state: "unready",
    });
  });

  test("an expired lease with an unreadable expiry is unready, not a deferral from NaN", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const row = harness.store.rows.get(
      key(TENANT, SUP)
    ) as SupervisorEndpointLeaseV2;
    harness.store.rows.set(key(TENANT, SUP), { ...row, expiresAt: "garbage" });
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.identityChanged,
      state: "unready",
    });
    expect(harness.delivery.readiness.notEnrolledSince(SUP)).toBeUndefined();
  });
});

describe("expired, unreleased lease: deferral within the existing bound", () => {
  test("readiness defers since expiresAt and the runtime deferral bounds it", async () => {
    const harness = makeHarness();
    const claimed = await claim(
      harness,
      LOOP_CLAUDE,
      `session:${CLAUDE_SESSION}`
    );
    clockMs = Date.parse(claimed.lease.expiresAt) + 5000;
    const since = Date.parse(claimed.lease.expiresAt);
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.leaseExpired,
      since,
      state: "deferred",
    });
    await expect(
      harness.delivery.readiness.assertReady(SENDER_SCOPE, SUP)
    ).rejects.toThrow(SUPERVISOR_ENDPOINT_REASONS.leaseExpired);
    expect(harness.delivery.readiness.notEnrolledSince(SUP)).toBe(since);
    expect(harness.delivery.readiness.notEnrolled()).toEqual([SUP]);
    // The existing not-enrolled deferral, fed by this port: defer within the
    // bound measured from expiresAt, fail once past it. No new scheduler.
    const deferral = new SupervisorMessageV2NotEnrolledDeferral({
      boundMs: 60_000,
      enrollment: harness.delivery.readiness,
      log: () => undefined,
    });
    expect(deferral.unready(SUP, new Date(since + 59_999))).toBe("defer");
    expect(deferral.unready(SUP, new Date(since + 60_000))).toBe("fail");
    // Delivery defers too, and never writes the mailbox while a session
    // still holds the (expired) lease.
    expect(await harness.delivery.deliver(envelope())).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.leaseExpired,
      status: "transient-failure",
    });
    expect(mailboxLines(harness)).toEqual([]);
    expect(harness.wakes).toEqual([]);
  });

  test("a renewal ends the spell; the sweep's own answer is kept otherwise", async () => {
    const sweep = new Map<string, number>([[OTHER_SUP, 42]]);
    const harness = makeHarness({
      enrollment: {
        notEnrolled: () => [...sweep.keys()],
        notEnrolledSince: (recipient) => sweep.get(recipient),
      },
    });
    const claimed = await claim(
      harness,
      LOOP_CLAUDE,
      `session:${CLAUDE_SESSION}`
    );
    harness.claudeReadyDirs.add(realpathSync(runDirOf("repo-a", "7")));
    clockMs = Date.parse(claimed.lease.expiresAt) + 1;
    await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP);
    expect(harness.delivery.readiness.notEnrolled()).toEqual([SUP, OTHER_SUP]);
    expect(harness.delivery.readiness.notEnrolledSince(OTHER_SUP)).toBe(42);
    // Expiry alone never fences: the holder renews its expired lease.
    const renewed = await harness.store.renew({
      fence: { epoch: claimed.lease.epoch, holderRef: "holder:one" },
      recipient: SUP,
      scope: { principal: SEAT_PRINCIPAL, tenantId: TENANT },
      ttlMs: TTL_MS,
    });
    expect(renewed.status).toBe("renewed");
    expect(
      (await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)).state
    ).toBe("endpoint-ready");
    expect(harness.delivery.readiness.notEnrolledSince(SUP)).toBeUndefined();
    expect(harness.delivery.readiness.notEnrolled()).toEqual([OTHER_SUP]);
  });
});

describe("live lease: probe and deliver by kind", () => {
  test("loop-run Claude seat: probe binds the run's Claude session and channel readiness", async () => {
    const harness = makeHarness();
    const runDir = realpathSync(runDirOf("repo-a", "7"));
    const claimed = await claim(
      harness,
      LOOP_CLAUDE,
      `session:${CLAUDE_SESSION}`
    );
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      state: "unready",
    });
    harness.claudeReadyDirs.add(runDir);
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      fence: { epoch: claimed.lease.epoch, holderRef: "holder:one" },
      kind: "loop-run",
      state: "endpoint-ready",
    });
    // Delivery goes through the run's bridge queue (server-derived runDir);
    // a Claude queue append is not provider acceptance, so it retries.
    expect(await harness.delivery.deliver(envelope())).toEqual({
      reason: "bridge queued without provider acceptance",
      status: "transient-failure",
    });
    const queued = readBridgeEvents(runDir).filter(
      (event) => event.kind === "message"
    );
    expect(queued).toMatchObject([
      { source: "supervisor", subject: "message-1", target: "claude" },
    ]);
    expect(mailboxLines(harness)).toEqual([]);
  });

  test("loop-run seat: a stopped run or an undeclared seat is not ready", async () => {
    const harness = makeHarness();
    const runDir = realpathSync(runDirOf("repo-a", "7"));
    harness.claudeReadyDirs.add(runDir);
    await claim(harness, LOOP_CLAUDE, `session:${CLAUDE_SESSION}`);
    writeRun("repo-a", "7", { state: "stopped", status: "stopped" });
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      state: "unready",
    });
    expect(await harness.delivery.deliver(envelope())).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      status: "transient-failure",
    });
    writeRun("repo-a", "7", { tmuxPaneLeftAgent: "codex" });
    expect(
      (await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)).state
    ).toBe("unready");
    expect(mailboxLines(harness)).toEqual([]);
  });

  test("loop-run Codex seat: probes the manifest's loopback thread, refuses a non-loopback one", async () => {
    const harness = makeHarness();
    await claim(harness, LOOP_CODEX, `session:${THREAD}`);
    expect(
      (await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)).state
    ).toBe("endpoint-ready");
    expect(harness.codexProbes).toEqual([
      { remoteUrl: REMOTE_URL, threadId: THREAD },
    ]);
    expect(await harness.delivery.deliver(envelope())).toEqual({
      status: "accepted",
    });
    expect(harness.codexDelivered).toHaveLength(1);
    writeRun("repo-a", "7", { codexRemoteUrl: "ws://192.168.1.18:4500" });
    harness.codexProbes.length = 0;
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      state: "unready",
    });
    expect(
      await harness.delivery.deliver(envelope({ workflowId: "wf-2" }))
    ).toMatchObject({ status: "transient-failure" });
    expect(harness.codexProbes).toEqual([]);
    expect(harness.codexDelivered).toHaveLength(1);
  });

  test("loop-run Codex seat: the descriptor must name the run's thread", async () => {
    const harness = makeHarness();
    await claim(harness, LOOP_CODEX, "session:other-thread");
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      state: "unready",
    });
    expect(harness.codexProbes).toEqual([]);
  });

  test("codex-thread: probe and inject at the manifest URL only; a retry does not duplicate work", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    expect(
      (await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)).state
    ).toBe("endpoint-ready");
    expect(await harness.delivery.deliver(envelope())).toEqual({
      status: "accepted",
    });
    expect(
      await harness.delivery.deliver(envelope({ deliveryAttempt: 2 }))
    ).toEqual({ status: "accepted" });
    expect(harness.codexDelivered).toHaveLength(1);
    expect(harness.codexDelivered[0]?.runDir).toBe(
      realpathSync(runDirOf("repo-a", "7"))
    );
    harness.codexReady = false;
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      state: "unready",
    });
    // A transient endpoint failure never falls through to the mailbox.
    expect(
      await harness.delivery.deliver(envelope({ workflowId: "wf-3" }))
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      status: "transient-failure",
    });
    expect(mailboxLines(harness)).toEqual([]);
  });

  test("codex-thread: a manifest that changes thread between resolve and inject is not injected", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const adapters = harness.adapters;
    const endpoint = {
      kind: "codex-thread",
      remoteUrl: REMOTE_URL,
      runDir: realpathSync(runDirOf("repo-a", "7")),
      threadId: THREAD,
    } as const;
    writeRun("repo-a", "7", { codexThreadId: "thread-2" });
    const lease = harness.store.rows.get(
      key(TENANT, SUP)
    ) as SupervisorEndpointLeaseV2;
    expect(
      await adapters["codex-thread"].deliver({
        endpoint,
        envelope: envelope(),
        lease: lease as never,
      })
    ).toMatchObject({ status: "transient-failure" });
    expect(harness.codexDelivered).toEqual([]);
  });

  test("claude-channel: identity from the session dir's session.json, readiness from the channel", async () => {
    const harness = makeHarness();
    const sessionDir = realpathSync(sessionDirOf("alpha", CHANNEL_SESSION));
    const claimed = await claim(harness, CHANNEL, `session:${CHANNEL_SESSION}`);
    expect(
      (await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)).state
    ).toBe("unready");
    harness.claudeReadyDirs.add(sessionDir);
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      fence: { epoch: claimed.lease.epoch, holderRef: "holder:one" },
      kind: "claude-channel",
      state: "endpoint-ready",
    });
    expect(await harness.delivery.deliver(envelope())).toEqual({
      reason: "bridge queued without provider acceptance",
      status: "transient-failure",
    });
    expect(
      readBridgeEvents(sessionDir).filter((event) => event.kind === "message")
    ).toMatchObject([{ source: "supervisor", target: "claude" }]);
    // Once the recipient read it (the bridge's delivered event), a retry is
    // accepted without a second queue entry.
    const [entry] = readBridgeEvents(sessionDir).filter(
      (event) => event.kind === "message"
    ) as BridgeMessage[];
    markBridgeMessage(sessionDir, entry as BridgeMessage, "delivered", "read");
    expect(
      await harness.delivery.deliver(envelope({ deliveryAttempt: 2 }))
    ).toEqual({ status: "accepted" });
    expect(
      readBridgeEvents(sessionDir).filter((event) => event.kind === "message")
    ).toHaveLength(1);
    // A session.json naming another Claude session no longer matches.
    writeBridgeSessionRecord(sessionDir, {
      claudeChannelServer: CHANNEL_SERVER,
      claudeSessionId: "someone-else",
    });
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      state: "unready",
    });
  });

  test("the seat descriptor must still name the lease", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const descriptorKey = `${key(TENANT, SUP)}\n${SEAT_PRINCIPAL}`;
    const original = harness.store.descriptors.get(
      descriptorKey
    ) as SupervisorSessionDescriptorV2;
    const variants: Partial<SupervisorSessionDescriptorV2>[] = [
      { endpointDigest: "f".repeat(64) },
      { endpointRef: "endpoint:loop-run" },
      { provider: "claude-code" },
      { descriptorId: `supervisor-session-descriptor:v2:${"b".repeat(64)}` },
      { revision: 0 },
      { principal: "principal:beta" },
      { sessionRef: "session:other" },
    ];
    for (const variant of variants) {
      harness.store.descriptors.set(descriptorKey, { ...original, ...variant });
      expect(
        await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
      ).toEqual({
        reason: SUPERVISOR_ENDPOINT_REASONS.identityChanged,
        state: "unready",
      });
    }
    harness.store.descriptors.delete(descriptorKey);
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.identityChanged,
      state: "unready",
    });
    harness.store.descriptors.set(descriptorKey, { ...original, revision: 9 });
    expect(
      (await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)).state
    ).toBe("endpoint-ready");
  });

  test("a lease row from another seat scope is refused", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const row = harness.store.rows.get(
      key(TENANT, SUP)
    ) as SupervisorEndpointLeaseV2;
    const descriptorKey = `${key(TENANT, SUP)}\n${SEAT_PRINCIPAL}`;
    const descriptor = harness.store.descriptors.get(
      descriptorKey
    ) as SupervisorSessionDescriptorV2;
    for (const variant of [
      { principal: "principal:beta" },
      { recipient: OTHER_SUP },
      { tenantId: "tenant:other" },
    ]) {
      // Lease and descriptor agree with each other, but not with the seat
      // they were looked up for: the scope check alone must refuse.
      harness.store.rows.set(key(TENANT, SUP), { ...row, ...variant });
      harness.store.descriptors.set(descriptorKey, {
        ...descriptor,
        ...variant,
      });
      expect(
        await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
      ).toEqual({
        reason: SUPERVISOR_ENDPOINT_REASONS.identityChanged,
        state: "unready",
      });
      expect(await harness.delivery.deliver(envelope())).toEqual({
        reason: SUPERVISOR_ENDPOINT_REASONS.identityChanged,
        status: "transient-failure",
      });
    }
    expect(harness.codexDelivered).toEqual([]);
    expect(mailboxLines(harness)).toEqual([]);
  });

  test("adapter failures stay on the endpoint route with fixed reasons", async () => {
    const secret = "/Users/someone/.loop/runs/repo-a/7 ws://127.0.0.1:4500";
    const harness = makeHarness({
      adapters: {
        "codex-thread": {
          deliver: () => Promise.reject(new Error(secret)),
          kind: "codex-thread",
          probe: () => Promise.reject(new Error(secret)),
        },
      },
    });
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      state: "unready",
    });
    expect(await harness.delivery.deliver(envelope())).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      status: "transient-failure",
    });
    const leaky = makeHarness({
      adapters: {
        "codex-thread": {
          deliver: () =>
            Promise.resolve({ reason: secret, status: "permanent-failure" }),
          kind: "codex-thread",
          probe: () => Promise.resolve(true),
        },
      },
    });
    await claim(leaky, CODEX_THREAD, `session:${THREAD}`);
    expect(await leaky.delivery.deliver(envelope())).toEqual({
      reason: "recipient endpoint refused the message",
      status: "permanent-failure",
    });
    expect(mailboxLines(harness)).toEqual([]);
  });

  test("a wake that throws or rejects never changes the mailbox outcome", async () => {
    for (const wake of [
      () => {
        throw new Error("wake exploded");
      },
      () => Promise.reject(new Error("wake rejected")),
    ]) {
      const harness = makeHarness({ wake });
      expect(await harness.delivery.deliver(envelope())).toEqual({
        status: "accepted",
      });
      await Promise.resolve();
    }
  });
});

describe("SECURITY: the stored locator is re-validated on every call", () => {
  test("every readiness check and delivery re-resolves; nothing is cached", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const afterClaim = harness.resolverCalls;
    await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP);
    await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP);
    await harness.delivery.deliver(envelope());
    expect(harness.resolverCalls).toBe(afterClaim + 3);
  });

  const refusedCases: [string, () => void][] = [
    [
      "a foreign manifest (another supervisor)",
      () => writeRun("repo-a", "7", { a2aSupervisorId: OTHER_SUP }),
    ],
    [
      "a manifest naming another run",
      () => writeRun("repo-a", "7", { runId: "8" }),
    ],
    [
      "a run directory swapped for a symlink out of the root",
      () => {
        const dir = runDirOf("repo-a", "7");
        renameSync(dir, join(outside, "moved"));
        symlinkSync(join(outside, "moved"), dir);
      },
    ],
    [
      "a run directory swapped for an in-root alias",
      () => {
        const dir = runDirOf("repo-a", "7");
        renameSync(dir, runDirOf("repo-a", "9"));
        symlinkSync(runDirOf("repo-a", "9"), dir);
      },
    ],
    [
      "a manifest swapped for a symlink out of the root",
      () => {
        const manifestPath = join(runDirOf("repo-a", "7"), "manifest.json");
        renameSync(manifestPath, join(outside, "manifest.json"));
        symlinkSync(join(outside, "manifest.json"), manifestPath);
      },
    ],
    [
      "a removed run directory",
      () => rmSync(runDirOf("repo-a", "7"), { force: true, recursive: true }),
    ],
    [
      "a non-loopback Codex URL",
      () =>
        writeRun("repo-a", "7", { codexRemoteUrl: "ws://192.168.1.18:4500" }),
    ],
    [
      "a hostname Codex URL",
      () =>
        writeRun("repo-a", "7", { codexRemoteUrl: "ws://example.com:4500" }),
    ],
    [
      "an IPv6-mapped Codex URL",
      () =>
        writeRun("repo-a", "7", {
          codexRemoteUrl: "ws://[::ffff:127.0.0.1]:4500",
        }),
    ],
    [
      "a Codex URL with no explicit port",
      () => writeRun("repo-a", "7", { codexRemoteUrl: "ws://127.0.0.1" }),
    ],
    [
      "a Codex URL with a path",
      () =>
        writeRun("repo-a", "7", {
          codexRemoteUrl: "ws://127.0.0.1:4500/redirect",
        }),
    ],
    [
      "a manifest that names another thread",
      () => writeRun("repo-a", "7", { codexThreadId: "thread-9" }),
    ],
  ];

  for (const [name, mutate] of refusedCases) {
    test(`after claim, ${name} is refused on the endpoint route, never the mailbox`, async () => {
      const harness = makeHarness();
      await claim(harness, CODEX_THREAD, `session:${THREAD}`);
      expect(
        (await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)).state
      ).toBe("endpoint-ready");
      harness.codexProbes.length = 0;
      mutate();
      expect(
        await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
      ).toEqual({
        reason: SUPERVISOR_ENDPOINT_REASONS.locatorRefused,
        state: "unready",
      });
      expect(await harness.delivery.deliver(envelope())).toEqual({
        reason: SUPERVISOR_ENDPOINT_REASONS.locatorRefused,
        status: "transient-failure",
      });
      // No provider was dialled and no mail was written.
      expect(harness.codexProbes).toEqual([]);
      expect(harness.codexDelivered).toEqual([]);
      expect(mailboxLines(harness)).toEqual([]);
      expect(harness.wakes).toEqual([]);
    });
  }

  test("a claude-channel session directory swapped for a symlink is refused", async () => {
    const harness = makeHarness();
    const dir = sessionDirOf("alpha", CHANNEL_SESSION);
    harness.claudeReadyDirs.add(realpathSync(dir));
    await claim(harness, CHANNEL, `session:${CHANNEL_SESSION}`);
    renameSync(dir, join(outside, "sess"));
    symlinkSync(join(outside, "sess"), dir);
    harness.claudeReadyDirs.add(join(outside, "sess"));
    harness.claudeReadyDirs.add(realpathSync(join(outside, "sess")));
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.locatorRefused,
      state: "unready",
    });
    expect(await harness.delivery.deliver(envelope())).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.locatorRefused,
      status: "transient-failure",
    });
    expect(existsSync(join(outside, "sess", "bridge.jsonl"))).toBe(false);
  });

  test("a claude-channel locator resolves only under the lease recipient's own slug", async () => {
    writeSession("beta", "beta-sess");
    const harness = makeHarness();
    // The id exists only under supervisor:beta's directory; supervisor:alpha
    // cannot name it, at claim or later.
    const refused = await harness.store.claim({
      holderRef: "holder:one",
      locator: { kind: "claude-channel", sessionId: "beta-sess" },
      recipient: SUP,
      scope: { principal: SEAT_PRINCIPAL, tenantId: TENANT },
      sessionRef: "session:beta-sess",
      ttlMs: TTL_MS,
    });
    expect(refused).toEqual({
      reason: "unresolved",
      status: "locator-refused",
    });
  });

  test("a resolver that returns another kind is refused", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const lease = harness.store.rows.get(
      key(TENANT, SUP)
    ) as SupervisorEndpointLeaseV2;
    const descriptor = await harness.store.current(
      { principal: SEAT_PRINCIPAL, tenantId: TENANT },
      SUP
    );
    expect(
      await checkSupervisorEndpointLease({
        adapters: harness.adapters,
        descriptor,
        lease,
        resolveLocator: () => ({
          kind: "claude-channel",
          sessionDir: sessionDirOf("alpha", CHANNEL_SESSION),
        }),
      })
    ).toBe(SUPERVISOR_ENDPOINT_REASONS.locatorRefused);
  });

  test("a 3xx upgrade from the manifest's loopback URL fails the probe and is not followed", async () => {
    let redirectHits = 0;
    let targetHits = 0;
    const target = serve({
      fetch: () => {
        targetHits += 1;
        return new Response("not a websocket", { status: 400 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    const redirect = serve({
      fetch: () => {
        redirectHits += 1;
        return new Response(null, {
          headers: { Location: `ws://127.0.0.1:${target.port}/` },
          status: 302,
        });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      writeRun("repo-a", "7", {
        codexRemoteUrl: `ws://127.0.0.1:${redirect.port}`,
      });
      const harness = makeHarness({
        // The production adapters: the real probeCodexThread and client.
        adapters: createSupervisorEndpointKindAdapters({
          loopRunRouteReady: () => true,
        }),
      });
      await claim(harness, CODEX_THREAD, `session:${THREAD}`);
      expect(
        await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
      ).toEqual({
        reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
        state: "unready",
      });
      expect(redirectHits).toBe(1);
      expect(targetHits).toBe(0);
    } finally {
      redirect.stop(true);
      target.stop(true);
    }
  });
});

describe("SECURITY: adapter guards hold on their own", () => {
  const queuedFor = (dir: string, workflowId: string) =>
    readBridgeEvents(dir).filter(
      (event) =>
        event.kind === "message" &&
        (event as BridgeMessage).taskId === workflowId
    );
  const codexEndpoint = (
    overrides: Partial<
      ResolvedSupervisorEndpoint & { kind: "codex-thread" }
    > = {}
  ) =>
    ({
      kind: "codex-thread",
      remoteUrl: REMOTE_URL,
      runDir: realpathSync(runDirOf("repo-a", "7")),
      threadId: THREAD,
      ...overrides,
    }) as const;
  const descriptorFor = async (harness: Harness) =>
    (await harness.store.current(
      { principal: SEAT_PRINCIPAL, tenantId: TENANT },
      SUP
    )) as SupervisorSessionDescriptorV2;
  const leaseOf = (harness: Harness) =>
    harness.store.rows.get(key(TENANT, SUP)) as never;

  test("loop-run Claude seat: the descriptor must name the run's Claude session", async () => {
    const harness = makeHarness();
    harness.claudeReadyDirs.add(realpathSync(runDirOf("repo-a", "7")));
    await claim(harness, LOOP_CLAUDE, "session:another-claude");
    expect(
      await harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      state: "unready",
    });
  });

  test("loop-run Codex seat: nothing is queued for a non-loopback manifest URL", async () => {
    const harness = makeHarness();
    const runDir = realpathSync(runDirOf("repo-a", "7"));
    const endpoint = {
      kind: "loop-run",
      manifestPath: join(runDir, "manifest.json"),
      runDir,
      seat: "codex",
    } as const;
    writeRun("repo-a", "7", { codexRemoteUrl: "ws://10.0.0.5:4500" });
    expect(
      await harness.adapters["loop-run"].deliver({
        endpoint,
        envelope: envelope(),
        lease: leaseOf(harness),
      })
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      status: "transient-failure",
    });
    expect(queuedFor(runDir, "supervisor-message-v2-wf-1")).toEqual([]);
    expect(harness.codexDelivered).toEqual([]);
  });

  test("loop-run Codex seat: a URL that turns non-loopback after routing is not injected", async () => {
    const delivered: string[] = [];
    const runDir = realpathSync(runDirOf("repo-a", "7"));
    const adapter = createLoopRunEndpointAdapter({
      codexDeliver: (dir) => {
        delivered.push(dir);
        return Promise.resolve(true);
      },
      loopRunRouteReady: () => {
        writeRun("repo-a", "7", { codexRemoteUrl: "ws://10.0.0.5:4500" });
        return true;
      },
    });
    expect(
      await adapter.deliver({
        endpoint: {
          kind: "loop-run",
          manifestPath: join(runDir, "manifest.json"),
          runDir,
          seat: "codex",
        },
        envelope: envelope(),
        lease: undefined as never,
      })
    ).toMatchObject({ status: "transient-failure" });
    expect(delivered).toEqual([]);
  });

  for (const [name, change] of [
    ["thread", { codexThreadId: "thread-2" }],
    ["URL", { codexRemoteUrl: "ws://127.0.0.1:4501" }],
  ] as const) {
    test(`codex-thread: a manifest ${name} that changes between resolve and inject is not injected`, async () => {
      const harness = makeHarness();
      await claim(harness, CODEX_THREAD, `session:${THREAD}`);
      writeRun("repo-a", "7", change);
      expect(
        await harness.adapters["codex-thread"].deliver({
          endpoint: codexEndpoint(),
          envelope: envelope(),
          lease: leaseOf(harness),
        })
      ).toMatchObject({ status: "transient-failure" });
      expect(harness.codexDelivered).toEqual([]);
    });
  }

  test("codex-thread: a non-loopback endpoint is neither probed nor dialled", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const adapter = harness.adapters["codex-thread"];
    const descriptor = await descriptorFor(harness);
    for (const remoteUrl of [
      "ws://192.168.1.18:4500",
      "ws://localhost.example.com:4500",
      "wss://127.0.0.1:4500",
    ]) {
      expect(
        await adapter.probe({
          descriptor,
          endpoint: codexEndpoint({ remoteUrl }),
          lease: leaseOf(harness),
        })
      ).toBe(false);
      expect(
        await adapter.deliver({
          endpoint: codexEndpoint({ remoteUrl }),
          envelope: envelope(),
          lease: leaseOf(harness),
        })
      ).toEqual({
        reason: SUPERVISOR_ENDPOINT_REASONS.locatorRefused,
        status: "transient-failure",
      });
    }
    expect(harness.codexProbes).toEqual([]);
    expect(harness.codexDelivered).toEqual([]);
    expect(
      queuedFor(
        realpathSync(runDirOf("repo-a", "7")),
        "supervisor-message-v2-wf-1"
      )
    ).toEqual([]);
  });

  test("codex-thread: the probe requires the descriptor to name the thread", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const descriptor = await descriptorFor(harness);
    expect(
      await harness.adapters["codex-thread"].probe({
        descriptor: { ...descriptor, sessionRef: "session:thread-2" },
        endpoint: codexEndpoint(),
        lease: leaseOf(harness),
      })
    ).toBe(false);
    expect(harness.codexProbes).toEqual([]);
  });

  test("claude-channel: nothing is queued while the channel is not ready", async () => {
    const harness = makeHarness();
    const sessionDir = realpathSync(sessionDirOf("alpha", CHANNEL_SESSION));
    const adapter = createClaudeChannelEndpointAdapter({
      claudeProbe: () => false,
    });
    expect(
      await adapter.deliver({
        endpoint: { kind: "claude-channel", sessionDir },
        envelope: envelope(),
        lease: leaseOf(harness),
      })
    ).toEqual({
      reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
      status: "transient-failure",
    });
    expect(queuedFor(sessionDir, "supervisor-message-v2-wf-1")).toEqual([]);
  });
});

describe("outages are opaque", () => {
  test("a lease store failure is the readiness outage error, never driver text", async () => {
    const harness = makeHarness();
    harness.store.failure = new Error(
      "connect ECONNREFUSED postgres://loop:hunter2@192.168.1.18:5432/loop"
    );
    const failure = await harness.delivery.readiness
      .readiness(SENDER_SCOPE, SUP)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(
      SupervisorMessageV2ReadinessUnavailableError
    );
    expect((failure as Error).message).toBe(
      "session readiness store is unavailable"
    );
    await expect(
      harness.delivery.readiness.assertReady(SENDER_SCOPE, SUP)
    ).rejects.toBeInstanceOf(SupervisorMessageV2ReadinessUnavailableError);
    expect(await harness.delivery.deliver(envelope())).toEqual({
      reason: "session readiness store is unavailable",
      status: "transient-failure",
    });
    expect(mailboxLines(harness)).toEqual([]);
  });

  test("a descriptor store failure is the outage error too", async () => {
    const harness = makeHarness();
    await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    harness.store.current = () =>
      Promise.reject(new Error("pg: secret detail"));
    await expect(
      harness.delivery.readiness.readiness(SENDER_SCOPE, SUP)
    ).rejects.toBeInstanceOf(SupervisorMessageV2ReadinessUnavailableError);
  });
});

describe("lease-backed provider readiness for the session store", () => {
  test("endpoint descriptors are recognized by their kind ref only", () => {
    expect(isSupervisorEndpointDescriptorRef("endpoint:loop-run")).toBe(true);
    expect(isSupervisorEndpointDescriptorRef("endpoint:claude-channel")).toBe(
      true
    );
    expect(isSupervisorEndpointDescriptorRef("endpoint:codex-thread")).toBe(
      true
    );
    expect(isSupervisorEndpointDescriptorRef("endpoint:claude-code")).toBe(
      false
    );
    expect(isSupervisorEndpointDescriptorRef("endpoint:codex-app-server")).toBe(
      false
    );
  });

  test("a live, matching lease is ready; expired, released, mismatched or refused are not", async () => {
    const harness = makeHarness();
    const claimed = await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const endpoints = new SupervisorEndpointDescriptorReadiness({
      adapters: harness.adapters,
      leases: harness.store,
      resolveLocator: (locator, supervisorId) =>
        createSupervisorEndpointLocatorResolver({ fs: fsDeps, roots: roots() })(
          locator,
          supervisorId
        ),
    });
    const directoryCalls: string[] = [];
    const provider = new LoopCodexSessionV2ProviderReadiness({
      directory: {
        resolve: (id) => {
          directoryCalls.push(id);
          return undefined;
        },
      },
      endpoints,
    });
    expect(await provider.ready(claimed.descriptor)).toEqual({
      descriptorId: claimed.descriptor.descriptorId,
      endpointDigest: claimed.descriptor.endpointDigest,
      provider: "codex-app-server",
      revision: claimed.descriptor.revision,
      sessionRef: `session:${THREAD}`,
      status: "ready",
    });
    expect(directoryCalls).toEqual([]);
    await expect(
      provider.ready({ ...claimed.descriptor, endpointDigest: "0".repeat(64) })
    ).rejects.toThrow(SUPERVISOR_ENDPOINT_REASONS.identityChanged);
    writeRun("repo-a", "7", { a2aSupervisorId: OTHER_SUP });
    await expect(provider.ready(claimed.descriptor)).rejects.toThrow(
      SUPERVISOR_ENDPOINT_REASONS.locatorRefused
    );
    writeRun("repo-a", "7");
    harness.codexReady = false;
    await expect(provider.ready(claimed.descriptor)).rejects.toThrow(
      SUPERVISOR_ENDPOINT_REASONS.probeFailed
    );
    harness.codexReady = true;
    clockMs = Date.parse(claimed.lease.expiresAt);
    await expect(provider.ready(claimed.descriptor)).rejects.toThrow(
      SUPERVISOR_ENDPOINT_REASONS.leaseExpired
    );
    await harness.store.release({
      fence: { epoch: claimed.lease.epoch, holderRef: "holder:one" },
      recipient: SUP,
      scope: { principal: SEAT_PRINCIPAL, tenantId: TENANT },
    });
    await expect(provider.ready(claimed.descriptor)).rejects.toThrow(
      SUPERVISOR_ENDPOINT_REASONS.probeFailed
    );
    harness.store.failure = new Error("pg: secret");
    await expect(provider.ready(claimed.descriptor)).rejects.toBeInstanceOf(
      SupervisorMessageV2ReadinessUnavailableError
    );
  });

  test("an endpoint descriptor with no endpoint readiness configured is refused", async () => {
    const harness = makeHarness();
    const claimed = await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    const provider = new LoopCodexSessionV2ProviderReadiness({
      directory: {
        resolve: () => ({ runDir: runDirOf("repo-a", "7"), target: "codex" }),
      },
      probe: () => Promise.resolve(true),
    });
    await expect(provider.ready(claimed.descriptor)).rejects.toThrow(
      "configured recipient has no endpoint readiness"
    );
  });

  test("an r8 manifest-bound descriptor keeps the directory path", async () => {
    const runDir = runDirOf("repo-a", "7");
    const descriptor: SupervisorSessionDescriptorV2 = {
      descriptorId: `supervisor-session-descriptor:v2:${"a".repeat(64)}`,
      endpointDigest: createHash("sha256").update(REMOTE_URL).digest("hex"),
      endpointRef: "endpoint:codex-app-server",
      expiresAt: "2026-10-11T13:00:00.000Z",
      issuedAt: "2026-10-11T12:00:00.000Z",
      principal: SEAT_PRINCIPAL,
      provider: "codex-app-server",
      recipient: SUP,
      revision: 1,
      schema: SUPERVISOR_SESSION_DESCRIPTOR_V2_SCHEMA,
      sessionRef: `session:${THREAD}`,
      tenantId: TENANT,
    };
    const endpointCalls: unknown[] = [];
    const provider = new LoopCodexSessionV2ProviderReadiness({
      directory: { resolve: () => ({ runDir, target: "codex" }) },
      endpoints: {
        ready: (value) => {
          endpointCalls.push(value);
          return Promise.resolve();
        },
      },
      probe: () => Promise.resolve(true),
    });
    expect((await provider.ready(descriptor)).status).toBe("ready");
    expect(endpointCalls).toEqual([]);
    const noDirectory = new LoopCodexSessionV2ProviderReadiness({
      probe: () => Promise.resolve(true),
    });
    await expect(noDirectory.ready(descriptor)).rejects.toThrow(
      "configured recipient has no Codex route"
    );
  });

  test("supervisorEndpointDescriptorMatchesLease refuses a lease whose locator kind disagrees", async () => {
    const harness = makeHarness();
    const claimed = await claim(harness, CODEX_THREAD, `session:${THREAD}`);
    expect(
      supervisorEndpointDescriptorMatchesLease(
        claimed.descriptor,
        claimed.lease
      )
    ).toBe(true);
    expect(
      supervisorEndpointDescriptorMatchesLease(claimed.descriptor, {
        ...claimed.lease,
        kind: "loop-run",
      })
    ).toBe(false);
    expect(
      supervisorEndpointDescriptorMatchesLease(claimed.descriptor, {
        ...claimed.lease,
        recipient: OTHER_SUP,
      })
    ).toBe(false);
    expect(
      supervisorEndpointDescriptorMatchesLease(claimed.descriptor, {
        ...claimed.lease,
        tenantId: "tenant:other",
      })
    ).toBe(false);
  });
});
