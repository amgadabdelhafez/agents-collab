import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "bun";
import {
  isActiveRunState,
  type ManifestHandle,
  type RunManifest,
  readRunManifest,
  readRunManifestHandle,
} from "./run-state";
import { boundedTmuxOptions, tmuxCommandTimedOut } from "./tmux-control";
import {
  manifestSocketState,
  type OwnedPaneTarget,
  paneArgv,
  paneTargetFromManifest,
} from "./tmux-socket";

export const GOVERNESS_PANE_DIED_SUBCOMMAND = "__governess-pane-died";
export const GOVERNESS_LIVENESS_FILE = "governess-liveness.jsonl";
export const GOVERNESS_RESTART_LIMIT = 3;
export const GOVERNESS_RESTART_WINDOW_MS = 5 * 60 * 1000;
export const GOVERNESS_DEAD_PANE_BORDER_FORMAT =
  "#{?pane_dead,#[fg=red,bold]STOPPED #{@loop_label}#[default],#{@loop_label}}";
export const GOVERNESS_REMAIN_ON_EXIT_FORMAT =
  "#[fg=red,bold]STOPPED#[default] #{@loop_label} (exit #{pane_dead_status}) - bounded recovery";

const MAX_JOURNAL_BYTES = 1024 * 1024;
const LINE_SPLIT_RE = /\r?\n/u;
const PANE_ID_RE = /^%\d+$/u;
const POSITIONAL_PANE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*:\d+\.\d+$/u;
const SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;

type LivenessEventName =
  | "respawn-attempt"
  | "respawn-failed"
  | "respawned"
  | "suppressed";

export interface GovernessPaneLivenessEvent {
  at: string;
  event: LivenessEventName;
  pane: string;
  pid: number;
  reason?: string;
  session: string;
}

interface PaneSnapshot {
  dead: boolean;
  id: string;
  session: string;
}

interface JournalRead {
  ok: boolean;
  text: string;
}

export interface GovernessPaneDiedInput {
  pane: string;
  runDir: string;
  session: string;
}

export interface GovernessPaneDiedResult {
  action: "failed" | "respawned" | "spared" | "suppressed";
  attemptsInWindow: number;
  reason: string;
}

export interface GovernessPaneLivenessDeps {
  appendEvent: (path: string, event: GovernessPaneLivenessEvent) => boolean;
  inspectPane: (target: OwnedPaneTarget) => PaneSnapshot | undefined;
  now: () => Date;
  readHandle: (path: string) => ManifestHandle | undefined;
  readJournal: (path: string) => JournalRead;
  readManifest: (path: string) => RunManifest | undefined;
  respawnPane: (target: OwnedPaneTarget) => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isLivenessEventName = (value: unknown): value is LivenessEventName =>
  value === "respawn-attempt" ||
  value === "respawn-failed" ||
  value === "respawned" ||
  value === "suppressed";

const parseJournal = (
  text: string
): { attempts: GovernessPaneLivenessEvent[]; ok: boolean } => {
  const attempts: GovernessPaneLivenessEvent[] = [];
  for (const line of text.split(LINE_SPLIT_RE)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { attempts: [], ok: false };
    }
    if (
      !(
        isRecord(parsed) &&
        typeof parsed.at === "string" &&
        Number.isFinite(Date.parse(parsed.at)) &&
        isLivenessEventName(parsed.event) &&
        typeof parsed.pane === "string" &&
        typeof parsed.pid === "number" &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.session === "string" &&
        (parsed.reason === undefined || typeof parsed.reason === "string")
      )
    ) {
      return { attempts: [], ok: false };
    }
    if (parsed.event === "respawn-attempt") {
      attempts.push(parsed as unknown as GovernessPaneLivenessEvent);
    }
  }
  return { attempts, ok: true };
};

const manifestOwnsPane = (
  manifest: RunManifest | undefined,
  input: GovernessPaneDiedInput
): boolean =>
  Boolean(
    manifest &&
      isActiveRunState(manifest.state) &&
      manifest.tmuxSession === input.session &&
      manifest.tmuxPaneGoverness === input.pane
  );

