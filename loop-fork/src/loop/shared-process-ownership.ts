import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmuxRuntimeAbsentForManifestSync } from "./launch-reservation";
import {
  ancestorsOf,
  descendantsOf,
  isSignallableGroup,
  type ProcessRow,
  type ProcessSnapshot,
  parentChainOf,
  readCommandTable,
  readProcessTable,
  type TerminationTarget,
} from "./process-group";
import {
  readAgentGroupRecords,
  readRunPaneProcessRecords,
} from "./run-pane-processes";
import {
  buildManifestPath,
  isActiveRunState,
  latestInstant,
  type RecordedRunPid,
  type RunManifest,
  readAuxiliaryRunPids,
  readRunManifest,
  resolveStorageRoot,
} from "./run-state";

/**
 * Whose process is it: the shared-process guard of the dead-run teardown.
 *
 * A run's agent descendant groups are found by a ppid walk from its agent
 * panes (`recordAgentDescendantGroups`). A long-lived process started from
 * inside a run is therefore recorded as that run's even when it serves another
 * run: a `loop` launch run from an agent's tool shell starts the new run's
 * Codex app-server (detached, its own group) as a descendant of the calling
 * CLI. Tearing the calling run down must not end it, and its liveness must not
 * keep the calling run's workspace owned unless it is positively working in
 * that workspace. A daemon that re-parented away (to launchd) and that no run
 * references is the calling run's only while its cwd is in the workspace.
 *
 * Rules (`classifyGroup`), first match wins:
 *
 * 1. `shared-process-skipped`: another run that is not provably dead (its
 *    manifest is active or unreadable, or terminal while a process it
 *    records still lives or its tmux runtime is not positively gone, see
 *    `terminalRunMayBeLive`) records the process or its group (its
 *    pid, launch attempt, Codex app-server, bridge worker, `run-processes/`
 *    records or utility worker claims), or a member's command line names that
 *    run's directory, tmux socket, tmux session or `--run-id`. For a walked
 *    group the same holds for every ancestor of a member below this run's
 *    pane processes (a child that another run's app-server started in a
 *    group of its own is that run's too). Never signalled. Release evidence
 *    only while a member's cwd is inside this run's workspace (or cannot be
 *    read). For the run's own explicit records (its pane groups, its
 *    manifest's app-server, its worker targets) another run's ppid-walk
 *    records (`agent-group-*`) do not count: that run only saw the process
 *    descend from its panes, and the owner's own teardown must still end it.
 *    This run's own tmux session, socket and run id never count as naming
 *    another run.
 * 2. `ownership-unknown`: the other runs cannot all be read, or the group is
 *    not in the process table. A walked group is never signalled; release
 *    evidence. An explicit record of the run's own is judged by rule 1 on the
 *    runs that CAN be read, and is signalled only when a positive identity
 *    binds it to this run, never because the other runs say nothing: the
 *    app-server by its exact recorded listen URL, listener and start time
 *    (`run-process-cleanup`), a pane group or worker target by the reference
 *    instant it is re-identified against before every signal, a worker also
 *    by its exact command. An explicit target with no such identity is not
 *    signalled while the other runs cannot be read.
 * 3. `run-owned`: a recorded process of the run's own (an agent pane group,
 *    its manifest's app-server), or a walked group that still has a member
 *    descending from one of the run's live pane processes.
 * 4. A walked group with no member attached to the run's pane processes is
 *    re-parented away only when every member's parent chain ends at launchd
 *    (pid 1), passing only through the group itself and the run's other
 *    walked groups. A group with any other parent is `ownership-unknown`
 *    (never signalled, release evidence). A re-parented group is
 *    `reparented-in-workspace` when a member's cwd is inside the workspace
 *    (signalled and release evidence, as before); `ownership-unknown` when a
 *    cwd cannot be read; and `reparented-outside-workspace` (never signalled,
 *    not release evidence) when every member's cwd is readable and outside it
 *    AND it was seen re-parented while its pane's agent process lived (now,
 *    or by a snapshot that recorded `reparentedAt`). Seen re-parented only
 *    after its pane ended, it may be a tool orphaned by that end (or a group
 *    the teardown could not end), so it is `ownership-unknown`.
 */

export type GroupOwnershipRule =
  | "ownership-unknown"
  | "reparented-in-workspace"
  | "reparented-outside-workspace"
  | "run-owned"
  | "shared-process-skipped";

export interface GroupOwnershipVerdict {
  /** Whether the group keeps this run's workspace owned while it lives. */
  readonly count: boolean;
  readonly detail?: string;
  /** Whether this run's teardown may signal it. */
  readonly kill: boolean;
  /** The other run that records or names it (`shared-process-skipped`). */
  readonly otherRunDir?: string;
  readonly otherRunId?: string;
  readonly rule: GroupOwnershipRule;
}

export interface OtherRunIdentity {
  readonly runDir: string;
  readonly runId: string;
  readonly session?: string;
  readonly socket?: string;
}

export interface OtherRunReference extends RecordedRunPid {
  readonly runDir: string;
  readonly runId: string;
}

