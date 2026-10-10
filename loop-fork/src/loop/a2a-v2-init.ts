// fix8: `loop orchestration a2a-v2 init <config>` turns the A2A V2 plane on for
// an existing orchestration config.
//
// 1. Ledger. Unless the config already has an a2aV2 section, or the operator
//    names an existing database variable (--database-url-env), it provisions a
//    local PostgreSQL ledger: one named container (default loop-a2a-ledger)
//    with a named volume, published on 127.0.0.1 only, restarted with the
//    Docker daemon. The password is generated here, handed to Docker through
//    the child environment (never argv) and written only to the 0600 env file
//    next to the config. Re-running reuses the container, the volume and the
//    password in the env file.
// 2. Config. The a2aV2 section (legacy workflow id format, a generated result
//    graph key in the env file) is written into a COPY of the config, the copy
//    is validated with the server's own parser, the original is backed up
//    (`<config>.bak-<UTC stamp>`, 0600) and the copy atomically renamed over
//    it, after checking the original did not change meanwhile.
//
// The V2 recipient must be a Loop binding: a supervisor with a manifestPath
// (the run manifest of a Loop pane the server can enrol). A supervisor that is
// mailbox-only cannot be a V2 recipient. Init never invents one; with none
// resolvable it provisions the ledger and the env file, writes no section and
// says what is missing (--recipient/--manifest).

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawn } from "bun";
import {
  A2A_V2_DATABASE_URL_ENV,
  A2A_V2_RESULT_GRAPH_KEY_ENV,
  a2aV2EnvFilePath,
  formatA2AV2EnvFile,
  probeA2AV2Database,
  readA2AV2EnvFile,
} from "./a2a-v2-env";
import { parseLoopOrchestrationConfig } from "./loop-orchestration-server";
import { readRunManifest } from "./run-state";

export const A2A_V2_LEDGER_CONTAINER = "loop-a2a-ledger";
export const A2A_V2_LEDGER_PORT = 55_432;
export const A2A_V2_LEDGER_LABEL = "dev.loop.a2a-ledger";
// The image the repo's own disposable-Postgres tests run, by digest.
export const A2A_V2_LEDGER_IMAGE =
  "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const LEDGER_USER = "loop";
const LEDGER_DB = "loop_a2a";
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const SUPERVISOR_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/;
const PRINCIPAL_RE = /^principal:[a-z0-9][a-z0-9._:-]{0,255}$/;
const TENANT_INVALID_RE = /[^a-z0-9._-]+/g;
const EDGE_DASH_RE = /^[-._]+|[-._]+$/g;
const PUBLISHED_RE = /^127\.0\.0\.1:(\d+)$/m;
const STAMP_SEPARATORS_RE = /[-:]/g;
const STAMP_MS_RE = /\.\d{3}Z$/;

export interface A2AV2InitOptions {
  configPath: string;
  /** Docker container (and, with `-data`, volume) name. */
  containerName?: string;
  /** An already-set variable holding a database URL: no ledger is provisioned. */
  databaseUrlEnv?: string;
  /** Host port on 127.0.0.1 the ledger is published on. */
  ledgerPort?: number;
  /** Manifest paths to bind, by supervisor id. */
  manifests?: Readonly<Record<string, string>>;
  /** The V2 recipient; default: the first supervisor with a manifestPath. */
  recipient?: string;
}

export interface DockerResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface A2AV2InitDeps {
  /** Runs `docker <args>`; `env` is added to the child environment only. */
  docker(
    args: readonly string[],
    env?: Record<string, string>
  ): Promise<DockerResult>;
  env: NodeJS.ProcessEnv;
  log(line: string): void;
  now(): Date;
  probeDatabase(url: string): Promise<boolean>;
  secret(bytes: number): string;
  sleep(ms: number): Promise<void>;
}

