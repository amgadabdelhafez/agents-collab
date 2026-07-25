import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import {
  readGovernessJournal,
  type GovernessControlRecord,
} from "./governess-journal";
import { readGovernessHandoffBundle } from "./governess-handoff";
import { driverLeaseIsCurrent } from "./governess-runtime";
import { loadRunState } from "./run-state";
import { migrateLegacyGovernessState } from "./legacy-governess-compat";
import type { Agent } from "./types";

export interface GovernessReplayIssue {
  controlId?: string;
  message: string;
  severity: "error" | "warning";
}

export interface GovernessReplayReport {
  controls: number;
  issues: GovernessReplayIssue[];
  latestEpoch: number;
  ok: boolean;
}

export const replayGovernessJournal = (
  records: GovernessControlRecord[]
): GovernessReplayReport => {
  const issues: GovernessReplayIssue[] = [];
  let previousSequence = 0;
  let latestEpoch = 0;
  const completed = new Set<string>();
  const latestByControl = new Map<string, GovernessControlRecord>();
  for (const record of records) {
    latestByControl.set(record.controlId, record);
    if (record.sequence <= previousSequence) {
      issues.push({
        controlId: record.controlId,
        message: "journal sequence is not strictly increasing",
        severity: "error",
      });
    }
    previousSequence = Math.max(previousSequence, record.sequence);
    if (record.epoch < latestEpoch && record.phase !== "failed") {
      issues.push({
        controlId: record.controlId,
        message: "non-failed control was recorded under a stale epoch",
        severity: "error",
      });
    }
    latestEpoch = Math.max(latestEpoch, record.epoch);
    if (record.phase === "completed") {
      if (completed.has(record.idempotencyKey)) {
        issues.push({
          controlId: record.controlId,
          message: "idempotency key completed more than once",
          severity: "error",
        });
      }
      completed.add(record.idempotencyKey);
    }
  }
  for (const record of latestByControl.values()) {
    if (record.phase === "prepared" || record.phase === "dispatched") {
      issues.push({
        controlId: record.controlId,
        message: `control has no delivery acknowledgement (latest phase: ${record.phase})`,
        severity: "error",
      });
    }
  }
  return {
    controls: new Set(records.map((record) => record.controlId)).size,
    issues,
    latestEpoch,
    ok: !issues.some((issue) => issue.severity === "error"),
  };
};

const tmuxSessionAlive = (session: string): boolean =>
  spawnSync(["tmux", "has-session", "-t", session], {
    stderr: "ignore",
  }).exitCode === 0;

const tmuxSessionReady = (session: string): boolean => {
  const result = spawnSync(
    ["tmux", "list-panes", "-t", session, "-F", "#{pane_dead}"],
    { stderr: "ignore", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    return false;
  }
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line === "0").length >= 3;
};

const failedReplay = (message: string): GovernessReplayReport => ({
  controls: 0,
  issues: [{ message, severity: "error" }],
  latestEpoch: 0,
  ok: false,
});

export const inspectGovernessJournal = (
  journalFile: string
): GovernessReplayReport => {
  if (!existsSync(journalFile)) {
    return failedReplay("governess control journal is missing");
  }
  try {
    return replayGovernessJournal(readGovernessJournal(journalFile));
  } catch (error) {
    return failedReplay(
      error instanceof Error ? error.message : String(error)
    );
  }
};

export const governessDoctor = (
  runId: string,
  cwd?: string,
  home?: string
): Record<string, unknown> => {
  const { manifest, storage } = loadRunState(runId, cwd, home);
  const stateFile = join(storage.runDir, "governess-state.json");
  migrateLegacyGovernessState(storage.runDir, stateFile);
  const journalFile = join(storage.runDir, "governess-control.jsonl");
  const journal = inspectGovernessJournal(journalFile);
  let epoch = 0;
  let state: {
    driverLease?: { epoch: number; expiresAt: string; holder: Agent };
    exitControl?: { mode?: string; replacementSession?: string };
    governessEpoch?: number;
    handoverBundles?: Partial<Record<Agent, string>>;
    lifecycleEvents?: Partial<Record<Agent, unknown>>;
  } | undefined;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    epoch = state.governessEpoch ?? 0;
  } catch {
    // Reported below.
  }
  const session = manifest?.tmuxSession;
  const expectedAgents = [
    manifest?.tmuxPaneLeftAgent,
    manifest?.tmuxPaneRightAgent,
  ].filter((agent): agent is Agent => agent !== undefined);
  const lifecycleReady =
    expectedAgents.length > 0 &&
    expectedAgents.every((agent) => state?.lifecycleEvents?.[agent]);
  const leaseReady = driverLeaseIsCurrent(
    state?.driverLease,
    state?.governessEpoch,
    Date.now()
  );
  const handoffReady =
    state?.exitControl?.mode !== "handover" &&
    state?.exitControl?.mode !== "launched"
      ? true
      : expectedAgents.every((agent) => {
          const path = state?.handoverBundles?.[agent];
          return Boolean(
            path && readGovernessHandoffBundle(path, agent, epoch)
          );
        });
  const replacementReady =
    state?.exitControl?.mode !== "launched"
      ? true
      : Boolean(
          state.exitControl.replacementSession &&
            tmuxSessionReady(state.exitControl.replacementSession)
        );
  const checks = {
    adapter: lifecycleReady,
    epoch: epoch > 0,
    handoff: handoffReady,
    journal: existsSync(journalFile) && journal.ok,
    lease: leaseReady,
    manifest: Boolean(manifest),
    replacement: replacementReady,
    runDir: existsSync(storage.runDir),
    session: Boolean(
      session && tmuxSessionAlive(session) && tmuxSessionReady(session)
    ),
    state: existsSync(stateFile) && state !== undefined,
    transport: existsSync(join(storage.runDir, "bridge.jsonl")),
  };
  return {
    checks,
    epoch,
    journal,
    ok: Object.values(checks).every(Boolean),
    runId,
    session,
  };
};

export const runGovernessUtilityCommand = (
  argv: string[],
  cwd?: string,
  home?: string
): boolean => {
  if (argv[0] !== "governess") {
    return false;
  }
  const command = argv[1];
  const runId = argv[2];
  if (!runId || (command !== "doctor" && command !== "replay")) {
    throw new Error("Usage: loop governess <doctor|replay> <run-id>");
  }
  if (command === "doctor") {
    process.stdout.write(
      `${JSON.stringify(governessDoctor(runId, cwd, home), null, 2)}\n`
    );
    return true;
  }
  const { storage } = loadRunState(runId, cwd, home);
  const report = inspectGovernessJournal(
    join(storage.runDir, "governess-control.jsonl")
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return true;
};
