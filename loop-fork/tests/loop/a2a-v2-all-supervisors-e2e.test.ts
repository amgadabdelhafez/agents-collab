// r9 T5: every configured supervisor as an A2A V2 recipient, end to end.
//
// The real orchestration server (runLoopOrchestrationServer) on a local
// Temporal dev server and a task-owned Docker PostgreSQL, with the real T1
// lease store, T2 endpoint delivery, T3 routes and T4 clients (`loop a2a`).
// Only the sessions' external processes are scripted: two Loop run
// directories (a Claude seat and a Codex thread) and one standalone Claude
// channel session directory, whose readiness probes and Codex injection are
// replaced by in-test effects, and whose Claude bridge queue is read by an
// in-test poller exactly as the channel server marks an entry delivered.
// Nothing here reaches the operator's live state: the server home, run and
// session roots, mailboxes and config are under one temp directory.

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { serve } from "bun";
import {
  A2AClientError,
  claimA2ASession,
  resolveA2AClientEndpoint,
} from "../../src/loop/a2a-session-client";
import { runA2ACommand } from "../../src/loop/a2a-session-command";
import { canonicalSupervisorA2AIdentity } from "../../src/loop/a2a-supervisor-adapter";
import { missingA2AV2GrantPairs } from "../../src/loop/a2a-v2-init";
import { acknowledgeBridgeDelivery } from "../../src/loop/bridge-dispatch";
import {
  markBridgeMessage,
  readPendingBridgeMessages,
  writeBridgeSessionRecord,
} from "../../src/loop/bridge-store";
import {
  defaultA2AV2EndpointFactories,
  runLoopOrchestrationServer,
} from "../../src/loop/loop-orchestration-server";
import { callRecipientRoute } from "../../src/loop/recipient-api-client";
import {
  createRunManifest,
  type RunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";
import { supervisorEndpointRoots } from "../../src/loop/supervisor-endpoint-lease";
import {
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  SupervisorResultGraphKey,
} from "../../src/loop/supervisor-message-v2-contract";
import { createSupervisorEndpointKindAdapters } from "../../src/loop/supervisor-message-v2-endpoint-delivery";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";
import { DisposablePostgres } from "../support/disposable-postgres";

let postgres: DisposablePostgres;
let temporal: TestWorkflowEnvironment;

beforeAll(async () => {
  postgres = await DisposablePostgres.create();
  temporal = await TestWorkflowEnvironment.createLocal();
}, 180_000);

afterAll(async () => {
  await temporal?.teardown();
  await postgres?.close();
});

const CONTROL = "principal:r9-control";
const OTHER = "principal:r9-other";
const CLAUDE_RUN = "supervisor:r9-claude-run";
const CODEX_RUN = "supervisor:r9-codex-run";
const CHANNEL = "supervisor:r9-channel";
/** Configured with a mailbox, never claims a session, another principal. */
const OUTSIDER = "supervisor:r9-outsider";
const SESSION_SUPERVISORS = [CLAUDE_RUN, CODEX_RUN, CHANNEL] as const;
const PRINCIPAL_OF: Record<string, string> = {
  [CHANNEL]: CONTROL,
  [CLAUDE_RUN]: CONTROL,
  [CODEX_RUN]: CONTROL,
  [OUTSIDER]: OTHER,
};
const TOKEN_ENV_OF: Record<string, string> = {
  [CHANNEL]: "R9_E2E_CHANNEL_TOKEN",
  [CLAUDE_RUN]: "R9_E2E_CLAUDE_RUN_TOKEN",
  [CODEX_RUN]: "R9_E2E_CODEX_RUN_TOKEN",
  [OUTSIDER]: "R9_E2E_OUTSIDER_TOKEN",
};
const REPO = "repo-r9-e2e";
const CLAUDE_RUN_ID = "run-claude";
const CODEX_RUN_ID = "run-codex";
const CHANNEL_SESSION = "chan-session-1";
const CHANNEL_CLAUDE_SESSION = "chan-claude-1";
const CODEX_URL = "ws://127.0.0.1:4500";
const CODEX_THREAD = "thread-r9-1";
const SESSION_TTL_MS = 4000;
const NOT_ENROLLED_BOUND_MS = 3000;
const ARTIFACT_PATH = "loop-fork/src/loop/workflow-port.ts";
/** The panes a paired run's manifest declares (no tmux is touched). */
const PAIRED_PANES = {
  tmuxPaneLeft: "%1",
  tmuxPaneLeftAgent: "claude" as const,
  tmuxPaneRight: "%2",
  tmuxPaneRightAgent: "codex" as const,
};

const freePort = (): number => {
  const probe = serve({
    fetch: () => new Response(null),
    hostname: "127.0.0.1",
    port: 0,
  });
  const port = probe.port;
  probe.stop(true);
  if (!port) {
    throw new Error("no free loopback port");
  }
  return port;
};

const waitFor = async <T>(
  label: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The id the server mints for a send (legacy format, the owner's default). */
const workflowIdFor = (
  tenant: string,
  from: string,
  to: string,
  messageId: string
): string => {
  const principal = PRINCIPAL_OF[from] as string;
  const { dedupeKey } = canonicalSupervisorA2AIdentity({
    contextId: messageId,
    messageId,
    principal,
    supervisorId: to,
    tenant,
  });
  return deriveSupervisorMessageV2LegacyWorkflowId(
    { principal, tenantId: tenant },
    dedupeKey
  );
};

/** The committed bytes a published result's artifact is checked against. */
const committedArtifact = () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const git = (args: string[]) =>
    execFileSync("git", [
      "--no-replace-objects",
      "-C",
      repositoryRoot,
      ...args,
    ]);
  const commit = git(["rev-parse", "HEAD"]).toString().trim();
  const bytes = git(["show", `${commit}:${ARTIFACT_PATH}`]);
  return {
    artifactRef: `artifact://sha256/${createHash("sha256").update(bytes).digest("hex")}`,
    commit,
    repositoryRoot,
  };
};

const graphInput = (artifactRef: string) => ({
  schema: "task-graph.v1",
  graphId: "r9-e2e-result",
  nodes: [
    {
      taskId: "result-node",
      acceptanceChecks: [{ checkId: "artifact", kind: "artifact" }],
      authorityGates: [],
      dependencies: [],
      ownerRepository: "agents-collab",
      readScopes: ["src"],
      writeScopes: [],
      specArtifactRef: artifactRef,
    },
  ],
});

interface Fixture {
  channelDir: string;
  claudeRunDir: string;
  codexRunDir: string;
  configPath: string;
  env: Record<string, string>;
  home: string;
  mailboxOf(supervisorId: string): string;
  port: number;
  remove(): void;
  root: string;
  runStorage(runId: string): RunStorage;
  taskQueue: string;
  tenant: string;
}

const fixture = (input: {
  /** Six (sender, recipient, messageId) sends whose result graphs to allow. */
  completions?: readonly { from: string; messageId: string; to: string }[];
  databaseUrl: string;
  secret?: string;
}): Fixture => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "r9-e2e-")));
  const home = join(root, "home");
  const roots = supervisorEndpointRoots(home);
  const tenant = `tenant:r9-e2e-${randomUUID().slice(0, 8)}`;
  const taskQueue = `r9-e2e-${randomUUID().slice(0, 8)}`;
  const runDirOf = (runId: string) => join(roots.runsRoot, REPO, runId);
  const runStorage = (runId: string): RunStorage => ({
    manifestPath: join(runDirOf(runId), "manifest.json"),
    repoId: REPO,
    runDir: runDirOf(runId),
    runId,
    storageRoot: roots.runsRoot,
    transcriptPath: join(runDirOf(runId), "transcript.jsonl"),
  });
  const claudeRunDir = runDirOf(CLAUDE_RUN_ID);
  const codexRunDir = runDirOf(CODEX_RUN_ID);
  mkdirSync(claudeRunDir, { recursive: true });
  mkdirSync(codexRunDir, { recursive: true });
  writeRunManifest(
    runStorage(CLAUDE_RUN_ID).manifestPath,
    createRunManifest({
      claudeSessionId: "claude-run-session-1",
      cwd: root,
      mode: "paired",
      pid: process.pid,
      primaryAgent: "claude",
      repoId: REPO,
      runId: CLAUDE_RUN_ID,
      state: "working",
      // A paired run declares its panes; the seat must be one of them.
      ...PAIRED_PANES,
    })
  );
  writeRunManifest(
    runStorage(CODEX_RUN_ID).manifestPath,
    createRunManifest({
      codexRemoteUrl: CODEX_URL,
      codexThreadId: CODEX_THREAD,
      cwd: root,
      mode: "paired",
      pid: process.pid,
      primaryAgent: "codex",
      repoId: REPO,
      runId: CODEX_RUN_ID,
      state: "working",
      ...PAIRED_PANES,
    })
  );
  const channelDir = join(roots.sessionsRoot, "r9-channel", CHANNEL_SESSION);
  writeBridgeSessionRecord(channelDir, {
    claudeChannelServer: "loop-bridge-r9-channel",
    claudeSessionId: CHANNEL_CLAUDE_SESSION,
  });
  const mailboxOf = (supervisorId: string) =>
    join(root, "mail", `${supervisorId.slice("supervisor:".length)}.jsonl`);
  const supervisors = [CLAUDE_RUN, CODEX_RUN, CHANNEL, OUTSIDER].map(
    (supervisorId) => ({
      mailbox: mailboxOf(supervisorId),
      principal: PRINCIPAL_OF[supervisorId],
      supervisorId,
      tokenEnv: TOKEN_ENV_OF[supervisorId],
    })
  );
  const pair = (principal: string, from: string, to: string) => ({
    from,
    operations: ["acknowledge", "claim", "receive"],
    principal,
    to,
  });
  const grants = [
    ...SESSION_SUPERVISORS.flatMap((from) =>
      SESSION_SUPERVISORS.filter((to) => to !== from).map((to) =>
        pair(CONTROL, from, to)
      )
    ),
    pair(CONTROL, CLAUDE_RUN, OUTSIDER),
    pair(OTHER, OUTSIDER, CHANNEL),
  ];
  const secret = input.secret ?? randomBytes(32).toString("hex");
  const key = SupervisorResultGraphKey.fromSecret(secret);
  const artifact = committedArtifact();
  const port = freePort();
  const configPath = join(root, "orchestration.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      // The r9 `a2a-v2 init` shape without --manifest: no recipient, the
      // control principal, legacy workflow ids.
      a2aV2: {
        databaseUrlEnv: "R9_E2E_DATABASE_URL",
        endpointRef: "endpoint:loop-run",
        notEnrolledBoundMs: NOT_ENROLLED_BOUND_MS,
        policy: {
          claimTimeoutMs: 120_000,
          escalationTimeoutMs: 240_000,
          // The workflow's own ceiling (the config parser accepts up to 100).
          maxDeliveryAttempts: 20,
          retryDelayMs: 1000,
        },
        principal: CONTROL,
        resultGraphKeyEnv: "R9_E2E_RESULT_GRAPH_KEY",
        ...(input.completions?.length
          ? {
              resultArtifacts: input.completions.map((send) => ({
                artifactRef: artifact.artifactRef,
                commit: artifact.commit,
                graphTaskId: "result-node",
                graphWorkflowId: deriveSupervisorMessageV2ResultGraphWorkflowId(
                  key,
                  {
                    principal: PRINCIPAL_OF[send.from] as string,
                    tenantId: tenant,
                  },
                  workflowIdFor(tenant, send.from, send.to, send.messageId)
                ),
                path: ARTIFACT_PATH,
                repositoryRoot: artifact.repositoryRoot,
              })),
            }
          : {}),
        routePath: "/a2a/v2",
        sessionTtlMs: SESSION_TTL_MS,
        tenant,
        workflowIdFormat: "legacy",
      },
      address: temporal.address,
      buildId: "r9-all-supervisors-e2e.v1",
      grants,
      hostname: "127.0.0.1",
      identity: "loop-orchestration@r9-e2e",
      namespace: "default",
      port,
      schema: "loop-orchestration-server.v1",
      stateDir: join(root, "state"),
      supervisors,
      taskQueue,
    })
  );
  const env: Record<string, string> = {
    HOME: home,
    LOOP_ORCHESTRATION_CONFIG: configPath,
    R9_E2E_DATABASE_URL: input.databaseUrl,
    R9_E2E_RESULT_GRAPH_KEY: secret,
  };
  for (const tokenEnv of Object.values(TOKEN_ENV_OF)) {
    env[tokenEnv] = randomUUID();
  }
  return {
    channelDir,
    claudeRunDir,
    codexRunDir,
    configPath,
    env,
    home,
    mailboxOf,
    port,
    remove: () => rmSync(root, { force: true, recursive: true }),
    root,
    runStorage,
    taskQueue,
    tenant,
  };
};