export const defaultA2AV2InitDeps = (): A2AV2InitDeps => ({
  async docker(args, env) {
    const child = spawn(["docker", ...args], {
      env: { ...process.env, ...env },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stderr: stderr.trim(), stdout: stdout.trim() };
  },
  env: process.env,
  log: (line) => process.stdout.write(`${line}\n`),
  now: () => new Date(),
  probeDatabase: (url) => probeA2AV2Database(url),
  secret: (bytes) => randomBytes(bytes).toString("base64url"),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

export interface A2AV2InitResult {
  backupPath?: string;
  configWritten: boolean;
  envFile: string;
  ledger: "existing-config" | "external" | "provisioned" | "reused";
  /** Set when no section was written: what the operator must supply. */
  missing?: string;
  recipient?: string;
}

/** An init that provisioned what it could but wrote no a2aV2 section. */
export class A2AV2InitIncompleteError extends Error {
  readonly result: A2AV2InitResult;
  constructor(message: string, result: A2AV2InitResult) {
    super(message);
    this.name = "A2AV2InitIncompleteError";
    this.result = result;
  }
}

/** `YYYYMMDDTHHMMSSZ`, the stamp the live config's earlier backups use. */
export const backupStamp = (now: Date): string =>
  now.toISOString().replace(STAMP_SEPARATORS_RE, "").replace(STAMP_MS_RE, "Z");

interface RawConfig {
  bytes: Buffer;
  digest: string;
  value: Record<string, unknown>;
}

const readRawConfig = (path: string): RawConfig => {
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("orchestration config is not a file");
    }
    const bytes = readFileSync(descriptor);
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("orchestration config must be an object");
    }
    return {
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
      value: value as Record<string, unknown>,
    };
  } finally {
    closeSync(descriptor);
  }
};

/** Writes `text` to a new 0600 file, fsynced; fails if the path exists. */
const writePrivateFile = (path: string, text: string): void => {
  const descriptor = openSync(
    path,
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
};

/** Replace `path` with `text` through a sibling temporary file and a rename. */
const replacePrivateFile = (path: string, text: string): void => {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  );
  try {
    writePrivateFile(temporary, text);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
};

const canonicalManifest = (supervisorId: string, path: string): string => {
  if (!isAbsolute(path)) {
    throw new Error(`--manifest ${supervisorId}: the path must be absolute`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `--manifest ${supervisorId}: ${path} is not a regular non-symlink file`
    );
  }
  if (realpathSync(path) !== path) {
    throw new Error(`--manifest ${supervisorId}: ${path} is not canonical`);
  }
  if (!readRunManifest(path)) {
    throw new Error(
      `--manifest ${supervisorId}: ${path} is not a run manifest`
    );
  }
  return path;
};

const tenantFor = (identity: string): string => {
  const label = identity
    .toLowerCase()
    .replace(TENANT_INVALID_RE, "-")
    .replace(EDGE_DASH_RE, "")
    .slice(0, 120);
  return `tenant:${label || "loop"}`;
};

const describeDocker = (result: DockerResult): string =>
  // Docker's own error text names images, containers and ports, never the
  // password, which only ever travels in the child environment.
  (result.stderr || result.stdout).split("\n")[0] ?? `exit ${result.code}`;

interface LedgerState {
  /** Host port the running container publishes 5432 on, 127.0.0.1 only. */
  port: number;
  reused: boolean;
}

const inspectContainer = async (
  deps: A2AV2InitDeps,
  name: string
): Promise<{ label: string; running: boolean } | undefined> => {
  const result = await deps.docker([
    "container",
    "inspect",
    "--format",
    `{{.State.Running}} {{index .Config.Labels "${A2A_V2_LEDGER_LABEL}"}}`,
    name,
  ]);
  if (result.code !== 0) {
    return undefined;
  }
  const [running, label = ""] = result.stdout.split(" ");
  return { label, running: running === "true" };
};

const volumeExists = async (
  deps: A2AV2InitDeps,
  volume: string
): Promise<boolean> =>
  (await deps.docker(["volume", "inspect", volume])).code === 0;

const publishedPort = async (
  deps: A2AV2InitDeps,
  name: string
): Promise<number> => {
  const result = await deps.docker(["port", name, "5432/tcp"]);
  const port = Number(PUBLISHED_RE.exec(result.stdout)?.[1]);
  if (result.code !== 0 || !Number.isSafeInteger(port)) {
    throw new Error(
      `ledger container ${name} does not publish 5432 on 127.0.0.1 only`
    );
  }
  // Refuse a container also published beyond loopback.
  if (
    result.stdout
      .split("\n")
      .filter(Boolean)
      .some((line) => !line.startsWith("127.0.0.1:"))
  ) {
    throw new Error(
      `ledger container ${name} is published beyond 127.0.0.1; refusing to use it`
    );
  }
  return port;
};

const ensureLedger = async (
  deps: A2AV2InitDeps,
  input: {
    name: string;
    password: string;
    port: number;
    passwordKnown: boolean;
  }
): Promise<LedgerState> => {
  const volume = `${input.name}-data`;
  const existing = await inspectContainer(deps, input.name);
  if (existing) {
    if (existing.label !== "1") {
      throw new Error(
        `a container named ${input.name} exists but was not created by a2a-v2 init (no ${A2A_V2_LEDGER_LABEL} label); choose another --ledger-name`
      );
    }
    if (!input.passwordKnown) {
      throw new Error(
        `ledger container ${input.name} exists but its password is not in the env file; restore the env file or remove the container and its volume ${volume}`
      );
    }
    if (!existing.running) {
      const started = await deps.docker(["start", input.name]);
      if (started.code !== 0) {
        throw new Error(
          `cannot start ledger container ${input.name}: ${describeDocker(started)}`
        );
      }
    }
    return { port: await publishedPort(deps, input.name), reused: true };
  }
  if (!input.passwordKnown && (await volumeExists(deps, volume))) {
    throw new Error(
      `ledger volume ${volume} exists but its password is not in the env file; restore the env file or remove the volume`
    );
  }
  const created = await deps.docker(
    [
      "run",
      "--detach",
      "--name",
      input.name,
      "--label",
      `${A2A_V2_LEDGER_LABEL}=1`,
      "--restart",
      "unless-stopped",
      "--volume",
      `${volume}:/var/lib/postgresql/data`,
      "--publish",
      `127.0.0.1:${input.port}:5432`,
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      `POSTGRES_USER=${LEDGER_USER}`,
      "--env",
      `POSTGRES_DB=${LEDGER_DB}`,
      A2A_V2_LEDGER_IMAGE,
    ],
    { POSTGRES_PASSWORD: input.password }
  );
  if (created.code !== 0) {
    throw new Error(
      `cannot create ledger container ${input.name}: ${describeDocker(created)}`
    );
  }
  return { port: await publishedPort(deps, input.name), reused: false };
};

const ledgerUrl = (password: string, port: number): string =>
  `postgres://${LEDGER_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${LEDGER_DB}`;

const passwordOf = (url: string | undefined): string | undefined => {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return parsed.password ? decodeURIComponent(parsed.password) : undefined;
  } catch {
    return undefined;
  }
};

