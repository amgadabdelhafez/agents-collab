import { SQL } from "bun";
import type { SupervisorA2AResultBinding } from "./a2a-supervisor-result";
import {
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  parseSupervisorMessageV2DeliveryEnvelope,
  parseSupervisorMessageV2Deployment,
  parseSupervisorMessageV2Input,
  SUPERVISOR_MESSAGE_V2_MAX_DELIVERY_ATTEMPTS,
  type SupervisorMessageV2DeliveryEnvelope,
  type SupervisorMessageV2Input,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import {
  SUPERVISOR_MESSAGE_V2_TERMINAL_OUTCOMES,
  type SupervisorMessageV2DeliveryLedger,
  type SupervisorMessageV2TerminalOutcome,
} from "./supervisor-message-v2-runtime";

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

/** JSON columns hold what Bun SQL stores for `${text}::jsonb`: a JSON string
 * whose content is the document. A row may also hold the object itself.
 * Both are read the same way. */
const storedJson = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const parseStoredBinding = (
  value: unknown,
  workflowId: string,
  taskId: string
): SupervisorA2AResultBinding | undefined => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "a2aTaskId,graphTaskId,graphWorkflowId,messageWorkflowId,recipient" ||
    Object.values(value).some(
      (entry) => typeof entry !== "string" || !RESULT_REFERENCE.test(entry)
    )
  ) {
    return undefined;
  }
  const binding = value as SupervisorA2AResultBinding;
  return binding.messageWorkflowId === workflowId &&
    binding.a2aTaskId === taskId
    ? binding
    : undefined;
};

/** The message-derived result graph, or undefined for an id that is not a V2
 * message workflow id (which then matches no binding). */
const derivedResultGraph = (
  scope: TrustedSupervisorMessageV2Scope,
  workflowId: string
): string | undefined => {
  try {
    return deriveSupervisorMessageV2ResultGraphWorkflowId(scope, workflowId);
  } catch {
    return undefined;
  }
};

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

const parseTerminalOutcome = (
  value: unknown
): SupervisorMessageV2TerminalOutcome => {
  if (
    !(SUPERVISOR_MESSAGE_V2_TERMINAL_OUTCOMES as readonly unknown[]).includes(
      value
    )
  ) {
    throw new Error("V2 workflow terminal outcome is invalid");
  }
  return value as SupervisorMessageV2TerminalOutcome;
};

const parseDispatchOwner = (owner: string): string => {
  if (!DISPATCH_OWNER.test(owner)) {
    throw new Error("V2 delivery lease owner is invalid");
  }
  return owner;
};

/** A start-intent row's workflow binding: its id and owning deployment. */
interface StartIntentBinding {
  deployment: string | null;
  workflow_id: string;
}

/**
 * Private, reopenable ledger for canonical V2 delivery identities.
 *
 * Workflow id formats. A ledger belongs to one deployment (the host's Temporal
 * task queue). It mints only deployment-scoped workflow ids and records the
 * deployment on each start intent. A row recorded before the discriminator
 * existed has `deployment` NULL and carries the legacy id; such a row is still
 * recovered, acknowledged and deduplicated under that legacy id, and a sender
 * retry of its dedupe key resolves to it rather than starting the message a
 * second time under the new format. No existing row is rewritten. Rows of
 * another deployment sharing the database are not this ledger's: it neither
 * recovers nor authorizes them.
 *
 * Transition limit: only legacy code writes legacy rows, so hosts sharing a
 * ledger database must not run the pre-discriminator build alongside this one.
 */
