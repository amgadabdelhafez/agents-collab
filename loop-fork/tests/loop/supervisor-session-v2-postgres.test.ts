import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
import { SQL } from "bun";
import {
  createSupervisorEndpointLocatorResolver,
  SupervisorEndpointLeaseError,
  type SupervisorEndpointLeaseStore,
  type SupervisorEndpointLeaseV2,
  type SupervisorEndpointLocator,
  type SupervisorEndpointLocatorRefusal,
  type SupervisorEndpointLocatorResolver,
  supervisorEndpointLocatorDigest,
  supervisorEndpointRoots,
} from "../../src/loop/supervisor-endpoint-lease";
import { SupervisorMessageV2ReadinessUnavailableError } from "../../src/loop/supervisor-message-v2-runtime";
import {
  deriveSupervisorSessionDescriptorV2Id,
  PostgresSupervisorSessionV2Store,
  SUPERVISOR_SESSION_RECEIPT_RETENTION_MAX_WINDOW_MS,
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

/**
 * Backdates every receipt of the scope by `ageMs`, keeping the order they
 * were written in (retention ranks a seat's receipts by write time).
 */
const age = async (owner: Scope, ageMs: number) => {
  await admin`
    UPDATE loop_supervisor_session_v2_rebind_receipt
    SET created_at = created_at - (${ageMs}::bigint * interval '1 millisecond')
    WHERE tenant_id = ${owner.tenantId}
  `;
  await admin`
    UPDATE loop_supervisor_session_v2_readiness_receipt
    SET created_at = created_at - (${ageMs}::bigint * interval '1 millisecond')
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
    // three (by write time), the new receipt included.
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
    // A "keep forever" window past what a database timestamp can subtract.
    { keepLatest: 3, keepNewerThanMs: Number.MAX_SAFE_INTEGER },
    {
      keepLatest: 3,
      keepNewerThanMs: SUPERVISOR_SESSION_RECEIPT_RETENTION_MAX_WINDOW_MS + 1,
    },
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

test("PostgreSQL: the longest accepted retention window still renews and prunes nothing", async () => {
  const owner = scope();
  const seat = "supervisor:retention-longest";
  const store = await connect({
    receiptRetention: {
      keepLatest: 1,
      keepNewerThanMs: SUPERVISOR_SESSION_RECEIPT_RETENTION_MAX_WINDOW_MS,
    },
  });
  try {
    await renewRepeatedly(store, owner, seat, 3);
    await age(owner, 365 * 24 * HOUR);
    await store.rebind(
      owner,
      descriptor(owner, seat, { issuedAtMs: START + 9000, revision: 5 })
    );
    expect((await store.current(owner, seat))?.revision).toBe(5);
    expect(await rebindRevisions(owner, seat)).toEqual([2, 3, 4, 5]);
  } finally {
    await store.close();
  }
}, 60_000);

const RECEIPT_TABLES = {
  readiness: {
    field: "descriptorRevision",
    name: "loop_supervisor_session_v2_readiness_receipt",
  },
  rebind: {
    field: "toRevision",
    name: "loop_supervisor_session_v2_rebind_receipt",
  },
} as const;

/**
 * Plants, in a seat's own scope and in both receipt tables, receipts that no
 * store code writes: a JSONB string that is not JSON text, string-shaped
 * JSON with a non-numeric revision, and objects whose revision is fractional
 * or past bigint. Returns a live count of the planted rows.
 */
const plantMalformedRows = async (
  owner: Scope,
  recipient: string,
  createdAgoMs: number
) => {
  const id = deriveSupervisorSessionDescriptorV2Id(owner, recipient);
  for (const { field, name } of Object.values(RECEIPT_TABLES)) {
    for (const shape of [
      "to_jsonb('not json'::text)",
      `to_jsonb('{"${field}":"x"}'::text)`,
      `'{"${field}":1.5}'::jsonb`,
      `'{"${field}":1e30}'::jsonb`,
    ]) {
      await admin.unsafe(
        `INSERT INTO ${name}
           (receipt_id, descriptor_id, tenant_id, principal, receipt_json, created_at)
         VALUES ($1, $2, $3, $4, ${shape},
           now() - ($5::bigint * interval '1 millisecond'))`,
        [
          `malformed-${randomUUID()}`,
          id,
          owner.tenantId,
          owner.principal,
          createdAgoMs,
        ]
      );
    }
  }
  return async () => {
    const [row] = await admin<{ count: number }[]>`
      SELECT (
        (SELECT count(*) FROM loop_supervisor_session_v2_rebind_receipt
          WHERE descriptor_id = ${id} AND receipt_id LIKE 'malformed-%')
        +
        (SELECT count(*) FROM loop_supervisor_session_v2_readiness_receipt
          WHERE descriptor_id = ${id} AND receipt_id LIKE 'malformed-%')
      )::int AS count
    `;
    return row?.count;
  };
};

test("PostgreSQL: a malformed stored receipt never blocks a seat's renewal, and ages out like any other", async () => {
  const owner = scope();
  const seat = "supervisor:retention-malformed";
  const store = await connect({
    receiptRetention: { keepLatest: 2, keepNewerThanMs: HOUR },
  });
  try {
    await renewRepeatedly(store, owner, seat, 1);
    const malformedOld = await plantMalformedRows(owner, seat, 2 * HOUR);
    expect(await malformedOld()).toBe(8);
    // The renewal succeeds and keeps readiness. The old malformed rows are
    // past the window and not among the latest two, so they are pruned.
    await store.rebind(
      owner,
      descriptor(owner, seat, { issuedAtMs: START + 3000, revision: 3 })
    );
    expect(await store.current(owner, seat)).toMatchObject({ revision: 3 });
    expect((await store.status(owner, seat))?.ready).toBe(true);
    expect(await malformedOld()).toBe(0);
    expect(await rebindRevisions(owner, seat)).toEqual([2, 3]);
    // Recent malformed rows are inside the window: kept, and still harmless.
    const malformedNew = await plantMalformedRows(owner, seat, 0);
    await store.rebind(
      owner,
      descriptor(owner, seat, { issuedAtMs: START + 4000, revision: 4 })
    );
    expect(await store.current(owner, seat)).toMatchObject({ revision: 4 });
    expect((await store.status(owner, seat))?.ready).toBe(true);
    expect(await malformedNew()).toBe(8);
  } finally {
    await store.close();
  }
}, 60_000);

test("PostgreSQL: a re-registered descriptor's renewal keeps its fresh receipts ahead of an earlier lifetime's leftovers", async () => {
  const owner = scope();
  const seat = "supervisor:retention-relifetime";
  const id = deriveSupervisorSessionDescriptorV2Id(owner, seat);
  const clock = { ms: START };
  const store = await connect({
    clock,
    receiptRetention: { keepLatest: 2, keepNewerThanMs: HOUR },
  });
  try {
    // The first lifetime reaches revision 4, probed on every revision.
    await renewRepeatedly(store, owner, seat, 3);
    // The descriptor row is removed by hand; its receipts stay behind.
    await admin`
      DELETE FROM loop_supervisor_session_v2_descriptor
      WHERE descriptor_id = ${id}
    `;
    // Every leftover is past the window. Revision 2's receipts, whose ids the
    // second lifetime's first renewal reuses, are the oldest; revisions 3 and
    // 4 are newer and above any revision the second lifetime reaches here.
    for (const { field, name } of Object.values(RECEIPT_TABLES)) {
      await admin.unsafe(
        `UPDATE ${name}
         SET created_at = now() - CASE
           WHEN ((receipt_json #>> '{}')::jsonb->>'${field}')::int = 2
           THEN interval '3 hours' ELSE interval '2 hours' END
         WHERE descriptor_id = $1`,
        [id]
      );
    }
    // The second lifetime: probed on revision 1, then renewed onto 2.
    clock.ms = START + 120_000;
    await store.register(owner, descriptor(owner, seat, { revision: 1 }));
    await store.assertReady(owner, seat);
    const renewed = await store.rebind(
      owner,
      descriptor(owner, seat, { issuedAtMs: clock.ms, revision: 2 })
    );
    clock.ms += 10_000;
    // The carried readiness receipt and the renewal's own rebind receipt
    // survive the prune that runs in the same transaction.
    expect(await store.status(owner, seat)).toMatchObject({
      ready: true,
      revision: 2,
    });
    const [kept] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM loop_supervisor_session_v2_rebind_receipt
      WHERE receipt_id = ${renewed.receipt.receiptId}
    `;
    expect(kept?.count).toBe(1);
  } finally {
    await store.close();
  }
}, 60_000);

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
    // Unreadable as JSON at all: a JSONB string that is not JSON text.
    const garbage = "supervisor:renewal-garbage";
    await store.register(owner, descriptor(owner, garbage, { revision: 1 }));
    await store.assertReady(owner, garbage);
    await admin`
      UPDATE loop_supervisor_session_v2_readiness_receipt
      SET receipt_json = to_jsonb('not json'::text)
      WHERE descriptor_id = ${deriveSupervisorSessionDescriptorV2Id(owner, garbage)}
        AND tenant_id = ${owner.tenantId}
    `;
    await store.rebind(owner, descriptor(owner, garbage, { revision: 2 }));
    expect(await store.status(owner, garbage)).toMatchObject({
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

/* ---------------------------------------------------------------------------
 * r9 T1: the endpoint lease store (loop_supervisor_endpoint_lease_v2) over
 * real PostgreSQL, with the server's own locator resolver over a real
 * filesystem fixture (symlinks and realpath are part of what is under test).
 * ------------------------------------------------------------------------- */
describe("PostgreSQL endpoint lease store", () => {
  const ALPHA = "supervisor:alpha";
  const BETA = "supervisor:beta";
  const SEAT_PRINCIPAL = "principal:seat-alpha";
  const TTL = 30_000;
  let base = "";
  let home = "";

  const runsRoot = () => supervisorEndpointRoots(home).runsRoot;
  const sessionsRoot = () => supervisorEndpointRoots(home).sessionsRoot;
  const manifestPath = (repoId: string, runId: string) =>
    join(runsRoot(), repoId, runId, "manifest.json");
  const writeRun = (
    repoId: string,
    runId: string,
    overrides: Record<string, unknown> = {}
  ) => {
    mkdirSync(join(runsRoot(), repoId, runId), { recursive: true });
    writeFileSync(
      manifestPath(repoId, runId),
      JSON.stringify({
        a2aSupervisorId: ALPHA,
        codexRemoteUrl: "ws://127.0.0.1:4500",
        codexThreadId: "thread-1",
        repoId,
        runId,
        ...overrides,
      })
    );
  };

  /** The server's resolver, counting calls so tests see where it runs. */
  const resolver = () => {
    const real = createSupervisorEndpointLocatorResolver({
      fs: {
        readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
        realpath: (path) => realpathSync(path),
      },
      roots: supervisorEndpointRoots(home),
    });
    const calls: string[] = [];
    const resolveLocator: SupervisorEndpointLocatorResolver = (
      locator,
      supervisorId
    ) => {
      calls.push(`${supervisorId}:${locator.kind}`);
      return real(locator, supervisorId);
    };
    return { calls, resolveLocator };
  };

  const loopRun = (runId = "run-1"): SupervisorEndpointLocator => ({
    kind: "loop-run",
    repoId: "repo-a",
    runId,
    seat: "claude",
  });

  const seatScope = () => ({
    principal: SEAT_PRINCIPAL,
    tenantId: `tenant:lease-${randomUUID().slice(0, 8)}`,
  });

  const open = async (
    input: { authority?: typeof allow; clock?: { ms: number } } = {}
  ) => {
    const clock = input.clock ?? { ms: START };
    const sessions = await PostgresSupervisorSessionV2Store.connect({
      authority: input.authority ?? allow,
      databaseUrl: postgres.databaseUrl(),
      now: () => new Date(clock.ms).toISOString(),
      provider: { ready: echo },
    });
    await sessions.migrate();
    const { calls, resolveLocator } = resolver();
    return {
      calls,
      leases: sessions.endpointLeases({ resolveLocator }),
      sessions,
    };
  };

  const claimInput = (
    owner: Scope,
    holderRef: string,
    extra: {
      locator?: SupervisorEndpointLocator;
      recipient?: string;
      sessionRef?: string;
      takeover?: boolean;
      ttlMs?: number;
    } = {}
  ) => ({
    holderRef,
    locator: extra.locator ?? loopRun(),
    recipient: extra.recipient ?? ALPHA,
    scope: owner,
    sessionRef: extra.sessionRef ?? "session:claude-alpha-1",
    ...(extra.takeover === undefined ? {} : { takeover: extra.takeover }),
    ttlMs: extra.ttlMs ?? TTL,
  });

  const claimed = async (
    leases: SupervisorEndpointLeaseStore,
    input: ReturnType<typeof claimInput>
  ) => {
    const result = await leases.claim(input);
    if (result.status !== "claimed") {
      throw new Error(`expected a claim, got ${JSON.stringify(result)}`);
    }
    return result;
  };

  const fenceOf = (lease: SupervisorEndpointLeaseV2) => ({
    epoch: lease.epoch,
    holderRef: lease.holderRef,
  });

  const leaseRows = async (owner: Scope, recipient = ALPHA) =>
    await admin<{ epoch: string; holder_ref: string }[]>`
      SELECT epoch::text AS epoch, holder_ref
      FROM loop_supervisor_endpoint_lease_v2
      WHERE tenant_id = ${owner.tenantId} AND recipient = ${recipient}
    `;

  const descriptorRows = async (owner: Scope, recipient = ALPHA) =>
    await admin<{ revision: string }[]>`
      SELECT revision::text AS revision
      FROM loop_supervisor_session_v2_descriptor
      WHERE tenant_id = ${owner.tenantId} AND recipient = ${recipient}
    `;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "r9-lease-store-"));
    home = join(base, "home");
    mkdirSync(home);
    writeRun("repo-a", "run-1");
    writeRun("repo-a", "run-2");
    writeRun("repo-a", "codex-1");
    mkdirSync(join(sessionsRoot(), "alpha", "sess-1"), { recursive: true });
    mkdirSync(join(sessionsRoot(), "beta", "sess-b"), { recursive: true });
  });

  afterAll(() => {
    if (base) {
      rmSync(base, { force: true, recursive: true });
    }
  });

  test("migrate creates the lease table keyed by (tenant, recipient), idempotently", async () => {
    const { sessions } = await open();
    await sessions.migrate();
    await sessions.close();
    const rows = await admin<{ column_name: string }[]>`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'loop_supervisor_endpoint_lease_v2'::regclass
        AND i.indisprimary
      ORDER BY a.attname
    `;
    expect(rows.map((row) => row.column_name)).toEqual([
      "recipient",
      "tenant_id",
    ]);
  });

  test("a first claim registers the seat's descriptor and the lease together, at epoch 1", async () => {
    const owner = seatScope();
    const { calls, leases, sessions } = await open();
    try {
      const result = await claimed(leases, claimInput(owner, "holder:a"));
      const expiresAt = new Date(START + TTL).toISOString();
      expect(result.tookOver).toBe(false);
      expect(result.previous).toBeNull();
      expect(result.lease).toEqual({
        descriptorId: deriveSupervisorSessionDescriptorV2Id(owner, ALPHA),
        descriptorRevision: 1,
        epoch: 1,
        expiresAt,
        holderRef: "holder:a",
        kind: "loop-run",
        locator: loopRun(),
        principal: SEAT_PRINCIPAL,
        recipient: ALPHA,
        releasedAt: null,
        schema: "supervisor-endpoint-lease.v2",
        tenantId: owner.tenantId,
      });
      // The descriptor binds the locator's ids by digest, in the seat's own
      // scope, and expires with the lease.
      expect(result.descriptor).toMatchObject({
        endpointDigest: supervisorEndpointLocatorDigest(loopRun()),
        endpointRef: "endpoint:loop-run",
        expiresAt,
        issuedAt: new Date(START).toISOString(),
        provider: "claude-code",
        revision: 1,
        sessionRef: "session:claude-alpha-1",
      });
      expect(await sessions.current(owner, ALPHA)).toEqual(result.descriptor);
      expect(
        await sessions.current(
          { ...owner, principal: "principal:sender" },
          ALPHA
        )
      ).toBeUndefined();
      expect(await leases.resolve(owner.tenantId, ALPHA)).toEqual({
        lease: result.lease,
        state: "live",
      });
      expect(await leases.list(owner.tenantId)).toEqual([result.lease]);
      expect(await leases.resolve(owner.tenantId, BETA)).toEqual({
        state: "none",
      });
      // The claim resolved its locator, for the claimed recipient.
      expect(calls).toEqual([`${ALPHA}:loop-run`]);
      // Only ids are stored: no path or URL reaches the row.
      const [row] = await admin<{ locator: string; type: string }[]>`
        SELECT locator_json::text AS locator, jsonb_typeof(locator_json) AS type
        FROM loop_supervisor_endpoint_lease_v2
        WHERE tenant_id = ${owner.tenantId}
      `;
      // A JSONB object (queryable in place), not a double-encoded string.
      expect(row?.type).toBe("object");
      expect(JSON.parse(row?.locator ?? "null")).toEqual(loopRun());
      expect(row?.locator).not.toContain("/");
    } finally {
      await sessions.close();
    }
  }, 60_000);

  test("a Codex thread claim binds session:<threadId> and the codex provider", async () => {
    const owner = seatScope();
    const { leases, sessions } = await open();
    const locator: SupervisorEndpointLocator = {
      kind: "codex-thread",
      repoId: "repo-a",
      runId: "codex-1",
      threadId: "thread-1",
    };
    try {
      await expect(
        leases.claim(claimInput(owner, "holder:a", { locator }))
      ).rejects.toBeInstanceOf(SupervisorEndpointLeaseError);
      expect(await leaseRows(owner)).toEqual([]);
      const result = await claimed(
        leases,
        claimInput(owner, "holder:a", {
          locator,
          sessionRef: "session:thread-1",
        })
      );
      expect(result.descriptor).toMatchObject({
        endpointDigest: supervisorEndpointLocatorDigest(locator),
        endpointRef: "endpoint:codex-thread",
        provider: "codex-app-server",
        sessionRef: "session:thread-1",
      });
    } finally {
      await sessions.close();
    }
  }, 60_000);

  test("renew extends lease and descriptor under the fence; release ends it; a released lease cannot be renewed", async () => {
    const owner = seatScope();
    const clock = { ms: START };
    const { calls, leases, sessions } = await open({ clock });
    try {
      const first = await claimed(leases, claimInput(owner, "holder:a"));
      await sessions.assertReady(owner, ALPHA);
      clock.ms += 10_000;
      const renewed = await leases.renew({
        fence: fenceOf(first.lease),
        recipient: ALPHA,
        scope: owner,
        ttlMs: TTL,
      });
      const renewedExpiry = new Date(START + 10_000 + TTL).toISOString();
      expect(renewed).toMatchObject({
        lease: {
          descriptorRevision: 2,
          epoch: 1,
          expiresAt: renewedExpiry,
          holderRef: "holder:a",
          locator: loopRun(),
        },
        status: "renewed",
      });
      expect(await sessions.current(owner, ALPHA)).toMatchObject({
        endpointDigest: first.descriptor.endpointDigest,
        expiresAt: renewedExpiry,
        revision: 2,
        sessionRef: first.descriptor.sessionRef,
      });
      expect(await leases.resolve(owner.tenantId, ALPHA)).toEqual({
        lease: (renewed as { lease: SupervisorEndpointLeaseV2 }).lease,
        state: "live",
      });
      // The same provider session: the earlier probe's readiness carries.
      expect((await sessions.status(owner, ALPHA))?.ready).toBe(true);
      // Renewal re-resolved the STORED locator.
      expect(calls).toEqual([`${ALPHA}:loop-run`, `${ALPHA}:loop-run`]);

      clock.ms += 1000;
      const released = await leases.release({
        fence: fenceOf(first.lease),
        recipient: ALPHA,
        scope: owner,
      });
      const releasedAt = new Date(clock.ms).toISOString();
      expect(released).toMatchObject({
        changed: true,
        lease: { epoch: 1, releasedAt },
        status: "released",
      });
      // Release never resolves the locator.
      expect(calls).toHaveLength(2);
      // Repeating the release with the same fence is an idempotent success.
      clock.ms += 1000;
      expect(
        await leases.release({
          fence: fenceOf(first.lease),
          recipient: ALPHA,
          scope: owner,
        })
      ).toMatchObject({
        changed: false,
        lease: { releasedAt },
        status: "released",
      });
      expect(
        await leases.renew({
          fence: fenceOf(first.lease),
          recipient: ALPHA,
          scope: owner,
          ttlMs: TTL,
        })
      ).toEqual({ reason: "released", status: "fenced" });
      expect(await leases.resolve(owner.tenantId, ALPHA)).toMatchObject({
        lease: { releasedAt },
        state: "released",
      });
      // The enrollment sweep's work set holds unreleased leases only.
      expect(await leases.list(owner.tenantId)).toEqual([]);

      // A released lease is claimable again, by anyone, at the next epoch.
      const again = await claimed(leases, claimInput(owner, "holder:b"));
      expect(again.lease).toMatchObject({ epoch: 2, releasedAt: null });
      expect(again.previous).toMatchObject({
        epoch: 1,
        holderRef: "holder:a",
        state: "released",
      });
      expect(again.tookOver).toBe(false);
      expect(again.descriptor.revision).toBe(3);
      expect(await leases.resolve(owner.tenantId, ALPHA)).toEqual({
        lease: again.lease,
        state: "live",
      });
    } finally {
      await sessions.close();
    }
  }, 60_000);

  test("a competing claim is fenced; takeover evicts the live holder and fences its renew and release", async () => {
    const owner = seatScope();
    const clock = { ms: START };
    const { calls, leases, sessions } = await open({ clock });
    try {
      const a = await claimed(leases, claimInput(owner, "holder:a"));
      clock.ms += 1000;
      expect(await leases.claim(claimInput(owner, "holder:b"))).toEqual({
        current: {
          epoch: 1,
          expiresAt: a.lease.expiresAt,
          holderRef: "holder:a",
          state: "live",
        },
        status: "held",
      });
      expect(
        await leases.claim(claimInput(owner, "holder:b", { takeover: false }))
      ).toMatchObject({ status: "held" });
      // The refused claim changed nothing.
      expect(await leases.resolve(owner.tenantId, ALPHA)).toEqual({
        lease: a.lease,
        state: "live",
      });
      expect(await descriptorRows(owner)).toEqual([{ revision: "1" }]);

      const b = await claimed(
        leases,
        claimInput(owner, "holder:b", {
          locator: loopRun("run-2"),
          sessionRef: "session:claude-alpha-2",
          takeover: true,
        })
      );
      expect(b.tookOver).toBe(true);
      expect(b.previous).toMatchObject({
        epoch: 1,
        holderRef: "holder:a",
        state: "live",
      });
      expect(b.lease).toMatchObject({
        epoch: 2,
        holderRef: "holder:b",
        locator: loopRun("run-2"),
      });
      expect(b.descriptor).toMatchObject({
        endpointDigest: supervisorEndpointLocatorDigest(loopRun("run-2")),
        revision: 2,
        sessionRef: "session:claude-alpha-2",
      });
      const resolvedBeforeFencing = calls.length;
      // The evicted holder's renew and release are fenced by the epoch.
      expect(
        await leases.renew({
          fence: fenceOf(a.lease),
          recipient: ALPHA,
          scope: owner,
          ttlMs: TTL,
        })
      ).toEqual({ reason: "epoch-mismatch", status: "fenced" });
      expect(
        await leases.release({
          fence: fenceOf(a.lease),
          recipient: ALPHA,
          scope: owner,
        })
      ).toEqual({ reason: "epoch-mismatch", status: "fenced" });
      // The current epoch with the wrong holder is fenced by the holder.
      expect(
        await leases.renew({
          fence: { epoch: 2, holderRef: "holder:a" },
          recipient: ALPHA,
          scope: owner,
          ttlMs: TTL,
        })
      ).toEqual({ reason: "holder-mismatch", status: "fenced" });
      expect(
        await leases.release({
          fence: { epoch: 2, holderRef: "holder:a" },
          recipient: ALPHA,
          scope: owner,
        })
      ).toEqual({ reason: "holder-mismatch", status: "fenced" });
      // Nothing that was fenced moved the lease, or resolved its locator.
      expect(await leases.resolve(owner.tenantId, ALPHA)).toEqual({
        lease: b.lease,
        state: "live",
      });
      expect(calls).toHaveLength(resolvedBeforeFencing);
      // No lease for a recipient never claimed.
      expect(
        await leases.renew({
          fence: { epoch: 1, holderRef: "holder:a" },
          recipient: BETA,
          scope: owner,
          ttlMs: TTL,
        })
      ).toEqual({ reason: "absent", status: "fenced" });
      // The live holder may claim again without takeover: a new epoch.
      const b2 = await claimed(
        leases,
        claimInput(owner, "holder:b", {
          locator: loopRun("run-2"),
          sessionRef: "session:claude-alpha-2",
        })
      );
      expect(b2.lease.epoch).toBe(3);
      expect(b2.tookOver).toBe(false);
      expect(
        await leases.renew({
          fence: fenceOf(b.lease),
          recipient: ALPHA,
          scope: owner,
          ttlMs: TTL,
        })
      ).toEqual({ reason: "epoch-mismatch", status: "fenced" });
    } finally {
      await sessions.close();
    }
  }, 60_000);

  test("expiry alone never fences: the holder renews an expired lease until another claim bumps the epoch", async () => {
    const owner = seatScope();
    const clock = { ms: START };
    const { leases, sessions } = await open({ clock });
    try {
      const a = await claimed(
        leases,
        claimInput(owner, "holder:a", { ttlMs: 5000 })
      );
      clock.ms = START + 5000;
      expect((await leases.resolve(owner.tenantId, ALPHA)).state).toBe(
        "expired"
      );
      // Expired but unreleased: still in the sweep's work set.
      expect(await leases.list(owner.tenantId)).toEqual([a.lease]);
      // Its holder renews it at the same epoch.
      expect(
        await leases.renew({
          fence: fenceOf(a.lease),
          recipient: ALPHA,
          scope: owner,
          ttlMs: 5000,
        })
      ).toMatchObject({
        lease: { epoch: 1, expiresAt: new Date(START + 10_000).toISOString() },
        status: "renewed",
      });
      expect((await leases.resolve(owner.tenantId, ALPHA)).state).toBe("live");
      expect(await leases.claim(claimInput(owner, "holder:b"))).toMatchObject({
        status: "held",
      });
      clock.ms = START + 10_001;
      expect((await leases.resolve(owner.tenantId, ALPHA)).state).toBe(
        "expired"
      );
      // An expired lease is claimable by another holder without takeover.
      const b = await claimed(leases, claimInput(owner, "holder:b"));
      expect(b.tookOver).toBe(false);
      expect(b.previous).toMatchObject({ epoch: 1, state: "expired" });
      expect(b.lease.epoch).toBe(2);
      expect(
        await leases.renew({
          fence: fenceOf(a.lease),
          recipient: ALPHA,
          scope: owner,
          ttlMs: 5000,
        })
      ).toEqual({ reason: "epoch-mismatch", status: "fenced" });
    } finally {
      await sessions.close();
    }
  }, 60_000);

  test("concurrent claims serialize: one wins a free recipient, and racing takeovers each get their own epoch", async () => {
    const owner = seatScope();
    const stores = await Promise.all(
      Array.from({ length: 4 }, async () => await open())
    );
    try {
      const holders = Array.from(
        { length: 8 },
        (_, index) => `holder:${index}`
      );
      const race = async (takeover: boolean) =>
        await Promise.all(
          holders.map(async (holderRef, index) => {
            const store = stores[index % stores.length];
            if (!store) {
              throw new Error("missing store");
            }
            return await store.leases.claim(
              claimInput(owner, holderRef, { takeover })
            );
          })
        );
      // A never-claimed recipient: exactly one claim wins at epoch 1.
      const first = await race(false);
      const winners = first.filter((result) => result.status === "claimed");
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (winner?.status !== "claimed") {
        throw new Error("expected a winner");
      }
      expect(winner.lease.epoch).toBe(1);
      const held = first.filter((result) => result.status === "held");
      expect(held).toHaveLength(7);
      for (const result of held) {
        expect(result).toMatchObject({
          current: { epoch: 1, holderRef: winner.lease.holderRef },
        });
      }
      expect(await descriptorRows(owner)).toEqual([{ revision: "1" }]);

      // Racing takeovers all succeed, one at a time: distinct epochs 2..9,
      // and the descriptor moved once per claim.
      const second = await race(true);
      const epochs = second
        .map((result) =>
          result.status === "claimed" ? result.lease.epoch : Number.NaN
        )
        .sort((left, right) => left - right);
      expect(epochs).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
      expect(
        await stores[0]?.leases.resolve(owner.tenantId, ALPHA)
      ).toMatchObject({
        lease: { descriptorRevision: 9, epoch: 9 },
        state: "live",
      });
      expect(await descriptorRows(owner)).toEqual([{ revision: "9" }]);
    } finally {
      for (const store of stores) {
        await store.sessions.close();
      }
    }
  }, 60_000);

  describe("SECURITY: locators are untrusted", () => {
    let outside = "";
    beforeAll(() => {
      outside = join(base, "outside");
      // A run that names another supervisor.
      writeRun("repo-a", "foreign", { a2aSupervisorId: BETA });
      // A run directory that is a symlink out of the runs root.
      mkdirSync(join(outside, "run"), { recursive: true });
      writeFileSync(
        join(outside, "run", "manifest.json"),
        JSON.stringify({
          a2aSupervisorId: ALPHA,
          repoId: "repo-a",
          runId: "escape",
        })
      );
      symlinkSync(join(outside, "run"), join(runsRoot(), "repo-a", "escape"));
      // A Codex run whose manifest points at a non-loopback host.
      writeRun("repo-a", "codex-remote", {
        codexRemoteUrl: "ws://192.168.1.18:4500",
      });
    });

    const refusedClaims: [
      string,
      SupervisorEndpointLocator,
      SupervisorEndpointLocatorRefusal,
    ][] = [
      ["a run without a manifest", loopRun("missing"), "unresolved"],
      [
        "a run naming another supervisor",
        loopRun("foreign"),
        "foreign-manifest",
      ],
      [
        "a run directory symlinked out of the root",
        loopRun("escape"),
        "not-contained",
      ],
      [
        "another supervisor's Claude session",
        { kind: "claude-channel", sessionId: "sess-b" },
        "unresolved",
      ],
      [
        "a Codex run whose manifest URL is not loopback",
        {
          kind: "codex-thread",
          repoId: "repo-a",
          runId: "codex-remote",
          threadId: "thread-1",
        },
        "remote-url-refused",
      ],
    ];
    for (const [label, locator, reason] of refusedClaims) {
      test(`a claim of ${label} is refused and writes nothing`, async () => {
        const owner = seatScope();
        const { leases, sessions } = await open();
        try {
          expect(
            await leases.claim(
              claimInput(owner, "holder:a", {
                locator,
                sessionRef:
                  locator.kind === "codex-thread"
                    ? `session:${locator.threadId}`
                    : "session:claude-alpha-1",
              })
            )
          ).toEqual({ reason, status: "locator-refused" });
          expect(await leaseRows(owner)).toEqual([]);
          expect(await descriptorRows(owner)).toEqual([]);
        } finally {
          await sessions.close();
        }
      }, 60_000);
    }

    test("the claimant's own Claude session resolves under its own slug", async () => {
      const owner = seatScope();
      const { leases, sessions } = await open();
      try {
        const result = await claimed(
          leases,
          claimInput(owner, "holder:a", {
            locator: { kind: "claude-channel", sessionId: "sess-1" },
          })
        );
        expect(result.descriptor.endpointRef).toBe("endpoint:claude-channel");
      } finally {
        await sessions.close();
      }
    }, 60_000);

    test("a locator carrying a path, a URL or a traversal id is invalid input", async () => {
      const owner = seatScope();
      const { calls, leases, sessions } = await open();
      try {
        for (const locator of [
          { ...loopRun(), runDir: "/etc" },
          { kind: "claude-channel", sessionDir: "/tmp", sessionId: "sess-1" },
          {
            kind: "codex-thread",
            remoteUrl: "ws://127.0.0.1:1",
            repoId: "repo-a",
            runId: "codex-1",
            threadId: "thread-1",
          },
          { ...loopRun(), runId: "../run-1" },
          { ...loopRun(), repoId: "/abs" },
          { kind: "claude-channel", sessionId: ".." },
        ]) {
          await expect(
            leases.claim(
              claimInput(owner, "holder:a", {
                locator: locator as unknown as SupervisorEndpointLocator,
              })
            )
          ).rejects.toBeInstanceOf(SupervisorEndpointLeaseError);
        }
        expect(calls).toEqual([]);
        expect(await leaseRows(owner)).toEqual([]);
      } finally {
        await sessions.close();
      }
    }, 60_000);

    test("renew re-resolves the stored locator and extends nothing once it is refused; release still lets go", async () => {
      const owner = seatScope();
      const clock = { ms: START };
      const { calls, leases, sessions } = await open({ clock });
      writeRun("repo-a", "renew-run");
      try {
        const a = await claimed(
          leases,
          claimInput(owner, "holder:a", { locator: loopRun("renew-run") })
        );
        const renew = async () =>
          await leases.renew({
            fence: fenceOf(a.lease),
            recipient: ALPHA,
            scope: owner,
            ttlMs: TTL,
          });
        // The run is handed to another supervisor after the claim.
        writeRun("repo-a", "renew-run", { a2aSupervisorId: BETA });
        clock.ms += 1000;
        expect(await renew()).toEqual({
          reason: "foreign-manifest",
          status: "locator-refused",
        });
        // The run directory is swapped for a symlink out of the root.
        rmSync(join(runsRoot(), "repo-a", "renew-run"), {
          force: true,
          recursive: true,
        });
        symlinkSync(
          join(outside, "run"),
          join(runsRoot(), "repo-a", "renew-run")
        );
        expect(await renew()).toEqual({
          reason: "not-contained",
          status: "locator-refused",
        });
        expect(calls).toHaveLength(3);
        // Nothing was extended: the lease lapses by TTL.
        expect(await leases.resolve(owner.tenantId, ALPHA)).toEqual({
          lease: a.lease,
          state: "live",
        });
        expect(await descriptorRows(owner)).toEqual([{ revision: "1" }]);
        expect(
          await leases.release({
            fence: fenceOf(a.lease),
            recipient: ALPHA,
            scope: owner,
          })
        ).toMatchObject({ changed: true, status: "released" });
        expect(calls).toHaveLength(3);
      } finally {
        rmSync(join(runsRoot(), "repo-a", "renew-run"), { force: true });
        await sessions.close();
      }
    }, 60_000);

    test("renew refuses a Codex run whose manifest URL moved off loopback", async () => {
      const owner = seatScope();
      const { leases, sessions } = await open();
      writeRun("repo-a", "codex-moves");
      const locator: SupervisorEndpointLocator = {
        kind: "codex-thread",
        repoId: "repo-a",
        runId: "codex-moves",
        threadId: "thread-1",
      };
      try {
        const a = await claimed(
          leases,
          claimInput(owner, "holder:a", {
            locator,
            sessionRef: "session:thread-1",
          })
        );
        for (const codexRemoteUrl of [
          "ws://evil.example:4500",
          "ws://[::ffff:127.0.0.1]:4500",
          "ws://127.0.0.1:4500/redirect?to=ws://evil.example",
          "wss://127.0.0.1:4500",
          "ws://localhost",
        ]) {
          writeRun("repo-a", "codex-moves", { codexRemoteUrl });
          expect(
            await leases.renew({
              fence: fenceOf(a.lease),
              recipient: ALPHA,
              scope: owner,
              ttlMs: TTL,
            })
          ).toEqual({
            reason: "remote-url-refused",
            status: "locator-refused",
          });
        }
        expect(await descriptorRows(owner)).toEqual([{ revision: "1" }]);
      } finally {
        await sessions.close();
      }
    }, 60_000);

    test("a stored lease edited out of band is refused, never used", async () => {
      const owner = seatScope();
      const { leases, sessions } = await open();
      try {
        await claimed(leases, claimInput(owner, "holder:a"));
        const stored = await admin<
          { descriptor_id: string; kind: string; session_ref: string }[]
        >`
          SELECT descriptor_id, kind, session_ref
          FROM loop_supervisor_endpoint_lease_v2
          WHERE tenant_id = ${owner.tenantId}
        `;
        for (const edit of [
          // Another run's ids without the digest that binds them.
          `locator_json = jsonb_set(locator_json, '{runId}', '"run-2"')`,
          // A path smuggled into the row.
          `locator_json = locator_json || '{"runDir": "/etc"}'::jsonb`,
          // The kind column disagreeing with the locator.
          `kind = 'claude-channel'`,
          // Another scope's descriptor.
          `descriptor_id = 'supervisor-session-descriptor:v2:${"0".repeat(64)}'`,
          // A session ref that is not one.
          `session_ref = 'claude-alpha-1'`,
          // A fence that is not one.
          "holder_ref = 'bad holder'",
        ]) {
          await admin.unsafe(
            `UPDATE loop_supervisor_endpoint_lease_v2
             SET ${edit}
             WHERE tenant_id = $1`,
            [owner.tenantId]
          );
          await expect(leases.resolve(owner.tenantId, ALPHA)).rejects.toThrow(
            "stored endpoint lease is invalid"
          );
          await expect(leases.list(owner.tenantId)).rejects.toThrow(
            "stored endpoint lease is invalid"
          );
          await expect(
            leases.claim(claimInput(owner, "holder:a"))
          ).rejects.toThrow("stored endpoint lease is invalid");
          await admin`
            UPDATE loop_supervisor_endpoint_lease_v2
            SET locator_json = ${JSON.stringify(loopRun())}::text::jsonb,
              kind = ${stored[0]?.kind ?? ""},
              descriptor_id = ${stored[0]?.descriptor_id ?? ""},
              session_ref = ${stored[0]?.session_ref ?? ""},
              holder_ref = 'holder:a'
            WHERE tenant_id = ${owner.tenantId}
          `;
          expect((await leases.resolve(owner.tenantId, ALPHA)).state).toBe(
            "live"
          );
        }
      } finally {
        await sessions.close();
      }
    }, 60_000);
  });

  test("renew decides again under the row lock: a change landing while it resolves its locator wins", async () => {
    for (const change of [
      {
        // A takeover: the epoch moves on.
        expected: { reason: "epoch-mismatch", status: "fenced" },
        set: "epoch = epoch + 1, holder_ref = 'holder:intruder'",
      },
      {
        // The stored locator changes under the same fence (out of band).
        expected: { reason: "invalid", status: "locator-refused" },
        set: `locator_json = '${JSON.stringify(loopRun("run-2"))}'::jsonb,
          locator_digest = '${supervisorEndpointLocatorDigest(loopRun("run-2"))}'`,
      },
    ]) {
      const owner = seatScope();
      const { calls, leases, sessions } = await open();
      try {
        const a = await claimed(leases, claimInput(owner, "holder:a"));
        let renewal: Promise<unknown> | undefined;
        await admin.begin(async (tx) => {
          await tx.unsafe(
            `UPDATE loop_supervisor_endpoint_lease_v2 SET ${change.set}
             WHERE tenant_id = $1`,
            [owner.tenantId]
          );
          // The renewal reads the committed row, passes the fence, resolves
          // its locator, then waits on this transaction's row lock.
          renewal = leases.renew({
            fence: fenceOf(a.lease),
            recipient: ALPHA,
            scope: owner,
            ttlMs: TTL,
          });
          // Commit only once the renewal is blocked on this row lock, so its
          // write path, not just its first read, meets the change.
          let waiting = 0;
          for (let tick = 0; tick < 400 && waiting === 0; tick += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            const [lock] = await admin<{ count: number }[]>`
              SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted
            `;
            waiting = lock?.count ?? 0;
          }
          expect(calls).toHaveLength(2);
          expect(waiting).toBeGreaterThan(0);
        });
        expect(await renewal).toEqual(change.expected);
        // Nothing was extended past the change.
        expect(await descriptorRows(owner)).toEqual([{ revision: "1" }]);
        const [row] = await admin<{ expires_at: Date }[]>`
          SELECT expires_at FROM loop_supervisor_endpoint_lease_v2
          WHERE tenant_id = ${owner.tenantId}
        `;
        expect(row?.expires_at.toISOString()).toBe(a.lease.expiresAt);
      } finally {
        await sessions.close();
      }
    }
  }, 60_000);

  test("lease and descriptor commit together: a denied rebind leaves the lease as it was", async () => {
    const owner = seatScope();
    let deny = false;
    const { leases, sessions } = await open({
      authority: {
        decide: () => ({
          allowed: !deny,
          authorityRef: "authority:lease-test",
          reasonCode: deny ? "denied-by-test" : "configured-session-rebind",
        }),
      },
    });
    try {
      const a = await claimed(leases, claimInput(owner, "holder:a"));
      deny = true;
      await expect(
        leases.claim(claimInput(owner, "holder:b", { takeover: true }))
      ).rejects.toThrow("session rebind denied: denied-by-test");
      await expect(
        leases.renew({
          fence: fenceOf(a.lease),
          recipient: ALPHA,
          scope: owner,
          ttlMs: TTL,
        })
      ).rejects.toThrow("session rebind denied: denied-by-test");
      expect(await leases.resolve(owner.tenantId, ALPHA)).toEqual({
        lease: a.lease,
        state: "live",
      });
      expect(await descriptorRows(owner)).toEqual([{ revision: "1" }]);
    } finally {
      await sessions.close();
    }
  }, 60_000);

  test("renew refuses a descriptor another writer moved or removed, and changes nothing", async () => {
    const owner = seatScope();
    const { leases, sessions } = await open();
    try {
      const a = await claimed(leases, claimInput(owner, "holder:a"));
      const renew = async () =>
        await leases.renew({
          fence: fenceOf(a.lease),
          recipient: ALPHA,
          scope: owner,
          ttlMs: TTL,
        });
      await sessions.rebind(owner, {
        ...a.descriptor,
        revision: 2,
        sessionRef: "session:someone-else",
      });
      await expect(renew()).rejects.toThrow(
        "endpoint lease descriptor no longer matches the lease"
      );
      expect(await leases.resolve(owner.tenantId, ALPHA)).toEqual({
        lease: a.lease,
        state: "live",
      });
      expect(await descriptorRows(owner)).toEqual([{ revision: "2" }]);
      // A removed descriptor is not silently re-registered by a renewal.
      await admin`
        DELETE FROM loop_supervisor_session_v2_descriptor
        WHERE tenant_id = ${owner.tenantId}
      `;
      await expect(renew()).rejects.toThrow(
        "endpoint lease descriptor no longer matches the lease"
      );
      expect(await descriptorRows(owner)).toEqual([]);
    } finally {
      await sessions.close();
    }
  }, 60_000);

  test("a lease is only its own scope's: another principal's renew or release reads it as absent", async () => {
    const owner = seatScope();
    const { leases, sessions } = await open();
    try {
      const a = await claimed(leases, claimInput(owner, "holder:a"));
      const other = { ...owner, principal: "principal:other" };
      expect(
        await leases.renew({
          fence: fenceOf(a.lease),
          recipient: ALPHA,
          scope: other,
          ttlMs: TTL,
        })
      ).toEqual({ reason: "absent", status: "fenced" });
      expect(
        await leases.release({
          fence: fenceOf(a.lease),
          recipient: ALPHA,
          scope: other,
        })
      ).toEqual({ reason: "absent", status: "fenced" });
      expect(await leases.resolve(owner.tenantId, ALPHA)).toEqual({
        lease: a.lease,
        state: "live",
      });
    } finally {
      await sessions.close();
    }
  }, 60_000);

  test("invalid input is refused before the store; an unreachable store answers unavailable with no driver text", async () => {
    const owner = seatScope();
    const { calls, leases, sessions } = await open();
    await sessions.close();
    const fence = { epoch: 1, holderRef: "holder:a" };
    for (const bad of [
      claimInput(owner, "holder:a", { recipient: "alpha" }),
      claimInput(owner, "bad holder"),
      claimInput(owner, "holder:a", { ttlMs: 999 }),
      claimInput(owner, "holder:a", { ttlMs: 86_400_001 }),
      claimInput(owner, "holder:a", { sessionRef: "claude-alpha-1" }),
      { ...claimInput(owner, "holder:a"), takeover: "yes" as never },
      { ...claimInput(owner, "holder:a"), scope: { tenantId: "x" } as never },
    ]) {
      await expect(leases.claim(bad)).rejects.toBeInstanceOf(
        SupervisorEndpointLeaseError
      );
    }
    await expect(
      leases.renew({
        fence: { epoch: 0, holderRef: "holder:a" },
        recipient: ALPHA,
        scope: owner,
        ttlMs: TTL,
      })
    ).rejects.toBeInstanceOf(SupervisorEndpointLeaseError);
    await expect(leases.resolve("tenant", ALPHA)).rejects.toBeInstanceOf(
      SupervisorEndpointLeaseError
    );
    expect(calls).toEqual([]);
    for (const call of [
      () => leases.claim(claimInput(owner, "holder:a")),
      () => leases.renew({ fence, recipient: ALPHA, scope: owner, ttlMs: TTL }),
      () => leases.release({ fence, recipient: ALPHA, scope: owner }),
      () => leases.resolve(owner.tenantId, ALPHA),
      () => leases.list(owner.tenantId),
    ]) {
      const error = await call().then(
        () => undefined,
        (rejection: unknown) => rejection
      );
      expect(error).toBeInstanceOf(
        SupervisorMessageV2ReadinessUnavailableError
      );
      expect((error as Error).message).toBe(
        "session readiness store is unavailable"
      );
    }
    expect(() =>
      sessions.endpointLeases({ resolveLocator: undefined as never })
    ).toThrow(SupervisorEndpointLeaseError);
  }, 60_000);
});
