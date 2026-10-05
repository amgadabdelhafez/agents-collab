import {
  type ListTasksRequest,
  type ListTasksResponse,
  Task,
  TaskState,
  type TaskStatus,
} from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { SQL } from "bun";
import {
  WORKFLOW_ID_METADATA_KEY,
  WORKFLOW_IDS_METADATA_KEY,
} from "./a2a-supervisor-executor";

/**
 * Private A2A task projection schema. Temporal remains the authoritative
 * workflow, delivery, governance, and effect history. This table exists only
 * because the maintained A2A SDK needs tenant-and-owner-scoped task snapshots
 * (including protocol history) to resume a client after the A2A ingress
 * process is replaced.
 *
 * In particular, this is not a replacement for the body-free JSONL supervisor
 * thread projection. Task history can contain request bodies and therefore
 * remains inside the private database boundary, never in threads.jsonl.
 */
const SCHEMA_VERSION = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const POSTGRES_URL_RE = /^postgres(?:ql)?:\/\//i;

interface A2ATaskRow {
  task_json: unknown;
}

interface TaskScope {
  ownerId: string;
  tenantId: string;
}

export interface PostgresA2ATaskStoreOptions {
  /**
   * Explicit protected configuration supplied by the service manager. There
   * is deliberately no environment-variable fallback here: a caller must
   * choose and inject its database boundary rather than silently sharing one.
   */
  databaseUrl: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cloneTask = (task: Task): Task => Task.fromJSON(Task.toJSON(task));

const taskFromDatabase = (value: unknown): Task => {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("persisted A2A task JSON is malformed");
    }
  }
  if (!isRecord(parsed)) {
    throw new Error("persisted A2A task JSON is not an object");
  }
  return Task.fromJSON(parsed);
};

const serializedTask = (task: Task): string =>
  JSON.stringify(Task.toJSON(task));

const requireNonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`A2A task ${field} is required`);
  }
  return value;
};

/**
 * PostgreSQL text values cannot contain NUL, so do not use a convenient NUL
 * separator for the advisory-lock input. Byte-length framing is unambiguous
 * for arbitrary UTF-8 identifiers while remaining a legal PostgreSQL text
 * parameter. The database then hashes this bounded lock name itself.
 */
const advisoryLockKeyFor = (...values: readonly string[]): string =>
  values
    .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
    .join("");

const scopeOf = (context: ServerCallContext): TaskScope => {
  const tenantId = requireNonEmpty(context.tenant, "tenant");
  const user = context.user;
  if (!user?.isAuthenticated) {
    throw new Error("an authenticated A2A owner is required");
  }
  return {
    ownerId: requireNonEmpty(user.userName, "owner"),
    tenantId,
  };
};

const messageIdentity = (value: unknown): string => {
  if (
    isRecord(value) &&
    typeof value.messageId === "string" &&
    value.messageId
  ) {
    return `message:${value.messageId}`;
  }
  return `wire:${JSON.stringify(value)}`;
};

const artifactIdentity = (value: unknown): string => JSON.stringify(value);

const appendDistinct = <T>(
  previous: readonly T[],
  incoming: readonly T[],
  identity: (value: T) => string
): T[] => {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const value of [...previous, ...incoming]) {
    const key = identity(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(structuredClone(value));
  }
  return merged;
};

const workflowIdsOf = (task: Task): string[] => {
  const value = task.metadata?.[WORKFLOW_IDS_METADATA_KEY];
  return Array.isArray(value)
    ? value.filter(
        (workflowId): workflowId is string =>
          typeof workflowId === "string" && workflowId.length > 0
      )
    : [];
};

const TERMINAL_TASK_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

const timestampValue = (status: TaskStatus | undefined): number | undefined => {
  const timestamp = status?.timestamp;
  if (!timestamp) {
    return undefined;
  }
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? undefined : value;
};

/**
 * The maintained SDK rejects a status update that would move a persisted
 * terminal task to another state. The TaskStore can receive independently
 * loaded SDK snapshots, so repeat that invariant at the persistence boundary:
 * an advisory lock orders saves, but cannot make an earlier snapshot current.
 */
const mergeStatus = (
  previous: TaskStatus | undefined,
  incoming: TaskStatus | undefined
): TaskStatus | undefined => {
  if (!previous) {
    return incoming ? structuredClone(incoming) : undefined;
  }
  if (!incoming) {
    return structuredClone(previous);
  }
  if (
    TERMINAL_TASK_STATES.has(previous.state) &&
    incoming.state !== previous.state
  ) {
    return structuredClone(previous);
  }
  const previousTimestamp = timestampValue(previous);
  const incomingTimestamp = timestampValue(incoming);
  if (
    previousTimestamp !== undefined &&
    incomingTimestamp !== undefined &&
    incomingTimestamp < previousTimestamp
  ) {
    return structuredClone(previous);
  }
  return structuredClone(incoming);
};

