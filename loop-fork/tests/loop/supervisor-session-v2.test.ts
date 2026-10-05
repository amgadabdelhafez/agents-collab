import { expect, test } from "bun:test";
import {
  deriveSupervisorSessionDescriptorV2Id,
  PostgresSupervisorSessionV2Store,
  type SupervisorSessionDescriptorV2,
  type SupervisorSessionProviderReadinessPort,
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

/**
 * A controlled in-memory stand-in for the four statements this store issues
 * on the readiness path. It honours the receipt INSERT's ON CONFLICT clause so
 * the test observes whether a later probe refreshes the stored receipt.
 * Real PostgreSQL coverage lives in supervisor-a2a-v2-service.test.ts.
 */
const controlledSql = () => {
  const descriptors = new Map<string, { json: string; key: string }>();
  const receipts = new Map<string, string>();
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
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
          descriptor_json: row.json,
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
    controlledSql(),
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