const mailboxWorkflowIds = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => String(JSON.parse(line).workflowId))
    : [];

/** The scripted sessions: liveness, and what each one received. */
const scriptedSessions = (f: Fixture) => {
  const alive = new Set<string>();
  const received = new Map<string, Set<string>>();
  const receive = (supervisorId: string, workflowId: string) => {
    const seen = received.get(supervisorId) ?? new Set<string>();
    seen.add(workflowId);
    received.set(supervisorId, seen);
  };
  // The Claude seat and the channel session read their bridge queue as the
  // channel server does: an entry it pushed is marked delivered.
  const claudeQueues: [string, string][] = [
    [CLAUDE_RUN, f.claudeRunDir],
    [CHANNEL, f.channelDir],
  ];
  const poller = setInterval(() => {
    for (const [supervisorId, dir] of claudeQueues) {
      if (!alive.has(dir)) {
        continue;
      }
      for (const entry of readPendingBridgeMessages(dir)) {
        if (entry.source === "supervisor" && entry.target === "claude") {
          markBridgeMessage(dir, entry, "delivered", "scripted channel read");
          receive(supervisorId, String(entry.taskId));
        }
      }
    }
  }, 100);
  const adapters = () =>
    createSupervisorEndpointKindAdapters({
      claudeProbe: (dir) => alive.has(dir),
      codexDeliver: (runDir, entry) => {
        if (!alive.has(runDir)) {
          return Promise.resolve(false);
        }
        acknowledgeBridgeDelivery(runDir, entry, "scripted codex accepted");
        receive(CODEX_RUN, String(entry.taskId));
        return Promise.resolve(true);
      },
      codexProbe: (remoteUrl, threadId) =>
        Promise.resolve(
          alive.has(f.codexRunDir) &&
            remoteUrl === CODEX_URL &&
            threadId === CODEX_THREAD
        ),
      loopRunRouteReady: (route) => alive.has(route.runDir),
    });
  return {
    adapters,
    alive,
    received: (supervisorId: string) => [...(received.get(supervisorId) ?? [])],
    stop: () => clearInterval(poller),
  };
};

