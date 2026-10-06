import { expect, test } from "bun:test";
import { SupervisorMessageV2ReadinessUnavailableError } from "../../src/loop/supervisor-message-v2-runtime";
import {
  deriveSupervisorSessionDescriptorV2Id,
  PostgresSupervisorSessionV2Store,
  SUPERVISOR_SESSION_READINESS_CLOCK_SKEW_MS,
  type SupervisorSessionDescriptorV2,
  type SupervisorSessionProviderReadinessPort,
  SupervisorSessionV2Error,
} from "../../src/loop/supervisor-session-v2";
import { SupervisorSessionV2DagAdapter } from "../../src/loop/supervisor-session-v2-dag-adapter";

const SCOPE = {
  principal: "principal:session-freshness-test",
  tenantId: "tenant:session-freshness-test",
};
const RECIPIENT = "supervisor:session-freshness";
const START = Date.parse("2026-09-27T12:00:00.000Z");

const descriptor = (): SupervisorSessionDescriptorV2 => ({
  descriptorId: deriveSupervisorSessionDescriptorV2Id(SCOPE, RECIPIENT),
  endpointDigest: "b".repeat(64),
  endpointRef: "endpoint:session-freshness",
  expiresAt: "2026-09-28T12:00:00.000Z",
  issuedAt: "2026-09-27T11:00:00.000Z",
  principal: SCOPE.principal,
  provider: "controlled-test",
  recipient: RECIPIENT,
  revision: 1,
  schema: "supervisor-session-descriptor.v2",
  sessionRef: "session:session-freshness",
  tenantId: SCOPE.tenantId,
});

/** Faults the controlled SQL below can inject on the readiness path. */
interface ControlledOutage {
  /** The stored descriptor row reads back as unparseable JSON. */
  corruptDescriptor: boolean;
  /** Every statement throws, as an unreachable database would. */
  down: boolean;
  /** Only the receipt write inside the readiness transaction throws. */
  receiptWriteDown: boolean;
}

/** A fake driver error carrying connection detail that must never surface. */
const OUTAGE_DETAIL =
  "connect ECONNREFUSED postgres://loop:hunter2@10.0.0.9:5432/loop";

/**
 * A controlled in-memory stand-in for the four statements this store issues
 * on the readiness path. It honours the receipt INSERT's ON CONFLICT clause so
 * the test observes whether a later probe refreshes the stored receipt.
 * Real PostgreSQL coverage lives in supervisor-a2a-v2-service.test.ts.
 */
const controlledSql = (outage: ControlledOutage) => {
  const descriptors = new Map<string, { json: string; key: string }>();
  const receipts = new Map<string, string>();
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (
      outage.down ||
      (outage.receiptWriteDown &&
        text.includes(
          "INSERT INTO loop_supervisor_session_v2_readiness_receipt"
        ))
    ) {
      return Promise.reject(new Error(OUTAGE_DETAIL));
    }
    let rows: Record<string, unknown>[] = [];
    if (text.includes("INSERT INTO loop_supervisor_session_v2_descriptor")) {
      const [id, tenant, principal, recipient, , json] = values as string[];
      if (!descriptors.has(String(id))) {
        descriptors.set(String(id), {
          json: String(json),
          key: `${tenant}|${principal}|${recipient}`,
        });
      }
    } else if (text.includes("SELECT descriptor_json")) {
      const [tenant, principal, recipient] = values as string[];
      const key = `${tenant}|${principal}|${recipient}`;
      rows = [...descriptors.values()]
        .filter((row) => row.key === key)
        .map((row) => ({
          descriptor_json: outage.corruptDescriptor ? "{not json" : row.json,
          principal,
          tenant_id: tenant,
        }));
    } else if (
      text.includes("INSERT INTO loop_supervisor_session_v2_readiness_receipt")
    ) {
      const [id, , , , json] = values as string[];
      if (!receipts.has(String(id)) || text.includes("DO UPDATE")) {
        receipts.set(String(id), String(json));
      }
    } else if (text.includes("SELECT receipt_json")) {
      const json = receipts.get(String(values[0]));
      rows = json ? [{ receipt_json: json }] : [];
    } else {
      throw new Error(`unexpected statement: ${text}`);
    }
    return Promise.resolve(Object.assign(rows, { count: rows.length }));
  };
  return Object.assign(run, {
    begin: (callback: (sql: typeof run) => Promise<unknown>) => callback(run),
    close: () => Promise.resolve(),
  });
};