export interface ReadOtherRuns {
  readonly references: readonly OtherRunReference[];
  readonly runs: readonly OtherRunIdentity[];
}

export type OtherRunIndex =
  | ({ readonly kind: "read" } & ReadOtherRuns)
  | {
      readonly kind: "unknown";
      /**
       * The runs that could be read, when some could not. Only the run's
       * own explicit records consult it (see `sharedWithOtherRun`): a
       * readable live run that records or names one makes it shared,
       * whatever the unreadable ones hold.
       */
      readonly readable?: ReadOtherRuns;
      readonly reason: string;
    };

export interface OtherRunIndexOptions {
  /**
   * Whether a run's tmux runtime is positively gone, by the release rule
   * (`tmuxRuntimeAbsentForManifestSync`).
   */
  readonly runtimeAbsent?: (manifestPath: string) => boolean;
  /**
   * The process table snapshot a terminal run's recorded processes are
   * judged on. Absent, one is read (once) when a terminal run needs it.
   */
  readonly table?: readonly ProcessRow[];
}

const realOrResolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * The run storage roots to scan: the one under `HOME`, and the root the run
 * directory itself lives in when it has the storage layout
 * (`<root>/.loop/runs/<repoId>/<runId>`).
 */
export const defaultStorageRoots = (
  runDir: string,
  home: string | undefined = process.env.HOME
): string[] => {
  const roots = [resolveStorageRoot(home)];
  const parent = dirname(dirname(resolve(runDir)));
  if (basename(parent) === "runs" && basename(dirname(parent)) === ".loop") {
    roots.push(parent);
  }
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = realOrResolved(root);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const listDirectories = (
  path: string
): { kind: "read"; names: string[] } | { kind: "unknown"; reason: string } => {
  try {
    return {
      kind: "read",
      names: readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "read", names: [] };
    }
    return {
      kind: "unknown",
      reason: `${path} is unreadable: ${(error as Error).message}`,
    };
  }
};

const isPositiveSafe = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

type OtherRunRead =
  | { kind: "absent" }
  | { kind: "dead" }
  | { kind: "unknown"; reason: string }
  | {
      identity: OtherRunIdentity;
      kind: "live";
      references: OtherRunReference[];
    };

type OtherRunManifest =
  | { kind: "absent" }
  | { kind: "dead" }
  | { kind: "unknown"; reason: string }
  | { kind: "live"; manifest: RunManifest | undefined; runId: string };

const looseString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/**
 * A present manifest that is not a valid one is not provably dead: its
 * numeric pid fields and tmux identity still count.
 */
const readLooseManifest = (
  manifestPath: string,
  fallbackRunId: string
): OtherRunManifest => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      kind: "unknown",
      reason: `${manifestPath} is unreadable: ${(error as Error).message}`,
    };
  }
  const loose = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const pid = (key: string): number | undefined =>
    isPositiveSafe(loose[key]) ? (loose[key] as number) : undefined;
  return {
    kind: "live",
    manifest: {
      codexAppServerPid: pid("codexAppServerPid"),
      launchAttemptPid: pid("launchAttemptPid"),
      pid: pid("pid") ?? 0,
      tmuxSession: looseString(loose.tmuxSession),
      tmuxSocket: looseString(loose.tmuxSocket),
      updatedAt: looseString(loose.updatedAt) ?? "invalid",
    } as RunManifest,
    runId: looseString(loose.runId) ?? fallbackRunId,
  };
};

/** What a terminal run's death is judged on (see `terminalRunMayBeLive`). */
interface DeadRunProbe {
  readonly runtimeAbsent: (manifestPath: string) => boolean;
  readonly table: () => readonly ProcessRow[] | undefined;
}

/** A launch GC released without ever binding a tmux session. */
const neverBound = (manifest: RunManifest): boolean =>
  manifest.workspaceReleaseKind === "abandoned-never-bound" &&
  !manifest.tmuxSession &&
  !manifest.tmuxPaneLeft &&
  !manifest.tmuxPaneRight &&
  !manifest.tmuxPaneGoverness &&
  !manifest.tmuxPaneAuPair &&
  !manifest.tmuxPaneNanny &&
  !manifest.tmuxPaneRecon?.length;

/**
 * Why a run whose manifest is terminal may still be live, or `undefined` when
 * it is provably dead, on the release's own evidence: its pid and launch
 * attempt, and every process and group it records (app-server, bridge worker,
 * `run-processes/` records, utility worker claims), are gone from one process
 * table snapshot or provably later processes (started after the later of its
 * handback and its last update, or after the record's own instant), AND its
 * tmux runtime is positively gone (the release rule; a never-bound launch has
 * none). A terminal manifest alone proves nothing: a run marked stopped whose
 * teardown could not end a process still holds it.
 */
