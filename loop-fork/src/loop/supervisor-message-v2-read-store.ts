import { createHmac, timingSafeEqual } from "node:crypto";
import { SQL } from "bun";
import {
  deriveSupervisorMessageV2BoardItemId,
  parseSupervisorMessageV2BoardItem,
  parseSupervisorMessageV2Projection,
  parseTrustedSupervisorMessageV2Scope,
  type SupervisorMessageV2BoardItem,
  type SupervisorMessageV2Projection,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import { supervisorMessageV2ScopedDigest } from "./supervisor-message-v2-workflow-identity";

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CURSOR_SCHEMA = "supervisor-message-board-cursor.v2" as const;

interface BoardRow {
  board_item_id: string;
  item_json: unknown;
  received_at: string;
  revision: number;
  workflow_id: string;
}

interface BoardCursor {
  receivedAt: string;
  schema: typeof CURSOR_SCHEMA;
  scopeDigest: string;
  signature: string;
  snapshotRevision: number;
  workflowId: string;
}

export interface SupervisorMessageV2BoardPage {
  items: SupervisorMessageV2BoardItem[];
  nextCursor: null | string;
  schema: "supervisor-message-board-page.v2";
  snapshotRevision: number;
}

export interface SupervisorMessageV2BoardListOptions {
  cursor?: string;
  limit?: number;
}

export interface PostgresSupervisorMessageV2ReadStoreOptions {
  /** Injected by the control-plane secret boundary, never stored in a cursor. */
  cursorKey: Uint8Array;
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

const advisoryLockKey = (...values: readonly string[]): string =>
  values
    .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
    .join("");

export const supervisorMessageV2BoardScopeLockKey = (
  scopeValue: TrustedSupervisorMessageV2Scope
): string => {
  const scope = parseTrustedSupervisorMessageV2Scope(scopeValue);
  return advisoryLockKey(scope.tenantId, scope.principal);
};

const scopeDigest = (scope: TrustedSupervisorMessageV2Scope): string =>
  supervisorMessageV2ScopedDigest(
    scope.tenantId,
    scope.principal,
    "board-cursor",
    []
  );

const cursorSignature = (value: unknown, cursorKey: Uint8Array): string =>
  createHmac("sha256", cursorKey).update(canonical(value)).digest("base64url");

const normalizedCursorKey = (value: Uint8Array): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.byteLength < 32) {
    throw new Error("SupervisorMessage V2 board cursor key is invalid");
  }
  return new Uint8Array(value);
};

const parsePageSize = (value: number | undefined): number => {
  if (value === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error("SupervisorMessage V2 board page size is invalid");
  }
  return value;
};

const decodeCursor = (
  value: string | undefined,
  scope: TrustedSupervisorMessageV2Scope,
  cursorKey: Uint8Array
): BoardCursor | undefined => {
  if (value === undefined) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (
      !(
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).sort().join(",") ===
          "receivedAt,schema,scopeDigest,signature,snapshotRevision,workflowId" &&
        (parsed as BoardCursor).schema === CURSOR_SCHEMA &&
        typeof (parsed as BoardCursor).receivedAt === "string" &&
        typeof (parsed as BoardCursor).workflowId === "string" &&
        typeof (parsed as BoardCursor).scopeDigest === "string" &&
        typeof (parsed as BoardCursor).signature === "string" &&
        Number.isSafeInteger((parsed as BoardCursor).snapshotRevision) &&
        (parsed as BoardCursor).snapshotRevision >= 0 &&
        (parsed as BoardCursor).scopeDigest === scopeDigest(scope)
      )
    ) {
      throw new Error("invalid");
    }
    const { signature, ...unsigned } = parsed as BoardCursor;
    const expected = Buffer.from(
      cursorSignature(unsigned, cursorKey),
      "base64url"
    );
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.byteLength !== expected.byteLength ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("invalid");
    }
    return parsed as BoardCursor;
  } catch {
    throw new Error("SupervisorMessage V2 board cursor is invalid for scope");
  }
};