/**
 * Preserve all protocol turns and all Temporal workflow associations when two
 * ingress processes save the same A2A task concurrently. The database-side
 * advisory lock below establishes the durable ordering; this merge means the
 * second saver cannot overwrite the first one's history merely because the SDK
 * loaded a slightly older task snapshot before it ran the executor.
 */
const mergeTask = (previous: Task | undefined, incoming: Task): Task => {
  if (!previous) {
    return cloneTask(incoming);
  }
  if (previous.contextId !== incoming.contextId) {
    throw new Error(
      `A2A task ${incoming.id} cannot change context from ${previous.contextId} to ${incoming.contextId}`
    );
  }

  const priorMetadata = previous.metadata ?? {};
  const incomingMetadata = incoming.metadata ?? {};
  const workflowIds = appendDistinct(
    workflowIdsOf(previous),
    workflowIdsOf(incoming),
    (workflowId) => workflowId
  );
  const metadata: Record<string, unknown> = {
    ...priorMetadata,
    ...incomingMetadata,
  };
  if (workflowIds.length > 0) {
    metadata[WORKFLOW_IDS_METADATA_KEY] = workflowIds;
  }
  const currentWorkflowId = incomingMetadata[WORKFLOW_ID_METADATA_KEY];
  if (typeof currentWorkflowId === "string" && currentWorkflowId) {
    metadata[WORKFLOW_ID_METADATA_KEY] = currentWorkflowId;
  }

  return {
    ...cloneTask(incoming),
    artifacts: appendDistinct(
      previous.artifacts ?? [],
      incoming.artifacts ?? [],
      artifactIdentity
    ),
    history: appendDistinct(
      previous.history ?? [],
      incoming.history ?? [],
      messageIdentity
    ),
    metadata,
    status: mergeStatus(previous.status, incoming.status),
  };
};

const pageTokenFor = (task: Task): string =>
  Buffer.from(`${task.status?.timestamp ?? ""}|${task.id}`).toString("base64");

const applyPageToken = (tasks: Task[], pageToken: string): Task[] => {
  if (!pageToken) {
    return tasks;
  }
  try {
    const decoded = Buffer.from(pageToken, "base64").toString("utf8");
    const [cursorTimestamp, ...idParts] = decoded.split("|");
    if (idParts.length === 0) {
      throw new Error("missing task id");
    }
    const cursorId = idParts.join("|");
    const index = tasks.findIndex(
      (task) =>
        (task.status?.timestamp ?? "") === cursorTimestamp &&
        task.id === cursorId
    );
    return index === -1 ? [] : tasks.slice(index + 1);
  } catch {
    throw new RequestMalformedError(
      "Token is not a valid base64-encoded cursor."
    );
  }
};

const validateDatabaseUrl = (databaseUrl: string): string => {
  if (!POSTGRES_URL_RE.test(databaseUrl)) {
    throw new Error("A2A task storage needs an explicit PostgreSQL URL");
  }
  return databaseUrl;
};

/**
 * The durable A2A SDK TaskStore. It deliberately implements only the SDK's
 * `save`/`load`/`list` projection contract: it never starts a Temporal
 * workflow, signals delivery, records a governance decision, or wakes a
 * provider. Those effects remain with the existing supervisor runtime.
 */
export class PostgresA2ATaskStore implements TaskStore {
  readonly #sql: SQL;

  private constructor(sql: SQL) {
    this.#sql = sql;
  }

