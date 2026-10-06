import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import {
  deriveSupervisorSessionDescriptorV2Id,
  PostgresSupervisorSessionV2Store,
  type SupervisorSessionDescriptorV2,
  type SupervisorSessionProviderReadinessPort,
} from "../../src/loop/supervisor-session-v2";
import { SupervisorSessionV2DagAdapter } from "../../src/loop/supervisor-session-v2-dag-adapter";
import { DisposablePostgres } from "../support/disposable-postgres";

// Real PostgreSQL (a task-owned Docker container) for the session store's
// renewal path: receipt retention, readiness across a renewal, and a renewal
// racing a readiness probe.

let postgres: DisposablePostgres;
let admin: SQL;

beforeAll(async () => {
  postgres = await DisposablePostgres.create();
  admin = new SQL(postgres.databaseUrl());
  await admin.connect();
}, 120_000);

afterAll(async () => {
  await admin?.close({ timeout: 0 }).catch(() => undefined);
  await postgres?.close();
});

const START = Date.parse("2026-10-05T12:00:00.000Z");
const HOUR = 3_600_000;

const scope = () => ({
  principal: "principal:session-retention",
  tenantId: `tenant:retention-${randomUUID().slice(0, 8)}`,
});
type Scope = ReturnType<typeof scope>;

const descriptor = (
  owner: Scope,
  recipient: string,
  input: { revision: number; sessionRef?: string; issuedAtMs?: number }
): SupervisorSessionDescriptorV2 => {
  const issuedAtMs = input.issuedAtMs ?? START;
  return {
    descriptorId: deriveSupervisorSessionDescriptorV2Id(owner, recipient),
    endpointDigest: "c".repeat(64),
    endpointRef: "endpoint:session-retention",
    expiresAt: new Date(issuedAtMs + 24 * HOUR).toISOString(),
    issuedAt: new Date(issuedAtMs).toISOString(),
    principal: owner.principal,
    provider: "controlled-test",
    recipient,
    revision: input.revision,
    schema: "supervisor-session-descriptor.v2",
    sessionRef: input.sessionRef ?? "session:retention-a",
    tenantId: owner.tenantId,
  };
};

const echo: SupervisorSessionProviderReadinessPort["ready"] = (current) => ({
  descriptorId: current.descriptorId,
  endpointDigest: current.endpointDigest,
  provider: current.provider,
  revision: current.revision,
  sessionRef: current.sessionRef,
  status: "ready" as const,
});

const allow = {
  decide: () => ({
    allowed: true,
    authorityRef: "authority:session-retention",
    reasonCode: "configured-session-rebind",
  }),
};

const connect = async (
  input: {
    clock?: { ms: number };
    ready?: SupervisorSessionProviderReadinessPort["ready"];
    receiptRetention?: { keepLatest: number; keepNewerThanMs: number };
  } = {}
) => {
  const clock = input.clock ?? { ms: START };
  const store = await PostgresSupervisorSessionV2Store.connect({
    authority: allow,
    databaseUrl: postgres.databaseUrl(),
    now: () => new Date(clock.ms).toISOString(),
    provider: { ready: (current) => (input.ready ?? echo)(current) },
    receiptRetention: input.receiptRetention,
  });
  await store.migrate();
  return store;
};

const receiptCounts = async (owner: Scope, recipient: string) => {
  const id = deriveSupervisorSessionDescriptorV2Id(owner, recipient);
  const [rebind] = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM loop_supervisor_session_v2_rebind_receipt
    WHERE descriptor_id = ${id} AND tenant_id = ${owner.tenantId}
      AND principal = ${owner.principal}
  `;
  const [readiness] = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM loop_supervisor_session_v2_readiness_receipt
    WHERE descriptor_id = ${id} AND tenant_id = ${owner.tenantId}
      AND principal = ${owner.principal}
  `;
  return { readiness: readiness?.count, rebind: rebind?.count };
};