const startServer = (
  f: Fixture,
  signal: AbortSignal,
  adapters?: () => ReturnType<typeof createSupervisorEndpointKindAdapters>
) => {
  const running = runLoopOrchestrationServer(f.configPath, f.env, {
    a2aV2EndpointRoots: supervisorEndpointRoots(f.home),
    a2aV2Endpoints: {
      ...defaultA2AV2EndpointFactories,
      ...(adapters ? { adapters } : {}),
    },
    signal,
  });
  const failed = running.then(
    () => "server stopped before it became ready",
    (error: unknown) =>
      `server failed: ${error instanceof Error ? error.message : String(error)}`
  );
  const ready = Promise.race([
    failed,
    waitFor("the server to report ready", async () => {
      const response = await fetch(`http://127.0.0.1:${f.port}/healthz`).catch(
        () => undefined
      );
      const body = (await response?.json().catch(() => undefined)) as
        | { state?: string }
        | undefined;
      return body?.state === "ready" ? "ready" : undefined;
    }),
  ]);
  return { ready, running };
};

const health = async (f: Fixture): Promise<Record<string, unknown>> =>
  (await (await fetch(`http://127.0.0.1:${f.port}/healthz`)).json()) as Record<
    string,
    unknown
  >;

/** /healthz carries counts and states only: no id of any kind. */
const expectNoIds = (body: unknown, ids: readonly string[]) => {
  const text = JSON.stringify(body);
  for (const fragment of [
    "supervisor:",
    "principal:",
    "tenant:",
    "supervisor-message",
    "session:",
    ...ids,
  ]) {
    expect(text).not.toContain(fragment);
  }
};

