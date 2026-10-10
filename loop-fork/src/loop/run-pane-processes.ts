import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  descendantsOf,
  type ProcessRow,
  processGroupOf,
} from "./process-group";

/**
 * Agent pane processes as recorded run processes.
 *
 * The Claude and Codex CLIs run as the processes of their tmux panes, in the
 * pane's process group; their tool subprocesses run with their cwd in the
 * workspace, mostly in groups of their own (see `recordAgentDescendantGroups`
 * below). Nothing recorded them, so a teardown released the workspace
 * as soon as tmux reported the session gone, while a tool subprocess that
 * survived the hangup could still be writing there. Each pane's pid and
 * process group is recorded under `run-processes/` at launch and on resume or
 * re-attach (and again by the teardown, for a pane that was respawned), and
 * the release evidence treats the group as live while any member exists.
 *
 * A record is never removed: a gone group is the absence evidence the release
 * reads. A pane whose process changes (respawn) gets a new record beside the
 * old one, so a survivor of the old process stays tracked.
 */

export const PANE_PROCESS_KIND = "agent-pane";
const PANE_PROCESS_PREFIX = "pane-";
const PROCESS_REGISTRY_DIR = "run-processes";
const PANE_ID_RE = /^%\d+$/;
const LINE_RE = /\r?\n/;
const WHITESPACE_RE = /\s+/;

export interface PaneProcessRecord {
  readonly kind: typeof PANE_PROCESS_KIND;
  readonly paneId: string;
  readonly pgid: number;
  readonly pid: number;
  readonly recordedAt: string;
  readonly runDir: string;
  readonly session: string;
}

export interface ListedPane {
  readonly paneId: string;
  readonly pid: number;
}

/** Pane fields of a run manifest (structural, so this module needs no import). */
export interface ManifestPaneFields {
  readonly tmuxPaneAuPair?: string;
  readonly tmuxPaneGoverness?: string;
  readonly tmuxPaneLeft?: string;
  readonly tmuxPaneNanny?: string;
  readonly tmuxPaneRecon?: readonly string[];
  readonly tmuxPaneRight?: string;
  readonly tmuxPaneUtility?: string;
}

/**
 * Every pane of the run but the governess's own: the agent seats and the
 * helper panes. Never the governess pane, whose process runs the teardown.
 */
export const agentPaneIdsOf = (manifest: ManifestPaneFields): string[] =>
  [
    manifest.tmuxPaneLeft,
    manifest.tmuxPaneRight,
    manifest.tmuxPaneUtility,
    manifest.tmuxPaneAuPair,
    manifest.tmuxPaneNanny,
    ...(manifest.tmuxPaneRecon ?? []),
  ].filter(
    (pane): pane is string =>
      typeof pane === "string" &&
      pane.length > 0 &&
      pane !== manifest.tmuxPaneGoverness
  );

/** The `-F` format every pane listing for these records uses. */
export const PANE_LISTING_FORMAT = "#{pane_id} #{pane_pid}";

/** Parses `#{pane_id} #{pane_pid}` lines; malformed lines are dropped. */
export const parsePaneListing = (stdout: string): ListedPane[] =>
  stdout
    .split(LINE_RE)
    .map((line) => line.trim().split(WHITESPACE_RE))
    .flatMap(([paneId, pidText]) => {
      const pid = Number.parseInt(pidText ?? "", 10);
      return paneId &&
        PANE_ID_RE.test(paneId) &&
        Number.isSafeInteger(pid) &&
        pid > 1 &&
        String(pid) === pidText
        ? [{ paneId, pid }]
        : [];
    });

const recordFileName = (paneId: string, pid: number): string =>
  `${PANE_PROCESS_PREFIX}${paneId.replace("%", "")}-${pid}.json`;

export interface RecordPaneProcessesInput {
  /**
   * The run's agent panes, by the ids its manifest records. Only these are
   * recorded: the governess's own pane never is (the teardown that releases
   * the workspace runs in it), nor is any pane the manifest does not name.
   */
  readonly agentPaneIds: ReadonlyArray<string | undefined>;
  readonly now: () => string;
  readonly panes: readonly ListedPane[];
  /** `undefined` when `ps` cannot say; the pane's own pid is then used. */
  readonly pgidOf?: (pid: number) => number | undefined;
  readonly runDir: string;
  readonly session: string;
}