const harness = (readinessMaxAgeMs?: number) => {
  let nowMs = START;
  let alive = true;
  const outage: ControlledOutage = {
    corruptDescriptor: false,
    down: false,
    receiptWriteDown: false,
  };
  const provider: SupervisorSessionProviderReadinessPort = {
    ready: (current) => {
      if (!alive) {
        throw new Error("controlled seat is gone");
      }
      return {
        descriptorId: current.descriptorId,
        endpointDigest: current.endpointDigest,
        provider: current.provider,
        revision: current.revision,
        sessionRef: current.sessionRef,
        status: "ready" as const,
      };
    },
  };
  // The store's constructor is private to keep production callers on
  // connect(); this test reaches it directly with the controlled SQL above.
  const Store = PostgresSupervisorSessionV2Store as unknown as new (
    ...args: unknown[]
  ) => PostgresSupervisorSessionV2Store;
  const store = new Store(
    controlledSql(outage),
    provider,
    {
      decide: () => ({
        allowed: false,
        authorityRef: "authority:none",
        reasonCode: "denied",
      }),
    },
    () => new Date(nowMs).toISOString(),
    readinessMaxAgeMs
  );
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    kill: () => {
      alive = false;
    },
    outage,
    store,
  };
};

test("session status stops reporting ready once the last successful probe is stale", async () => {
  const { advance, kill, store } = harness(60_000);
  await store.register(SCOPE, descriptor());
  await store.assertReady(SCOPE, RECIPIENT);
  const gate = new SupervisorSessionV2DagAdapter(store);
  await expect(gate.status(SCOPE, RECIPIENT)).resolves.toMatchObject({
    ready: true,
  });

  // The seat dies after its one successful probe. Nothing re-probes, and the
  // descriptor itself is still well inside its 24h expiry.
  kill();
  await expect(store.assertReady(SCOPE, RECIPIENT)).rejects.toThrow(
    "controlled seat is gone"
  );
  advance(60_001);
  await expect(store.status(SCOPE, RECIPIENT)).resolves.toMatchObject({
    ready: false,
  });
  await expect(gate.status(SCOPE, RECIPIENT)).resolves.toMatchObject({
    ready: false,
  });
});

test("each successful probe refreshes session readiness for the same revision", async () => {
  const { advance, store } = harness(60_000);
  await store.register(SCOPE, descriptor());
  await store.assertReady(SCOPE, RECIPIENT);
  advance(45_000);
  await store.assertReady(SCOPE, RECIPIENT);
  advance(45_000);
  const status = await store.status(SCOPE, RECIPIENT);
  expect(status?.ready).toBe(true);
  const receipt = await store.readinessReceipt(
    SCOPE,
    descriptor().descriptorId,
    1
  );
  expect(receipt?.checkedAt).toBe(new Date(START + 45_000).toISOString());
  expect(status?.readinessReceiptId).toBe(receipt?.receiptId ?? "absent");
});

test("session readiness uses a short default freshness window", async () => {
  const { advance, store } = harness();
  await store.register(SCOPE, descriptor());
  await store.assertReady(SCOPE, RECIPIENT);
  await expect(store.status(SCOPE, RECIPIENT)).resolves.toMatchObject({
    ready: true,
  });
  advance(60 * 60 * 1000);
  await expect(store.status(SCOPE, RECIPIENT)).resolves.toMatchObject({
    ready: false,
  });
});