const a2a = (f: Fixture, argv: string[], body?: string) =>
  runA2ACommand(["a2a", ...argv], {
    env: f.env,
    ...(body === undefined ? {} : { readBody: () => body }),
    resolveRunStorage: (runId) => f.runStorage(runId),
  });

const send = async (
  f: Fixture,
  from: string,
  to: string,
  messageId: string
): Promise<string> => {
  const receipt = await a2a(
    f,
    [
      "send",
      "--as",
      from,
      "--to",
      to,
      "--body-file",
      "/dev/null/unused",
      "--message-id",
      messageId,
    ],
    `r9 e2e ${messageId} from ${from} to ${to}`
  );
  expect(receipt).toMatchObject({
    accepted: true,
    action: "send",
    to,
    workResultCompleted: false,
  });
  // The server minted exactly the legacy id derived from the sender's scope.
  expect(receipt.workflowId).toBe(workflowIdFor(f.tenant, from, to, messageId));
  return String(receipt.workflowId);
};

const status = (f: Fixture, from: string, workflowId: string) =>
  a2a(f, ["status", "--as", from, "--message-id", workflowId]);

/**
 * Waits until the sender's status shows the delivery recorded. A Claude
 * session sees a pushed entry (and a mailbox reader its envelope) before the
 * message workflow records the delivery on its next attempt; a recipient
 * claim before that is refused, so the scripted recipient acknowledges only
 * after it.
 */
const deliveredTo = (f: Fixture, from: string, workflowId: string) =>
  waitFor(`${workflowId} recorded delivered`, async () => {
    const current = await status(f, from, workflowId);
    return current.deliveredAt ? current : undefined;
  });

const ack = (f: Fixture, recipient: string, workflowId: string) =>
  a2a(f, ["ack", "--as", recipient, "--workflow", workflowId]);

const token = (f: Fixture, supervisorId: string) =>
  f.env[TOKEN_ENV_OF[supervisorId] as string] as string;

/** A V1 message to the mailbox-only id, through the V1 control surface. */
const sendV1 = async (f: Fixture, id: string) => {
  const response = await fetch(
    `http://127.0.0.1:${f.port}/api/v1/supervisor-messages/receive`,
    {
      body: JSON.stringify({
        input: {
          artifactRefs: [],
          body: "r9: V1 keeps working",
          dedupeKey: id,
          from: CLAUDE_RUN,
          messageId: id,
          policy: {
            claimTimeoutMs: 60_000,
            escalationTimeoutMs: 120_000,
            maxDeliveryAttempts: 3,
            retryDelayMs: 1000,
          },
          receivedAt: new Date().toISOString(),
          threadId: `thread-${id}`,
          to: OUTSIDER,
        },
        messageKind: "question",
        requestId: `receive-${id}`,
      }),
      headers: {
        authorization: `Bearer ${token(f, CLAUDE_RUN)}`,
        "content-type": "application/json",
      },
      method: "POST",
    }
  );
  expect(response.status).toBe(200);
  await waitFor("the V1 message in the mailbox", () =>
    existsSync(f.mailboxOf(OUTSIDER)) &&
    readFileSync(f.mailboxOf(OUTSIDER), "utf8").includes(id)
      ? true
      : undefined
  );
};