const rebindRevisions = async (owner: Scope, recipient: string) =>
  (
    await admin<{ revision: number }[]>`
      SELECT ((receipt_json #>> '{}')::jsonb->>'toRevision')::int AS revision
      FROM loop_supervisor_session_v2_rebind_receipt
      WHERE descriptor_id = ${deriveSupervisorSessionDescriptorV2Id(owner, recipient)}
        AND tenant_id = ${owner.tenantId}
        AND principal = ${owner.principal}
      ORDER BY revision
    `
  ).map((row) => row.revision);

const readinessRevisions = async (owner: Scope, recipient: string) =>
  (
    await admin<{ revision: number }[]>`
      SELECT ((receipt_json #>> '{}')::jsonb->>'descriptorRevision')::int AS revision
      FROM loop_supervisor_session_v2_readiness_receipt
      WHERE descriptor_id = ${deriveSupervisorSessionDescriptorV2Id(owner, recipient)}
        AND tenant_id = ${owner.tenantId}
        AND principal = ${owner.principal}
      ORDER BY revision
    `
  ).map((row) => row.revision);

/**
 * Plants aged rows that reuse a seat's descriptor id under another tenant and
 * under another principal, in both receipt tables. A seat's renewal must
 * never prune outside its own scope, whatever the id, nor let such rows (at a
 * revision above any of its own) take its latest-N places. Returns a live
 * count of the planted rows.
 */
const plantForeignRows = async (owner: Scope, recipient: string) => {
  const id = deriveSupervisorSessionDescriptorV2Id(owner, recipient);
  const foreign = [
    { principal: owner.principal, tenant: "tenant:forged" },
    { principal: "principal:forged", tenant: owner.tenantId },
  ];
  for (const { principal, tenant } of foreign) {
    await admin`
      INSERT INTO loop_supervisor_session_v2_rebind_receipt
        (receipt_id, descriptor_id, tenant_id, principal, receipt_json, created_at)
      VALUES (${`forged-rebind-${randomUUID()}`}, ${id}, ${tenant}, ${principal},
        '{"toRevision": 999}'::jsonb, now() - interval '30 days')
    `;
    await admin`
      INSERT INTO loop_supervisor_session_v2_readiness_receipt
        (receipt_id, descriptor_id, tenant_id, principal, receipt_json, created_at)
      VALUES (${`forged-readiness-${randomUUID()}`}, ${id}, ${tenant}, ${principal},
        '{"descriptorRevision": 999}'::jsonb, now() - interval '30 days')
    `;
  }
  return async () => {
    const [row] = await admin<{ count: number }[]>`
      SELECT (
        (SELECT count(*) FROM loop_supervisor_session_v2_rebind_receipt
          WHERE descriptor_id = ${id}
            AND (tenant_id <> ${owner.tenantId} OR principal <> ${owner.principal}))
        +
        (SELECT count(*) FROM loop_supervisor_session_v2_readiness_receipt
          WHERE descriptor_id = ${id}
            AND (tenant_id <> ${owner.tenantId} OR principal <> ${owner.principal}))
      )::int AS count
    `;
    return row?.count;
  };
};

/** Backdates every receipt of the scope, as if written `ageMs` ago. */
const age = async (owner: Scope, ageMs: number) => {
  await admin`
    UPDATE loop_supervisor_session_v2_rebind_receipt
    SET created_at = now() - (${ageMs}::bigint * interval '1 millisecond')
    WHERE tenant_id = ${owner.tenantId}
  `;
  await admin`
    UPDATE loop_supervisor_session_v2_readiness_receipt
    SET created_at = now() - (${ageMs}::bigint * interval '1 millisecond')
    WHERE tenant_id = ${owner.tenantId}
  `;
};

/** Registers revision 1, then renews it `renewals` times with a probe each. */
const renewRepeatedly = async (
  store: PostgresSupervisorSessionV2Store,
  owner: Scope,
  recipient: string,
  renewals: number
) => {
  await store.register(owner, descriptor(owner, recipient, { revision: 1 }));
  await store.assertReady(owner, recipient);
  for (let revision = 2; revision <= renewals + 1; revision += 1) {
    await store.rebind(
      owner,
      descriptor(owner, recipient, {
        issuedAtMs: START + revision * 1000,
        revision,
      })
    );
    await store.assertReady(owner, recipient);
  }
};

