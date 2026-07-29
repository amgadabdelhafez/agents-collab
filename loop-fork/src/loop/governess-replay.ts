import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { readBridgeQueueHealth } from "./bridge-store";
import {
  decideGovernessCycle,
  type GovernessCycleDecision,
  type GovernessObservationSnapshot,
} from "./governess-cycle";
import {
  readGovernessHandoffAcceptance,
  readGovernessHandoffBundle,
} from "./governess-handoff";
import {
  type GovernessControlRecord,
  inspectGovernessJournalStorage,
  readGovernessJournal,
} from "./governess-journal";
import { decideGovernessPolicy } from "./governess-policy";
import { driverLeaseIsCurrent } from "./governess-runtime";
import { migrateLegacyGovernessState } from "./legacy-governess-compat";
import { loadRunState } from "./run-state";
import {
  boundedTmuxOptions,
  type TmuxLiveness,
  tmuxCommandTimedOut,
  tmuxSessionLiveness,
} from "./tmux-control";
import type { Agent } from "./types";

export interface GovernessReplayIssue {
  controlId?: string;
  message: string;
  severity: "error" | "warning";
}

export interface GovernessReplayReport {
  behavioralChecks: number;
  controls: number;
  issues: GovernessReplayIssue[];
  latestEpoch: number;
  ok: boolean;
}

export const replayGovernessJournal = (
  records: GovernessControlRecord[]
): GovernessReplayReport => {
  const structural = inspectJournalStructure(records);
  const behavioral = inspectBehavior(records);
  const issues = [...structural.issues, ...behavioral.issues];
  return {
    behavioralChecks: behavioral.checks,
    controls: new Set(records.map((record) => record.controlId)).size,
    issues,
    latestEpoch: structural.latestEpoch,
    ok: !issues.some((issue) => issue.severity === "error"),
  };
};

const tmuxSessionReady = (session: string): boolean | "unknown" => {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      ["tmux", "list-panes", "-t", session, "-F", "#{pane_dead}"],
      boundedTmuxOptions({ stderr: "ignore", stdout: "pipe" })
    );
  } catch {
    return "unknown";
  }
  if (tmuxCommandTimedOut(result)) {
    return "unknown";
  }
  if (result.exitCode !== 0) {
    return false;
  }
  return (
    (result.stdout?.toString() ?? "").split("\n").filter((line) => line === "0")
      .length >= 3
  );
};

const failedReplay = (message: string): GovernessReplayReport => ({
  behavioralChecks: 0,
  controls: 0,
  issues: [{ message, severity: "error" }],
  latestEpoch: 0,
  ok: false,
});

const parseCyclePayload = (
  payload: string
):
  | {
      decisions: GovernessCycleDecision[];
      snapshot: GovernessObservationSnapshot;
    }
  | undefined => {
  try {
    const value = JSON.parse(payload) as {
      decisions?: unknown;
      kind?: unknown;
      snapshot?: unknown;
    };
    if (
      value.kind !== "governess-cycle" ||
      !Array.isArray(value.decisions) ||
      !value.snapshot ||
      typeof value.snapshot !== "object"
    ) {
      return undefined;
    }
    return {
      decisions: value.decisions as GovernessCycleDecision[],
      snapshot: value.snapshot as GovernessObservationSnapshot,
    };
  } catch {
    return undefined;
  }
};