const terminalRunMayBeLive = (
  manifestPath: string,
  manifest: RunManifest,
  probe: DeadRunProbe
): string | undefined => {
  const table = probe.table();
  if (!table) {
    return "process table unavailable";
  }
  const rows = new Map(table.map((row) => [row.pid, row]));
  const pidLive = (pid: number, at: string): boolean => {
    const row = rows.get(pid);
    const atMs = Date.parse(at);
    return Boolean(
      row &&
        (row.startedAtMs === undefined ||
          !Number.isFinite(atMs) ||
          row.startedAtMs <= atMs)
    );
  };
  // The group rule of the release (`groupCanStillOwnRun`): a live leader is
  // judged by its start alone; with it gone, any member keeps the group live.
  const groupLive = (pgid: number, at: string): boolean =>
    isSignallableGroup(pgid) &&
    (rows.has(pgid)
      ? pidLive(pgid, at)
      : table.some((row) => row.pgid === pgid));
  const reference = latestInstant(
    ...[manifest.workspaceReleasedAt, manifest.updatedAt].filter(
      (value): value is string => typeof value === "string"
    )
  );
  for (const [source, pid] of [
    ["pid", manifest.pid],
    ["launchAttemptPid", manifest.launchAttemptPid],
  ] as const) {
    if (isPositiveSafe(pid) && pidLive(pid, reference)) {
      return `its ${source} ${pid} may be live`;
    }
  }
  const auxiliary = readAuxiliaryRunPids(manifestPath, manifest, reference);
  if (auxiliary.kind === "unreadable") {
    return auxiliary.reason;
  }
  const live = auxiliary.pids.find((entry) =>
    entry.group
      ? groupLive(entry.pid, entry.reference)
      : pidLive(entry.pid, entry.reference)
  );
  if (live) {
    return `its ${live.source} ${live.pid} may be live`;
  }
  if (!(neverBound(manifest) || probe.runtimeAbsent(manifestPath))) {
    return `its tmux session ${manifest.tmuxSession ?? "(none recorded)"} is not positively gone`;
  }
  return undefined;
};

/**
 * A run is provably dead only when its manifest is readable, in a terminal
 * state, and every process it records and its tmux runtime are positively
 * gone (`terminalRunMayBeLive`); an active, unreadable, or terminal but not
 * provably dead manifest is live. A directory with neither a manifest nor
 * process records is not a run.
 */
const readOtherRunManifest = (
  runDir: string,
  probe: DeadRunProbe
): OtherRunManifest => {
  const manifestPath = buildManifestPath(runDir);
  if (!existsSync(manifestPath)) {
    const hasEvidence =
      existsSync(join(runDir, "run-processes")) ||
      existsSync(join(runDir, "bridge-worker.json"));
    return hasEvidence
      ? { kind: "live", manifest: undefined, runId: basename(runDir) }
      : { kind: "absent" };
  }
  const manifest = readRunManifest(manifestPath);
  if (!manifest) {
    return readLooseManifest(manifestPath, basename(runDir));
  }
  if (isActiveRunState(manifest.state)) {
    return { kind: "live", manifest, runId: manifest.runId };
  }
  return terminalRunMayBeLive(manifestPath, manifest, probe) === undefined
    ? { kind: "dead" }
    : { kind: "live", manifest, runId: manifest.runId };
};

/**
 * One other run directory and every process it records. A live run whose
 * evidence cannot be read makes the whole index unknown.
 */
const readOtherRun = (runDir: string, probe: DeadRunProbe): OtherRunRead => {
  const read = readOtherRunManifest(runDir, probe);
  if (read.kind !== "live") {
    return read;
  }
  const { manifest, runId } = read;
  const reference = manifest?.updatedAt ?? "invalid";
  const auxiliary = readAuxiliaryRunPids(
    buildManifestPath(runDir),
    manifest ?? ({ updatedAt: reference } as RunManifest),
    reference
  );
  if (auxiliary.kind === "unreadable") {
    return {
      kind: "unknown",
      reason: `run ${runId} (${runDir}): ${auxiliary.reason}`,
    };
  }
  const references: OtherRunReference[] = auxiliary.pids.map((entry) => ({
    ...entry,
    runDir,
    runId,
  }));
  for (const [source, pid] of [
    ["pid", manifest?.pid],
    ["launchAttemptPid", manifest?.launchAttemptPid],
  ] as const) {
    if (isPositiveSafe(pid)) {
      references.push({ pid, reference, runDir, runId, source });
    }
  }
  return {
    identity: {
      runDir,
      runId,
      ...(manifest?.tmuxSession ? { session: manifest.tmuxSession } : {}),
      ...(manifest?.tmuxSocket ? { socket: manifest.tmuxSocket } : {}),
    },
    kind: "live",
    references,
  };
};

/** Every run directory under `roots` (`<root>/<repoId>/<runId>`), or why not. */
const listRunDirectories = (
  roots: readonly string[]
):
  | { kind: "read"; runDirs: string[] }
  | { kind: "unknown"; reason: string } => {
  const runDirs: string[] = [];
  for (const root of roots) {
    const repos = listDirectories(root);
    if (repos.kind === "unknown") {
      return repos;
    }
    for (const repo of repos.names) {
      const ids = listDirectories(join(root, repo));
      if (ids.kind === "unknown") {
        return ids;
      }
      runDirs.push(...ids.names.map((id) => join(root, repo, id)));
    }
  }
  return { kind: "read", runDirs };
};