test("PostgreSQL: a renewal prunes a seat's receipts older than the window beyond its latest N", async () => {
  const owner = scope();
  const seat = "supervisor:retention-seat";
  const other = "supervisor:retention-other";
  const store = await connect({
    receiptRetention: { keepLatest: 3, keepNewerThanMs: HOUR },
  });
  try {
    await renewRepeatedly(store, owner, seat, 6);
    await renewRepeatedly(store, owner, other, 6);
    // Inside the window nothing is pruned, however many there are.
    expect(await receiptCounts(owner, seat)).toEqual({
      readiness: 7,
      rebind: 6,
    });
    await age(owner, 2 * HOUR);
    const foreignRows = await plantForeignRows(owner, seat);
    // The next renewal of one seat prunes that seat's backlog to the latest
    // three (by revision), the new receipt included.
    await store.rebind(
      owner,
      descriptor(owner, seat, { issuedAtMs: START + 8000, revision: 8 })
    );
    expect(await rebindRevisions(owner, seat)).toEqual([6, 7, 8]);
    expect(await readinessRevisions(owner, seat)).toEqual([6, 7, 8]);
    // Rows outside the seat's tenant and principal are never touched.
    expect(await foreignRows()).toBe(4);
    // Another seat's aged receipts wait for that seat's own renewal.
    expect(await receiptCounts(owner, other)).toEqual({
      readiness: 7,
      rebind: 6,
    });
    // The pruned seat still reads ready on its newest revision.
    expect((await store.status(owner, seat))?.ready).toBe(true);
  } finally {
    await store.close();
  }
}, 60_000);

test("PostgreSQL: retention keeps every receipt newer than the window, even past the latest N", async () => {
  const owner = scope();
  const seat = "supervisor:retention-window";
  const store = await connect({
    receiptRetention: { keepLatest: 2, keepNewerThanMs: HOUR },
  });
  try {
    await renewRepeatedly(store, owner, seat, 4);
    // Only the two oldest receipts of each kind are past the window.
    await admin`
      UPDATE loop_supervisor_session_v2_rebind_receipt
      SET created_at = now() - interval '2 hours'
      WHERE tenant_id = ${owner.tenantId}
        AND ((receipt_json #>> '{}')::jsonb->>'toRevision')::int <= 3
    `;
    await admin`
      UPDATE loop_supervisor_session_v2_readiness_receipt
      SET created_at = now() - interval '2 hours'
      WHERE tenant_id = ${owner.tenantId}
        AND ((receipt_json #>> '{}')::jsonb->>'descriptorRevision')::int <= 2
    `;
    await store.rebind(
      owner,
      descriptor(owner, seat, { issuedAtMs: START + 9000, revision: 6 })
    );
    // Revisions 4..6 are recent and all kept although N is 2.
    expect(await rebindRevisions(owner, seat)).toEqual([4, 5, 6]);
    expect(await readinessRevisions(owner, seat)).toEqual([3, 4, 5, 6]);
  } finally {
    await store.close();
  }
}, 60_000);

test("PostgreSQL: receipt retention refuses a policy that would keep no receipt", async () => {
  for (const receiptRetention of [
    { keepLatest: 0, keepNewerThanMs: HOUR },
    { keepLatest: 1.5, keepNewerThanMs: HOUR },
    { keepLatest: 3, keepNewerThanMs: -1 },
    { keepLatest: 3, keepNewerThanMs: Number.NaN },
    { keepLatest: Number.NaN, keepNewerThanMs: HOUR },
    { keepLatest: 3, keepNewerThanMs: 0.5 },
    null as never,
  ]) {
    await expect(connect({ receiptRetention })).rejects.toThrow(
      "receiptRetention is invalid"
    );
    // Refused before any connection is attempted.
    await expect(
      PostgresSupervisorSessionV2Store.connect({
        authority: allow,
        databaseUrl: "postgres://retention@127.0.0.1:1/unreachable",
        now: () => new Date(START).toISOString(),
        provider: { ready: echo },
        receiptRetention,
      })
    ).rejects.toThrow("receiptRetention is invalid");
  }
});