const snapshotMatches = (
  snapshot: PaneSnapshot | undefined,
  input: GovernessPaneDiedInput
): boolean =>
  Boolean(
    snapshot?.dead &&
      snapshot.session === input.session &&
      (!PANE_ID_RE.test(input.pane) || snapshot.id === input.pane)
  );

const defaultReadJournal = (path: string): JournalRead => {
  try {
    if (!existsSync(path)) {
      return { ok: true, text: "" };
    }
    if (statSync(path).size > MAX_JOURNAL_BYTES) {
      return { ok: false, text: "" };
    }
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch {
    return { ok: false, text: "" };
  }
};

const defaultAppendEvent = (
  path: string,
  event: GovernessPaneLivenessEvent
): boolean => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
};

const runTmux = (argv: string[]): ReturnType<typeof spawnSync> =>
  spawnSync(argv, boundedTmuxOptions({ stderr: "ignore", stdout: "pipe" }));

export const governessInspectPaneArgs = (target: OwnedPaneTarget): string[] =>
  paneArgv(target, "display-message", [
    "-p",
    "#{session_name}\t#{pane_id}\t#{pane_dead}",
  ]);

const defaultInspectPane = (
  target: OwnedPaneTarget
): PaneSnapshot | undefined => {
  const result = runTmux(governessInspectPaneArgs(target));
  if (tmuxCommandTimedOut(result) || result.exitCode !== 0) {
    return undefined;
  }
  const [actualSession, id, dead] = (result.stdout?.toString() ?? "")
    .trim()
    .split("\t");
  if (!(actualSession && id && (dead === "0" || dead === "1"))) {
    return undefined;
  }
  return { dead: dead === "1", id, session: actualSession };
};

export const governessRespawnPaneArgs = (target: OwnedPaneTarget): string[] =>
  paneArgv(target, "respawn-pane", ["-k"]);

const defaultRespawnPane = (target: OwnedPaneTarget): boolean => {
  const result = runTmux(governessRespawnPaneArgs(target));
  return !tmuxCommandTimedOut(result) && result.exitCode === 0;
};

export const defaultGovernessPaneLivenessDeps =
  (): GovernessPaneLivenessDeps => ({
    appendEvent: defaultAppendEvent,
    inspectPane: defaultInspectPane,
    now: () => new Date(),
    readHandle: (path) => readRunManifestHandle(path),
    readJournal: defaultReadJournal,
    readManifest: (path) => readRunManifest(path),
    respawnPane: defaultRespawnPane,
  });

const ownedGovernessPane = (
  handle: ManifestHandle | undefined
): OwnedPaneTarget | undefined =>
  handle ? paneTargetFromManifest(handle, "tmuxPaneGoverness") : undefined;

const unavailableTargetReason = (handle: ManifestHandle | undefined): string =>
  `tmux-target-${handle ? manifestSocketState(handle) : "missing"}`;

interface OwnedPaneSnapshot {
  reason?: string;
  target?: OwnedPaneTarget;
}

const readOwnedPaneSnapshot = (
  deps: GovernessPaneLivenessDeps,
  manifestPath: string,
  input: GovernessPaneDiedInput
): OwnedPaneSnapshot => {
  const before = deps.readHandle(manifestPath);
  const manifest = deps.readManifest(manifestPath);
  const after = deps.readHandle(manifestPath);
  if (!manifestOwnsPane(manifest, input)) {
    return { reason: "run-inactive-or-ownership-mismatch" };
  }
  if (!(before && after)) {
    return { reason: unavailableTargetReason(after ?? before) };
  }
  if (before.manifestSha256 !== after.manifestSha256) {
    return { reason: "manifest-changed-during-target-read" };
  }
  const target = ownedGovernessPane(after);
  return target ? { target } : { reason: unavailableTargetReason(after) };
};

const livenessEvent = (
  input: GovernessPaneDiedInput,
  event: LivenessEventName,
  at: string,
  reason?: string
): GovernessPaneLivenessEvent => ({
  at,
  event,
  pane: input.pane,
  pid: process.pid,
  ...(reason ? { reason } : {}),
  session: input.session,
});

const result = (
  action: GovernessPaneDiedResult["action"],
  reason: string,
  attemptsInWindow = 0
): GovernessPaneDiedResult => ({ action, attemptsInWindow, reason });