/**
 * Every run other than `selfRunDir` under `roots` that is not provably dead,
 * with every process it records. `unknown` when any of them (or a root)
 * cannot be read; it then still carries the runs that could be (`readable`).
 */
export const readOtherRunIndex = (
  selfRunDir: string,
  roots: readonly string[],
  options: OtherRunIndexOptions = {}
): OtherRunIndex => {
  const self = new Set([resolve(selfRunDir), realOrResolved(selfRunDir)]);
  const listed = listRunDirectories(roots);
  if (listed.kind === "unknown") {
    return { ...listed, readable: { references: [], runs: [] } };
  }
  const probe: DeadRunProbe = {
    runtimeAbsent:
      options.runtimeAbsent ??
      ((manifestPath) => tmuxRuntimeAbsentForManifestSync(manifestPath)),
    table: options.table ? () => options.table : memo(readProcessTable),
  };
  const runs: OtherRunIdentity[] = [];
  const references: OtherRunReference[] = [];
  let unreadable: string | undefined;
  for (const runDir of listed.runDirs) {
    if (self.has(resolve(runDir)) || self.has(realOrResolved(runDir))) {
      continue;
    }
    const read = readOtherRun(runDir, probe);
    if (read.kind === "unknown") {
      unreadable ??= read.reason;
      continue;
    }
    if (read.kind === "live") {
      runs.push(read.identity);
      references.push(...read.references);
    }
  }
  return unreadable === undefined
    ? { kind: "read", references, runs }
    : { kind: "unknown", readable: { references, runs }, reason: unreadable };
};

