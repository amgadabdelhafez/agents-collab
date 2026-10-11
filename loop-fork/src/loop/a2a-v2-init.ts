// fix8: `loop orchestration a2a-v2 init <config>` turns the A2A V2 plane on for
// an existing orchestration config.
//
// 1. Ledger. Unless the config already has an a2aV2 section, or the operator
//    names an existing database variable (--database-url-env), it provisions a
//    local PostgreSQL ledger: one named container (default loop-a2a-ledger)
//    with a named volume, published on 127.0.0.1 only, restarted with the
//    Docker daemon. The password is generated here and written to the 0600 env
//    file (inside the ledger URL) and to a 0600 secret file next to the config
//    (`<config-dir>/<container>.password`), which the container mounts
//    read-only and reads through POSTGRES_PASSWORD_FILE. The password is never
//    in argv and never in the container's environment, so `docker inspect`
//    does not show it. Re-running reuses the container, the volume and the
//    password in the env file. A ledger created by the first fix8 build
//    (POSTGRES_PASSWORD in its container environment) is reused as it is, with
//    one line naming the command that recreates it with the secret file.
// 2. Config. The a2aV2 section (legacy workflow id format, a generated result
//    graph key in the env file) is written into a COPY of the config, the copy
//    is validated with the server's own parser, the original is backed up
//    (`<config>.bak-<UTC stamp>`, 0600) and the copy atomically renamed over
//    it, after checking the original did not change meanwhile.
//
// r8 (--manifest or --recipient): the one V2 recipient must be a Loop
// binding: a supervisor with a manifestPath (the run manifest of a Loop pane
// the server can enrol). Init never invents one; with none resolvable it
// provisions the ledger and the env file, writes no section and says what is
// missing.
//
// r9 (neither flag): every configured supervisor is a recipient, through its
// own ingress and session lease, so the section names no recipient. Its
// principal is the control principal: --control <supervisor-id>'s, or the
// first supervisor's (printed). Each sender/recipient pair needs a grant
// (receive, claim, acknowledge, under the sender's principal); init lists the
// missing ones and never invents them.

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
import { isLoopbackPublishedPort } from "./orchestration-origin-policy";
import { readRunManifest } from "./run-state";

export const A2A_V2_LEDGER_CONTAINER = "loop-a2a-ledger";
export const A2A_V2_LEDGER_PORT = 55_432;
export const A2A_V2_LEDGER_LABEL = "dev.loop.a2a-ledger";
// The image the repo's own disposable-Postgres tests run, by digest.
export const A2A_V2_LEDGER_IMAGE =
  "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
/** Where the ledger container sees its password file (read-only mount). */
export const A2A_V2_LEDGER_PASSWORD_TARGET =
  "/run/secrets/loop-a2a-ledger-password";
const LEDGER_USER = "loop";
const LEDGER_DB = "loop_a2a";
// `--mount` is a CSV list: a source path with either character would be
// misparsed, so such a config directory is refused instead.
const MOUNT_UNSAFE_RE = /[,"\n]/;
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
  /**
   * r9 (no --manifest, no --recipient): the supervisor whose principal is
   * the section's control principal; default: the first supervisor.
   */
  controlSupervisor?: string;
  /** An already-set variable holding a database URL: no ledger is provisioned. */
  databaseUrlEnv?: string;
  /** Host port on 127.0.0.1 the ledger is published on. */
  ledgerPort?: number;
  /** Manifest paths to bind, by supervisor id. */
  manifests?: Readonly<Record<string, string>>;
  /** The V2 recipient; default: the first supervisor with a manifestPath. */
  recipient?: string;
}