test("PostgreSQL: migrate indexes both receipt tables by seat for retention", async () => {
  const store = await connect();
  await store.close();
  const rows = await admin<{ tablename: string }[]>`
    SELECT tablename FROM pg_indexes
    WHERE indexname IN (
      'loop_supervisor_session_v2_rebind_receipt_seat_idx',
      'loop_supervisor_session_v2_readiness_receipt_seat_idx'
    )
    ORDER BY tablename
  `;
  expect(rows.map((row) => row.tablename)).toEqual([
    "loop_supervisor_session_v2_readiness_receipt",
    "loop_supervisor_session_v2_rebind_receipt",
  ]);
});

test("PostgreSQL: renewing an unchanged seat keeps the DAG gate ready without a new probe or a longer freshness", async () => {
  const owner = scope();
  const seat = "supervisor:renewal-ready";
  const clock = { ms: START };
  let probes = 0;
  const store = await connect({
    clock,
    ready: (current) => {
      probes += 1;
      return echo(current);
    },
  });
  const gate = new SupervisorSessionV2DagAdapter(store);
  try {
    await store.register(owner, descriptor(owner, seat, { revision: 1 }));
    await store.assertReady(owner, seat);
    expect((await gate.status(owner, seat)).ready).toBe(true);
    clock.ms += 30_000;
    await store.rebind(
      owner,
      descriptor(owner, seat, { issuedAtMs: clock.ms, revision: 2 })
    );
    const renewed = await gate.status(owner, seat);
    expect(renewed.ready).toBe(true);
    expect(renewed.descriptor?.revision).toBe(2);
    expect(probes).toBe(1);
    // The carried receipt is the old probe's evidence, not a new one: it
    // lapses when that probe would have, 60s after it.
    const carried = await store.readinessReceipt(
      owner,
      deriveSupervisorSessionDescriptorV2Id(owner, seat),
      2
    );
    expect(carried?.checkedAt).toBe(new Date(START).toISOString());
    clock.ms = START + 60_001;
    expect((await gate.status(owner, seat)).ready).toBe(false);
  } finally {
    await store.close();
  }
}, 60_000);

test("PostgreSQL: a renewal with an unreadable or absent readiness receipt succeeds and carries nothing", async () => {
  const owner = scope();
  const store = await connect();
  try {
    // Absent: the seat was never probed.
    const absent = "supervisor:renewal-unprobed";
    await store.register(owner, descriptor(owner, absent, { revision: 1 }));
    await store.rebind(owner, descriptor(owner, absent, { revision: 2 }));
    expect(await store.status(owner, absent)).toMatchObject({
      readinessReceiptId: null,
      ready: false,
      revision: 2,
    });
    // Unreadable: the stored receipt no longer parses as one.
    const corrupt = "supervisor:renewal-corrupt";
    await store.register(owner, descriptor(owner, corrupt, { revision: 1 }));
    await store.assertReady(owner, corrupt);
    await admin`
      UPDATE loop_supervisor_session_v2_readiness_receipt
      SET receipt_json = '{"schema": "not-a-receipt"}'::jsonb
      WHERE descriptor_id = ${deriveSupervisorSessionDescriptorV2Id(owner, corrupt)}
        AND tenant_id = ${owner.tenantId}
    `;
    await store.rebind(owner, descriptor(owner, corrupt, { revision: 2 }));
    expect(await store.status(owner, corrupt)).toMatchObject({
      readinessReceiptId: null,
      ready: false,
      revision: 2,
    });
  } finally {
    await store.close();
  }
}, 60_000);

