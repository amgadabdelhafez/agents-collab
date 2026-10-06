import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2WorkflowId,
  type TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import { PostgresSupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-delivery-ledger";

const SCOPE: TrustedSupervisorMessageV2Scope = {
  principal: "principal:sender",
  tenantId: "tenant:one",
};
const FOREIGN: TrustedSupervisorMessageV2Scope = {
  ...SCOPE,
  tenantId: "tenant:foreign",
};
const WORKFLOW_ID = deriveSupervisorMessageV2WorkflowId(
  SCOPE,
  "ledger-retention-proof"
);

/**
 * Stands in for PostgreSQL holding only completed delivery rows, keyed by
 * their primary key. It deliberately offers no view of `envelope_json`: Bun's
 * client binds `${canonicalText}::jsonb` as a JSON string scalar, so a JSON
 * path such as `envelope_json->>'workflowId'` reads NULL from production rows.
 * The completion check has to work from the scoped delivery identity alone.
 */
const ledgerWithCompleted = (completed: readonly string[]) => {
  const statements: { text: string; values: unknown[] }[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$");
    statements.push({ text, values });
    const requested = values.flatMap((value) =>
      typeof value === "string" ? value.split(",") : []
    );
    return Promise.resolve([
      { completed: requested.some((id) => completed.includes(id)) },
    ]);
  };
  const Ledger = PostgresSupervisorMessageV2DeliveryLedger as unknown as new (
    sql: SQL
  ) => PostgresSupervisorMessageV2DeliveryLedger;
  return { ledger: new Ledger(sql as unknown as SQL), statements };
};

describe("V2 delivery ledger completion lookup", () => {
  test("finds a delivery completed on a later attempt by its scoped identity", async () => {
    const { ledger, statements } = ledgerWithCompleted([
      deriveSupervisorMessageV2DeliveryId(SCOPE, WORKFLOW_ID, 3),
    ]);

    await expect(ledger.hasCompletedDelivery(WORKFLOW_ID, SCOPE)).resolves.toBe(
      true
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).not.toContain("envelope_json");
  });

  test("does not count the same attempt completed in another trusted scope", async () => {
    const { ledger } = ledgerWithCompleted([
      deriveSupervisorMessageV2DeliveryId(FOREIGN, WORKFLOW_ID, 1),
    ]);

    await expect(ledger.hasCompletedDelivery(WORKFLOW_ID, SCOPE)).resolves.toBe(
      false
    );
  });

  test("covers every attempt the contract can issue, and nothing else", async () => {
    const { ledger, statements } = ledgerWithCompleted([]);

    await expect(ledger.hasCompletedDelivery(WORKFLOW_ID, SCOPE)).resolves.toBe(
      false
    );
    const requested = statements[0]?.values.flatMap((value) =>
      typeof value === "string" ? value.split(",") : []
    );
    expect(requested).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        deriveSupervisorMessageV2DeliveryId(SCOPE, WORKFLOW_ID, index + 1)
      )
    );
  });

  test("rejects a malformed workflow ID before querying", async () => {
    const { ledger, statements } = ledgerWithCompleted([]);

    await expect(
      ledger.hasCompletedDelivery("supervisor-message-workflow:v2:x", SCOPE)
    ).rejects.toThrow();
    expect(statements).toEqual([]);
  });
});