const cursorFor = (
  scope: TrustedSupervisorMessageV2Scope,
  item: SupervisorMessageV2BoardItem,
  snapshotRevision: number,
  cursorKey: Uint8Array
): string =>
  (() => {
    const unsigned = {
      receivedAt: item.receivedAt,
      schema: CURSOR_SCHEMA,
      scopeDigest: scopeDigest(scope),
      snapshotRevision,
      workflowId: item.workflowId,
    };
    return Buffer.from(
      canonical({
        ...unsigned,
        signature: cursorSignature(unsigned, cursorKey),
      })
    ).toString("base64url");
  })();

const itemFromRow = (
  row: Pick<BoardRow, "item_json">,
  scope: TrustedSupervisorMessageV2Scope
): SupervisorMessageV2BoardItem => {
  const value =
    typeof row.item_json === "string"
      ? JSON.parse(row.item_json)
      : row.item_json;
  return parseSupervisorMessageV2BoardItem(value, scope);
};

/**
 * A body-free, append-only projection store. It is separate from the A2A SDK
 * TaskStore because SDK task history may contain message content. Reads bind
 * both tenant and authenticated principal in SQL before JSON is loaded.
 */
export class PostgresSupervisorMessageV2ReadStore {
  readonly #cursorKey: Uint8Array;
  readonly #sql: SQL;

  private constructor(sql: SQL, cursorKey: Uint8Array) {
    this.#cursorKey = cursorKey;
    this.#sql = sql;
  }