const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;
const WHITESPACE_RE = /\s+/;
const TOKEN_SPLIT_RE = /[\s'"=]+/;
const QUOTES_RE = /^['"]|['"]$/g;

const namesPath = (command: string, path: string): boolean =>
  path.length > 1 &&
  new RegExp(
    `${path.replace(REGEX_META_RE, "\\$&")}(?=$|[\\s'"/,;:=\\])])`
  ).test(command);

/** What a command line may name without naming another run. */
export interface SelfIdentity {
  readonly runId?: string;
  readonly session?: string;
  readonly socket?: string;
}

const samePath = (left: string, right: string): boolean =>
  left === right || resolve(left) === resolve(right);

/**
 * What of another run a command line names, or `undefined`: its run
 * directory, tmux socket, tmux session (as a whole word or `session:target`),
 * or its run id after `--run-id`. A session, socket or run id this run shares
 * is never a match (runs on one tmux server share its socket; run ids repeat
 * across repositories).
 */
export const commandNamesRun = (
  command: string,
  run: OtherRunIdentity,
  self: SelfIdentity = {}
): string | undefined => {
  if (namesPath(command, run.runDir)) {
    return "run directory";
  }
  if (
    run.socket &&
    !(self.socket && samePath(self.socket, run.socket)) &&
    namesPath(command, run.socket)
  ) {
    return "tmux socket";
  }
  const session = run.session;
  if (
    session &&
    session !== self.session &&
    command
      .split(TOKEN_SPLIT_RE)
      .some((token) => token === session || token.startsWith(`${session}:`))
  ) {
    return "tmux session";
  }
  if (run.runId !== self.runId) {
    const words = command.split(WHITESPACE_RE);
    for (let index = 0; index < words.length; index += 1) {
      const word = (words[index] ?? "").replace(QUOTES_RE, "");
      const next = (words[index + 1] ?? "").replace(QUOTES_RE, "");
      if (
        (word === "--run-id" && next === run.runId) ||
        word === `--run-id=${run.runId}`
      ) {
        return "run id";
      }
    }
  }
  return undefined;
};

/** Whether a member started by `reference` (unknown start counts as yes). */
const startedByReference = (row: ProcessRow, reference: string): boolean => {
  const referenceMs = Date.parse(reference);
  return (
    !Number.isFinite(referenceMs) ||
    row.startedAtMs === undefined ||
    row.startedAtMs <= referenceMs
  );
};

/**
 * Whether another run's record names this group or one of its members. A
 * record whose id is held only by processes started after the record's
 * instant names a later, unrelated process (see `groupProvenAt`).
 */
const referenceNames = (
  reference: RecordedRunPid,
  pgid: number,
  members: readonly ProcessRow[]
): boolean => {
  if (reference.group) {
    return (
      reference.pid === pgid &&
      members.some((row) => startedByReference(row, reference.reference))
    );
  }
  return (
    members.some(
      (row) =>
        row.pid === reference.pid &&
        startedByReference(row, reference.reference)
    ) ||
    (reference.pid === pgid &&
      members.some((row) => startedByReference(row, reference.reference)))
  );
};

/** Whether another run's record names one ancestor process. */
const referenceNamesAncestor = (
  reference: RecordedRunPid,
  ancestor: ProcessRow
): boolean =>
  (reference.group
    ? reference.pid === ancestor.pgid
    : reference.pid === ancestor.pid) &&
  startedByReference(ancestor, reference.reference);

export type SharedWith =
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly reason: string }
  | {
      readonly kind: "shared";
      readonly otherRunDir: string;
      readonly otherRunId: string;
      readonly source: string;
    };

export interface SharedCheckInput {
  /**
   * The members' ancestors (see `ancestorsOf`): a process another run
   * records or names makes every descendant group shared too.
   */
  readonly ancestors?: readonly ProcessRow[];
  readonly commands: () => ReadonlyMap<number, string> | undefined;
  /**
   * For an explicit record of this run's own: other runs' ppid-walk records
   * (`run-processes/agent-group-*`) do not make it shared.
   */
  readonly ignoreWalkRecords?: boolean;
  readonly index: () => OtherRunIndex;
  readonly members: readonly ProcessRow[];
  readonly pgid: number;
  readonly self: SelfIdentity;
}

/** The `source` of another run's ppid-walk record. */
export const WALK_RECORD_SOURCE_RE = /^run-processes\/agent-group-\d+\.json$/;

/**
 * Whether another live run records or names the group, one of its members,
 * or one of their `ancestors`.
 */
export const sharedWithOtherRun = (input: SharedCheckInput): SharedWith => {
  const index = input.index();
  if (index.kind === "unknown") {
    // For an explicit record of this run's own, a readable live run that
    // records or names it still makes it shared, whatever the unreadable
    // runs hold. A walked group stays unknown.
    const readable = input.ignoreWalkRecords ? index.readable : undefined;
    const shared = readable
      ? (recordedByOtherRun(readable.references, input) ??
        namedByOtherRun(readable.runs, input))
      : undefined;
    return shared?.kind === "shared"
      ? shared
      : { kind: "unknown", reason: index.reason };
  }
  return (
    recordedByOtherRun(index.references, input) ??
    namedByOtherRun(index.runs, input)
  );
};

/** The first other-run record naming the group, a member or an ancestor. */
const recordedByOtherRun = (
  references: readonly OtherRunReference[],
  input: SharedCheckInput
): SharedWith | undefined => {
  const ancestors = input.ancestors ?? [];
  for (const reference of references) {
    if (
      input.ignoreWalkRecords &&
      WALK_RECORD_SOURCE_RE.test(reference.source)
    ) {
      continue;
    }
    const recorded = `recorded by run ${reference.runId} as ${reference.source} (pid ${reference.pid})`;
    const direct = referenceNames(reference, input.pgid, input.members);
    const ancestor = direct
      ? undefined
      : ancestors.find((row) => referenceNamesAncestor(reference, row));
    if (direct || ancestor) {
      return {
        kind: "shared",
        otherRunDir: reference.runDir,
        otherRunId: reference.runId,
        source: ancestor
          ? `ancestor pid ${ancestor.pid}: ${recorded}`
          : recorded,
      };
    }
  }
  return undefined;
};

/** The first other run a member's or an ancestor's command line names. */
const namedByOtherRun = (
  runs: readonly OtherRunIdentity[],
  input: SharedCheckInput
): SharedWith => {
  const named = [
    ...input.members.map((row) => ({ label: "pid", row })),
    ...(input.ancestors ?? []).map((row) => ({ label: "ancestor pid", row })),
  ];
  if (runs.length === 0 || named.length === 0) {
    return { kind: "none" };
  }
  const commands = input.commands();
  if (!commands) {
    return { kind: "unknown", reason: "command lines unavailable" };
  }
  for (const { label, row } of named) {
    const command = commands.get(row.pid);
    if (!command) {
      continue;
    }
    for (const run of runs) {
      const names = commandNamesRun(command, run, input.self);
      if (names) {
        return {
          kind: "shared",
          otherRunDir: run.runDir,
          otherRunId: run.runId,
          source: `${label} ${row.pid}'s command names run ${run.runId}'s ${names}`,
        };
      }
    }
  }
  return { kind: "none" };
};

/** At most this many members' cwds are read for one group. */
export const CWD_MEMBER_LIMIT = 32;

const isInside = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Where the group's members work: `inside` when any member's cwd is inside
 * the workspace root, `outside` when every member's cwd was read and none is,
 * `unknown` otherwise (no workspace root, no member, an unreadable cwd, or
 * more members than `CWD_MEMBER_LIMIT`).
 */
export const workspacePresence = (
  members: readonly ProcessRow[],
  workspaceRoot: string | undefined,
  cwdOfPid: (pid: number) => string | undefined
): "inside" | "outside" | "unknown" => {
  if (!workspaceRoot || members.length === 0) {
    return "unknown";
  }
  const roots = [
    ...new Set([resolve(workspaceRoot), realOrResolved(workspaceRoot)]),
  ];
  let unknown = members.length > CWD_MEMBER_LIMIT;
  for (const member of members.slice(0, CWD_MEMBER_LIMIT)) {
    const cwd = cwdOfPid(member.pid);
    if (!cwd) {
      unknown = true;
      continue;
    }
    if (roots.some((root) => isInside(cwd, root))) {
      return "inside";
    }
  }
  return unknown ? "unknown" : "outside";
};

/** What the run's own ppid walk recorded about one group. */
export interface WalkedGroup {
  readonly paneId: string;
  readonly reparentedAt?: string;
}

export interface OwnershipContext {
  readonly commands: () => ReadonlyMap<number, string> | undefined;
  readonly cwdOfPid: (pid: number) => string | undefined;
  readonly index: () => OtherRunIndex;
  /** The panes (by id) whose agent process is live and proven in `table`. */
  readonly livePaneIds: ReadonlySet<string>;
  /** This run's live, proven agent pane processes in `table`. */
  readonly paneRoots: readonly number[];
  /**
   * Where an ancestor walk stops: every pane process this run recorded
   * (proven or not), so the walk never climbs into the tmux server.
   */
  readonly paneStops: ReadonlySet<number>;
  readonly self: SelfIdentity;
  readonly table: readonly ProcessRow[];
  /** This run's own walk records, by group id. */
  readonly walked: ReadonlyMap<number, WalkedGroup>;
  readonly workspaceRoot?: string;
}

/** The members of a group in the table, or the process and its group. */
export const membersOf = (
  id: number,
  kind: "group" | "process",
  table: readonly ProcessRow[]
): ProcessRow[] =>
  table.filter((row) =>
    kind === "group" ? row.pgid === id : row.pid === id || row.pgid === id
  );

/**
 * The ownership rule for one live group (or recorded process). `inferred`
 * marks a group the run holds only because the ppid walk found it (an
 * `agent-group-*` record); a recorded process of the run's own (pane group,
 * manifest app-server) is not inferred.
 */
export const classifyGroup = (
  id: number,
  ctx: OwnershipContext,
  options: { inferred: boolean; kind?: "group" | "process" }
): GroupOwnershipVerdict => {
  const members = membersOf(id, options.kind ?? "group", ctx.table);
  const shared = sharedWithOtherRun({
    ...(options.inferred
      ? { ancestors: ancestorsOf(members, ctx.table, ctx.paneStops) }
      : { ignoreWalkRecords: true }),
    commands: ctx.commands,
    index: ctx.index,
    members,
    pgid: id,
    self: ctx.self,
  });
  if (shared.kind === "shared") {
    const where = workspacePresence(members, ctx.workspaceRoot, ctx.cwdOfPid);
    return {
      count: where !== "outside",
      detail: `${shared.source}; cwd ${where} this run's workspace`,
      kill: false,
      otherRunDir: shared.otherRunDir,
      otherRunId: shared.otherRunId,
      rule: "shared-process-skipped",
    };
  }
  if (!options.inferred) {
    return { count: true, kill: true, rule: "run-owned" };
  }
  if (shared.kind === "unknown") {
    return {
      count: true,
      detail: `other runs unreadable: ${shared.reason}`,
      kill: false,
      rule: "ownership-unknown",
    };
  }
  if (members.length === 0) {
    return {
      count: true,
      detail: "no member in the process table",
      kill: false,
      rule: "ownership-unknown",
    };
  }
  const attached = new Set(
    descendantsOf(ctx.paneRoots, ctx.table).map((row) => row.pid)
  );
  if (members.some((row) => attached.has(row.pid))) {
    return { count: true, kill: true, rule: "run-owned" };
  }
  // Re-parented away means to launchd, reached only through the group and
  // the run's own other walked groups; any other parent may be another run's
  // or a stranger's, so its ownership is unknown.
  const chain = parentChainOf(id, ctx.table, new Set(ctx.walked.keys()));
  if (chain.kind !== "launchd") {
    return {
      count: true,
      detail:
        chain.kind === "parent"
          ? `parent ${chain.pid} is neither this run's pane tree nor launchd`
          : "no member in the process table",
      kill: false,
      rule: "ownership-unknown",
    };
  }
  const where = workspacePresence(members, ctx.workspaceRoot, ctx.cwdOfPid);
  if (where === "inside") {
    return {
      count: true,
      detail: "re-parented to launchd; cwd inside the workspace",
      kill: true,
      rule: "reparented-in-workspace",
    };
  }
  if (where === "unknown") {
    return {
      count: true,
      detail: "re-parented to launchd; cwd unknown",
      kill: false,
      rule: "ownership-unknown",
    };
  }
  const walked = ctx.walked.get(id);
  const seenWhilePaneLived =
    walked !== undefined &&
    (walked.reparentedAt !== undefined || ctx.livePaneIds.has(walked.paneId));
  if (!seenWhilePaneLived) {
    return {
      count: true,
      detail:
        "re-parented to launchd, cwd outside the workspace, but never seen re-parented while its pane lived (it may be a tool its pane's end orphaned)",
      kill: false,
      rule: "ownership-unknown",
    };
  }
  return {
    count: false,
    detail: `re-parented to launchd${walked.reparentedAt ? ` (seen at ${walked.reparentedAt})` : ""} while its pane lived; cwd outside the workspace`,
    kill: false,
    rule: "reparented-outside-workspace",
  };
};

/** This run's agent pane records whose process is provably live in `table`. */
const provenPanes = (
  runDir: string,
  table: readonly ProcessRow[]
): Array<{ paneId: string; pid: number }> => {
  const rows = new Map(table.map((row) => [row.pid, row]));
  return readRunPaneProcessRecords(runDir).flatMap((pane) => {
    const row = rows.get(pane.pid);
    const recordedMs = Date.parse(pane.recordedAt);
    return row &&
      row.pgid === pane.pgid &&
      Number.isFinite(recordedMs) &&
      row.startedAtMs !== undefined &&
      row.startedAtMs <= recordedMs
      ? [{ paneId: pane.paneId, pid: pane.pid }]
      : [];
  });
};

/** This run's agent pane processes that are provably the recorded ones. */
export const provenPaneRoots = (
  runDir: string,
  table: readonly ProcessRow[]
): number[] => provenPanes(runDir, table).map((pane) => pane.pid);

/** Every pane process this run recorded: where an ancestor walk stops. */
const paneStopsOf = (runDir: string): Set<number> =>
  new Set(readRunPaneProcessRecords(runDir).map((pane) => pane.pid));

/** This run's own walk records, by group id. */
const walkedGroupsOf = (runDir: string): Map<number, WalkedGroup> =>
  new Map(
    readAgentGroupRecords(runDir).map((record) => [
      record.pgid,
      {
        paneId: record.paneId,
        ...(record.reparentedAt ? { reparentedAt: record.reparentedAt } : {}),
      },
    ])
  );

const SYSTEM_LSOF = "/usr/sbin/lsof";

/** The cwd of `pid` (`lsof -a -p <pid> -d cwd`), or `undefined`. */
export const readCwdOfPid = (pid: number): string | undefined => {
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    return undefined;
  }
  const result = spawnSync(
    // macOS keeps lsof in /usr/sbin, which a minimal PATH may lack.
    existsSync(SYSTEM_LSOF) ? SYSTEM_LSOF : "lsof",
    ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    {
      encoding: "utf8",
      timeout: 3000,
    }
  );
  if (result.status !== 0 || result.error) {
    return undefined;
  }
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("n"));
  return line && line.length > 1 ? line.slice(1) : undefined;
};