/**
 * Writes one record per listed pane that has none yet, atomically (written
 * beside the run directory, then renamed into `run-processes/`, so a reader
 * never sees a partial record). A pane process is a session and group leader
 * (tmux setsid()s it), so its group falls back to its own pid when `ps` cannot
 * say. Returns the record of every listed agent pane.
 */
export const recordRunPaneProcesses = (
  input: RecordPaneProcessesInput
): PaneProcessRecord[] => {
  const agentPanes = new Set(input.agentPaneIds.filter(Boolean));
  const dir = join(input.runDir, PROCESS_REGISTRY_DIR);
  const pgidOf = input.pgidOf ?? processGroupOf;
  const records: PaneProcessRecord[] = [];
  for (const pane of input.panes) {
    if (!agentPanes.has(pane.paneId)) {
      continue;
    }
    const path = join(dir, recordFileName(pane.paneId, pane.pid));
    const existing = readPaneRecord(path);
    if (existing) {
      records.push(existing);
      continue;
    }
    const record: PaneProcessRecord = {
      kind: PANE_PROCESS_KIND,
      paneId: pane.paneId,
      pgid: pgidOf(pane.pid) ?? pane.pid,
      pid: pane.pid,
      recordedAt: input.now(),
      runDir: input.runDir,
      session: input.session,
    };
    mkdirSync(dir, { recursive: true });
    const temporary = join(
      input.runDir,
      `.${recordFileName(pane.paneId, pane.pid)}.${process.pid}.tmp`
    );
    try {
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, "utf8");
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) {
        rmSync(temporary, { force: true });
      }
    }
    records.push(record);
  }
  return records;
};

const isPositiveSafe = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A well-formed pane record, or `undefined`. */
export const parsePaneRecord = (
  value: unknown
): PaneProcessRecord | undefined => {
  const record = value as Partial<PaneProcessRecord> | null;
  return record &&
    record.kind === PANE_PROCESS_KIND &&
    typeof record.paneId === "string" &&
    isPositiveSafe(record.pid) &&
    isPositiveSafe(record.pgid) &&
    typeof record.runDir === "string" &&
    typeof record.session === "string" &&
    typeof record.recordedAt === "string"
    ? (record as PaneProcessRecord)
    : undefined;
};

