import { SQL } from "bun";
import {
  deriveSupervisorMessageV2ReceiptId,
  parseSupervisorMessageV2GovernanceReceipt,
  parseSupervisorMessageV2GovernanceRequest,
  parseTrustedSupervisorMessageV2Scope,
  type SupervisorMessageV2GovernanceReceipt,
  type SupervisorMessageV2GovernanceRequest,
  type SupervisorMessageV2Projection,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import type { SupervisorMessageV2Coordinator } from "./supervisor-message-v2-runtime";
import { WorkflowError } from "./workflow-port";

export interface SupervisorMessageV2AuthorityDecision {
  allowed: boolean;
  authorityRef: string;
  reasonCode: string;
}

/**
 * The authority boundary is intentionally small: it decides one already
 * scope-bound V2 operation and never receives a message body.  A route may
 * use an upstream policy engine behind this port without teaching Temporal or
 * the board how that decision was made.
 */
export interface SupervisorMessageV2AuthorityPort {
  decide(
    request: SupervisorMessageV2GovernanceRequest
  ):
    | Promise<SupervisorMessageV2AuthorityDecision>
    | SupervisorMessageV2AuthorityDecision;
}

/** A durable implementation belongs to the caller-owned control database. */
export interface SupervisorMessageV2GovernanceReceiptPort {
  record(
    receipt: SupervisorMessageV2GovernanceReceipt
  ):
    | Promise<SupervisorMessageV2GovernanceReceipt>
    | SupervisorMessageV2GovernanceReceipt;
}

export interface GovernedSupervisorMessageV2ServiceOptions {
  authority: SupervisorMessageV2AuthorityPort;
  coordinator: SupervisorMessageV2Coordinator;
  now?: () => string;
  receipts: SupervisorMessageV2GovernanceReceiptPort;
}

export interface GovernedSupervisorMessageV2Command {
  claimant: string;
  requestId: string;
  trustedScope: TrustedSupervisorMessageV2Scope;
  workflowId: string;
}

const REFERENCE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/;
const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;

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

const reference = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !REFERENCE_RE.test(value)) {
    throw new WorkflowError(
      "invalid-command",
      `SupervisorMessage V2 governance ${field} is invalid`
    );
  }
  return value;
};

export class SupervisorMessageV2GovernanceError extends Error {
  readonly authorityRef: string;
  readonly reasonCode: string;

  constructor(decision: SupervisorMessageV2AuthorityDecision) {
    super(`SupervisorMessage V2 authority denied: ${decision.reasonCode}`);
    this.name = "SupervisorMessageV2GovernanceError";
    this.authorityRef = decision.authorityRef;
    this.reasonCode = decision.reasonCode;
  }
}

const parseStoredReceipt = (
  value: unknown
): SupervisorMessageV2GovernanceReceipt => {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw new Error("SupervisorMessage V2 stored receipt is invalid");
  }
  const scope = parseTrustedSupervisorMessageV2Scope({
    principal: (value as SupervisorMessageV2GovernanceReceipt).principal,
    tenantId: (value as SupervisorMessageV2GovernanceReceipt).tenantId,
  });
  const request = parseSupervisorMessageV2GovernanceRequest(
    {
      claimant: (value as SupervisorMessageV2GovernanceReceipt).claimant,
      from: (value as SupervisorMessageV2GovernanceReceipt).from,
      operation: (value as SupervisorMessageV2GovernanceReceipt).operation,
      principal: scope.principal,
      schema: "supervisor-message-governance-request.v2",
      tenantId: scope.tenantId,
      threadId: (value as SupervisorMessageV2GovernanceReceipt).threadId,
      to: (value as SupervisorMessageV2GovernanceReceipt).to,
      workflowId: (value as SupervisorMessageV2GovernanceReceipt).workflowId,
    },
    scope
  );
  return parseSupervisorMessageV2GovernanceReceipt(value, scope, request);
};

const receiptSemantics = (
  receipt: SupervisorMessageV2GovernanceReceipt
): string => {
  const { at: _at, ...semantic } = receipt;
  return canonical(semantic);
};

