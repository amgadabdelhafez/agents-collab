import { SQL } from "bun";
import type { SupervisorA2AResultBinding } from "./a2a-supervisor-result";
import {
  deriveSupervisorMessageV2WorkflowId,
  parseSupervisorMessageV2DeliveryEnvelope,
  parseSupervisorMessageV2Input,
  type SupervisorMessageV2DeliveryEnvelope,
  type SupervisorMessageV2Input,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import type { SupervisorMessageV2DeliveryLedger } from "./supervisor-message-v2-runtime";

const DISPATCH_OWNER = /^v2-dispatcher:[A-Za-z0-9._:-]{1,255}$/;
const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
const RESULT_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/;

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : entry
  );

/**
 * `receivedAt` records the first accepted ingress event and is retained as
 * part of the durable start payload for Temporal recovery. It is not a retry
 * discriminator: a response-loss retry happens later by definition. Every
 * other parsed field remains immutable, including body, sender claim, policy,
 * scope-bearing fields, dedupe key, and stable thread identity.
 */
const startIntentSemantics = (input: SupervisorMessageV2Input): string => {
  const { receivedAt: _receivedAt, ...immutable } = input;
  return canonical(immutable);
};

const parseDispatchOwner = (owner: string): string => {
  if (!DISPATCH_OWNER.test(owner)) {
    throw new Error("V2 delivery lease owner is invalid");
  }
  return owner;
};

