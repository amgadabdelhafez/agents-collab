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
import { processGroupOf } from "./process-group";

/**
 * Agent pane processes as recorded run processes.
 *
 * The Claude and Codex CLIs run as the processes of their tmux panes, and
 * their tool subprocesses run in the pane's process group with their cwd in
 * the workspace. Nothing recorded them, so a teardown released the workspace
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