/**
 * A small deterministic test adapter. Production composition should use the
 * PostgreSQL implementation below so a restart cannot turn a prior decision
 * into a fresh audit event.
 */
export class InMemorySupervisorMessageV2GovernanceReceiptStore
  implements SupervisorMessageV2GovernanceReceiptPort
{
  readonly #receipts = new Map<string, SupervisorMessageV2GovernanceReceipt>();

  record(
    receiptValue: SupervisorMessageV2GovernanceReceipt
  ): SupervisorMessageV2GovernanceReceipt {
    const receipt = parseStoredReceipt(receiptValue);
    const prior = this.#receipts.get(receipt.receiptId);
    if (prior && receiptSemantics(prior) !== receiptSemantics(receipt)) {
      throw new Error("SupervisorMessage V2 receipt identity conflicts");
    }
    if (!prior) {
      this.#receipts.set(receipt.receiptId, receipt);
    }
    return structuredClone(prior ?? receipt);
  }

  get(receiptId: string): SupervisorMessageV2GovernanceReceipt | undefined {
    const receipt = this.#receipts.get(receiptId);
    return receipt ? structuredClone(receipt) : undefined;
  }
}

/**
 * Durable receipt port for the control database. Receipt identity includes the
 * claimant, while the first accepted timestamp is retained. A replay with an
 * advancing clock returns the original receipt; a changed policy decision or
 * reason under the same identity conflicts rather than overwriting audit
 * history.
 */