const inspectJournalStructure = (
  records: GovernessControlRecord[]
): { issues: GovernessReplayIssue[]; latestEpoch: number } => {
  const issues: GovernessReplayIssue[] = [];
  const completed = new Set<string>();
  const latestByControl = new Map<string, GovernessControlRecord>();
  let latestEpoch = 0;
  let previousSequence = 0;
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
    if (record.phase === "completed" && completed.has(record.idempotencyKey)) {
      issues.push({
        controlId: record.controlId,
        message: "idempotency key completed more than once",
        severity: "error",
      });
    }
    if (record.phase === "completed") {
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
  return { issues, latestEpoch };
};

const inspectBehavior = (
  records: GovernessControlRecord[]
): { checks: number; issues: GovernessReplayIssue[] } => {
  const issues: GovernessReplayIssue[] = [];
  let checks = 0;
  for (const record of records) {
    if (record.phase === "prepared" && record.policyContext) {
      checks += 1;
      const decision = decideGovernessPolicy(
        record.action,
        record.policyContext
      );
      if (!decision.allowed || decision.class !== record.policyClass) {
        issues.push({
          controlId: record.controlId,
          message: `policy replay drift: recorded ${record.policyClass}, current ${decision.class} (${decision.reason})`,
          severity: "error",
        });
      }
    }
    const cycle =
      record.action === "observe-runtime" &&
      record.phase === "completed" &&
      record.payload
        ? parseCyclePayload(record.payload)
        : undefined;
    if (!cycle) {
      continue;
    }
    checks += 1;
    if (
      JSON.stringify(decideGovernessCycle(cycle.snapshot)) !==
      JSON.stringify(cycle.decisions)
    ) {
      issues.push({
        controlId: record.controlId,
        message:
          "cycle replay drift: current decisions differ from recorded decisions",
        severity: "error",
      });
    }
  }
  return { checks, issues };
};

export const explainGovernessControl = (
  records: GovernessControlRecord[],
  controlId?: string
): Record<string, unknown> => {
  const selectedId =
    controlId ??
    records.findLast((record) => record.action !== "observe-runtime")
      ?.controlId;
  if (!selectedId) {
    return { error: "no effectful governess control found", ok: false };
  }
  const history = records.filter((record) => record.controlId === selectedId);
  const prepared = history.find((record) => record.phase === "prepared");
  const latest = history.at(-1);
  if (!(prepared && latest)) {
    return { controlId: selectedId, error: "control not found", ok: false };
  }
  const currentPolicy = prepared.policyContext
    ? decideGovernessPolicy(prepared.action, prepared.policyContext)
    : undefined;
  return {
    action: prepared.action,
    agent: prepared.agent,
    controlId: selectedId,
    epoch: prepared.epoch,
    evidence: latest.evidence,
    idempotencyKey: prepared.idempotencyKey,
    latestPhase: latest.phase,
    ok: true,
    payloadHash: prepared.payloadHash,
    phases: history.map((record) => ({
      at: record.at,
      evidence: record.evidence,
      phase: record.phase,
      reason: record.reason,
      sequence: record.sequence,
      transport: record.transport,
    })),
    policy: {
      current: currentPolicy,
      input: prepared.policyContext,
      recordedClass: prepared.policyClass,
    },
    transport: latest.transport,
  };
};

export const inspectGovernessJournal = (
  journalFile: string
): GovernessReplayReport => {
  if (!existsSync(journalFile)) {
    return failedReplay("governess control journal is missing");
  }
  try {
    return replayGovernessJournal(readGovernessJournal(journalFile));
  } catch (error) {
    return failedReplay(error instanceof Error ? error.message : String(error));
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
  let journalStorage:
    | ReturnType<typeof inspectGovernessJournalStorage>
    | { error: string; indexCurrent: false }
    | undefined;
  if (existsSync(journalFile)) {
    try {
      journalStorage = inspectGovernessJournalStorage(journalFile);
    } catch (error) {
      journalStorage = {
        error: error instanceof Error ? error.message : String(error),
        indexCurrent: false,
      };
    }
  }
  const bridgeQueue = readBridgeQueueHealth(storage.runDir);
  let epoch = 0;
  let state:
    | {
        driverLease?: { epoch: number; expiresAt: string; holder: Agent };
        exitControl?: {
          handoverManifest?: string;
          mode?: string;
          replacementSession?: string;
        };
        governessEpoch?: number;
        handoverBundles?: Partial<Record<Agent, string>>;
        lifecycleEvents?: Partial<Record<Agent, unknown>>;
      }
    | undefined;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as NonNullable<
      typeof state
    >;
    state = parsed;
    epoch = parsed.governessEpoch ?? 0;
  } catch {
    // Reported below.
  }
  const session = manifest?.tmuxSession;
  const sessionLiveness: TmuxLiveness = session
    ? tmuxSessionLiveness(session)
    : "dead";
  const sessionReady = session ? tmuxSessionReady(session) : false;
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
    state?.exitControl?.mode === "launched"
      ? Boolean(
          state.exitControl.replacementSession &&
            state.exitControl.handoverManifest &&
            tmuxSessionReady(state.exitControl.replacementSession) === true &&
            readGovernessHandoffAcceptance(
              state.exitControl.handoverManifest,
              state.exitControl.replacementSession
            )
        )
      : true;
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
      session && sessionLiveness === "live" && sessionReady === true
    ),
    state: existsSync(stateFile) && state !== undefined,
    transport: existsSync(join(storage.runDir, "bridge.jsonl")),
  };
  return {
    checks,
    epoch,
    bridgeQueue,
    journal,
    journalStorage,
    ok: Object.values(checks).every(Boolean),
    runId,
    session,
    sessionLiveness,
    sessionReady,
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
  if (
    !runId ||
    (command !== "doctor" && command !== "replay" && command !== "explain")
  ) {
    throw new Error(
      "Usage: loop governess <doctor|replay|explain> <run-id> [control-id]"
    );
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
  if (command === "explain") {
    const records = readGovernessJournal(
      join(storage.runDir, "governess-control.jsonl")
    );
    process.stdout.write(
      `${JSON.stringify(explainGovernessControl(records, argv[3]), null, 2)}\n`
    );
    return true;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return true;
};