const memo = <T>(read: () => T): (() => T) => {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = read();
      done = true;
    }
    return value;
  };
};

export interface OwnershipProbes {
  commandTable: () => ReadonlyMap<number, string> | undefined;
  cwdOfPid: (pid: number) => string | undefined;
  /**
   * The other runs, judged (for a terminal one, whether it is provably dead)
   * on `table` when the caller has a snapshot.
   */
  otherRunIndex: (
    runDir: string,
    table?: readonly ProcessRow[]
  ) => OtherRunIndex;
  processTable: () => readonly ProcessRow[] | undefined;
}

export const defaultOwnershipProbes: OwnershipProbes = {
  commandTable: readCommandTable,
  cwdOfPid: readCwdOfPid,
  otherRunIndex: (runDir, table) =>
    readOtherRunIndex(runDir, defaultStorageRoots(runDir), {
      ...(table ? { table } : {}),
    }),
  processTable: readProcessTable,
};

/** The workspace root a run's processes may write: its binding, else its cwd. */
export const workspaceRootOf = (
  manifest: Pick<RunManifest, "cwd" | "workspaceBinding"> | undefined
): string | undefined =>
  manifest?.workspaceBinding?.root || manifest?.cwd || undefined;

/**
 * The run id, tmux session and tmux socket a command may name without naming
 * another run.
 */