const waitForDatabase = async (
  deps: A2AV2InitDeps,
  url: string,
  attempts = 120
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await deps.probeDatabase(url)) {
      return;
    }
    await deps.sleep(500);
  }
  throw new Error("the A2A V2 ledger database did not accept queries");
};

const DEFAULT_POLICY = {
  claimTimeoutMs: 300_000,
  escalationTimeoutMs: 900_000,
  maxDeliveryAttempts: 5,
  retryDelayMs: 30_000,
};

const validateInitOptions = (
  options: A2AV2InitOptions
): { containerName: string; ledgerPort: number } => {
  const containerName = options.containerName ?? A2A_V2_LEDGER_CONTAINER;
  if (!DOCKER_NAME_RE.test(containerName)) {
    throw new Error("--ledger-name is invalid");
  }
  const ledgerPort = options.ledgerPort ?? A2A_V2_LEDGER_PORT;
  if (
    !(
      Number.isSafeInteger(ledgerPort) &&
      ledgerPort >= 1024 &&
      ledgerPort <= 65_535
    )
  ) {
    throw new Error("--ledger-port is invalid");
  }
  if (options.databaseUrlEnv && !TOKEN_ENV_RE.test(options.databaseUrlEnv)) {
    throw new Error("--database-url-env is invalid");
  }
  return { containerName, ledgerPort };
};