export const parseGovernessPaneDiedArgs = (
  argv: string[]
): GovernessPaneDiedInput => {
  const [rawRunDir, session, pane, ...extra] = argv;
  if (
    !(
      rawRunDir &&
      isAbsolute(rawRunDir) &&
      session &&
      SESSION_RE.test(session) &&
      pane &&
      (PANE_ID_RE.test(pane) ||
        (POSITIONAL_PANE_RE.test(pane) && pane.startsWith(`${session}:`))) &&
      extra.length === 0
    )
  ) {
    throw new Error(
      "Usage: loop __governess-pane-died <absolute-run-dir> <tmux-session> <tmux-pane>"
    );
  }
  return { pane, runDir: resolve(rawRunDir), session };
};

export const handleGovernessPaneDied = (
  input: GovernessPaneDiedInput,
  overrides: Partial<GovernessPaneLivenessDeps> = {}
): GovernessPaneDiedResult => {
  const deps = { ...defaultGovernessPaneLivenessDeps(), ...overrides };
  const manifestPath = join(input.runDir, "manifest.json");
  const journalPath = join(input.runDir, GOVERNESS_LIVENESS_FILE);
  const initial = readOwnedPaneSnapshot(deps, manifestPath, input);
  const initialTarget = initial.target;
  if (!initialTarget) {
    return result("spared", initial.reason ?? "tmux-target-missing");
  }
  if (!snapshotMatches(deps.inspectPane(initialTarget), input)) {
    return result("spared", "session-pane-missing-or-live");
  }

  const journal = deps.readJournal(journalPath);
  if (!journal.ok) {
    return result("suppressed", "restart-journal-unreadable");
  }
  const parsedJournal = parseJournal(journal.text);
  if (!parsedJournal.ok) {
    return result("suppressed", "restart-journal-invalid");
  }
  const now = deps.now();
  const cutoff = now.getTime() - GOVERNESS_RESTART_WINDOW_MS;
  const attemptsInWindow = parsedJournal.attempts.filter(
    (event) => Date.parse(event.at) >= cutoff
  ).length;
  if (attemptsInWindow >= GOVERNESS_RESTART_LIMIT) {
    deps.appendEvent(
      journalPath,
      livenessEvent(input, "suppressed", now.toISOString(), "restart-budget")
    );
    return result("suppressed", "restart-budget", attemptsInWindow);
  }

  // The budget read is an asynchronous boundary from the perspective of the
  // pane hook. Re-read both authorities immediately before recording and
  // acting so teardown or a replacement workspace wins the race.
  const current = readOwnedPaneSnapshot(deps, manifestPath, input);
  const currentTarget = current.target;
  if (!currentTarget) {
    return result(
      "spared",
      "ownership-changed-before-respawn",
      attemptsInWindow
    );
  }
  if (!snapshotMatches(deps.inspectPane(currentTarget), input)) {
    return result("spared", "pane-changed-before-respawn", attemptsInWindow);
  }

  const at = now.toISOString();
  if (
    !deps.appendEvent(journalPath, livenessEvent(input, "respawn-attempt", at))
  ) {
    return result("failed", "restart-attempt-not-durable", attemptsInWindow);
  }
  const effect = readOwnedPaneSnapshot(deps, manifestPath, input);
  const effectTarget = effect.target;
  if (!effectTarget) {
    return result(
      "spared",
      "ownership-changed-after-attempt",
      attemptsInWindow + 1
    );
  }
  if (!snapshotMatches(deps.inspectPane(effectTarget), input)) {
    return result("spared", "pane-changed-after-attempt", attemptsInWindow + 1);
  }
  if (!deps.respawnPane(effectTarget)) {
    deps.appendEvent(
      journalPath,
      livenessEvent(input, "respawn-failed", at, "tmux-respawn-failed")
    );
    return result("failed", "tmux-respawn-failed", attemptsInWindow + 1);
  }
  if (!deps.appendEvent(journalPath, livenessEvent(input, "respawned", at))) {
    return result(
      "respawned",
      "respawned-outcome-not-durable",
      attemptsInWindow + 1
    );
  }
  return result("respawned", "respawned", attemptsInWindow + 1);
};