export const selfOf = (
  manifest:
    | Pick<RunManifest, "runId" | "tmuxSession" | "tmuxSocket">
    | undefined
): SelfIdentity => ({
  ...(manifest?.runId ? { runId: manifest.runId } : {}),
  ...(manifest?.tmuxSession ? { session: manifest.tmuxSession } : {}),
  ...(manifest?.tmuxSocket ? { socket: manifest.tmuxSocket } : {}),
});

/** An ownership context over one table snapshot, with lazy probes. */
export const ownershipContext = (input: {
  manifest: RunManifest | undefined;
  probes: OwnershipProbes;
  runDir: string;
  table: readonly ProcessRow[];
}): OwnershipContext => {
  const panes = provenPanes(input.runDir, input.table);
  return {
    commands: memo(input.probes.commandTable),
    cwdOfPid: input.probes.cwdOfPid,
    index: memo(() => input.probes.otherRunIndex(input.runDir, input.table)),
    livePaneIds: new Set(panes.map((pane) => pane.paneId)),
    paneRoots: panes.map((pane) => pane.pid),
    paneStops: paneStopsOf(input.runDir),
    self: selfOf(input.manifest),
    table: input.table,
    walked: walkedGroupsOf(input.runDir),
    ...(workspaceRootOf(input.manifest)
      ? { workspaceRoot: workspaceRootOf(input.manifest) }
      : {}),
  };
};

