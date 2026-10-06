import { SQL } from "bun";
import type { SupervisorA2AResultBinding } from "./a2a-supervisor-result";
import {
  deriveLegacyUnkeyedSupervisorMessageV2ResultGraphWorkflowId,
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
  type SupervisorResultGraphKey,
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
/** Recorded once the pre-reservation binding scan has run on a database. */
const RESULT_GRAPH_TASK_BACKFILL_MARKER = "result-graph-task-backfill.v1";
/** The marker row naming the workflow id format a database's start intents
 * are written in, and the build that recorded it. */
const WORKFLOW_ID_FORMAT_MARKER = "workflow-id-format.v1";
/** The build id grammar of the orchestration config's `buildId`. */
const BUILD_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
/** Recorded marker text this build will repeat in an error message. */
const PRINTABLE_MARKER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/;

/**
 * The workflow id formats a ledger writes. `legacy` is the format before the
 * deployment discriminator (`supervisor-message-workflow:v2:<sha256>`), the
 * one a pre-discriminator build reads; `deployment` is the deployment-scoped
 * format (`supervisor-message-workflow:v2:deployment:<sha256>`). Either way a
 * ledger reads, recovers and deduplicates both.
 */
export const SUPERVISOR_MESSAGE_V2_WORKFLOW_ID_FORMATS = [
  "legacy",
  "deployment",
] as const;
export type SupervisorMessageV2WorkflowIdFormat =
  (typeof SUPERVISOR_MESSAGE_V2_WORKFLOW_ID_FORMATS)[number];

/**
 * A start refused over the database's workflow id format. Its message is
 * exact and operator-facing: it names formats, build ids and counts only.
 */
export class SupervisorMessageV2WorkflowIdFormatError extends Error {
  override readonly name = "SupervisorMessageV2WorkflowIdFormatError";
}

const isWorkflowIdFormat = (
  value: unknown
): value is SupervisorMessageV2WorkflowIdFormat =>
  (SUPERVISOR_MESSAGE_V2_WORKFLOW_ID_FORMATS as readonly unknown[]).includes(
    value
  );

const printable = (value: unknown): string =>
  typeof value === "string" && PRINTABLE_MARKER_RE.test(value)
    ? value
    : "<unreadable>";

/**
 * Refuses, for every writer including a build that predates the marker, a
 * start intent whose format is not the recorded one, and a legacy-format
 * intent for a message already held under a deployment id (its
 * `legacy_workflow_id`). Versioned by name so a later build can replace it.
 */
const START_INTENT_FORMAT_GUARD = `CREATE OR REPLACE FUNCTION loop_supervisor_message_v2_start_intent_format_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  recorded_format TEXT;
  recorded_build TEXT;
  written_format TEXT := CASE WHEN NEW.deployment IS NULL THEN 'legacy' ELSE 'deployment' END;
BEGIN
  SELECT value, build_id INTO recorded_format, recorded_build
    FROM loop_supervisor_message_v2_schema_marker WHERE name = '${WORKFLOW_ID_FORMAT_MARKER}';
  IF recorded_format IS DISTINCT FROM written_format THEN
    RAISE EXCEPTION 'V2 delivery ledger writes "%" workflow ids (recorded by build %); a "%" start intent is refused. Every host sharing this ledger database must run a build that supports the recorded format, with the same a2aV2.workflowIdFormat',
      coalesce(recorded_format, 'none'), coalesce(recorded_build, 'unknown'), written_format;
  END IF;
  IF NEW.deployment IS NULL AND EXISTS (
    SELECT 1 FROM loop_supervisor_message_v2_start_intent WHERE legacy_workflow_id = NEW.workflow_id
  ) THEN
    RAISE EXCEPTION 'V2 start intent % is held under a deployment workflow id; it is never recorded again under its legacy id', NEW.workflow_id;
  END IF;
  RETURN NEW;
END
$guard$`;

/** A recorded binding that will never publish, by ids only. */
export interface SupervisorMessageV2UnpublishableResultBinding {
  a2aTaskId: string;
  graphTaskId: string | null;
  graphWorkflowId: string | null;
  messageWorkflowId: string;
  /** body-chosen-graph: recorded before graphs were derived from the
   * message; malformed: the stored binding cannot be read. */
  reason: "body-chosen-graph" | "malformed";
  tenantId: string;
}

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

/** Undefined for an id that is not a V2 message workflow id (which then
 * matches no binding). */
const attempt = (derive: () => string): string | undefined => {
  try {
    return derive();
  } catch {
    return undefined;
  }
};

/** The retired unkeyed v2 graph of a message: accepted only for bindings
 * recorded before the key existed. */
const legacyResultGraph = (
  scope: TrustedSupervisorMessageV2Scope,
  workflowId: string
): string | undefined =>
  attempt(() =>
    deriveLegacyUnkeyedSupervisorMessageV2ResultGraphWorkflowId(
      scope,
      workflowId
    )
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

/** Options for opening a V2 delivery ledger. */
export interface PostgresSupervisorMessageV2DeliveryLedgerOptions {
  /** This host's build id, recorded with a workflow id format it sets. */
  buildId: string;
  /** The workflow-id discriminator: the host's Temporal task queue. */
  deployment: string;
  /** The host secret keying result graph ids. Without it nothing can be
   * bound, and only bindings recorded under the unkeyed v2 id publish. */
  resultGraphKey?: SupervisorResultGraphKey;
  /**
   * The workflow id format new messages are written in (operator config
   * `a2aV2.workflowIdFormat`). Omitted, the format the database records, or
   * `legacy` when it records none. `deployment` is an explicit opt-in.
   */
  workflowIdFormat?: SupervisorMessageV2WorkflowIdFormat;
}

/** A start-intent row's workflow binding: its id and owning deployment. */
interface StartIntentBinding {
  deployment: string | null;
  workflow_id: string;
}

/**
 * Private, reopenable ledger for canonical V2 delivery identities.
 *
 * Workflow id formats. A ledger belongs to one deployment (the host's Temporal
 * task queue) and writes new messages in one format, the one its database
 * records (see `migrate`). In `legacy` format it mints the pre-discriminator
 * id, byte for byte, with `deployment` NULL: exactly the row a
 * pre-discriminator build writes and reads, so that build can be rolled back
 * to. In `deployment` format it mints deployment-scoped ids and records the
 * deployment on each start intent.
 *
 * Whatever it writes, it reads both. A legacy row (`deployment` NULL) is
 * recovered, acknowledged and deduplicated under its legacy id; a row of this
 * deployment under its deployment id. A sender retry of a dedupe key resolves
 * to the row already recorded in either format, so a message is never started
 * a second time across a format change. No existing row is rewritten.
 *
 * Deployment isolation (decision 6) covers deployment-format rows only: a
 * deployment-format row of another deployment sharing the database is not
 * this ledger's, and it neither recovers nor authorizes it. A legacy row
 * names no deployment, so every ledger on the database treats it as its own,
 * as a pre-discriminator build does: each recovers it, and a dedupe key
 * resolves to the same legacy id on every deployment. In `legacy` format,
 * the default, every new row is such a row, so hosts on different task
 * queues that share the database get no isolation until every one of them
 * writes `deployment`. The task-queue ownership checks of the workflow port
 * still refuse an execution another task queue already holds; they cannot
 * refuse a start whose execution does not exist yet.
 *
 * Mixed versions. The database refuses (by trigger, for every writer,
 * including a pre-discriminator build) a start intent in any format but the
 * recorded one, and a legacy intent for a message held under a deployment id.
 * A pre-discriminator build therefore shares a database safely only while it
 * records `legacy`; after the flip to `deployment` it can record nothing, and
 * its recovery refuses the first deployment-format row it reads. Returning to
 * `legacy` is allowed once every deployment-format intent has settled, but
 * those rows stay, so a database that ever held one is not readable by a
 * pre-discriminator build again: return to this build's `legacy` mode instead.
 */
export class PostgresSupervisorMessageV2DeliveryLedger
  implements SupervisorMessageV2DeliveryLedger
{
  readonly #buildId: string;
  readonly #deployment: string;
  readonly #requestedFormat: SupervisorMessageV2WorkflowIdFormat | undefined;
  readonly #sql: SQL;
  readonly #resultGraphKey: SupervisorResultGraphKey | undefined;
  #format: SupervisorMessageV2WorkflowIdFormat | undefined;

  private constructor(
    sql: SQL,
    options: PostgresSupervisorMessageV2DeliveryLedgerOptions
  ) {
    this.#buildId = options.buildId;
    this.#deployment = options.deployment;
    this.#requestedFormat = options.workflowIdFormat;
    this.#sql = sql;
    this.#resultGraphKey = options.resultGraphKey;
  }

  static async connect(
    databaseUrl: string,
    options: PostgresSupervisorMessageV2DeliveryLedgerOptions
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
    if (
      typeof options.buildId !== "string" ||
      !BUILD_ID_RE.test(options.buildId)
    ) {
      throw new Error("V2 delivery ledger build id is invalid");
    }
    if (
      options.workflowIdFormat !== undefined &&
      !isWorkflowIdFormat(options.workflowIdFormat)
    ) {
      throw new Error("V2 delivery ledger workflow id format is invalid");
    }
    const sql = new SQL(databaseUrl);
    await sql.connect();
    return new PostgresSupervisorMessageV2DeliveryLedger(sql, {
      buildId: options.buildId,
      deployment,
      resultGraphKey: options.resultGraphKey,
      workflowIdFormat: options.workflowIdFormat,
    });
  }

  /** The format new messages are written in, once `migrate` resolved it. */
  get workflowIdFormat(): SupervisorMessageV2WorkflowIdFormat | undefined {
    return this.#format;
  }

  #writeFormat(): SupervisorMessageV2WorkflowIdFormat {
    if (!this.#format) {
      throw new Error(
        "V2 delivery ledger has no workflow id format: migrate() must succeed first"
      );
    }
    return this.#format;
  }

  /** The keyed graph of a message, or undefined without the key. */
  #keyedResultGraph(
    scope: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): string | undefined {
    const key = this.#resultGraphKey;
    return key
      ? attempt(() =>
          deriveSupervisorMessageV2ResultGraphWorkflowId(key, scope, workflowId)
        )
      : undefined;
  }

  /** True when `graphWorkflowId` is derived from this message: the keyed id,
   * or the unkeyed v2 id a binding recorded before the key may still name. */
  #isDerivedResultGraph(
    scope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    graphWorkflowId: string
  ): boolean {
    return (
      graphWorkflowId === this.#keyedResultGraph(scope, workflowId) ||
      graphWorkflowId === legacyResultGraph(scope, workflowId)
    );
  }

  /** The deployment discriminator this ledger mints workflow ids for. */
  get deployment(): string {
    return this.#deployment;
  }

  /**
   * Whether a row's id is the one its dedupe key derives for its owner: the
   * deployment-scoped id on this deployment's rows, the legacy id on a
   * legacy row (deployment NULL), whichever build or deployment wrote it.
   * Anything else, including another deployment's deployment-format row, is
   * not bound for this ledger.
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
   * The workflow id a received message runs under: the id this scope already
   * recorded the dedupe key under, in either format, else the id of the
   * format this ledger writes. A message accepted before a format change is
   * never started again under the other format.
   */
  async workflowIdFor(
    trustedScope: TrustedSupervisorMessageV2Scope,
    dedupeKey: string
  ): Promise<string> {
    const format = this.#writeFormat();
    const legacy = deriveSupervisorMessageV2LegacyWorkflowId(
      trustedScope,
      dedupeKey
    );
    const current = deriveSupervisorMessageV2WorkflowId(
      trustedScope,
      dedupeKey,
      this.#deployment
    );
    const rows = await this.#sql<
      { workflow_id: string }[]
    >`SELECT workflow_id FROM loop_supervisor_message_v2_start_intent
      WHERE (workflow_id = ${legacy} AND deployment IS NULL)
         OR (workflow_id = ${current} AND deployment = ${this.#deployment})`;
    const recorded = rows[0]?.workflow_id;
    if (recorded) {
      return recorded;
    }
    return format === "legacy" ? legacy : current;
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
    await this
      .#sql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_schema_marker (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    // Bindings that will never publish, recorded by the one-time scan below
    // and cleared when the message is re-bound to its derived graph.
    await this
      .#sql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_unpublishable_result_binding (
      workflow_id TEXT NOT NULL, a2a_task_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('body-chosen-graph', 'malformed')),
      graph_workflow_id TEXT, graph_task_id TEXT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workflow_id, a2a_task_id)
    )`;
    await this.#backfillResultGraphTasks();
    // Additive terminal marker on the start intent. NULL means no terminal
    // outcome was observed; a value closes the workflow for recovery, sender
    // retries and delivery claims, even after the engine purges it.
    await this
      .#sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS terminal_outcome TEXT CHECK (terminal_outcome IN ('acknowledged', 'canceled', 'dead-lettered', 'exhausted', 'terminated'))`;
    await this.#replaceRetiredTerminalOutcomeCheck();
    await this
      .#sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ`;
    // Additive owner of a start intent. NULL marks a row recorded before
    // workflow ids carried a deployment discriminator: it keeps its legacy id
    // and is neither backfilled nor rewritten.
    await this
      .#sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS deployment TEXT`;
    // Additive: the format marker's value and writer, and the legacy id a
    // deployment-format row would have had (named only once the format
    // returns to legacy; see #recordLegacyIdsOfDeploymentRows).
    await this
      .#sql`ALTER TABLE loop_supervisor_message_v2_schema_marker ADD COLUMN IF NOT EXISTS value TEXT`;
    await this
      .#sql`ALTER TABLE loop_supervisor_message_v2_schema_marker ADD COLUMN IF NOT EXISTS build_id TEXT`;
    await this
      .#sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS legacy_workflow_id TEXT`;
    await this
      .#sql`CREATE INDEX IF NOT EXISTS loop_supervisor_message_v2_start_intent_legacy_workflow_id ON loop_supervisor_message_v2_start_intent (legacy_workflow_id)`;
    this.#format = await this.#resolveWorkflowIdFormat();
  }

  /**
   * Resolves, records and enforces the format new start intents are written
   * in, once per start. Starts are serialized, and every start intent write
   * (by any build) waits until the format is settled and guarded.
   *
   * The marker row records the format and the build that set it; a format
   * this build does not support refuses start. The format written is the
   * configured one, or the recorded one when none is configured, `legacy`
   * when none is recorded: opting in to `deployment` is always explicit.
   * Writing `legacy` is refused while any deployment-format intent has no
   * terminal outcome, whether the marker recorded the flip or a
   * deployment-id build that predates the marker wrote it. While `legacy`,
   * every deployment-format row names its legacy id, so the guard refuses
   * that id to any writer.
   */
  async #resolveWorkflowIdFormat(): Promise<SupervisorMessageV2WorkflowIdFormat> {
    return await this.#sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('loop_supervisor_message_v2_workflow_id_format'))`;
      // Self-conflicting, and taken by every INSERT: a write in flight is
      // counted below, and a later one meets the guard of the new format.
      await sql`LOCK TABLE loop_supervisor_message_v2_start_intent IN SHARE ROW EXCLUSIVE MODE`;
      const marker = (
        await sql<
          { build_id: string | null; value: string | null }[]
        >`SELECT value, build_id FROM loop_supervisor_message_v2_schema_marker WHERE name = ${WORKFLOW_ID_FORMAT_MARKER}`
      )[0];
      if (marker && !isWorkflowIdFormat(marker.value)) {
        throw new SupervisorMessageV2WorkflowIdFormatError(
          `V2 delivery ledger records workflow id format "${printable(marker.value)}" (written by build ${printable(marker.build_id)}), which this build does not support; it supports "legacy" and "deployment". Run a build that supports the recorded format`
        );
      }
      const recorded: SupervisorMessageV2WorkflowIdFormat | undefined =
        marker?.value as SupervisorMessageV2WorkflowIdFormat | undefined;
      const format = this.#requestedFormat ?? recorded ?? "legacy";
      if (format === "legacy") {
        const unsettled = await sql<
          { count: number }[]
        >`SELECT count(*)::integer AS count FROM loop_supervisor_message_v2_start_intent
          WHERE deployment IS NOT NULL AND terminal_outcome IS NULL`;
        const count = unsettled[0]?.count ?? 0;
        if (count > 0) {
          throw new SupervisorMessageV2WorkflowIdFormatError(
            `V2 delivery ledger cannot return to legacy workflow ids: ${count} deployment-format start intents have no terminal outcome. Keep a2aV2.workflowIdFormat "deployment" until they settle`
          );
        }
        await this.#recordLegacyIdsOfDeploymentRows(sql);
      }
      if (recorded !== format) {
        await sql`INSERT INTO loop_supervisor_message_v2_schema_marker (name, value, build_id) VALUES (${WORKFLOW_ID_FORMAT_MARKER}, ${format}, ${this.#buildId})
          ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, build_id = EXCLUDED.build_id, applied_at = now()`;
      }
      await sql.unsafe(START_INTENT_FORMAT_GUARD);
      const guarded = await sql<
        { present: boolean }[]
      >`SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'loop_supervisor_message_v2_start_intent_format_guard_v1' AND tgrelid = 'loop_supervisor_message_v2_start_intent'::regclass) AS present`;
      if (!guarded[0]?.present) {
        await sql`CREATE TRIGGER loop_supervisor_message_v2_start_intent_format_guard_v1
          BEFORE INSERT ON loop_supervisor_message_v2_start_intent
          FOR EACH ROW EXECUTE FUNCTION loop_supervisor_message_v2_start_intent_format_guard_v1()`;
      }
      return format;
    });
  }

  /** Names the legacy id of every deployment-format row that lacks it (one
   * recorded while the format was `deployment`), so the guard refuses that
   * id. A row that cannot be read is left alone: nothing binds it. */
  async #recordLegacyIdsOfDeploymentRows(sql: SQL): Promise<void> {
    const rows = await sql<
      {
        input_json: unknown;
        principal: string;
        tenant_id: string;
        workflow_id: string;
      }[]
    >`SELECT workflow_id, tenant_id, principal, input_json FROM loop_supervisor_message_v2_start_intent
      WHERE deployment IS NOT NULL AND legacy_workflow_id IS NULL`;
    for (const row of rows) {
      const scope = { principal: row.principal, tenantId: row.tenant_id };
      const legacy = attempt(() =>
        deriveSupervisorMessageV2LegacyWorkflowId(
          scope,
          parseSupervisorMessageV2Input(storedJson(row.input_json), scope)
            .dedupeKey
        )
      );
      if (legacy) {
        await sql`UPDATE loop_supervisor_message_v2_start_intent SET legacy_workflow_id = ${legacy} WHERE workflow_id = ${row.workflow_id}`;
      }
    }
  }

  /**
   * A database migrated by an intermediate build (3f7a70f2) already has the
   * terminal_outcome column, so ADD COLUMN IF NOT EXISTS skips it and keeps
   * that build's CHECK, which allows 'completed' and refuses 'acknowledged'.
   * That build stored a recipient acknowledgement as 'completed'. Under a
   * table lock (ALTER TABLE above already takes the same lock on every start),
   * any terminal_outcome CHECK that is not the current list (missing, allowing
   * 'completed', or missing a current outcome) is replaced, and stored
   * 'completed' is rewritten to 'acknowledged', in one transaction. A current
   * CHECK is left as it is, so a normal start changes nothing, and a CHECK
   * that also allows a newer build's outcomes is not narrowed.
   */
  async #replaceRetiredTerminalOutcomeCheck(): Promise<void> {
    await this.#sql.begin(async (sql) => {
      // Serializes hosts migrating one database at the same time.
      await sql`LOCK TABLE loop_supervisor_message_v2_start_intent IN ACCESS EXCLUSIVE MODE`;
      const checks = await sql<{ definition: string; name: string }[]>`
        SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'loop_supervisor_message_v2_start_intent'::regclass
          AND c.contype = 'c' AND a.attname = 'terminal_outcome'`;
      const current =
        checks.length > 0 &&
        checks.every(
          (check) =>
            !check.definition.includes("'completed'") &&
            SUPERVISOR_MESSAGE_V2_TERMINAL_OUTCOMES.every((value) =>
              check.definition.includes(`'${value}'`)
            )
        );
      if (current) {
        return;
      }
      for (const check of checks) {
        await sql.unsafe(
          `ALTER TABLE loop_supervisor_message_v2_start_intent DROP CONSTRAINT "${check.name.replaceAll('"', '""')}"`
        );
      }
      await sql`UPDATE loop_supervisor_message_v2_start_intent SET terminal_outcome = 'acknowledged' WHERE terminal_outcome = 'completed'`;
      await sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD CONSTRAINT loop_supervisor_message_v2_start_intent_terminal_outcome_check CHECK (terminal_outcome IN ('acknowledged', 'canceled', 'dead-lettered', 'exhausted', 'terminated'))`;
    });
  }

  /**
   * Bindings recorded before reservations existed, scanned once per schema
   * version: a marker row records the scan in the same transaction. Every
   * binding written since is reserved by `bindResult` itself, so a later
   * start never rescans the table. Only a binary older than 2b1b1893 could
   * add an unreserved row afterwards; such a row is not picked up.
   *
   * A binding whose graph is the unkeyed v2 graph derived from its own
   * message is reserved, in a stable order, so the first such binding keeps
   * it. Any other binding named a graph the request body chose, or cannot be
   * read: it is not reserved, `resultBinding` never returns it, and it is
   * recorded as unpublishable (ids only) so the host can report it.
   * `bindResult` lets that message be re-bound to its keyed graph. Rows are
   * parsed here rather than with JSON operators because bindings are stored
   * as JSON strings (see `storedJson`).
   */
  async #backfillResultGraphTasks(): Promise<void> {
    await this.#sql.begin(async (sql) => {
      const done = await sql<
        { name: string }[]
      >`SELECT name FROM loop_supervisor_message_v2_schema_marker WHERE name = ${RESULT_GRAPH_TASK_BACKFILL_MARKER}`;
      if (done[0]) {
        return;
      }
      const rows = await sql<
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
          binding &&
          binding.graphWorkflowId ===
            legacyResultGraph(
              { tenantId: row.tenant_id, principal: row.principal },
              row.workflow_id
            )
        ) {
          await sql`INSERT INTO loop_supervisor_message_v2_result_graph_task (graph_workflow_id, graph_task_id, tenant_id, a2a_task_id)
            VALUES (${binding.graphWorkflowId}, ${binding.graphTaskId}, ${row.tenant_id}, ${row.a2a_task_id})
            ON CONFLICT DO NOTHING`;
          continue;
        }
        // No keyed binding can be here: migrate records the marker before
        // this code ever binds, so every other row predates the key.
        await sql`INSERT INTO loop_supervisor_message_v2_unpublishable_result_binding (workflow_id, a2a_task_id, tenant_id, reason, graph_workflow_id, graph_task_id)
          VALUES (${row.workflow_id}, ${row.a2a_task_id}, ${row.tenant_id}, ${binding ? "body-chosen-graph" : "malformed"},
            ${binding?.graphWorkflowId ?? null}, ${binding?.graphTaskId ?? null})
          ON CONFLICT (workflow_id, a2a_task_id) DO NOTHING`;
      }
      await sql`INSERT INTO loop_supervisor_message_v2_schema_marker (name) VALUES (${RESULT_GRAPH_TASK_BACKFILL_MARKER})
        ON CONFLICT (name) DO NOTHING`;
    });
  }

  /** Recorded bindings that will never publish. Pass a tenant to list only
   * that tenant's. Ids only: no message body, no secret. */
  async unpublishableResultBindings(
    tenantId?: string
  ): Promise<SupervisorMessageV2UnpublishableResultBinding[]> {
    const rows = await this.#sql<
      {
        a2a_task_id: string;
        graph_task_id: string | null;
        graph_workflow_id: string | null;
        reason: SupervisorMessageV2UnpublishableResultBinding["reason"];
        tenant_id: string;
        workflow_id: string;
      }[]
    >`SELECT workflow_id, a2a_task_id, tenant_id, reason, graph_workflow_id, graph_task_id
      FROM loop_supervisor_message_v2_unpublishable_result_binding
      WHERE ${tenantId ?? null}::text IS NULL OR tenant_id = ${tenantId ?? null}
      ORDER BY tenant_id, a2a_task_id, workflow_id`;
    return rows.map((row) => ({
      a2aTaskId: row.a2a_task_id,
      graphTaskId: row.graph_task_id,
      graphWorkflowId: row.graph_workflow_id,
      messageWorkflowId: row.workflow_id,
      reason: row.reason,
      tenantId: row.tenant_id,
    }));
  }

  /**
   * Immutable assignment. The graph must be the one derived, under this
   * host's result graph key, from the message's own scoped identity; a
   * body-named graph that differs (including the retired unkeyed v2 id) is
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
    if (!this.#resultGraphKey) {
      throw new Error("Result graph key is not configured");
    }
    await this.assertStartIntent(binding.messageWorkflowId, scope);
    if (
      binding.graphWorkflowId !==
      this.#keyedResultGraph(scope, binding.messageWorkflowId)
    ) {
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
      // A derived binding, keyed or recorded under the unkeyed v2 id, is
      // immutable. Throwing also rolls back a reservation this call just made.
      if (
        stored &&
        this.#isDerivedResultGraph(
          scope,
          binding.messageWorkflowId,
          stored.graphWorkflowId
        )
      ) {
        throw new Error("Result binding conflicts with prior assignment");
      }
      // A binding recorded before graphs were derived from the message named
      // a graph the request body chose (or cannot be read). It was never
      // publishable, so the message's derived graph replaces it.
      await sql`UPDATE loop_supervisor_message_v2_result_binding SET binding_json = ${canonical(binding)}::jsonb
        WHERE workflow_id = ${binding.messageWorkflowId} AND a2a_task_id = ${binding.a2aTaskId} AND tenant_id = ${scope.tenantId} AND principal = ${scope.principal}`;
      await sql`DELETE FROM loop_supervisor_message_v2_unpublishable_result_binding
        WHERE workflow_id = ${binding.messageWorkflowId} AND a2a_task_id = ${binding.a2aTaskId} AND tenant_id = ${scope.tenantId}`;
    });
  }

  /** The binding to publish, only while its graph is derived from the
   * message (the keyed id, or the unkeyed v2 id of a binding recorded before
   * the key) and it still holds that graph task's reservation. */
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
    if (!this.#isDerivedResultGraph(scope, workflowId, value.graphWorkflowId)) {
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
    const format = this.#writeFormat();
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
    if (workflowId === current && format === "deployment") {
      // Never record a dedupe key a second time under the new format while
      // its legacy intent exists: that would start the message twice.
      await this
        .#sql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json, deployment)
        SELECT ${workflowId}, ${trustedScope.tenantId}, ${trustedScope.principal}, ${encoded}::jsonb, ${this.#deployment}
        WHERE NOT EXISTS (SELECT 1 FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${legacy})
        ON CONFLICT (workflow_id) DO NOTHING`;
    }
    if (workflowId === legacy && format === "legacy") {
      // The row a pre-discriminator build writes, byte for byte. The format
      // guard refuses it while the message is held under a deployment id.
      await this
        .#sql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json)
        VALUES (${workflowId}, ${trustedScope.tenantId}, ${trustedScope.principal}, ${encoded}::jsonb)
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
      // Only the written format is minted; a deployment id is also refused
      // while the same dedupe key is held under its legacy id.
      if (format === "legacy") {
        throw new Error(
          'V2 deployment workflow id has no recorded start intent; this ledger writes legacy workflow ids (a2aV2.workflowIdFormat "legacy")'
        );
      }
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
    // This deployment's intents and every legacy one; another deployment's
    // deployment-format intents in a shared database are not recovered here.
    // A legacy intent names no deployment, so every deployment recovers it.
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
