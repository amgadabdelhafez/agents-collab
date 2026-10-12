// `loop token code`: mint an enrollment code through the server's owner
// route. The token service and routes are the production ones (a real
// Ed25519 key and store under a scratch directory) behind a loopback
// listener; the client is the production resolver and enrolled credential.

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "bun";
import { enrollA2ASession } from "../../src/loop/a2a-session-credential";
import {
  createTokenRoutes,
  loadTokenSigningKey,
  OrchestrationTokenService,
  type RoleBinding,
  TokenStore,
  writeOwnerOnlyFile,
  writeTokenSigningKey,
} from "../../src/loop/orchestration-token-service";
import {
  AUTHORITY_DENIED_MESSAGE,
  runTokenCommand,
} from "../../src/loop/token-code-command";

const ROUTE = "/a2a/v2";
const OWNER = "supervisor:tc-owner";
const SUP = "supervisor:tc-sup";
const WORKER = "supervisor:tc-worker";
const TREE = { project: "loop", repoKey: "agents-collab" };
const ROLES: Record<string, RoleBinding> = {
  [OWNER]: { project: "all", repoKey: "estate", role: "owner" },
  [SUP]: { ...TREE, role: "supervisor" },
  [WORKER]: { ...TREE, role: "worker" },
};

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "token-code-")));
  roots.push(root);
  return root;
};

/** The production token routes; records each request path and every code minted. */
const tokenServer = (root: string) => {
  const keyFile = join(root, "signing.pem");
  writeTokenSigningKey(keyFile);
  const service = new OrchestrationTokenService({
    bindings: new Map(Object.entries(ROLES)),
    key: loadTokenSigningKey(keyFile),
    store: new TokenStore(join(root, "tokens")),
  });
  const routes = createTokenRoutes(service);
  const paths: string[] = [];
  const minted: string[] = [];
  const server = serve({
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      const response = (await routes(request, path)) as Response;
      if (path.endsWith("/enrollment-codes") && response.ok) {
        const body = (await response.clone().json()) as {
          data: { code: string };
        };
        minted.push(body.data.code);
      }
      return response;
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  cleanups.push(() => server.stop(true));
  const origin = `http://127.0.0.1:${server.port}`;
  return { minted, origin, paths, service };
};

/** A session's machine with `as` enrolled through a host-minted code. */
const enrolledMachine = async (
  server: ReturnType<typeof tokenServer>,
  as: string
) => {
  const home = scratch();
  const configPath = join(home, "orchestration.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      a2aV2: { routePath: ROUTE },
      origin: server.origin,
      supervisors: Object.entries(ROLES).map(([supervisorId, role]) => ({
        role,
        supervisorId,
      })),
    }),
    { mode: 0o600 }
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    LOOP_ORCHESTRATION_CONFIG: configPath,
  };
  const codeFile = join(home, "enroll.code");
  writeOwnerOnlyFile(
    codeFile,
    `${server.service.issueEnrollmentCode({ kind: "host" }, as).code}\n`
  );
  await enrollA2ASession({
    codeFile,
    env,
    origin: server.origin,
    role: ROLES[as] as RoleBinding,
    supervisorId: as,
  });
  server.paths.length = 0;
  return { env, home };
};

/** Runs the command with stdout/stderr captured, as the CLI prints it. */
const run = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const output: string[] = [];
  const original = {
    error: console.error,
    log: console.log,
    stderr: process.stderr.write,
    stdout: process.stdout.write,
  };
  const capture = (chunk: unknown): boolean => {
    output.push(String(chunk));
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  console.error = (...args: unknown[]) => output.push(args.join(" "));
  let error: Error | undefined;
  try {
    for (const line of await runTokenCommand(argv, {
      env,
      log: (line) => output.push(line),
    })) {
      process.stdout.write(`${line}\n`);
    }
  } catch (caught) {
    error = caught as Error;
    output.push(error.message, String(error.stack));
  } finally {
    process.stdout.write = original.stdout;
    process.stderr.write = original.stderr;
    console.log = original.log;
    console.error = original.error;
  }
  return { error, text: output.join("\n") };
};

const argv = (as: string, out: string): string[] => [
  "token",
  "code",
  "--as",
  as,
  "--for",
  WORKER,
  "--out",
  out,
];

describe("loop token code", () => {
  test("an owner session mints: the code lands in a new 0600 file and is never printed", async () => {
    const server = tokenServer(scratch());
    const machine = await enrolledMachine(server, OWNER);
    const out = join(machine.home, "worker.code");
    const result = await run(argv(OWNER, out), machine.env);
    expect(result.error).toBeUndefined();
    expect(server.minted).toHaveLength(1);
    const code = server.minted[0] as string;
    expect(readFileSync(out, "utf8")).toBe(`${code}\n`);
    // biome-ignore lint/suspicious/noBitwiseOperators: mode bits
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(result.text).toContain(`enrollment code for ${WORKER} written to`);
    expect(result.text).toMatch(/expires \d{4}-\d{2}-\d{2}T/);
    expect(result.text).not.toContain(code);
    // The minted code is a real one: it enrolls the worker.
    expect(server.service.enroll(code)?.token).toBeString();
  });

  test("an existing --out is refused before anything is minted, and left as it was", async () => {
    const server = tokenServer(scratch());
    const machine = await enrolledMachine(server, OWNER);
    const out = join(machine.home, "taken.code");
    writeFileSync(out, "keep me\n", { mode: 0o644 });
    const result = await run(argv(OWNER, out), machine.env);
    expect(result.error?.message).toContain("already exists");
    expect(readFileSync(out, "utf8")).toBe("keep me\n");
    expect(server.paths).not.toContain("/api/v1/tokens/enrollment-codes");
    expect(server.minted).toHaveLength(0);
  });

  test("a supervisor session's 403 authority-denied maps to the authority message and writes nothing", async () => {
    const server = tokenServer(scratch());
    const machine = await enrolledMachine(server, SUP);
    const out = join(machine.home, "denied.code");
    const result = await run(argv(SUP, out), machine.env);
    expect(server.paths).toContain("/api/v1/tokens/enrollment-codes");
    expect(result.error?.message).toContain(AUTHORITY_DENIED_MESSAGE);
    expect(() => statSync(out)).toThrow();
    expect(server.minted).toHaveLength(0);
  });
});
