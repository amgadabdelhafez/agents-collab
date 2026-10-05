import {
  type A2ARequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";

const DEFAULT_PATHNAME = "/a2a";
const MAX_BODY_BYTES = 64 * 1024;
const PRINCIPAL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

/**
 * Structural match for the existing control-surface authenticator. Keeping
 * this edge dependency-free lets the A2A module compile independently while a
 * future server can pass its existing `SupervisorControlSurfaceAuthenticator`
 * without an adapter or another authentication policy.
 */
export interface SupervisorA2AAuthenticatedIdentity {
  principal: string;
  supervisorId: string;
}

export interface SupervisorA2AAuthenticator {
  authenticate(
    request: Request
  ):
    | Promise<SupervisorA2AAuthenticatedIdentity | undefined>
    | SupervisorA2AAuthenticatedIdentity
    | undefined;
}

export interface SupervisorA2AHttpOptions {
  /** Reuses the existing control-surface authentication boundary. */
  authenticator: SupervisorA2AAuthenticator;
  /** The protocol handler whose TaskStore/executor are already composed. */
  handler: A2ARequestHandler;
  pathname?: string;
  /** A route-bound tenant selected by the hosting control plane, never by JSON. */
  tenant: string;
}

const json = (
  status: number,
  value: unknown,
  headers?: HeadersInit
): Response =>
  Response.json(value, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    status,
  });

const jsonRpcError = (
  id: string | number | null,
  code: number,
  message: string
): Record<string, unknown> => ({
  error: { code, message },
  id,
  jsonrpc: "2.0",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestIdOf = (value: unknown): string | number | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  return typeof id === "string" ||
    (typeof id === "number" && Number.isInteger(id))
    ? id
    : null;
};

const contentTypeIsJson = (request: Request): boolean => {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || mediaType === "application/a2a+json"
  );
};

const verifiedPrincipal = (
  identity: SupervisorA2AAuthenticatedIdentity | undefined
): string | undefined => {
  if (!(identity && PRINCIPAL_RE.test(identity.principal))) {
    return undefined;
  }
  return identity.principal;
};

/**
 * The SDK's JSON-RPC transport treats a truthy `params.tenant` as a command to
 * call `context.setTenant`. This adapter has already fixed a tenant from its
 * authenticated route, so it validates a caller-supplied tenant and injects
 * the route-bound value before the maintained SDK sees it. A fresh context is
 * intentionally tenant-unset here: the SDK then performs its normal one-time
 * `setTenant` from the normalized request.
 */
const normalizeRouteBoundTenant = (
  rawBody: string,
  tenant: string
):
  | { kind: "sdk"; body: string | Record<string, unknown> }
  | { id: string | number | null; kind: "tenant-error" } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Let the maintained SDK emit the standard JSON-RPC parse error.
    return { body: rawBody, kind: "sdk" };
  }
  if (!(isRecord(parsed) && isRecord(parsed.params))) {
    return { body: parsed as Record<string, unknown>, kind: "sdk" };
  }
  if ("tenant" in parsed.params && parsed.params.tenant !== tenant) {
    return { id: requestIdOf(parsed), kind: "tenant-error" };
  }
  return {
    body: { ...parsed, params: { ...parsed.params, tenant } },
    kind: "sdk",
  };
};

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

/**
 * A deliberately thin Bun request/response adapter around the maintained A2A
 * SDK JSON-RPC handler. It is reusable by a future control-plane server, but
 * this module itself publishes no listener, Agent Card, or live route.
 *
 * It supports non-streaming requests only. The agent card remains
 * `streaming:false`; any future SSE/reconnect support must be separately
 * backed by Temporal state transitions and a durable event/cursor design.
 */
export const createSupervisorA2AHttpHandler = (
  options: SupervisorA2AHttpOptions
): ((request: Request) => Promise<Response>) => {
  const pathname = options.pathname ?? DEFAULT_PATHNAME;
  if (!options.tenant.trim()) {
    throw new Error("A2A route tenant is required");
  }
  const transport = new JsonRpcTransportHandler(options.handler);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== pathname) {
      return json(404, { error: { code: "not-found" } });
    }
    if (request.method !== "POST") {
      return json(
        405,
        { error: { code: "method-not-allowed" } },
        { allow: "POST" }
      );
    }
    if (!contentTypeIsJson(request)) {
      return json(415, { error: { code: "content-type-invalid" } });
    }
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json(413, { error: { code: "body-too-large" } });
    }

    // Authenticate before parsing/dispatching protocol parameters and before
    // the SDK can allocate a task context or call its TaskStore.
    let principal: string | undefined;
    try {
      principal = verifiedPrincipal(
        await options.authenticator.authenticate(request)
      );
    } catch {
      return json(500, { error: { code: "authentication-failed" } });
    }
    if (!principal) {
      return json(401, { error: { code: "unauthenticated" } });
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json(413, { error: { code: "body-too-large" } });
    }
    const normalized = normalizeRouteBoundTenant(rawBody, options.tenant);
    if (normalized.kind === "tenant-error") {
      return json(
        400,
        jsonRpcError(normalized.id, -32_602, "request tenant is not authorized")
      );
    }

    const context = new ServerCallContext({
      user: { isAuthenticated: true, userName: principal },
    });
    const response = await transport.handle(normalized.body, context);
    if (isAsyncIterable(response)) {
      // The SDK should have rejected this through the card capability gate. If
      // a future handler changes that invariant without an SSE adapter, fail
      // closed rather than silently buffering or claiming streaming support.
      return json(
        501,
        jsonRpcError(
          null,
          -32_600,
          "streaming is not configured for this route"
        )
      );
    }
    return json(200, response);
  };
};