/** Step 1: the ledger. Sets the database URL in `envValues` when provisioned. */
const prepareLedger = async (
  deps: A2AV2InitDeps,
  input: {
    containerName: string;
    databaseUrlEnv?: string;
    envValues: Map<string, string>;
    ledgerPort: number;
  }
): Promise<{
  databaseUrlEnv: string;
  ledger: A2AV2InitResult["ledger"];
}> => {
  if (input.databaseUrlEnv) {
    const url =
      deps.env[input.databaseUrlEnv] ??
      input.envValues.get(input.databaseUrlEnv);
    if (!url) {
      throw new Error(`--database-url-env ${input.databaseUrlEnv} is not set`);
    }
    if (!(await deps.probeDatabase(url))) {
      throw new Error(
        `the database named by ${input.databaseUrlEnv} does not accept queries`
      );
    }
    return { databaseUrlEnv: input.databaseUrlEnv, ledger: "external" };
  }
  const knownPassword = passwordOf(
    input.envValues.get(A2A_V2_DATABASE_URL_ENV)
  );
  const password = knownPassword ?? deps.secret(24);
  const state = await ensureLedger(deps, {
    name: input.containerName,
    password,
    passwordKnown: knownPassword !== undefined,
    port: input.ledgerPort,
  });
  const url = ledgerUrl(password, state.port);
  await waitForDatabase(deps, url);
  input.envValues.set(A2A_V2_DATABASE_URL_ENV, url);
  deps.log(
    `ledger ${state.reused ? "reused" : "created"}: container ${input.containerName}, volume ${input.containerName}-data, 127.0.0.1:${state.port}`
  );
  return {
    databaseUrlEnv: A2A_V2_DATABASE_URL_ENV,
    ledger: state.reused ? "reused" : "provisioned",
  };
};

/** Step 2: the configured supervisors with --manifest bindings applied. */
const bindManifests = (
  raw: RawConfig,
  manifests: Readonly<Record<string, string>>
): Record<string, unknown>[] => {
  const supervisors = (raw.value.supervisors as Record<string, unknown>[]).map(
    (entry) => ({ ...entry })
  );
  for (const [supervisorId, path] of Object.entries(manifests)) {
    if (!SUPERVISOR_RE.test(supervisorId)) {
      throw new Error(`--manifest ${supervisorId}: not a supervisor id`);
    }
    const entry = supervisors.find((one) => one.supervisorId === supervisorId);
    if (!entry) {
      throw new Error(
        `--manifest ${supervisorId}: no such supervisor in the config`
      );
    }
    entry.manifestPath = canonicalManifest(supervisorId, path);
  }
  return supervisors;
};

/** The recipient, or what is missing for one. */
const chooseRecipient = (
  supervisors: readonly Record<string, unknown>[],
  requested: string | undefined
): { entry: Record<string, unknown> } | { missing: string } => {
  const hasManifest = (entry: Record<string, unknown>) =>
    typeof entry.manifestPath === "string";
  const entry = requested
    ? supervisors.find((one) => one.supervisorId === requested)
    : supervisors.find(hasManifest);
  if (requested && !entry) {
    return {
      missing: `--recipient ${requested} is not a configured supervisor`,
    };
  }
  if (!(entry && hasManifest(entry))) {
    const unbound = supervisors
      .filter((one) => !hasManifest(one))
      .map((one) => String(one.supervisorId));
    const which = requested
      ? `${requested} has none`
      : "no configured supervisor has one";
    return {
      missing: `the V2 recipient must be a Loop binding (a supervisor with a manifestPath), and ${which}; pass --manifest <supervisor-id>=<absolute run manifest.json> for the Loop run that will receive (mailbox-only: ${unbound.join(", ")})`,
    };
  }
  if (!PRINCIPAL_RE.test(String(entry.principal))) {
    return {
      missing: `the recipient's principal ${String(entry.principal)} is not of the form principal:<name>`,
    };
  }
  return { entry };
};

const a2aV2SectionFor = (input: {
  databaseUrlEnv: string;
  identity: string;
  recipient: Record<string, unknown>;
}) => {
  const seat =
    input.recipient.seat === "claude" || input.recipient.seat === "codex"
      ? input.recipient.seat
      : readRunManifest(String(input.recipient.manifestPath))?.primaryAgent;
  return {
    databaseUrlEnv: input.databaseUrlEnv,
    endpointRef:
      seat === "claude" ? "endpoint:claude-code" : "endpoint:codex-app-server",
    policy: { ...DEFAULT_POLICY },
    principal: String(input.recipient.principal),
    recipient: String(input.recipient.supervisorId),
    resultGraphKeyEnv: A2A_V2_RESULT_GRAPH_KEY_ENV,
    routePath: "/a2a/v2",
    sessionTtlMs: 3_600_000,
    tenant: tenantFor(input.identity),
    // Owner decision (fix8): keep the legacy id format, which a rollback to a
    // pre-discriminator build still reads.
    workflowIdFormat: "legacy",
  };
};