export interface RecordedProcessVerdict {
  readonly count: boolean;
  readonly detail?: string;
  readonly otherRunId?: string;
  readonly rule: string;
}

/**
 * The release-evidence classifier: whether a live recorded process of the run
 * keeps its workspace owned. Only the two kinds another run can hold too are
 * judged (the manifest's Codex app-server and the ppid walk's descendant
 * groups); every other record counts as before. Without a process table every
 * record counts.
 */
export const recordedProcessClassifier =
  (
    probes: OwnershipProbes = defaultOwnershipProbes,
    onExcluded?: (entry: RecordedRunPid, verdict: GroupOwnershipVerdict) => void
  ) =>
  (manifestPath: string, manifest: RunManifest) => {
    const runDir = dirname(manifestPath);
    const context = memo(() => {
      const table = probes.processTable();
      return table
        ? ownershipContext({ manifest, probes, runDir, table })
        : undefined;
    });
    return (entry: RecordedRunPid): RecordedProcessVerdict => {
      const appServer = entry.source === "codexAppServerPid";
      const inferred = WALK_RECORD_SOURCE_RE.test(entry.source);
      if (!(appServer || inferred)) {
        return { count: true, rule: "recorded" };
      }
      const ctx = context();
      if (!ctx) {
        return {
          count: true,
          detail: "process table unavailable",
          rule: "ownership-unknown",
        };
      }
      const verdict = classifyGroup(entry.pid, ctx, {
        inferred,
        kind: appServer ? "process" : "group",
      });
      if (!verdict.count) {
        onExcluded?.(entry, verdict);
      }
      return {
        count: verdict.count,
        rule: verdict.rule,
        ...(verdict.detail ? { detail: verdict.detail } : {}),
        ...(verdict.otherRunId ? { otherRunId: verdict.otherRunId } : {}),
      };
    };
  };

export interface SharedTargetSkip {
  readonly detail: string;
  readonly otherRunId?: string;
  readonly reason: "ownership-unknown" | "shared-process-skipped";
}

/**
 * The pre-signal shared-process check of a teardown: on the signal round's
 * process snapshot (`ProcessSnapshot`: the same table and command lines the
 * round's identity re-check reads; a fresh read without one) and a fresh read
 * of the other runs, every target another live run records or names is
 * skipped (for an `inferred` target, also when it names one of its members'
 * ancestors; for any other target, never by another run's walk record alone,
 * and also when a readable run records it while others cannot be read). When
 * the other runs cannot all be read, every `inferred` target is skipped, and
 * so is an explicit target that carries no positive identity (neither a
 * reference instant nor a worker identity). Keys are `kind:id`. Without a
 * table every inferred target is skipped (its ownership cannot be judged).
 */
export const sharedTargetCheck =
  (
    runDir: string,
    manifest: () => RunManifest | undefined,
    probes: OwnershipProbes = defaultOwnershipProbes
  ) =>
  (
    targets: readonly TerminationTarget[],
    snapshot?: ProcessSnapshot
  ): Map<string, SharedTargetSkip> => {
    const skips = new Map<string, SharedTargetSkip>();
    const table = snapshot ? snapshot.table : probes.processTable();
    const commands = snapshot ? snapshot.commands : memo(probes.commandTable);
    const index = memo(() => probes.otherRunIndex(runDir, table));
    const self = selfOf(manifest());
    const stops = memo(() => paneStopsOf(runDir));
    for (const target of targets) {
      const members = table ? membersOf(target.id, target.kind, table) : [];
      const shared: SharedWith = table
        ? sharedWithOtherRun({
            ...(target.ownership === "inferred"
              ? { ancestors: ancestorsOf(members, table, stops()) }
              : { ignoreWalkRecords: true }),
            commands,
            index,
            members,
            pgid: target.id,
            self,
          })
        : { kind: "unknown", reason: "process table unavailable" };
      const skip = targetSkip(shared, target);
      if (skip) {
        skips.set(`${target.kind}:${target.id}`, skip);
      }
    }
    return skips;
  };

/**
 * A target is skipped when shared. When its ownership cannot be judged, an
 * inferred target always is, and an explicit one unless a positive identity
 * binds it to this run (a reference instant it is re-identified against, or
 * a worker identity).
 */
const targetSkip = (
  shared: SharedWith,
  target: TerminationTarget
): SharedTargetSkip | undefined => {
  if (shared.kind === "shared") {
    return {
      detail: shared.source,
      otherRunId: shared.otherRunId,
      reason: "shared-process-skipped",
    };
  }
  if (shared.kind !== "unknown") {
    return undefined;
  }
  if (target.ownership === "inferred") {
    return { detail: shared.reason, reason: "ownership-unknown" };
  }
  return target.reference === undefined && target.identity === undefined
    ? {
        detail: `${shared.reason}; no identity binds it to this run`,
        reason: "ownership-unknown",
      }
    : undefined;
};