/** One sender/recipient pair whose grant lacks operations V2 needs. */
export interface A2AV2MissingGrant {
  from: string;
  /** The operations no configured grant of this pair holds, sorted. */
  operations: string[];
  principal: string;
  to: string;
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
  /** r9: the supervisor whose principal is the control principal. */
  controlSupervisor?: string;
  envFile: string;
  ledger: "existing-config" | "external" | "provisioned" | "reused";
  /** Set when no section was written: what the operator must supply. */
  missing?: string;
  /** r9: the sender/recipient pairs the grants do not cover yet. */
  missingGrants?: A2AV2MissingGrant[];
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

/** `<config-dir>/<container>.password`: the ledger's secret file. */
export const ledgerPasswordFilePath = (
  configPath: string,
  containerName: string
): string => join(dirname(configPath), `${containerName}.password`);

const holdsExactly = (path: string, password: string): boolean => {
  let descriptor: number | undefined;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    return (
      stat.isFile() &&
      // biome-ignore lint/suspicious/noBitwiseOperators: permission bits are a bit mask.
      (stat.mode & 0o777) === 0o600 &&
      readFileSync(descriptor, "utf8") === password
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

/**
 * The ledger's password file: 0600, the password alone (no newline). Left
 * as it is when it already holds exactly that at 0600 (a running
 * container's bind mount keeps its inode), else replaced atomically.
 */
const ensurePasswordFile = (path: string, password: string): void => {
  if (MOUNT_UNSAFE_RE.test(path)) {
    throw new Error(
      `the ledger password file ${JSON.stringify(path)} contains a comma, a quote or a newline, which docker --mount cannot carry; move the orchestration config to a plainer directory`
    );
  }
  if (!holdsExactly(path, password)) {
    replacePrivateFile(path, password);
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
  // Docker's own error text names images, containers, mounts and ports, never
  // the password, which only ever travels in the 0600 password file.
  (result.stderr || result.stdout).split("\n")[0] ?? `exit ${result.code}`;

interface LedgerState {
  /** Host port the running container publishes 5432 on, 127.0.0.1 only. */
  port: number;
  reused: boolean;
}

interface LedgerContainer {
  label: string;
  /**
   * Created by the first fix8 build: POSTGRES_PASSWORD is in the container's
   * environment, so `docker inspect` shows it until it is recreated.
   */
  passwordInEnv: boolean;
  running: boolean;
}

const PASSWORD_IN_ENV_MARK = "password-in-env";

const inspectContainer = async (
  deps: A2AV2InitDeps,
  name: string
): Promise<LedgerContainer | undefined> => {
  // The template only reports whether a POSTGRES_PASSWORD entry exists: the
  // value never leaves the daemon.
  const result = await deps.docker([
    "container",
    "inspect",
    "--format",
    `{{.State.Running}}|{{index .Config.Labels "${A2A_V2_LEDGER_LABEL}"}}|{{range .Config.Env}}{{if eq (index (split . "=") 0) "POSTGRES_PASSWORD"}}${PASSWORD_IN_ENV_MARK}{{end}}{{end}}`,
    name,
  ]);
  if (result.code !== 0) {
    return undefined;
  }
  const [running, label = "", marks = ""] = result.stdout.split("|");
  return {
    label,
    passwordInEnv: marks.includes(PASSWORD_IN_ENV_MARK),
    running: running === "true",
  };
};

/** The one line a reused pre-secret-file ledger gets. Names only. */
export const legacyLedgerLine = (name: string, configPath: string): string =>
  `ledger ${name} was created with POSTGRES_PASSWORD in its container environment (fix8 before the secret file): \`docker inspect ${name}\` shows the password to anyone who can reach the Docker daemon. Reused as it is. To recreate it with the 0600 secret file (the volume ${name}-data, its data and the password are kept): docker rm -f ${name} && loop orchestration a2a-v2 init ${configPath}`;

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
  // RA1's origin policy: the ledger port is plaintext, so every binding it
  // is published on must be a loopback IP literal. Refuse a container also
  // published beyond loopback.
  if (
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => !isLoopbackPublishedPort(line))
  ) {
    throw new Error(
      `ledger container ${name} is published beyond 127.0.0.1; refusing to use it`
    );
  }
  return port;
};

interface LedgerInput {
  configPath: string;
  name: string;
  password: string;
  /** The password file next to the config (ledgerPasswordFilePath). */
  passwordFile: string;
  passwordKnown: boolean;
  port: number;
}

/** Reuses (and starts) an existing labelled ledger container. */
const reuseLedger = async (
  deps: A2AV2InitDeps,
  input: LedgerInput,
  existing: LedgerContainer
): Promise<LedgerState> => {
  if (existing.label !== "1") {
    throw new Error(
      `a container named ${input.name} exists but was not created by a2a-v2 init (no ${A2A_V2_LEDGER_LABEL} label); choose another --ledger-name`
    );
  }
  if (!input.passwordKnown) {
    throw new Error(
      `ledger container ${input.name} exists but its password is not in the env file; restore the env file or remove the container and its volume ${input.name}-data`
    );
  }
  if (existing.passwordInEnv) {
    deps.log(legacyLedgerLine(input.name, input.configPath));
  } else {
    // Its bind mount needs the file to exist when it starts.
    ensurePasswordFile(input.passwordFile, input.password);
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
};

const ensureLedger = async (
  deps: A2AV2InitDeps,
  input: LedgerInput
): Promise<LedgerState> => {
  const volume = `${input.name}-data`;
  const existing = await inspectContainer(deps, input.name);
  if (existing) {
    return await reuseLedger(deps, input, existing);
  }
  if (!input.passwordKnown && (await volumeExists(deps, volume))) {
    throw new Error(
      `ledger volume ${volume} exists but its password is not in the env file; restore the env file or remove the volume`
    );
  }
  // The password reaches the container only as a read-only file: never
  // argv, never the container's environment (`docker inspect` shows that).
  ensurePasswordFile(input.passwordFile, input.password);
  const created = await deps.docker([
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
    "--mount",
    `type=bind,source=${input.passwordFile},target=${A2A_V2_LEDGER_PASSWORD_TARGET},readonly`,
    "--publish",
    `127.0.0.1:${input.port}:5432`,
    "--env",
    `POSTGRES_PASSWORD_FILE=${A2A_V2_LEDGER_PASSWORD_TARGET}`,
    "--env",
    `POSTGRES_USER=${LEDGER_USER}`,
    "--env",
    `POSTGRES_DB=${LEDGER_DB}`,
    A2A_V2_LEDGER_IMAGE,
  ]);
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
    configPath: string;
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
    configPath: input.configPath,
    name: input.containerName,
    password,
    passwordFile: ledgerPasswordFilePath(input.configPath, input.containerName),
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

/**
 * With an a2aV2 section already written: the ledger init provisioned (its
 * URL, with a password, in the env file under LOOP_A2A_V2_DATABASE_URL) is
 * kept running. A labelled container is reused (started when stopped; a
 * pre-secret-file one gets its one line). A removed container whose volume
 * is still there is recreated with the secret file, on the port the env
 * file's URL names, so the documented recreate command
 * (`docker rm -f <name> && loop orchestration a2a-v2 init <config>`) keeps
 * the data, the password and the URL. Anything else is left alone.
 */
const keepConfiguredLedger = async (
  deps: A2AV2InitDeps,
  input: {
    configPath: string;
    containerName: string;
    databaseUrlEnv: string;
    envValues: ReadonlyMap<string, string>;
  }
): Promise<void> => {
  const url =
    input.databaseUrlEnv === A2A_V2_DATABASE_URL_ENV
      ? input.envValues.get(A2A_V2_DATABASE_URL_ENV)
      : undefined;
  const password = passwordOf(url);
  const mine = await inspectContainer(deps, input.containerName);
  if (!(url && password) || (mine && mine.label !== "1")) {
    return;
  }
  const ledgerInput: LedgerInput = {
    configPath: input.configPath,
    name: input.containerName,
    password,
    passwordFile: ledgerPasswordFilePath(input.configPath, input.containerName),
    passwordKnown: true,
    port: Number(new URL(url).port) || A2A_V2_LEDGER_PORT,
  };
  if (mine) {
    await reuseLedger(deps, ledgerInput, mine);
    return;
  }
  if (!(await volumeExists(deps, `${input.containerName}-data`))) {
    return;
  }
  const state = await ensureLedger(deps, ledgerInput);
  await waitForDatabase(deps, ledgerUrl(password, state.port));
  deps.log(
    `ledger recreated with its secret file: container ${input.containerName}, volume ${input.containerName}-data (kept), 127.0.0.1:${state.port}`
  );
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

/** The operations every sender/recipient pair needs under V2. */
const PAIR_OPERATIONS = ["acknowledge", "claim", "receive"] as const;

/**
 * Every ordered pair of distinct configured supervisors whose grants (under
 * the sender's principal) lack an operation V2 needs: `receive` to send,
 * `claim` and `acknowledge` for the recipient to act on it. Reported only;
 * init never writes a grant.
 */
export const missingA2AV2GrantPairs = (
  supervisors: readonly Record<string, unknown>[],
  grants: unknown
): A2AV2MissingGrant[] => {
  const held = Array.isArray(grants)
    ? (grants as Record<string, unknown>[])
    : [];
  const missing: A2AV2MissingGrant[] = [];
  for (const sender of supervisors) {
    for (const recipient of supervisors) {
      const from = String(sender.supervisorId);
      const to = String(recipient.supervisorId);
      if (from === to) {
        continue;
      }
      const principal = String(sender.principal);
      const granted = new Set(
        held
          .filter(
            (grant) =>
              grant.from === from &&
              grant.to === to &&
              grant.principal === principal &&
              Array.isArray(grant.operations)
          )
          .flatMap((grant) => grant.operations as unknown[])
      );
      const operations = PAIR_OPERATIONS.filter(
        (operation) => !granted.has(operation)
      );
      if (operations.length > 0) {
        missing.push({ from, operations: [...operations], principal, to });
      }
    }
  }
  return missing;
};

/** r9: the control supervisor, or what is missing for one. */
const chooseControl = (
  supervisors: readonly Record<string, unknown>[],
  requested: string | undefined
): { entry: Record<string, unknown> } | { missing: string } => {
  const entry = requested
    ? supervisors.find((one) => one.supervisorId === requested)
    : supervisors[0];
  if (!entry) {
    return {
      missing: `--control ${String(requested)} is not a configured supervisor`,
    };
  }
  if (!PRINCIPAL_RE.test(String(entry.principal))) {
    return {
      missing: `the control principal ${String(entry.principal)} (${String(entry.supervisorId)}) is not of the form principal:<name>; pass --control <supervisor-id> naming one that is`,
    };
  }
  return { entry };
};

/** r9: no recipient; every configured supervisor is one. */
const a2aV2AllSupervisorsSectionFor = (input: {
  control: Record<string, unknown>;
  databaseUrlEnv: string;
  identity: string;
}) => ({
  databaseUrlEnv: input.databaseUrlEnv,
  // Required by the parser; unused without an r8 recipient (a lease-backed
  // descriptor's endpointRef is endpoint:<kind>).
  endpointRef: "endpoint:loop-run",
  policy: { ...DEFAULT_POLICY },
  principal: String(input.control.principal),
  resultGraphKeyEnv: A2A_V2_RESULT_GRAPH_KEY_ENV,
  routePath: "/a2a/v2",
  sessionTtlMs: 3_600_000,
  tenant: tenantFor(input.identity),
  // Owner decision (fix8): keep the legacy id format.
  workflowIdFormat: "legacy",
});

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
    // when it is ours (recreating it from its kept volume when the operator
    // removed the container), and change nothing else.
    await keepConfiguredLedger(deps, {
      configPath: options.configPath,
      containerName,
      databaseUrlEnv: current.a2aV2.databaseUrlEnv,
      envValues,
    });
    deps.log(
      `a2aV2 already configured in ${options.configPath}; config unchanged`
    );
    return { configWritten: false, envFile, ledger: "existing-config" };
  }
  const { databaseUrlEnv, ledger } = await prepareLedger(deps, {
    configPath: options.configPath,
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
  const r8 =
    options.recipient !== undefined ||
    Object.keys(options.manifests ?? {}).length > 0;
  if (!r8) {
    return await writeAllSupervisorsSection({
      configPath: options.configPath,
      controlSupervisor: options.controlSupervisor,
      databaseUrlEnv,
      deps,
      envFile,
      identity: current.identity,
      ledger,
      raw,
      supervisors,
    });
  }
  if (options.controlSupervisor !== undefined) {
    throw new Error(
      "--control applies only without --manifest and --recipient (the r8 section's principal is its recipient's)"
    );
  }
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

/**
 * r9 step 2: the section with no recipient, under the control principal,
 * written as r8's is (validated, backed up, renamed over). The missing grant
 * pairs are reported, one line each, and returned; none is written.
 */
const writeAllSupervisorsSection = (input: {
  configPath: string;
  controlSupervisor: string | undefined;
  databaseUrlEnv: string;
  deps: A2AV2InitDeps;
  envFile: string;
  identity: string;
  ledger: A2AV2InitResult["ledger"];
  raw: RawConfig;
  supervisors: Record<string, unknown>[];
}): A2AV2InitResult => {
  const control = chooseControl(input.supervisors, input.controlSupervisor);
  if ("missing" in control) {
    throw new A2AV2InitIncompleteError(
      `a2aV2 not written: ${control.missing}. The ledger and ${input.envFile} are ready; rerun init with what is missing.`,
      {
        configWritten: false,
        envFile: input.envFile,
        ledger: input.ledger,
        missing: control.missing,
      }
    );
  }
  const a2aV2 = a2aV2AllSupervisorsSectionFor({
    control: control.entry,
    databaseUrlEnv: input.databaseUrlEnv,
    identity: input.identity,
  });
  const next = { ...input.raw.value, a2aV2, supervisors: input.supervisors };
  // Validated by the server's own parser before anything is replaced.
  parseLoopOrchestrationConfig(next);
  const backupPath = replaceConfig(
    input.configPath,
    input.raw,
    next,
    input.deps.now()
  );
  const controlSupervisor = String(control.entry.supervisorId);
  input.deps.log(`backup ${backupPath}`);
  input.deps.log(
    `a2aV2 written to ${input.configPath}: every configured supervisor is a recipient (no r8 recipient), control principal ${a2aV2.principal} (${controlSupervisor}${input.controlSupervisor ? "" : ", the first supervisor; change with --control <supervisor-id>"}), workflowIdFormat legacy`
  );
  const missingGrants = missingA2AV2GrantPairs(
    input.supervisors,
    input.raw.value.grants
  );
  const pairs = input.supervisors.length * (input.supervisors.length - 1);
  input.deps.log(
    missingGrants.length === 0
      ? `grants: every sender/recipient pair holds ${PAIR_OPERATIONS.join(", ")}`
      : `grants: ${missingGrants.length} of ${pairs} sender/recipient pairs lack operations V2 needs; init never writes a grant, add each to "grants" (principal is the sender's):`
  );
  for (const entry of missingGrants) {
    input.deps.log(
      `missing grant: from ${entry.from} to ${entry.to} principal ${entry.principal} operations ${entry.operations.join(", ")}`
    );
  }
  return {
    backupPath,
    configWritten: true,
    controlSupervisor,
    envFile: input.envFile,
    ledger: input.ledger,
    missingGrants,
  };
};