export class PostgresSupervisorMessageV2DeliveryLedger
  implements SupervisorMessageV2DeliveryLedger
{
  readonly #deployment: string;
  readonly #sql: SQL;

  private constructor(sql: SQL, deployment: string) {
    this.#deployment = deployment;
    this.#sql = sql;
  }

  static async connect(
    databaseUrl: string,
    options: { deployment: string }
  ): Promise<PostgresSupervisorMessageV2DeliveryLedger> {
    if (!POSTGRES_URL.test(databaseUrl)) {
      throw new Error("V2 delivery ledger needs an explicit PostgreSQL URL");
    }
    let deployment: string;
    try {
      deployment = parseSupervisorMessageV2Deployment(options?.deployment);
    } catch {
      throw new Error("V2 delivery ledger deployment is invalid");
    }
    const sql = new SQL(databaseUrl);
    await sql.connect();
    return new PostgresSupervisorMessageV2DeliveryLedger(sql, deployment);
  }

  /** The deployment discriminator this ledger mints workflow ids for. */
  get deployment(): string {
    return this.#deployment;
  }

  /**
   * Whether a row's id is the one its dedupe key derives for its owner: the
   * deployment-scoped id on this deployment's rows, the legacy id on a row
   * recorded before the discriminator (deployment NULL). Anything else,
   * including another deployment's row, is not bound for this ledger.
   */
  #isBound(
    row: StartIntentBinding,
    scope: TrustedSupervisorMessageV2Scope,
    dedupeKey: string
  ): boolean {
    const ours =
      row.deployment === this.#deployment &&
      row.workflow_id ===
        deriveSupervisorMessageV2WorkflowId(scope, dedupeKey, this.#deployment);
    const legacy =
      row.deployment === null &&
      row.workflow_id ===
        deriveSupervisorMessageV2LegacyWorkflowId(scope, dedupeKey);
    return ours || legacy;
  }

  /**
   * The workflow id a received message runs under: the legacy id when this
   * scope already recorded the dedupe key under it, else the deployment id.
   * A message accepted before the format change is never started again.
   */
  async workflowIdFor(
    trustedScope: TrustedSupervisorMessageV2Scope,
    dedupeKey: string
  ): Promise<string> {
    const legacy = deriveSupervisorMessageV2LegacyWorkflowId(
      trustedScope,
      dedupeKey
    );
    const rows = await this.#sql<
      { workflow_id: string }[]
    >`SELECT workflow_id FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${legacy} AND deployment IS NULL`;
    return rows[0]
      ? legacy
      : deriveSupervisorMessageV2WorkflowId(
          trustedScope,
          dedupeKey,
          this.#deployment
        );
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
    // An unreleased revision reserved a graph task per message workflow with
    // this index, which refused follow-up turns of the same A2A task.
    await this
      .#sql`DROP INDEX IF EXISTS loop_supervisor_message_v2_result_binding_graph_task`;
    // A graph task is evidence for one A2A task at a time. The graph itself
    // is derived from one message's scoped identity, so the only contention
    // left is one message carried by two A2A tasks.
    await this
      .#sql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_result_graph_task (
      graph_workflow_id TEXT NOT NULL, graph_task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL, a2a_task_id TEXT NOT NULL,
      PRIMARY KEY (graph_workflow_id, graph_task_id)
    )`;
    await this.#backfillResultGraphTasks();
    // Additive terminal marker on the start intent. NULL means no terminal
    // outcome was observed; a value closes the workflow for recovery, sender
    // retries and delivery claims, even after the engine purges it.
    await this
      .#sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS terminal_outcome TEXT CHECK (terminal_outcome IN ('acknowledged', 'canceled', 'dead-lettered', 'exhausted', 'terminated'))`;
    await this
      .#sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ`;
    // Additive owner of a start intent. NULL marks a row recorded before
    // workflow ids carried a deployment discriminator: it keeps its legacy id
    // and is neither backfilled nor rewritten.
    await this
      .#sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS deployment TEXT`;
  }

  /**
   * Bindings recorded before reservations existed. A binding whose graph is
   * the one derived from its own message is reserved, in a stable order, so
   * the first such binding keeps it. Any other binding named a graph the
   * request body chose: it is not reserved, `resultBinding` never returns
   * it, and `bindResult` lets that message be re-bound to its derived graph.
   * Malformed rows are skipped rather than stopping the host. Rows are parsed
   * here rather than with JSON operators because bindings are stored as JSON
   * strings (see `storedJson`).
   */
  async #backfillResultGraphTasks(): Promise<void> {
    const rows = await this.#sql<
      {
        a2a_task_id: string;
        binding_json: unknown;
        principal: string;
        tenant_id: string;
        workflow_id: string;
      }[]
    >`SELECT workflow_id, a2a_task_id, tenant_id, principal, binding_json
      FROM loop_supervisor_message_v2_result_binding
      ORDER BY tenant_id, a2a_task_id, workflow_id`;
    for (const row of rows) {
      const binding = parseStoredBinding(
        storedJson(row.binding_json),
        row.workflow_id,
        row.a2a_task_id
      );
      if (
        !binding ||
        binding.graphWorkflowId !==
          derivedResultGraph(
            { tenantId: row.tenant_id, principal: row.principal },
            row.workflow_id
          )
      ) {
        continue;
      }
      await this
        .#sql`INSERT INTO loop_supervisor_message_v2_result_graph_task (graph_workflow_id, graph_task_id, tenant_id, a2a_task_id)
        VALUES (${binding.graphWorkflowId}, ${binding.graphTaskId}, ${row.tenant_id}, ${row.a2a_task_id})
        ON CONFLICT DO NOTHING`;
    }
  }

  /**
   * Immutable assignment. The graph must be the one derived from the
   * message's own scoped identity; a body-named graph that differs is
   * refused here as well as by the host. This ledger reserves the graph task
   * for this one A2A task, in the same transaction as the binding, so a
   * refused bind leaves nothing reserved.
   *
   * A reservation held by another A2A task passes to this one only when
   * `releasable` confirms the holder has ended (failed, canceled or
   * rejected: terminal states, so the answer cannot go stale). The holder's
   * binding then no longer holds its graph task and is never published.
   */
  async bindResult(
    scope: TrustedSupervisorMessageV2Scope,
    binding: SupervisorA2AResultBinding,
    options: {
      releasable?(holder: {
        a2aTaskId: string;
        tenantId: string;
      }): Promise<boolean>;
    } = {}
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
    const derived = derivedResultGraph(scope, binding.messageWorkflowId);
    if (binding.graphWorkflowId !== derived) {
      throw new Error("Result graph is not derived from this message");
    }
    const assigned = await this.recipientAssignment({
      tenantId: scope.tenantId,
      recipient: binding.recipient,
      workflowId: binding.messageWorkflowId,
    });
    if (!assigned || assigned.principal !== scope.principal) {
      throw new Error("Result recipient is not assigned");
    }
    await this.#sql.begin(async (sql) => {
      await sql`INSERT INTO loop_supervisor_message_v2_result_graph_task (graph_workflow_id, graph_task_id, tenant_id, a2a_task_id)
        VALUES (${binding.graphWorkflowId}, ${binding.graphTaskId}, ${scope.tenantId}, ${binding.a2aTaskId})
        ON CONFLICT DO NOTHING`;
      const reserved = await sql<
        { a2a_task_id: string; tenant_id: string }[]
      >`SELECT tenant_id, a2a_task_id FROM loop_supervisor_message_v2_result_graph_task
        WHERE graph_workflow_id = ${binding.graphWorkflowId} AND graph_task_id = ${binding.graphTaskId}`;
      const holder = reserved[0];
      if (
        !holder ||
        holder.tenant_id !== scope.tenantId ||
        holder.a2a_task_id !== binding.a2aTaskId
      ) {
        const released =
          holder?.tenant_id === scope.tenantId &&
          (await options.releasable?.({
            tenantId: holder.tenant_id,
            a2aTaskId: holder.a2a_task_id,
          })) === true &&
          (
            await sql`UPDATE loop_supervisor_message_v2_result_graph_task SET a2a_task_id = ${binding.a2aTaskId}
              WHERE graph_workflow_id = ${binding.graphWorkflowId} AND graph_task_id = ${binding.graphTaskId}
                AND tenant_id = ${holder.tenant_id} AND a2a_task_id = ${holder.a2a_task_id}
              RETURNING a2a_task_id`
          ).length === 1;
        if (!released) {
          throw new Error("Result graph task is reserved for another A2A task");
        }
      }
      await sql`INSERT INTO loop_supervisor_message_v2_result_binding (workflow_id, a2a_task_id, tenant_id, principal, binding_json)
        VALUES (${binding.messageWorkflowId}, ${binding.a2aTaskId}, ${scope.tenantId}, ${scope.principal}, ${canonical(binding)}::jsonb)
        ON CONFLICT (workflow_id, a2a_task_id) DO NOTHING`;
      const existing = await sql<
        { binding_json: unknown }[]
      >`SELECT binding_json FROM loop_supervisor_message_v2_result_binding
        WHERE workflow_id = ${binding.messageWorkflowId} AND a2a_task_id = ${binding.a2aTaskId} AND tenant_id = ${scope.tenantId} AND principal = ${scope.principal}`;
      if (!existing[0]) {
        throw new Error("Result binding conflicts with prior assignment");
      }
      const stored = parseStoredBinding(
        storedJson(existing[0].binding_json),
        binding.messageWorkflowId,
        binding.a2aTaskId
      );
      if (stored && canonical(stored) === canonical(binding)) {
        return;
      }
      // A derived binding is immutable. Throwing also rolls back a
      // reservation this call just made.
      if (stored?.graphWorkflowId === derived) {
        throw new Error("Result binding conflicts with prior assignment");
      }
      // A binding recorded before graphs were derived from the message named
      // a graph the request body chose. It was never publishable, so the
      // message's derived graph replaces it.
      await sql`UPDATE loop_supervisor_message_v2_result_binding SET binding_json = ${canonical(binding)}::jsonb
        WHERE workflow_id = ${binding.messageWorkflowId} AND a2a_task_id = ${binding.a2aTaskId} AND tenant_id = ${scope.tenantId} AND principal = ${scope.principal}`;
    });
  }

  /** The binding to publish, only while its graph is the one derived from
   * the message and it still holds that graph task's reservation. */
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
    const value = parseStoredBinding(
      storedJson(rows[0].binding_json),
      workflowId,
      taskId
    );
    if (!value) {
      throw new Error("Stored result binding is invalid");
    }
    if (value.graphWorkflowId !== derivedResultGraph(scope, workflowId)) {
      return undefined;
    }
    const reserved = await this.#sql<
      { a2a_task_id: string }[]
    >`SELECT a2a_task_id FROM loop_supervisor_message_v2_result_graph_task
      WHERE graph_workflow_id = ${value.graphWorkflowId} AND graph_task_id = ${value.graphTaskId}
        AND tenant_id = ${scope.tenantId} AND a2a_task_id = ${taskId}`;
    return reserved[0] ? value : undefined;
  }

  async claim(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    trustedScope: TrustedSupervisorMessageV2Scope,
    owner: string,
    now: Date,
    leaseMs: number
  ): Promise<{
    fence: number;
    state: "busy" | "claimed" | "closed" | "succeeded";
  }> {
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
    >`UPDATE loop_supervisor_message_v2_delivery_ledger SET lease_owner = ${parsedOwner}, lease_fence = lease_fence + 1, lease_until = ${until} WHERE delivery_id = ${parsed.deliveryId} AND completed_at IS NULL AND (lease_until IS NULL OR lease_until <= ${now}) AND NOT EXISTS (SELECT 1 FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${parsed.workflowId} AND terminal_outcome IS NOT NULL) RETURNING completed_at, lease_fence::integer AS lease_fence`;
    if (rows[0]) {
      return { fence: rows[0].lease_fence, state: "claimed" };
    }
    if (await this.terminalOutcome(parsed.workflowId, trustedScope)) {
      return { fence: 0, state: "closed" };
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
    const current = deriveSupervisorMessageV2WorkflowId(
      trustedScope,
      parsed.dedupeKey,
      this.#deployment
    );
    const legacy = deriveSupervisorMessageV2LegacyWorkflowId(
      trustedScope,
      parsed.dedupeKey
    );
    if (workflowId !== current && workflowId !== legacy) {
      throw new Error(
        "V2 workflow start intent has an invalid workflow binding"
      );
    }
    const encoded = canonical(parsed);
    if (workflowId === current) {
      // Never record a dedupe key a second time under the new format while
      // its legacy intent exists: that would start the message twice.
      await this
        .#sql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json, deployment)
        SELECT ${workflowId}, ${trustedScope.tenantId}, ${trustedScope.principal}, ${encoded}::jsonb, ${this.#deployment}
        WHERE NOT EXISTS (SELECT 1 FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${legacy})
        ON CONFLICT (workflow_id) DO NOTHING`;
    }
    const rows = await this.#sql<
      (StartIntentBinding & {
        input_json: unknown;
        principal: string;
        tenant_id: string;
      })[]
    >`SELECT workflow_id, deployment, input_json, principal, tenant_id FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${workflowId}`;
    const row = rows[0];
    if (!row) {
      // A legacy id is never minted; a deployment id is refused while the
      // same dedupe key is held under its legacy id.
      throw new Error(
        workflowId === legacy
          ? "V2 legacy workflow id has no recorded start intent; a new message uses its deployment workflow id"
          : "V2 workflow start intent is held under its legacy workflow id"
      );
    }
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
        row.tenant_id === trustedScope.tenantId &&
        row.principal === trustedScope.principal &&
        storedParsed &&
        this.#isBound(row, trustedScope, storedParsed.dedupeKey) &&
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
    await this.startIntent(workflowId, trustedScope);
  }

  async startIntent(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<SupervisorMessageV2Input> {
    const rows = await this.#sql<
      (StartIntentBinding & {
        input_json: unknown;
        principal: string;
        tenant_id: string;
      })[]
    >`SELECT workflow_id, deployment, input_json, principal, tenant_id FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${workflowId}`;
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
    if (!this.#isBound(row, trustedScope, parsed.dedupeKey)) {
      throw new Error(
        "V2 workflow start intent has an invalid workflow binding"
      );
    }
    return parsed;
  }

  /** Body-free host lookup. Caller supplies route tenant and authenticated
   * recipient, never a sender principal taken from the request body. */
  async recipientAssignment(input: {
    tenantId: string;
    recipient: string;
    workflowId: string;
  }): Promise<TrustedSupervisorMessageV2Scope | undefined> {
    const rows = await this.#sql<
      (StartIntentBinding & {
        input_json: unknown;
        principal: string;
        tenant_id: string;
      })[]
    >`SELECT workflow_id, deployment, input_json, principal, tenant_id FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${input.workflowId} AND tenant_id = ${input.tenantId}`;
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
      !this.#isBound(row, scope, parsed.dedupeKey)
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
    // This deployment's intents and pre-discriminator ones; another
    // deployment's intents in a shared database are not recovered here.
    const rows = await this.#sql<
      (StartIntentBinding & {
        input_json: unknown;
        principal: string;
        tenant_id: string;
      })[]
    >`SELECT input_json, principal, tenant_id, workflow_id, deployment FROM loop_supervisor_message_v2_start_intent WHERE deployment = ${this.#deployment} OR deployment IS NULL ORDER BY workflow_id`;
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
      if (!this.#isBound(row, trustedScope, parsed.dedupeKey)) {
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

  /**
   * Looks a workflow's deliveries up by primary key. Every delivery ID is a
   * scoped digest of (scope, workflow, attempt) and attempts are bounded, so
   * the candidates are enumerable and a foreign scope derives none of them.
   * It never reads `envelope_json`: this client binds `${text}::jsonb` as a
   * JSON string scalar, where a JSON path such as `->>'workflowId'` is NULL.
   */
  async hasCompletedDelivery(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<boolean> {
    const deliveryIds = Array.from(
      { length: SUPERVISOR_MESSAGE_V2_MAX_DELIVERY_ATTEMPTS },
      (_, index) =>
        deriveSupervisorMessageV2DeliveryId(trustedScope, workflowId, index + 1)
    ).join(",");
    const rows = await this.#sql<
      { completed: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM loop_supervisor_message_v2_delivery_ledger WHERE delivery_id = ANY(string_to_array(${deliveryIds}::text, ',')) AND completed_at IS NOT NULL) AS completed`;
    return rows[0]?.completed === true;
  }

  async recordTerminalOutcome(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope,
    outcome: SupervisorMessageV2TerminalOutcome
  ): Promise<void> {
    const parsed = parseTerminalOutcome(outcome);
    await this.assertStartIntent(workflowId, trustedScope);
    await this
      .#sql`UPDATE loop_supervisor_message_v2_start_intent SET terminal_outcome = ${parsed}, terminal_at = now() WHERE workflow_id = ${workflowId} AND tenant_id = ${trustedScope.tenantId} AND principal = ${trustedScope.principal} AND terminal_outcome IS NULL`;
  }

  async terminalOutcome(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope
  ): Promise<SupervisorMessageV2TerminalOutcome | undefined> {
    const rows = await this.#sql<
      { terminal_outcome: string | null }[]
    >`SELECT terminal_outcome FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${workflowId} AND tenant_id = ${trustedScope.tenantId} AND principal = ${trustedScope.principal}`;
    const value = rows[0]?.terminal_outcome;
    return value === null || value === undefined
      ? undefined
      : parseTerminalOutcome(value);
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