export class PostgresSupervisorMessageV2GovernanceReceiptStore
  implements SupervisorMessageV2GovernanceReceiptPort
{
  readonly #sql: SQL;

  private constructor(sql: SQL) {
    this.#sql = sql;
  }

  static async connect(
    databaseUrl: string
  ): Promise<PostgresSupervisorMessageV2GovernanceReceiptStore> {
    if (!POSTGRES_URL.test(databaseUrl)) {
      throw new Error(
        "SupervisorMessage V2 receipts need an explicit PostgreSQL URL"
      );
    }
    const sql = new SQL(databaseUrl);
    try {
      await sql.connect();
      return new PostgresSupervisorMessageV2GovernanceReceiptStore(sql);
    } catch (error) {
      await sql.close({ timeout: 0 }).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#sql.close({ timeout: 0 });
  }

  async migrate(): Promise<void> {
    await this.#sql`
      CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_governance_receipt (
        receipt_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        receipt_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await this.#sql`
      CREATE INDEX IF NOT EXISTS loop_supervisor_message_v2_receipt_scope_idx
      ON loop_supervisor_message_v2_governance_receipt (tenant_id, principal)
    `;
  }

  async record(
    receiptValue: SupervisorMessageV2GovernanceReceipt
  ): Promise<SupervisorMessageV2GovernanceReceipt> {
    const receipt = parseStoredReceipt(receiptValue);
    const encoded = canonical(receipt);
    await this.#sql`
      INSERT INTO loop_supervisor_message_v2_governance_receipt (
        receipt_id, tenant_id, principal, receipt_json
      ) VALUES (
        ${receipt.receiptId}, ${receipt.tenantId}, ${receipt.principal}, ${encoded}::jsonb
      ) ON CONFLICT (receipt_id) DO NOTHING
    `;
    const rows = await this.#sql<{ receipt_json: unknown }[]>`
      SELECT receipt_json
      FROM loop_supervisor_message_v2_governance_receipt
      WHERE receipt_id = ${receipt.receiptId}
        AND tenant_id = ${receipt.tenantId}
        AND principal = ${receipt.principal}
    `;
    const storedValue =
      typeof rows[0]?.receipt_json === "string"
        ? JSON.parse(rows[0].receipt_json)
        : rows[0]?.receipt_json;
    const stored = parseStoredReceipt(storedValue);
    if (receiptSemantics(stored) !== receiptSemantics(receipt)) {
      throw new Error("SupervisorMessage V2 receipt identity conflicts");
    }
    return stored;
  }

  async get(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    receiptId: string
  ): Promise<SupervisorMessageV2GovernanceReceipt | undefined> {
    const trustedScope =
      parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const rows = await this.#sql<{ receipt_json: unknown }[]>`
      SELECT receipt_json
      FROM loop_supervisor_message_v2_governance_receipt
      WHERE receipt_id = ${receiptId}
        AND tenant_id = ${trustedScope.tenantId}
        AND principal = ${trustedScope.principal}
    `;
    if (!rows[0]) {
      return undefined;
    }
    const value =
      typeof rows[0].receipt_json === "string"
        ? JSON.parse(rows[0].receipt_json)
        : rows[0].receipt_json;
    return parseStoredReceipt(value);
  }
}

/**
 * V2 governance deliberately separates an allowed command receipt from the
 * subsequent recipient acknowledgement state transition.  A receipt says the
 * authority accepted the requested command; it never says the message's work
 * is completed.
 */
export class GovernedSupervisorMessageV2Service {
  readonly #authority: SupervisorMessageV2AuthorityPort;
  readonly #coordinator: SupervisorMessageV2Coordinator;
  readonly #now: () => string;
  readonly #receipts: SupervisorMessageV2GovernanceReceiptPort;

  constructor(options: GovernedSupervisorMessageV2ServiceOptions) {
    this.#authority = options.authority;
    this.#coordinator = options.coordinator;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#receipts = options.receipts;
  }

  claim(
    command: GovernedSupervisorMessageV2Command
  ): Promise<SupervisorMessageV2Projection> {
    return this.#existing("claim", command, () =>
      this.#coordinator.claim(
        command.trustedScope,
        command.workflowId,
        reference(command.claimant, "claimant"),
        command.requestId
      )
    );
  }

  acknowledge(
    command: GovernedSupervisorMessageV2Command
  ): Promise<SupervisorMessageV2Projection> {
    return this.#existing("acknowledge", command, () =>
      this.#coordinator.acknowledge(
        command.trustedScope,
        command.workflowId,
        reference(command.claimant, "claimant"),
        command.requestId
      )
    );
  }

  async #existing(
    operation: "acknowledge" | "claim",
    command: GovernedSupervisorMessageV2Command,
    run: () => Promise<SupervisorMessageV2Projection>
  ): Promise<SupervisorMessageV2Projection> {
    // The coordinator checks the durable start intent before we call policy or
    // signal Temporal.  A foreign tenant/principal therefore has no authority
    // oracle and cannot cause an effect in this workflow.
    const projection = await this.#coordinator.status(
      command.trustedScope,
      command.workflowId
    );
    const request = parseSupervisorMessageV2GovernanceRequest(
      {
        claimant: reference(command.claimant, "claimant"),
        from: projection.from,
        operation,
        principal: command.trustedScope.principal,
        schema: "supervisor-message-governance-request.v2",
        tenantId: command.trustedScope.tenantId,
        threadId: projection.threadId,
        to: projection.to,
        workflowId: command.workflowId,
      },
      command.trustedScope
    );
    await this.#authorize(request, command.trustedScope);
    return run();
  }

  async #authorize(
    request: SupervisorMessageV2GovernanceRequest,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<void> {
    const raw = await this.#authority.decide(request);
    const decision = {
      allowed: raw.allowed === true,
      authorityRef: reference(raw.authorityRef, "authorityRef"),
      reasonCode: reference(raw.reasonCode, "reasonCode"),
    };
    const receipt = parseSupervisorMessageV2GovernanceReceipt(
      {
        at: this.#now(),
        authorityRef: decision.authorityRef,
        claimant: request.claimant,
        decision: decision.allowed ? "allowed" : "denied",
        from: request.from,
        operation: request.operation,
        principal: request.principal,
        reasonCode: decision.reasonCode,
        receiptId: deriveSupervisorMessageV2ReceiptId(
          trustedScope,
          request.workflowId,
          request.operation,
          decision.authorityRef,
          request.claimant
        ),
        schema: "supervisor-message-governance-receipt.v2",
        tenantId: request.tenantId,
        threadId: request.threadId,
        to: request.to,
        workflowId: request.workflowId,
      },
      trustedScope,
      request
    );
    await this.#receipts.record(receipt);
    if (!decision.allowed) {
      throw new SupervisorMessageV2GovernanceError(decision);
    }
  }
}