/** Private, reopenable ledger for canonical V2 delivery identities. */
export class PostgresSupervisorMessageV2DeliveryLedger
  implements SupervisorMessageV2DeliveryLedger
{
  readonly #sql: SQL;

  private constructor(sql: SQL) {
    this.#sql = sql;
  }

  static async connect(
    databaseUrl: string
  ): Promise<PostgresSupervisorMessageV2DeliveryLedger> {
    if (!POSTGRES_URL.test(databaseUrl)) {
      throw new Error("V2 delivery ledger needs an explicit PostgreSQL URL");
    }
    const sql = new SQL(databaseUrl);
    await sql.connect();
    return new PostgresSupervisorMessageV2DeliveryLedger(sql);
  }

  async migrate(): Promise<void> {
    await this
      .#sql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_delivery_ledger (delivery_id TEXT PRIMARY KEY, envelope_json JSONB NOT NULL, completed_at TIMESTAMPTZ, lease_owner TEXT, lease_fence BIGINT NOT NULL DEFAULT 0, lease_until TIMESTAMPTZ)`;
    await this
      .#sql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_start_intent (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL, input_json JSONB NOT NULL)`;
    await this
      .#sql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_result_binding (
      workflow_id TEXT NOT NULL REFERENCES loop_supervisor_message_v2_start_intent(workflow_id),
      a2a_task_id TEXT NOT NULL, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
      binding_json JSONB NOT NULL, PRIMARY KEY (workflow_id, a2a_task_id)
    )`;
  }

  /** Host-only immutable assignment. No HTTP caller chooses a graph. */
  async bindResult(
    scope: TrustedSupervisorMessageV2Scope,
    binding: SupervisorA2AResultBinding
  ): Promise<void> {
    if (
      Object.keys(binding).sort().join(",") !==
        "a2aTaskId,graphTaskId,graphWorkflowId,messageWorkflowId,recipient" ||
      Object.values(binding).some(
        (value) => typeof value !== "string" || !RESULT_REFERENCE.test(value)
      )
    ) {
      throw new Error("Invalid result binding");
    }
    await this.assertStartIntent(binding.messageWorkflowId, scope);
    const assigned = await this.recipientAssignment({
      tenantId: scope.tenantId,
      recipient: binding.recipient,
      workflowId: binding.messageWorkflowId,
    });
    if (!assigned || assigned.principal !== scope.principal) {
      throw new Error("Result recipient is not assigned");
    }
    await this
      .#sql`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
      VALUES (${binding.messageWorkflowId}, ${binding.a2aTaskId}, ${scope.tenantId}, ${scope.principal}, ${canonical(binding)}::jsonb)
      ON CONFLICT (workflow_id, a2a_task_id) DO NOTHING`;
    const existing = await this.resultBinding(
      scope,
      binding.messageWorkflowId,
      binding.a2aTaskId
    );
    if (canonical(existing) !== canonical(binding)) {
      throw new Error("Result binding conflicts with prior assignment");
    }
  }

  async resultBinding(
    scope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    taskId: string
  ): Promise<SupervisorA2AResultBinding | undefined> {
    const rows = await this.#sql<
      { binding_json: unknown }[]
    >`SELECT binding_json FROM loop_supervisor_message_v2_result_binding
      WHERE workflow_id = ${workflowId} AND a2a_task_id = ${taskId} AND tenant_id = ${scope.tenantId} AND principal = ${scope.principal}`;
    if (!rows[0]) {
      return undefined;
    }
    const value =
      typeof rows[0].binding_json === "string"
        ? JSON.parse(rows[0].binding_json)
        : rows[0].binding_json;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "a2aTaskId,graphTaskId,graphWorkflowId,messageWorkflowId,recipient" ||
      Object.values(value).some(
        (entry) => typeof entry !== "string" || !RESULT_REFERENCE.test(entry)
      ) ||
      value.messageWorkflowId !== workflowId ||
      value.a2aTaskId !== taskId
    ) {
      throw new Error("Stored result binding is invalid");
    }
    return value as SupervisorA2AResultBinding;
  }

  async claim(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    trustedScope: TrustedSupervisorMessageV2Scope,
    owner: string,
    now: Date,
    leaseMs: number
  ): Promise<{ fence: number; state: "busy" | "claimed" | "succeeded" }> {
    const parsed = parseSupervisorMessageV2DeliveryEnvelope(
      envelope,
      trustedScope
    );
    const parsedOwner = parseDispatchOwner(owner);
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("V2 delivery lease duration is invalid");
    }
    await this.prepare(parsed, trustedScope);
    const until = new Date(now.getTime() + leaseMs);
    const rows = await this.#sql<
      { completed_at: Date | null; lease_fence: number }[]
    >`UPDATE loop_supervisor_message_v2_delivery_ledger SET lease_owner = ${parsedOwner}, lease_fence = lease_fence + 1, lease_until = ${until} WHERE delivery_id = ${parsed.deliveryId} AND completed_at IS NULL AND (lease_until IS NULL OR lease_until <= ${now}) RETURNING completed_at, lease_fence::integer AS lease_fence`;
    if (rows[0]) {
      return { fence: rows[0].lease_fence, state: "claimed" };
    }
    const existing = await this.#sql<
      { completed_at: Date | null }[]
    >`SELECT completed_at FROM loop_supervisor_message_v2_delivery_ledger WHERE delivery_id = ${parsed.deliveryId}`;
    if (existing[0]?.completed_at) {
      return { fence: 0, state: "succeeded" };
    }
    return { fence: 0, state: "busy" };
  }

  async close(): Promise<void> {
    await this.#sql.close({ timeout: 0 });
  }

  async recordStartIntent(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope,
    input: SupervisorMessageV2Input
  ): Promise<SupervisorMessageV2Input> {
    const parsed = parseSupervisorMessageV2Input(input, trustedScope);
    const expectedWorkflowId = deriveSupervisorMessageV2WorkflowId(
      trustedScope,
      parsed.dedupeKey
    );
    if (workflowId !== expectedWorkflowId) {
      throw new Error(
        "V2 workflow start intent has an invalid workflow binding"
      );
    }
    const encoded = canonical(parsed);
    await this
      .#sql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json) VALUES (${workflowId}, ${trustedScope.tenantId}, ${trustedScope.principal}, ${encoded}::jsonb) ON CONFLICT (workflow_id) DO NOTHING`;
    const rows = await this.#sql<
      { input_json: unknown; principal: string; tenant_id: string }[]
    >`SELECT input_json, principal, tenant_id FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${workflowId}`;
    const row = rows[0];
    const stored =
      typeof row?.input_json === "string"
        ? JSON.parse(row.input_json)
        : row?.input_json;
    const storedParsed =
      row && stored
        ? parseSupervisorMessageV2Input(stored, trustedScope)
        : undefined;
    if (
      !(
        row &&
        row.tenant_id === trustedScope.tenantId &&
        row.principal === trustedScope.principal &&
        storedParsed &&
        startIntentSemantics(storedParsed) === startIntentSemantics(parsed)
      )
    ) {
      throw new Error(
        "V2 workflow start intent conflicts with the existing binding"
      );
    }
    return storedParsed;
  }

  async assertStartIntent(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<void> {
    const rows = await this.#sql<
      { input_json: unknown; principal: string; tenant_id: string }[]
    >`SELECT input_json, principal, tenant_id FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${workflowId}`;
    const row = rows[0];
    const input =
      typeof row?.input_json === "string"
        ? JSON.parse(row.input_json)
        : row?.input_json;
    if (
      !(
        row &&
        row.tenant_id === trustedScope.tenantId &&
        row.principal === trustedScope.principal &&
        input &&
        typeof input === "object"
      )
    ) {
      throw new Error(
        "V2 workflow scope does not match its durable start intent"
      );
    }
    const parsed = parseSupervisorMessageV2Input(input, trustedScope);
    if (
      workflowId !==
      deriveSupervisorMessageV2WorkflowId(trustedScope, parsed.dedupeKey)
    ) {
      throw new Error(
        "V2 workflow start intent has an invalid workflow binding"
      );
    }
  }

  /** Body-free host lookup. Caller supplies route tenant and authenticated
   * recipient, never a sender principal taken from the request body. */
  async recipientAssignment(input: {
    tenantId: string;
    recipient: string;
    workflowId: string;
  }): Promise<TrustedSupervisorMessageV2Scope | undefined> {
    const rows = await this.#sql<
      { input_json: unknown; principal: string; tenant_id: string }[]
    >`SELECT input_json, principal, tenant_id FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${input.workflowId} AND tenant_id = ${input.tenantId}`;
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const scope = { tenantId: row.tenant_id, principal: row.principal };
    const stored =
      typeof row.input_json === "string"
        ? JSON.parse(row.input_json)
        : row.input_json;
    const parsed = parseSupervisorMessageV2Input(stored, scope);
    if (
      parsed.to !== input.recipient ||
      deriveSupervisorMessageV2WorkflowId(scope, parsed.dedupeKey) !==
        input.workflowId
    ) {
      return undefined;
    }
    return scope;
  }

  async recoverableStarts(): Promise<
    readonly {
      input: SupervisorMessageV2Input;
      trustedScope: TrustedSupervisorMessageV2Scope;
      workflowId: string;
    }[]
  > {
    const rows = await this.#sql<
      {
        input_json: unknown;
        principal: string;
        tenant_id: string;
        workflow_id: string;
      }[]
    >`SELECT input_json, principal, tenant_id, workflow_id FROM loop_supervisor_message_v2_start_intent ORDER BY workflow_id`;
    return rows.map((row) => {
      const input =
        typeof row.input_json === "string"
          ? JSON.parse(row.input_json)
          : row.input_json;
      const trustedScope = {
        principal: row.principal,
        tenantId: row.tenant_id,
      };
      if (!(input && typeof input === "object")) {
        throw new Error("V2 recovery ledger row has no start input");
      }
      const parsed = parseSupervisorMessageV2Input(input, trustedScope);
      if (
        row.workflow_id !==
        deriveSupervisorMessageV2WorkflowId(trustedScope, parsed.dedupeKey)
      ) {
        throw new Error(
          "V2 recovery ledger row has an invalid workflow binding"
        );
      }
      return {
        input: parsed,
        trustedScope,
        workflowId: row.workflow_id,
      };
    });
  }

  async prepare(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<"new" | "succeeded"> {
    const parsed = parseSupervisorMessageV2DeliveryEnvelope(
      envelope,
      trustedScope
    );
    const encoded = canonical(parsed);
    await this
      .#sql`INSERT INTO loop_supervisor_message_v2_delivery_ledger (delivery_id, envelope_json) VALUES (${parsed.deliveryId}, ${encoded}::jsonb) ON CONFLICT (delivery_id) DO NOTHING`;
    const rows = await this.#sql<
      { completed_at: Date | null; matches: boolean }[]
    >`SELECT completed_at, envelope_json = ${encoded}::jsonb AS matches FROM loop_supervisor_message_v2_delivery_ledger WHERE delivery_id = ${parsed.deliveryId}`;
    const row = rows[0];
    if (!row?.matches) {
      throw new Error("V2 delivery ID is bound to a different envelope");
    }
    return row.completed_at ? "succeeded" : "new";
  }

  async complete(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<void> {
    const parsed = parseSupervisorMessageV2DeliveryEnvelope(
      envelope,
      trustedScope
    );
    const encoded = canonical(parsed);
    const updated = await this
      .#sql`UPDATE loop_supervisor_message_v2_delivery_ledger SET completed_at = now() WHERE delivery_id = ${parsed.deliveryId} AND envelope_json = ${encoded}::jsonb`;
    if (updated.count !== 1) {
      throw new Error(
        "V2 delivery completion lacks the prepared bound envelope"
      );
    }
  }

  async completeClaim(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    trustedScope: TrustedSupervisorMessageV2Scope,
    owner: string,
    fence: number
  ): Promise<void> {
    const parsed = parseSupervisorMessageV2DeliveryEnvelope(
      envelope,
      trustedScope
    );
    const parsedOwner = parseDispatchOwner(owner);
    if (!Number.isSafeInteger(fence) || fence < 1) {
      throw new Error("V2 delivery completion fence is invalid");
    }
    const encoded = canonical(parsed);
    const updated = await this
      .#sql`UPDATE loop_supervisor_message_v2_delivery_ledger SET completed_at = now() WHERE delivery_id = ${parsed.deliveryId} AND envelope_json = ${encoded}::jsonb AND lease_owner = ${parsedOwner} AND lease_fence = ${fence} AND completed_at IS NULL`;
    if (updated.count !== 1) {
      throw new Error("V2 delivery completion fence is stale or unbound");
    }
  }
}