const readPaneRecord = (path: string): PaneProcessRecord | undefined => {
  try {
    return parsePaneRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
};

/** Every well-formed pane record of the run. */
export const readRunPaneProcessRecords = (
  runDir: string
): PaneProcessRecord[] => {
  const dir = join(runDir, PROCESS_REGISTRY_DIR);
  let files: string[];
  try {
    files = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return files
    .filter(
      (file) => file.startsWith(PANE_PROCESS_PREFIX) && file.endsWith(".json")
    )
    .flatMap((file) => {
      const record = readPaneRecord(join(dir, file));
      return record && record.runDir === runDir ? [record] : [];
    });
};

/**
 * The process groups of the agent CLIs' descendants.
 *
 * The real CLIs do not keep their tool subprocesses in the pane's group:
 * Claude Code starts each Bash tool shell as a session leader (its own group),
 * and Codex starts each exec command and MCP server in a group of its own. A
 * build or test such a tool runs can keep writing in the workspace after the
 * session kill while the pane group is empty. So, while the CLIs are still the
 * parents, each agent pane process's descendants are found by a ppid walk over
 * one process table snapshot, and every group they are in (other than the pane
 * groups themselves) is recorded as `run-processes/agent-group-<pgid>.json`.
 * The release evidence treats each such group as live while any member exists,
 * and the teardown ends them after the session kill.
 *
 * Snapshots are taken at launch, on a resume that re-attaches, periodically by
 * the governess, and by the teardown right before its session kill. A
 * descendant that leaves every recorded group AND loses its parent chain to
 * the CLI between two snapshots (a double fork that also calls setsid) is not
 * seen. Records of groups that are gone are pruned by later snapshots (a gone
 * group never comes back: a reused id is a new, unrelated group), so the
 * directory does not grow with every tool call.
 */

export const AGENT_GROUP_KIND = "agent-descendant-group";
const AGENT_GROUP_PREFIX = "agent-group-";

export interface AgentGroupRecord {
  readonly kind: typeof AGENT_GROUP_KIND;
  /** The agent pane whose process the group's member descends from. */
  readonly paneId: string;
  readonly pgid: number;
  readonly recordedAt: string;
  readonly runDir: string;
}

const agentGroupFileName = (pgid: number): string =>
  `${AGENT_GROUP_PREFIX}${pgid}.json`;

/** A well-formed descendant group record, or `undefined`. */
export const parseAgentGroupRecord = (
  value: unknown
): AgentGroupRecord | undefined => {
  const record = value as Partial<AgentGroupRecord> | null;
  return record &&
    record.kind === AGENT_GROUP_KIND &&
    typeof record.paneId === "string" &&
    isPositiveSafe(record.pgid) &&
    record.pgid > 1 &&
    typeof record.runDir === "string" &&
    typeof record.recordedAt === "string" &&
    Number.isFinite(Date.parse(record.recordedAt))
    ? (record as AgentGroupRecord)
    : undefined;
};

const readAgentGroupRecord = (path: string): AgentGroupRecord | undefined => {
  try {
    return parseAgentGroupRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
};

const agentGroupFiles = (runDir: string): string[] => {
  try {
    return readdirSync(join(runDir, PROCESS_REGISTRY_DIR))
      .filter(
        (file) => file.startsWith(AGENT_GROUP_PREFIX) && file.endsWith(".json")
      )
      .sort();
  } catch {
    return [];
  }
};

/** Every well-formed descendant group record of the run. */
export const readAgentGroupRecords = (runDir: string): AgentGroupRecord[] =>
  agentGroupFiles(runDir).flatMap((file) => {
    const record = readAgentGroupRecord(
      join(runDir, PROCESS_REGISTRY_DIR, file)
    );
    return record && record.runDir === runDir ? [record] : [];
  });

export interface RecordAgentGroupsInput {
  /** Whether any process is a member of the group (`kill(-pgid, 0)`). */
  readonly groupAlive: (pgid: number) => boolean;
  readonly now: () => string;
  /** This process's own group, never recorded. */
  readonly ownGroup?: number;
  readonly runDir: string;
  /** One snapshot of the whole process table. */
  readonly table: readonly ProcessRow[];
}

export interface RecordAgentGroupsResult {
  /** Gone groups whose records this snapshot removed. */
  readonly pruned: number[];
  /** Records of the groups found in this snapshot (written or kept). */
  readonly records: AgentGroupRecord[];
}

const startedBy = (row: ProcessRow, referenceMs: number): boolean =>
  row.startedAtMs !== undefined && row.startedAtMs <= referenceMs;

/**
 * Records the groups of every live descendant of the run's agent pane
 * processes, from one table snapshot. A pane process is walked only while it
 * is provably the recorded one: the live process with its pid is in the
 * recorded group and started by the record's instant (a reused pid would
 * otherwise make an unrelated tree look like the run's). An existing record
 * of the same group is kept; one whose id now names a later group (no member
 * started by its instant) is replaced. Every record (pane or descendant) whose
 * group is provably still the recorded one is moved up to this snapshot's
 * instant (`advanceProvenRecords`). Records of groups absent from the snapshot
 * and from `kill(-pgid, 0)` are removed.
 */
export const recordAgentDescendantGroups = (
  input: RecordAgentGroupsInput
): RecordAgentGroupsResult => {
  const panes = readRunPaneProcessRecords(input.runDir);
  const paneGroups = new Set(panes.map((pane) => pane.pgid));
  const rows = new Map(input.table.map((row) => [row.pid, row]));
  const found = new Map<number, string>();
  for (const pane of panes) {
    const row = rows.get(pane.pid);
    const recordedMs = Date.parse(pane.recordedAt);
    if (
      !(
        row &&
        row.pgid === pane.pgid &&
        Number.isFinite(recordedMs) &&
        startedBy(row, recordedMs)
      )
    ) {
      continue;
    }
    for (const descendant of descendantsOf([pane.pid], input.table)) {
      const pgid = descendant.pgid;
      if (
        pgid > 1 &&
        !paneGroups.has(pgid) &&
        pgid !== input.ownGroup &&
        !found.has(pgid)
      ) {
        found.set(pgid, pane.paneId);
      }
    }
  }
  const dir = join(input.runDir, PROCESS_REGISTRY_DIR);
  const now = input.now();
  const records: AgentGroupRecord[] = [];
  for (const [pgid, paneId] of found) {
    const existing = readAgentGroupRecord(join(dir, agentGroupFileName(pgid)));
    if (
      existing &&
      existing.runDir === input.runDir &&
      groupProvenAt(pgid, existing.recordedAt, input.table)
    ) {
      records.push(existing);
      continue;
    }
    const record: AgentGroupRecord = {
      kind: AGENT_GROUP_KIND,
      paneId,
      pgid,
      recordedAt: now,
      runDir: input.runDir,
    };
    writeRecordAtomically(input.runDir, agentGroupFileName(pgid), record);
    records.push(record);
  }
  advanceProvenRecords(input.runDir, input.table, now);
  const live = new Set(input.table.map((row) => row.pgid));
  const pruned: number[] = [];
  for (const file of agentGroupFiles(input.runDir)) {
    const record = readAgentGroupRecord(join(dir, file));
    // A malformed record is never pruned: it stays unreadable evidence.
    if (
      !record ||
      found.has(record.pgid) ||
      live.has(record.pgid) ||
      input.groupAlive(record.pgid)
    ) {
      continue;
    }
    rmSync(join(dir, file), { force: true });
    pruned.push(record.pgid);
  }
  return { pruned, records };
};

/**
 * Whether group `pgid` in `table` is provably the group recorded at
 * `recordedAt`: some member started by that instant. A group id reused after
 * the recorded group emptied belongs to a later group, whose members all
 * started after its creation (see `targetStillRecorded`).
 */
export const groupProvenAt = (
  pgid: number,
  recordedAt: string,
  table: readonly ProcessRow[]
): boolean => {
  const recordedMs = Date.parse(recordedAt);
  return (
    Number.isFinite(recordedMs) &&
    table.some((row) => row.pgid === pgid && startedBy(row, recordedMs))
  );
};

/**
 * Moves each record's instant up to this snapshot while its group is provably
 * still the recorded one. Identity is then carried from snapshot to snapshot,
 * so a group whose original members (the pane CLI, a tool's shell) have exited
 * while later members (a build it started) remain is still identified, and a
 * teardown can end it. A record that cannot be proven keeps its instant: it
 * stays release evidence but is never a termination target.
 */
const advanceProvenRecords = (
  runDir: string,
  table: readonly ProcessRow[],
  now: string
): void => {
  const nowMs = Date.parse(now);
  const stale = (recordedAt: string): boolean =>
    Number.isFinite(nowMs) && Date.parse(recordedAt) < nowMs;
  for (const pane of readRunPaneProcessRecords(runDir)) {
    if (
      stale(pane.recordedAt) &&
      groupProvenAt(pane.pgid, pane.recordedAt, table)
    ) {
      writeRecordAtomically(runDir, recordFileName(pane.paneId, pane.pid), {
        ...pane,
        recordedAt: now,
      });
    }
  }
  for (const group of readAgentGroupRecords(runDir)) {
    if (
      stale(group.recordedAt) &&
      groupProvenAt(group.pgid, group.recordedAt, table)
    ) {
      writeRecordAtomically(runDir, agentGroupFileName(group.pgid), {
        ...group,
        recordedAt: now,
      });
    }
  }
};

const writeRecordAtomically = (
  runDir: string,
  fileName: string,
  record: unknown
): void => {
  mkdirSync(join(runDir, PROCESS_REGISTRY_DIR), { recursive: true });
  const temporary = join(runDir, `.${fileName}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, "utf8");
    renameSync(temporary, join(runDir, PROCESS_REGISTRY_DIR, fileName));
  } finally {
    if (existsSync(temporary)) {
      rmSync(temporary, { force: true });
    }
  }
};