  static async connect(
    databaseUrl: string,
    options: PostgresSupervisorMessageV2ReadStoreOptions
  ): Promise<PostgresSupervisorMessageV2ReadStore> {
    if (!POSTGRES_URL.test(databaseUrl)) {
      throw new Error(
        "SupervisorMessage V2 board needs an explicit PostgreSQL URL"
      );
    }
    const cursorKey = normalizedCursorKey(options.cursorKey);
    const sql = new SQL(databaseUrl);
    try {
      await sql.connect();
      return new PostgresSupervisorMessageV2ReadStore(sql, cursorKey);
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
      CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_board_revision (
        revision BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        board_item_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        item_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await this.#sql`
      CREATE INDEX IF NOT EXISTS loop_supervisor_message_v2_board_scope_revision_idx
      ON loop_supervisor_message_v2_board_revision
      (tenant_id, principal, revision)
    `;
    await this.#sql`
      CREATE INDEX IF NOT EXISTS loop_supervisor_message_v2_board_scope_workflow_idx
      ON loop_supervisor_message_v2_board_revision
      (tenant_id, principal, workflow_id, revision DESC)
    `;
  }

  async get(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): Promise<SupervisorMessageV2BoardItem | undefined> {
    const trustedScope =
      parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const rows = await this.#sql<BoardRow[]>`
      SELECT board_item_id, item_json, received_at, revision::integer AS revision, workflow_id
      FROM loop_supervisor_message_v2_board_revision
      WHERE tenant_id = ${trustedScope.tenantId}
        AND principal = ${trustedScope.principal}
        AND workflow_id = ${workflowId}
      ORDER BY revision DESC
      LIMIT 1
    `;
    return rows[0] ? itemFromRow(rows[0], trustedScope) : undefined;
  }

  async list(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    options: SupervisorMessageV2BoardListOptions = {}
  ): Promise<SupervisorMessageV2BoardPage> {
    const trustedScope =
      parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const limit = parsePageSize(options.limit);
    const cursor = decodeCursor(options.cursor, trustedScope, this.#cursorKey);
    if (!cursor) {
      return await this.#sql.begin(async (sql) => {
        await sql`
          SELECT pg_advisory_xact_lock(
            hashtext(${supervisorMessageV2BoardScopeLockKey(trustedScope)})
          )
        `;
        return this.#readPage(
          sql,
          trustedScope,
          limit,
          undefined,
          await this.#snapshotRevision(sql, trustedScope)
        );
      });
    }
    return await this.#readPage(
      this.#sql,
      trustedScope,
      limit,
      cursor,
      cursor.snapshotRevision
    );
  }

  async #readPage(
    sql: SQL,
    trustedScope: TrustedSupervisorMessageV2Scope,
    limit: number,
    cursor: BoardCursor | undefined,
    snapshotRevision: number
  ): Promise<SupervisorMessageV2BoardPage> {
    const receivedAt = cursor?.receivedAt ?? null;
    const workflowId = cursor?.workflowId ?? null;
    const rows = await sql<BoardRow[]>`
      WITH current_at_snapshot AS (
        SELECT DISTINCT ON (workflow_id)
          board_item_id, item_json, received_at, revision, workflow_id
        FROM loop_supervisor_message_v2_board_revision
        WHERE tenant_id = ${trustedScope.tenantId}
          AND principal = ${trustedScope.principal}
          AND revision <= ${snapshotRevision}
        ORDER BY workflow_id, revision DESC
      )
      SELECT board_item_id, item_json, received_at, revision::integer AS revision, workflow_id
      FROM current_at_snapshot
      WHERE ${receivedAt}::text IS NULL
        OR received_at < ${receivedAt}
        OR (received_at = ${receivedAt} AND workflow_id > ${workflowId}::text)
      ORDER BY received_at DESC, workflow_id ASC
      LIMIT ${limit + 1}
    `;
    const items = rows
      .slice(0, limit)
      .map((row) => itemFromRow(row, trustedScope));
    const final = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && final
          ? cursorFor(trustedScope, final, snapshotRevision, this.#cursorKey)
          : null,
      schema: "supervisor-message-board-page.v2",
      snapshotRevision,
    };
  }

  async upsert(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    projectionValue: SupervisorMessageV2Projection
  ): Promise<SupervisorMessageV2BoardItem> {
    const trustedScope =
      parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const projection = parseSupervisorMessageV2Projection(
      projectionValue,
      trustedScope
    );
    const item = parseSupervisorMessageV2BoardItem(
      {
        ...projection,
        boardItemId: deriveSupervisorMessageV2BoardItemId(
          trustedScope,
          workflowId
        ),
        schema: "supervisor-message-board-item.v2",
        workflowId,
      },
      trustedScope
    );
    const encoded = canonical(item);
    await this.#sql.begin(async (sql) => {
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${supervisorMessageV2BoardScopeLockKey(trustedScope)})
        )
      `;
      const current = await sql<BoardRow[]>`
        SELECT board_item_id, item_json, received_at, revision::integer AS revision, workflow_id
        FROM loop_supervisor_message_v2_board_revision
        WHERE tenant_id = ${trustedScope.tenantId}
          AND principal = ${trustedScope.principal}
          AND workflow_id = ${workflowId}
        ORDER BY revision DESC
        LIMIT 1
        FOR UPDATE
      `;
      if (
        current[0] &&
        canonical(itemFromRow(current[0], trustedScope)) === encoded
      ) {
        return;
      }
      await sql`
        INSERT INTO loop_supervisor_message_v2_board_revision (
          tenant_id, principal, workflow_id, board_item_id, received_at, item_json
        ) VALUES (
          ${trustedScope.tenantId}, ${trustedScope.principal}, ${workflowId},
          ${item.boardItemId}, ${item.receivedAt}, ${encoded}::jsonb
        )
      `;
    });
    return item;
  }

  async #snapshotRevision(
    sql: SQL,
    scope: TrustedSupervisorMessageV2Scope
  ): Promise<number> {
    const rows = await sql<{ revision: number | null }[]>`
      SELECT MAX(revision)::integer AS revision
      FROM loop_supervisor_message_v2_board_revision
      WHERE tenant_id = ${scope.tenantId} AND principal = ${scope.principal}
    `;
    return rows[0]?.revision ?? 0;
  }
}