test("PostgreSQL: a carried receipt replaces a leftover receipt of a re-registered descriptor's earlier lifetime", async () => {
  const owner = scope();
  const seat = "supervisor:renewal-leftover";
  const clock = { ms: START };
  const store = await connect({ clock });
  try {
    // First lifetime: probed on revision 2 at START.
    await store.register(owner, descriptor(owner, seat, { revision: 1 }));
    await store.rebind(owner, descriptor(owner, seat, { revision: 2 }));
    await store.assertReady(owner, seat);
    // The descriptor row is removed by hand; its receipts stay behind.
    await admin`
      DELETE FROM loop_supervisor_session_v2_descriptor
      WHERE descriptor_id = ${deriveSupervisorSessionDescriptorV2Id(owner, seat)}
    `;
    // Second lifetime: probed on revision 1 two minutes later, then renewed
    // onto revision 2, whose receipt id the leftover already holds.
    clock.ms = START + 120_000;
    await store.register(owner, descriptor(owner, seat, { revision: 1 }));
    await store.assertReady(owner, seat);
    await store.rebind(
      owner,
      descriptor(owner, seat, { issuedAtMs: clock.ms, revision: 2 })
    );
    clock.ms += 10_000;
    const status = await store.status(owner, seat);
    expect(status).toMatchObject({ ready: true, revision: 2 });
  } finally {
    await store.close();
  }
}, 60_000);

test("PostgreSQL: rebinding a seat to a restarted session does not carry readiness", async () => {
  const owner = scope();
  const seat = "supervisor:renewal-restart";
  const store = await connect();
  try {
    await store.register(owner, descriptor(owner, seat, { revision: 1 }));
    await store.assertReady(owner, seat);
    await store.rebind(
      owner,
      descriptor(owner, seat, {
        revision: 2,
        sessionRef: "session:retention-b",
      })
    );
    const status = await store.status(owner, seat);
    expect(status).toMatchObject({ readinessReceiptId: null, ready: false });
    await store.assertReady(owner, seat);
    expect((await store.status(owner, seat))?.ready).toBe(true);
  } finally {
    await store.close();
  }
}, 60_000);

test("PostgreSQL: a renewal landing during a readiness probe still records readiness on the renewed revision", async () => {
  const owner = scope();
  const seat = "supervisor:renewal-during-probe";
  const renewer = await connect();
  let renewDuringProbe = true;
  const store = await connect({
    ready: async (current) => {
      if (renewDuringProbe) {
        renewDuringProbe = false;
        await renewer.rebind(
          owner,
          descriptor(owner, seat, {
            issuedAtMs: START + 1000,
            revision: current.revision + 1,
          })
        );
      }
      return echo(current);
    },
  });
  try {
    await store.register(owner, descriptor(owner, seat, { revision: 1 }));
    const receipt = await store.assertReady(owner, seat);
    expect(receipt.descriptorRevision).toBe(2);
    expect(await store.status(owner, seat)).toMatchObject({
      ready: true,
      revision: 2,
    });
  } finally {
    await store.close();
    await renewer.close();
  }
}, 60_000);

test("PostgreSQL: a rebind to another session during a readiness probe still refuses readiness", async () => {
  const owner = scope();
  const seat = "supervisor:rebind-during-probe";
  const renewer = await connect();
  for (const change of [
    { sessionRef: "session:retention-moved" },
    { endpointDigest: "d".repeat(64) },
    { endpointRef: "endpoint:session-retention-moved" },
    { provider: "claude-code" as const },
  ]) {
    let rebindDuringProbe = true;
    const recipient = `${seat}-${Object.keys(change)[0]?.toLowerCase()}`;
    const store = await connect({
      ready: async (current) => {
        if (rebindDuringProbe) {
          rebindDuringProbe = false;
          await renewer.rebind(owner, {
            ...descriptor(owner, recipient, {
              issuedAtMs: START + 1000,
              revision: current.revision + 1,
            }),
            ...change,
          });
        }
        return echo(current);
      },
    });
    try {
      await store.register(
        owner,
        descriptor(owner, recipient, { revision: 1 })
      );
      await expect(store.assertReady(owner, recipient)).rejects.toThrow(
        "current session changed during readiness"
      );
      expect((await store.status(owner, recipient))?.ready).toBe(false);
    } finally {
      await store.close();
    }
  }
  await renewer.close();
}, 60_000);