/** Step 3: back up the original, then rename a validated 0600 copy over it. */
const replaceConfig = (
  configPath: string,
  raw: RawConfig,
  next: Record<string, unknown>,
  now: Date
): string => {
  const temporary = join(
    dirname(configPath),
    `.${basename(configPath)}.a2a-v2-init.${process.pid}.tmp`
  );
  const backupPath = `${configPath}.bak-${backupStamp(now)}`;
  try {
    // 0600 whatever the original's mode: the config names secret variables.
    writePrivateFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
    if (readRawConfig(configPath).digest !== raw.digest) {
      throw new Error(
        "orchestration config changed while init ran; nothing was replaced"
      );
    }
    copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
    chmodSync(backupPath, 0o600);
    renameSync(temporary, configPath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return backupPath;
};

export const runA2AV2Init = async (
  options: A2AV2InitOptions,
  deps: A2AV2InitDeps = defaultA2AV2InitDeps()
): Promise<A2AV2InitResult> => {
  const { containerName, ledgerPort } = validateInitOptions(options);
  const raw = readRawConfig(options.configPath);
  const current = parseLoopOrchestrationConfig(raw.value);
  const envFile = a2aV2EnvFilePath(options.configPath);
  const envRead = readA2AV2EnvFile(envFile);
  if (envRead.kind === "refused") {
    throw new Error(`A2A V2 env file refused: ${envRead.reason}`);
  }
  const envValues =
    envRead.kind === "read" ? envRead.values : new Map<string, string>();
  if (current.a2aV2) {
    // Idempotent: the section is the operator's now. Keep the ledger running
    // when it is ours, and change nothing else.
    const mine = await inspectContainer(deps, containerName);
    if (mine?.label === "1" && !mine.running) {
      await deps.docker(["start", containerName]);
    }
    deps.log(
      `a2aV2 already configured in ${options.configPath}; config unchanged`
    );
    return { configWritten: false, envFile, ledger: "existing-config" };
  }
  const { databaseUrlEnv, ledger } = await prepareLedger(deps, {
    containerName,
    ...(options.databaseUrlEnv
      ? { databaseUrlEnv: options.databaseUrlEnv }
      : {}),
    envValues,
    ledgerPort,
  });
  if (!envValues.get(A2A_V2_RESULT_GRAPH_KEY_ENV)) {
    envValues.set(A2A_V2_RESULT_GRAPH_KEY_ENV, deps.secret(32));
  }
  (envRead.kind === "absent" ? writePrivateFile : replacePrivateFile)(
    envFile,
    formatA2AV2EnvFile(envValues)
  );
  deps.log(
    `env file ${envFile} (0600): ${[...envValues.keys()].sort().join(", ")}`
  );
  const supervisors = bindManifests(raw, options.manifests ?? {});
  const chosen = chooseRecipient(supervisors, options.recipient);
  if ("missing" in chosen) {
    throw new A2AV2InitIncompleteError(
      `a2aV2 not written: ${chosen.missing}. The ledger and ${envFile} are ready; rerun init with what is missing.`,
      { configWritten: false, envFile, ledger, missing: chosen.missing }
    );
  }
  const a2aV2 = a2aV2SectionFor({
    databaseUrlEnv,
    identity: current.identity,
    recipient: chosen.entry,
  });
  const next = { ...raw.value, a2aV2, supervisors };
  // Validated by the server's own parser before anything is replaced.
  parseLoopOrchestrationConfig(next);
  const backupPath = replaceConfig(options.configPath, raw, next, deps.now());
  deps.log(`backup ${backupPath}`);
  deps.log(
    `a2aV2 written to ${options.configPath}: recipient ${a2aV2.recipient}, principal ${a2aV2.principal}, workflowIdFormat legacy`
  );
  return {
    backupPath,
    configWritten: true,
    envFile,
    ledger,
    recipient: a2aV2.recipient,
  };
};