test("a readiness receipt dated beyond the clock-skew tolerance is not fresh", async () => {
  const { advance, store } = harness(60_000);
  await store.register(SCOPE, descriptor());
  // A host whose clock runs ten minutes fast writes the receipt.
  advance(10 * 60 * 1000);
  await store.assertReady(SCOPE, RECIPIENT);
  advance(-10 * 60 * 1000);
  await expect(store.status(SCOPE, RECIPIENT)).resolves.toMatchObject({
    ready: false,
  });
  // It must not read fresh at any point during the ten minutes either.
  advance(9 * 60 * 1000);
  await expect(store.status(SCOPE, RECIPIENT)).resolves.toMatchObject({
    ready: false,
  });
});

test("a readiness receipt within the clock-skew tolerance stays fresh, one millisecond past it does not", async () => {
  const { advance, store } = harness(60_000);
  await store.register(SCOPE, descriptor());
  advance(SUPERVISOR_SESSION_READINESS_CLOCK_SKEW_MS);
  await store.assertReady(SCOPE, RECIPIENT);
  advance(-SUPERVISOR_SESSION_READINESS_CLOCK_SKEW_MS);
  await expect(store.status(SCOPE, RECIPIENT)).resolves.toMatchObject({
    ready: true,
  });

  advance(SUPERVISOR_SESSION_READINESS_CLOCK_SKEW_MS + 1);
  await store.assertReady(SCOPE, RECIPIENT);
  advance(-(SUPERVISOR_SESSION_READINESS_CLOCK_SKEW_MS + 1));
  await expect(store.status(SCOPE, RECIPIENT)).resolves.toMatchObject({
    ready: false,
  });
});

const rejection = async (operation: Promise<unknown>): Promise<Error> => {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("rejection was not an Error");
  }
  throw new Error("operation did not reject");
};

test("a readiness store outage is reported as unavailable with an opaque message", async () => {
  const { outage, store } = harness(60_000);
  await store.register(SCOPE, descriptor());

  outage.down = true;
  const unreachable = await rejection(store.assertReady(SCOPE, RECIPIENT));
  expect(unreachable).toBeInstanceOf(
    SupervisorMessageV2ReadinessUnavailableError
  );
  expect(unreachable.message).toBe("session readiness store is unavailable");
  expect(JSON.stringify(unreachable)).not.toContain("hunter2");
  expect(String(unreachable.stack)).not.toContain("hunter2");

  // The provider probe succeeded, but the receipt write inside the
  // transaction cannot reach the store.
  outage.down = false;
  outage.receiptWriteDown = true;
  const writeFailed = await rejection(store.assertReady(SCOPE, RECIPIENT));
  expect(writeFailed).toBeInstanceOf(
    SupervisorMessageV2ReadinessUnavailableError
  );
  expect(writeFailed.message).not.toContain("hunter2");

  outage.receiptWriteDown = false;
  await expect(store.assertReady(SCOPE, RECIPIENT)).resolves.toMatchObject({
    status: "ready",
  });
});

test("an unready seat, absent or corrupt descriptor stays an ordinary readiness refusal", async () => {
  const { kill, outage, store } = harness(60_000);
  await store.register(SCOPE, descriptor());

  // A corrupt stored row is the store answering, not the store being down:
  // it must stay a bounded readiness failure instead of deferring forever.
  outage.corruptDescriptor = true;
  const corrupt = await rejection(store.assertReady(SCOPE, RECIPIENT));
  expect(corrupt).toBeInstanceOf(SupervisorSessionV2Error);
  expect(corrupt).not.toBeInstanceOf(
    SupervisorMessageV2ReadinessUnavailableError
  );
  outage.corruptDescriptor = false;

  const absent = await rejection(
    store.assertReady(SCOPE, "supervisor:session-absent")
  );
  expect(absent).toBeInstanceOf(SupervisorSessionV2Error);
  expect(absent).not.toBeInstanceOf(
    SupervisorMessageV2ReadinessUnavailableError
  );

  kill();
  const dead = await rejection(store.assertReady(SCOPE, RECIPIENT));
  expect(dead.message).toBe("controlled seat is gone");
  expect(dead).not.toBeInstanceOf(SupervisorMessageV2ReadinessUnavailableError);
});