  static async connect(
    options: PostgresA2ATaskStoreOptions
  ): Promise<PostgresA2ATaskStore> {
    const sql = new SQL(validateDatabaseUrl(options.databaseUrl));
    try {
      await sql.connect();
      return new PostgresA2ATaskStore(sql);
    } catch (error) {
      await sql.close({ timeout: 0 }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * An explicit, idempotent migration boundary. Production activation can bind
   * this to its controlled migration job; tests invoke it against their own
   * disposable container. `connect` intentionally does not mutate a database.
   */
  async migrate(): Promise<void> {
    await this.#sql.begin(async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS loop_a2a_schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS loop_a2a_tasks (
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          context_id TEXT NOT NULL,
          task_json JSONB NOT NULL,
          status_state INTEGER NOT NULL,
          status_timestamp TEXT NOT NULL,
          revision BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, owner_id, task_id)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS loop_a2a_tasks_scope_status_idx
        ON loop_a2a_tasks (tenant_id, owner_id, status_timestamp DESC, task_id DESC)
      `;
      await sql`
        INSERT INTO loop_a2a_schema_migrations (version)
        VALUES (${SCHEMA_VERSION})
        ON CONFLICT (version) DO NOTHING
      `;
    });
  }

  async close(): Promise<void> {
    await this.#sql.close({ timeout: 0 });
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    await this.update(task.id, context, () => task);
  }

  async update(
    id: string,
    context: ServerCallContext,
    transform: (current: Task | undefined) => Task
  ): Promise<void> {
    const scope = scopeOf(context);
    const taskId = requireNonEmpty(id, "id");

    await this.#sql.begin(async (sql) => {
      // Serialise even the initial insert. Row locks alone do not protect the
      // absent-row case, while this transaction-scoped advisory lock does.
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${advisoryLockKeyFor(scope.tenantId, scope.ownerId, taskId)})
        )
      `;
      const rows = await sql<A2ATaskRow[]>`
        SELECT task_json
        FROM loop_a2a_tasks
        WHERE tenant_id = ${scope.tenantId}
          AND owner_id = ${scope.ownerId}
          AND task_id = ${taskId}
        FOR UPDATE
      `;
      const current = rows[0] ? taskFromDatabase(rows[0].task_json) : undefined;
      const task = transform(current);
      if (task.id !== taskId) {
        throw new Error("Atomic task update cannot change task identity");
      }
      requireNonEmpty(task.contextId, "context id");
      const merged = mergeTask(current, task);
      const statusState = merged.status?.state ?? 0;
      const statusTimestamp = merged.status?.timestamp ?? "";
      const serialized = serializedTask(merged);
      if (rows[0]) {
        await sql`
          UPDATE loop_a2a_tasks
          SET context_id = ${merged.contextId},
              task_json = ${serialized}::jsonb,
              status_state = ${statusState},
              status_timestamp = ${statusTimestamp},
              revision = revision + 1,
              updated_at = now()
          WHERE tenant_id = ${scope.tenantId}
            AND owner_id = ${scope.ownerId}
            AND task_id = ${taskId}
        `;
      } else {
        await sql`
          INSERT INTO loop_a2a_tasks (
            tenant_id,
            owner_id,
            task_id,
            context_id,
            task_json,
            status_state,
            status_timestamp,
            revision
          ) VALUES (
            ${scope.tenantId},
            ${scope.ownerId},
            ${taskId},
            ${merged.contextId},
            ${serialized}::jsonb,
            ${statusState},
            ${statusTimestamp},
            1
          )
        `;
      }
    });
  }

  async load(
    taskId: string,
    context: ServerCallContext
  ): Promise<Task | undefined> {
    const scope = scopeOf(context);
    const rows = await this.#sql<A2ATaskRow[]>`
      SELECT task_json
      FROM loop_a2a_tasks
      WHERE tenant_id = ${scope.tenantId}
        AND owner_id = ${scope.ownerId}
        AND task_id = ${taskId}
    `;
    return rows[0] ? taskFromDatabase(rows[0].task_json) : undefined;
  }

  async list(
    params: ListTasksRequest,
    context: ServerCallContext
  ): Promise<ListTasksResponse> {
    const scope = scopeOf(context);
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_PAGE_SIZE
    ) {
      throw new RequestMalformedError("pageSize must be between 1 and 100");
    }
    const rows = await this.#sql<A2ATaskRow[]>`
      SELECT task_json
      FROM loop_a2a_tasks
      WHERE tenant_id = ${scope.tenantId}
        AND owner_id = ${scope.ownerId}
      ORDER BY status_timestamp DESC, task_id DESC
    `;
    let tasks = rows.map((row) => taskFromDatabase(row.task_json));
    if (params.contextId) {
      tasks = tasks.filter((task) => task.contextId === params.contextId);
    }
    if (params.status !== undefined && params.status !== 0) {
      tasks = tasks.filter((task) => task.status?.state === params.status);
    }
    if (params.statusTimestampAfter) {
      const after = new Date(params.statusTimestampAfter).getTime();
      tasks = tasks.filter(
        (task) =>
          task.status?.timestamp !== undefined &&
          new Date(task.status.timestamp).getTime() > after
      );
    }
    const totalSize = tasks.length;
    tasks = applyPageToken(tasks, params.pageToken);
    const paginated = tasks.slice(0, pageSize);
    const projected = paginated.map((task) => {
      const copy = cloneTask(task);
      if (!params.includeArtifacts) {
        copy.artifacts = [];
      }
      return copy;
    });
    const last = paginated.at(-1);
    return {
      nextPageToken:
        last && tasks.length > paginated.length ? pageTokenFor(last) : "",
      pageSize,
      tasks: projected,
      totalSize,
    };
  }
}