const post = (f: Fixture, as: string, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${f.port}${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token(f, as)}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

test("every configured supervisor is an A2A V2 recipient: six directed sends delivered, acknowledged and completed; release, mailbox, reclaim; a fenced competing claim; bounded expiry; a session-less id's mailbox", async () => {
  const sends = SESSION_SUPERVISORS.flatMap((from) =>
    SESSION_SUPERVISORS.filter((to) => to !== from).map((to) => ({
      from,
      messageId: `r9-${from.slice(14)}-to-${to.slice(14)}`,
      to,
    }))
  );
  expect(sends).toHaveLength(6);
  const secret = randomBytes(32).toString("hex");
  const f = fixture({
    completions: sends,
    databaseUrl: postgres.databaseUrl(),
    secret,
  });
  const sessions = scriptedSessions(f);
  const errors = spyOn(console, "error");
  const logged = (fragment: string) =>
    errors.mock.calls.some(([line]) => String(line).includes(fragment));
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  const ownedWorkflowIds = new Set<string>();
  try {
    // init's grant report: every pair of the three session supervisors holds
    // receive, claim and acknowledge under the sender's principal.
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    expect(
      missingA2AV2GrantPairs(
        config.supervisors.filter((entry: { supervisorId: string }) =>
          (SESSION_SUPERVISORS as readonly string[]).includes(
            entry.supervisorId
          )
        ),
        config.grants
      )
    ).toEqual([]);

    const started = startServer(f, stop.signal, sessions.adapters);
    running = started.running;
    expect(await started.ready).toBe("ready");
    expect(await health(f)).toMatchObject({ a2aV2: "ready", state: "ready" });

    // Enroll: a Loop run's Claude seat, a Loop run's Codex thread and a
    // standalone Claude channel session, each by ids only, through `loop a2a`.
    for (const dir of [f.claudeRunDir, f.codexRunDir, f.channelDir]) {
      sessions.alive.add(dir);
    }
    const enrolled = [
      await a2a(f, [
        "enroll",
        "--as",
        CLAUDE_RUN,
        "--kind",
        "loop-run",
        "--run",
        CLAUDE_RUN_ID,
        "--seat",
        "claude",
      ]),
      await a2a(f, [
        "enroll",
        "--as",
        CODEX_RUN,
        "--kind",
        "codex-thread",
        "--run",
        CODEX_RUN_ID,
      ]),
      await a2a(f, [
        "enroll",
        "--as",
        CHANNEL,
        "--kind",
        "claude-channel",
        "--session",
        CHANNEL_SESSION,
        "--provider-session",
        CHANNEL_CLAUDE_SESSION,
      ]),
    ];
    expect(
      enrolled.map((entry) => (entry.receipt as { kind: string }).kind)
    ).toEqual(["loop-run", "codex-thread", "claude-channel"]);

    // 1. All six directed sends: delivered to the live session (never the
    // mailbox), acknowledged, then completed by a published result.
    const workflowIds = new Map<string, string>();
    for (const entry of sends) {
      workflowIds.set(
        entry.messageId,
        await send(f, entry.from, entry.to, entry.messageId)
      );
    }
    for (const entry of sends) {
      const workflowId = workflowIds.get(entry.messageId) as string;
      ownedWorkflowIds.add(workflowId);
      await waitFor(`${entry.messageId} to reach ${entry.to}`, () =>
        sessions.received(entry.to).includes(workflowId) ? true : undefined
      );
      const delivered = await waitFor(
        `${entry.messageId} delivered`,
        async () => {
          const current = await status(f, entry.from, workflowId);
          return current.deliveredAt ? current : undefined;
        }
      );
      expect(delivered).toMatchObject({
        acknowledgedAt: null,
        to: entry.to,
        workResultCompleted: false,
      });
    }
    for (const supervisorId of SESSION_SUPERVISORS) {
      expect(mailboxWorkflowIds(f.mailboxOf(supervisorId))).toEqual([]);
    }
    for (const entry of sends) {
      const workflowId = workflowIds.get(entry.messageId) as string;
      // Another recipient cannot acknowledge it.
      const intruder = SESSION_SUPERVISORS.find(
        (id) => id !== entry.to && id !== entry.from
      ) as string;
      await expect(ack(f, intruder, workflowId)).rejects.toThrow("ack refused");
      expect(await ack(f, entry.to, workflowId)).toMatchObject({
        acknowledged: [{ phase: "acknowledged", workflowId }],
        workResultCompleted: false,
      });
      const acknowledged = await status(f, entry.from, workflowId);
      expect(acknowledged.acknowledgedAt).toBeString();
      expect(acknowledged.deliveredAt).toBeString();
      // A read acknowledgement is not completion.
      expect(acknowledged.workResultCompleted).toBe(false);
    }
    const workflows = new TemporalWorkflowPort(temporal.client.workflow, {
      taskQueue: f.taskQueue,
    });
    const { artifactRef } = committedArtifact();
    for (const entry of sends) {
      const messageWorkflowId = workflowIds.get(entry.messageId) as string;
      const beforeResult = await status(f, entry.from, messageWorkflowId);
      expect(beforeResult.taskState).not.toBe("TASK_STATE_COMPLETED");
      const started = await post(f, entry.from, "/a2a/v2/result-graph", {
        input: graphInput(artifactRef),
        messageWorkflowId,
        requestId: `r9-graph-${entry.messageId}`,
      });
      expect(started.status).toBe(200);
      const { graphWorkflowId } = (await started.json()) as {
        graphWorkflowId: string;
      };
      ownedWorkflowIds.add(graphWorkflowId);
      const taskId = await a2aTaskIdOf(f, entry.from, messageWorkflowId);
      const bound = await post(f, entry.from, "/a2a/v2/assignment", {
        a2aTaskId: taskId,
        graphTaskId: "result-node",
        graphWorkflowId,
        messageWorkflowId,
        recipient: entry.to,
      });
      expect(bound.status).toBe(200);
      for (const [name, requestId] of [
        ["claim", "claim"],
        ["start", "running"],
      ] as const) {
        await workflows.signal({
          name,
          payload: { taskId: "result-node", workerId: entry.to },
          requestId: `r9-${requestId}-${entry.messageId}`,
          workflowId: graphWorkflowId,
        });
      }
      await workflows.signal({
        name: "complete",
        payload: {
          receipts: [{ artifactRef, checkId: "artifact" }],
          taskId: "result-node",
          workerId: entry.to,
        },
        requestId: `r9-accepted-${entry.messageId}`,
        workflowId: graphWorkflowId,
      });
      expect(
        await callRecipientRoute({
          command: {
            operation: "publish-result",
            requestId: `r9-publish-${entry.messageId}`,
            taskId,
            workflowId: messageWorkflowId,
          },
          token: token(f, entry.to),
          url: `http://127.0.0.1:${f.port}/a2a/v2/recipient`,
        })
      ).toMatchObject({ resultPublished: true, taskId });
      expect(await status(f, entry.from, messageWorkflowId)).toMatchObject({
        taskState: "TASK_STATE_COMPLETED",
        workResultCompleted: true,
      });
    }

    // 2. The sender's view is its own principal's only.
    const firstWorkflowId = workflowIds.get(
      sends[0]?.messageId ?? ""
    ) as string;
    const foreign = await status(f, OUTSIDER, firstWorkflowId).catch(
      (error: unknown) => error
    );
    expect(foreign).toBeInstanceOf(A2AClientError);
    expect((foreign as A2AClientError).code).toBe("not-found");
    // A sender of another principal reaches a live lease held in the seat's
    // own scope: delivered to the channel session and acknowledged there.
    const crossScope = await send(f, OUTSIDER, CHANNEL, "r9-outsider-to-chan");
    ownedWorkflowIds.add(crossScope);
    await waitFor("the cross-principal send to reach the channel", () =>
      sessions.received(CHANNEL).includes(crossScope) ? true : undefined
    );
    await waitFor("the cross-principal send delivered", async () =>
      (await status(f, OUTSIDER, crossScope)).deliveredAt ? true : undefined
    );
    expect(await ack(f, CHANNEL, crossScope)).toMatchObject({
      acknowledged: [{ phase: "acknowledged", workflowId: crossScope }],
    });

    // 3. Release, then mailbox fallback, then reclaim (the Claude run).
    expect(
      await a2a(f, ["release", "--as", CLAUDE_RUN, "--run", CLAUDE_RUN_ID])
    ).toMatchObject({ action: "release", outcome: "released" });
    const toMailbox = await send(f, CODEX_RUN, CLAUDE_RUN, "r9-released-1");
    ownedWorkflowIds.add(toMailbox);
    await waitFor("the released seat's mail", () =>
      mailboxWorkflowIds(f.mailboxOf(CLAUDE_RUN)).includes(toMailbox)
        ? true
        : undefined
    );
    expect(sessions.received(CLAUDE_RUN)).not.toContain(toMailbox);
    await deliveredTo(f, CODEX_RUN, toMailbox);
    expect(await ack(f, CLAUDE_RUN, toMailbox)).toMatchObject({
      acknowledged: [{ phase: "acknowledged", workflowId: toMailbox }],
    });
    expect((await status(f, CODEX_RUN, toMailbox)).acknowledgedAt).toBeString();
    await a2a(f, [
      "enroll",
      "--as",
      CLAUDE_RUN,
      "--kind",
      "loop-run",
      "--run",
      CLAUDE_RUN_ID,
      "--seat",
      "claude",
    ]);
    const reclaimed = await send(f, CODEX_RUN, CLAUDE_RUN, "r9-reclaimed-1");
    ownedWorkflowIds.add(reclaimed);
    await waitFor("the reclaimed seat's delivery", () =>
      sessions.received(CLAUDE_RUN).includes(reclaimed) ? true : undefined
    );
    expect(mailboxWorkflowIds(f.mailboxOf(CLAUDE_RUN))).toEqual([toMailbox]);

    // 4. A competing claim is fenced (the Codex thread).
    const codexEndpoint = resolveA2AClientEndpoint(CODEX_RUN, { env: f.env });
    const rival = {
      holderRef: "rival:codex-thread",
      locator: {
        kind: "codex-thread" as const,
        repoId: REPO,
        runId: CODEX_RUN_ID,
        threadId: CODEX_THREAD,
      },
      sessionRef: `session:${CODEX_THREAD}`,
    };
    const held = await claimA2ASession(codexEndpoint, rival).catch(
      (error: unknown) => error
    );
    expect(held).toBeInstanceOf(A2AClientError);
    expect((held as A2AClientError).code).toBe("lease-held");
    const takeover = await claimA2ASession(codexEndpoint, {
      ...rival,
      takeover: true,
    });
    expect(takeover.tookOver).toBe(true);
    // The evicted holder's recorded fence no longer releases anything.
    expect(
      await a2a(f, ["release", "--as", CODEX_RUN, "--run", CODEX_RUN_ID])
    ).toMatchObject({ outcome: "fenced" });
    const restored = await a2a(f, [
      "enroll",
      "--as",
      CODEX_RUN,
      "--kind",
      "codex-thread",
      "--run",
      CODEX_RUN_ID,
      "--takeover",
    ]);
    expect((restored.receipt as { epoch: number }).epoch).toBeGreaterThan(
      takeover.epoch
    );
    const afterRestore = await send(f, CLAUDE_RUN, CODEX_RUN, "r9-restored-1");
    ownedWorkflowIds.add(afterRestore);
    await waitFor("delivery after the restored claim", () =>
      sessions.received(CODEX_RUN).includes(afterRestore) ? true : undefined
    );

    // 5. Expiry defers, bounded, and never falls through to the mailbox
    // (the channel session goes quiet: no renewal, the lease lapses).
    sessions.alive.delete(f.channelDir);
    await sleep(SESSION_TTL_MS + 1500);
    const deferred = await send(f, CLAUDE_RUN, CHANNEL, "r9-expired-1");
    ownedWorkflowIds.add(deferred);
    await waitFor("the deferral line", () =>
      logged(`V2 delivery to ${CHANNEL} deferred`) ? true : undefined
    );
    await waitFor(
      "the bound to pass",
      () =>
        logged(
          `V2 delivery to ${CHANNEL} still deferred after ${NOT_ENROLLED_BOUND_MS}ms not enrolled`
        )
          ? true
          : undefined,
      NOT_ENROLLED_BOUND_MS + 20_000
    );
    expect((await status(f, CLAUDE_RUN, deferred)).deliveredAt).toBeNull();
    expect(mailboxWorkflowIds(f.mailboxOf(CHANNEL))).toEqual([]);
    expect(sessions.received(CHANNEL)).not.toContain(deferred);
    // The session comes back: the sweep renews the expired lease and the
    // deferred message is delivered to the session, still not the mailbox.
    sessions.alive.add(f.channelDir);
    await waitFor("delivery once the session is back", () =>
      sessions.received(CHANNEL).includes(deferred) ? true : undefined
    );
    expect(mailboxWorkflowIds(f.mailboxOf(CHANNEL))).toEqual([]);
    await deliveredTo(f, CLAUDE_RUN, deferred);
    expect(await ack(f, CHANNEL, deferred)).toMatchObject({
      acknowledged: [{ phase: "acknowledged", workflowId: deferred }],
    });

    // 6. An id with no session: its mailbox, acknowledged via `loop a2a ack`.
    const sessionless = await send(f, CLAUDE_RUN, OUTSIDER, "r9-sessionless-1");
    ownedWorkflowIds.add(sessionless);
    await waitFor("the session-less id's mail", () =>
      mailboxWorkflowIds(f.mailboxOf(OUTSIDER)).includes(sessionless)
        ? true
        : undefined
    );
    await deliveredTo(f, CLAUDE_RUN, sessionless);
    expect(await ack(f, OUTSIDER, sessionless)).toMatchObject({
      acknowledged: [{ phase: "acknowledged", workflowId: sessionless }],
      workResultCompleted: false,
    });
    expect(await status(f, CLAUDE_RUN, sessionless)).toMatchObject({
      workResultCompleted: false,
    });
    expect(
      (await status(f, CLAUDE_RUN, sessionless)).acknowledgedAt
    ).toBeString();

    // 7. /healthz names nothing.
    expectNoIds(await health(f), [
      ...ownedWorkflowIds,
      REPO,
      CLAUDE_RUN_ID,
      CODEX_RUN_ID,
      CHANNEL_SESSION,
      CODEX_THREAD,
      f.tenant,
    ]);
  } finally {
    sessions.stop();
    stop.abort();
    await running?.catch(() => undefined);
    errors.mockRestore();
    for (const workflowId of ownedWorkflowIds) {
      await temporal.client.workflow
        .getHandle(workflowId)
        .terminate("r9 e2e cleanup")
        .catch(() => undefined);
    }
    f.remove();
  }
}, 300_000);

/** The A2A task carrying a message, from the sender's own status scope. */
const a2aTaskIdOf = async (
  f: Fixture,
  from: string,
  messageWorkflowId: string
): Promise<string> => {
  const { PostgresA2ATaskStore } = await import(
    "../../src/loop/a2a-postgres-task-store"
  );
  const { ServerCallContext } = await import("@a2a-js/sdk/server");
  const { TaskState } = await import("@a2a-js/sdk");
  const { WORKFLOW_IDS_METADATA_KEY } = await import(
    "../../src/loop/a2a-supervisor-executor"
  );
  const tasks = await PostgresA2ATaskStore.connect({
    databaseUrl: postgres.databaseUrl(),
  });
  try {
    const listed = await tasks.list(
      {
        contextId: "",
        includeArtifacts: false,
        pageSize: 100,
        pageToken: "",
        status: TaskState.TASK_STATE_UNSPECIFIED,
        statusTimestampAfter: undefined,
        tenant: f.tenant,
      },
      new ServerCallContext({
        tenant: f.tenant,
        user: {
          isAuthenticated: true,
          userName: PRINCIPAL_OF[from] as string,
        },
      })
    );
    const task = listed.tasks.find((candidate) => {
      const ids = candidate.metadata?.[WORKFLOW_IDS_METADATA_KEY];
      return Array.isArray(ids) && ids.includes(messageWorkflowId);
    });
    if (!task) {
      throw new Error(`no A2A task carries ${messageWorkflowId}`);
    }
    return task.id;
  } finally {
    await tasks.close();
  }
};

test("a V2 ledger that is down keeps V1 up: at start V2 is disabled, and mid-run V2 answers 503 while V1 and /healthz stay ready", async () => {
  // At start: an unreachable ledger disables V2; V1 serves.
  const unreachable = fixture({
    databaseUrl: `postgres://loop:unused@127.0.0.1:${freePort()}/none`,
  });
  const stopUnreachable = new AbortController();
  let runningUnreachable: Promise<void> | undefined;
  const errors = spyOn(console, "error");
  try {
    const started = startServer(unreachable, stopUnreachable.signal);
    runningUnreachable = started.running;
    expect(await started.ready).toBe("ready");
    expect(await health(unreachable)).toMatchObject({
      a2aV2: "disabled",
      state: "ready",
    });
    await sendV1(unreachable, "r9-v1-at-start");
    for (const path of [
      "/a2a/v2/sessions/claim",
      `/a2a/v2/supervisors/${CHANNEL.slice(11)}`,
    ]) {
      const v2 = await post(unreachable, CLAUDE_RUN, path, {});
      expect(v2.status).toBe(503);
      expect(await v2.json()).toEqual({ error: { code: "v2-unavailable" } });
    }
    expectNoIds(await health(unreachable), [unreachable.tenant]);
  } finally {
    stopUnreachable.abort();
    await runningUnreachable?.catch(() => undefined);
    unreachable.remove();
  }

  // Mid-run: the ledger's database goes away under a running V2 plane.
  const own = await DisposablePostgres.create();
  const f = fixture({ databaseUrl: own.databaseUrl() });
  const sessions = scriptedSessions(f);
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  let closed = false;
  try {
    const started = startServer(f, stop.signal, sessions.adapters);
    running = started.running;
    expect(await started.ready).toBe("ready");
    expect(await health(f)).toMatchObject({ a2aV2: "ready", state: "ready" });
    sessions.alive.add(f.codexRunDir);
    await a2a(f, [
      "enroll",
      "--as",
      CODEX_RUN,
      "--kind",
      "codex-thread",
      "--run",
      CODEX_RUN_ID,
    ]);
    const before = await send(f, CLAUDE_RUN, CODEX_RUN, "r9-ledger-before");
    await waitFor("delivery before the outage", () =>
      sessions.received(CODEX_RUN).includes(before) ? true : undefined
    );
    await own.close();
    closed = true;
    // V1 and the server's own health are untouched.
    expect(await health(f)).toMatchObject({ state: "ready" });
    await sendV1(f, "r9-v1-mid-outage");
    // V2 says it cannot answer, never that the message does not exist.
    const outage = await status(f, CLAUDE_RUN, before).catch(
      (error: unknown) => error
    );
    expect(outage).toBeInstanceOf(A2AClientError);
    expect((outage as A2AClientError).code).toBe("v2-unavailable");
    const claim = await a2a(f, [
      "enroll",
      "--as",
      CODEX_RUN,
      "--kind",
      "codex-thread",
      "--run",
      CODEX_RUN_ID,
    ]).catch((error: unknown) => error);
    expect(claim).toBeInstanceOf(A2AClientError);
    expect((claim as A2AClientError).code).toBe("v2-unavailable");
    expect(await health(f)).toMatchObject({ state: "ready" });
    expectNoIds(await health(f), [before, f.tenant]);
  } finally {
    sessions.stop();
    stop.abort();
    await running?.catch(() => undefined);
    errors.mockRestore();
    if (!closed) {
      await own.close();
    }
    f.remove();
  }
}, 240_000);
