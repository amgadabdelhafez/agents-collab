import type { Plugin } from "vite";

export interface ExactHostRequest {
  readonly host?: string;
  readonly url?: string;
}

export interface ExactHostRejection {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: 403;
}

const REJECTION_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

const REJECTION_BODY = JSON.stringify({
  code: "HOST_REJECTED",
  error: "Host rejected",
});

export function handleExactHostRequest(
  request: ExactHostRequest,
  expectedHosts: readonly string[]
): ExactHostRejection | undefined {
  if (request.host && expectedHosts.includes(request.host)) {
    return undefined;
  }
  return {
    body: REJECTION_BODY,
    headers: REJECTION_HEADERS,
    status: 403,
  };
}

interface MiddlewareStack {
  use(
    handler: (
      request: {
        readonly headers: Readonly<
          Record<string, string | string[] | undefined>
        >;
        readonly url?: string;
      },
      response: {
        end(body?: string): void;
        setHeader(name: string, value: string): void;
        statusCode: number;
      },
      next: () => void
    ) => void
  ): void;
}

function installExactHostGuard(
  middlewares: MiddlewareStack,
  expectedHosts: readonly string[]
): void {
  middlewares.use((request, response, next) => {
    const rejection = handleExactHostRequest(
      {
        host:
          typeof request.headers.host === "string"
            ? request.headers.host
            : undefined,
        url: request.url,
      },
      expectedHosts
    );
    if (!rejection) {
      next();
      return;
    }
    response.statusCode = rejection.status;
    for (const [name, value] of Object.entries(rejection.headers)) {
      response.setHeader(name, value);
    }
    response.end(rejection.body);
  });
}

export const exactHostGuardPlugin = (
  expectedHosts: readonly string[]
): Plugin => ({
  configurePreviewServer(server) {
    installExactHostGuard(server.middlewares, expectedHosts);
  },
  configureServer(server) {
    installExactHostGuard(server.middlewares, expectedHosts);
  },
  enforce: "pre",
  name: "loop-exact-host-guard",
});
