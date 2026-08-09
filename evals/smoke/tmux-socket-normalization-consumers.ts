import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clearStaleTmuxBridgeState,
  hasLiveCodexTmuxSession,
  readBridgeRuntimeStatus,
  submitTmuxBridgeMessage,
} from "../../loop-fork/src/loop/bridge-runtime";
import { enqueueBridgeMessage } from "../../loop-fork/src/loop/bridge-store";
import { gcStaleClaudeBridgeRegistrations } from "../../loop-fork/src/loop/claude-config-gc";
import { codexTmuxProxyInternals } from "../../loop-fork/src/loop/codex-tmux-proxy";
import { defaultGovernessDeps } from "../../loop-fork/src/loop/governess";
import { defaultGovernessPaneLivenessDeps } from "../../loop-fork/src/loop/governess-pane-liveness";
import { governessDoctor } from "../../loop-fork/src/loop/governess-replay";
import { reservePairedLaunch } from "../../loop-fork/src/loop/launch-reservation";
import { preparePairedOptions } from "../../loop-fork/src/loop/paired-options";
import { panelInternals } from "../../loop-fork/src/loop/panel";
import { gcAbandonedRunProcesses } from "../../loop-fork/src/loop/run-process-cleanup";
import {
  readRunManifest,
  readRunManifestHandle,
} from "../../loop-fork/src/loop/run-state";
import { runInTmux } from "../../loop-fork/src/loop/tmux";
import {
  tmuxTargetLiveness,
  tmuxTargetLivenessAsync,
} from "../../loop-fork/src/loop/tmux-control";
import {
  describeTmuxTarget,
  paneTargetFromManifest,
  targetFromManifest,
  tmuxAttachCommand,
} from "../../loop-fork/src/loop/tmux-socket";

const LINE_SPLIT_RE = /\r?\n/;

const [home, runDir, manifestPath, socketA, socketB, registryPath] =
  process.argv.slice(2);
if (!(home && runDir && manifestPath && socketA && socketB && registryPath)) {
  throw new Error("usage: consumer-harness HOME RUN_DIR MANIFEST A B REGISTRY");
}

const assert = (condition: unknown, detail: string): asserts condition => {
  if (!condition) {
    throw new Error(detail);
  }
};
const pass = (consumer: string, detail: string): void => {
  process.stdout.write(
    `${JSON.stringify({ consumer, detail, status: "pass" })}\n`
  );
};
const traceText = (): string =>
  readFileSync(process.env.LOOP_SMOKE_TMUX_TRACE as string, "utf8");
const traceDelta = (before: string): string => {
  const after = traceText();
  assert(
    after.startsWith(before),
    "tmux trace was replaced during consumer run"
  );
  return after.slice(before.length);
};
const expectContacts = (
  before: string,
  consumer: string,
  expected: Array<{ command: string; target?: string }>
): string => {
  const delta = traceDelta(before);
  const contacts = delta
    .trim()
    .split(LINE_SPLIT_RE)
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter((fields) => fields[1] !== "-V");
  assert(contacts.length > 0, `${consumer} issued no tmux contact`);
  for (const fields of contacts) {
    assert(
      fields[1] === "-S" && fields[2] === socketA && fields[3],
      `${consumer} issued a non-A contact: ${fields.join(" ")}`
    );
  }
  for (const contact of expected) {
    assert(
      contacts.some(
        (fields) =>
          fields[3] === contact.command &&
          (!contact.target || fields.includes(contact.target))
      ),
      `${consumer} omitted ${contact.command}${contact.target ? ` for ${contact.target}` : ""}`
    );
  }
  return delta;
};

assert(
  process.env.LOOP_TMUX_SOCKET === socketB,
  "LOOP_TMUX_SOCKET is not hostile B"
);
assert(process.env.TMUX?.startsWith(`${socketB},`), "TMUX is not hostile B");
assert(
  join(
    process.env.TMUX_TMPDIR as string,
    `tmux-${process.getuid?.() ?? 0}`,
    "default"
  ) === socketB,
  "TMUX_TMPDIR does not derive hostile B"
);

const manifest = readRunManifest(manifestPath);
const handle = readRunManifestHandle(manifestPath);
assert(manifest && handle, "producer manifest or provenance handle missing");
const target = targetFromManifest(handle);
assert(target, "producer manifest did not yield a target");
const identity = describeTmuxTarget(target);
assert(identity.socket === socketA, `target socket ${identity.socket} != A`);
assert(identity.session === manifest.tmuxSession, "target session mismatch");
let ossPane: string | undefined;
if (manifest.tmuxPaneLeftAgent === "oss") {
  ossPane = manifest.tmuxPaneLeft;
} else if (manifest.tmuxPaneRightAgent === "oss") {
  ossPane = manifest.tmuxPaneRight;
}
assert(ossPane, "producer manifest omitted OSS pane");
pass("manifest-target", `${identity.socket} ${identity.session}`);

const syncTraceBefore = traceText();
assert(tmuxTargetLiveness(target) === "live", "sync liveness did not reach A");
expectContacts(syncTraceBefore, "tmux-control-sync", [
  { command: "has-session", target: identity.session },
]);
pass("tmux-control-sync", "live on producer target");
const asyncTraceBefore = traceText();
assert(
  (await tmuxTargetLivenessAsync(target, spawn)) === "live",
  "async liveness did not reach A"
);
expectContacts(asyncTraceBefore, "tmux-control-async", [
  { command: "has-session", target: identity.session },
]);
pass("tmux-control-async", "live on producer target");

const attach = tmuxAttachCommand(target);
assert(
  attach ===
    `tmux -S '${socketA.replaceAll("'", "'\\''")}' attach -t '${identity.session.replaceAll("'", "'\\''")}'`,
  `unexpected attach command ${attach}`
);
pass("attach-hint", attach);

const attachTraceBefore = traceText();
const attachLogs: string[] = [];
const delegated = await runInTmux(
  ["--tmux", "--session", manifest.runId],
  {
    cwd: manifest.cwd,
    env: { ...process.env, TMUX: undefined },
    findBinary: () => true,
    isInteractive: () => true,
    log: (line) => attachLogs.push(line),
    preparePairedRun: () => ({
      manifest,
      storage: {
        manifestPath,
        repoId: manifest.repoId,
        runDir,
        runId: manifest.runId,
        storageRoot: dirname(runDir),
        transcriptPath: join(runDir, "transcript.jsonl"),
      },
    }),
    resolveLaunchSocket: () => {
      throw new Error("tmux.ts attach consulted hostile launch resolution");
    },
  },
  {
    opts: {
      agent: "oss",
      pairedMode: true,
      pairWith: "claude",
      sessionId: manifest.runId,
      tmux: true,
    } as never,
    task: "D027 attach probe",
  }
);
assert(delegated, "tmux.ts did not delegate the existing run");
expectContacts(attachTraceBefore, "tmux-default-attach", [
  { command: "has-session", target: identity.session },
  { command: "attach", target: identity.session },
]);
assert(
  attachLogs.some((line) => line.includes("foreground tmux attach failed")),
  "non-TTY attach failure did not preserve the live exact session"
);
pass(
  "tmux-default-attach",
  "default attach argv reached A and preserved live session"
);

const bridgeStatusTraceBefore = traceText();
const bridgeStatus = readBridgeRuntimeStatus(runDir);
assert(
  bridgeStatus.tmuxLiveness === "live",
  "bridge status did not see A live"
);
assert(hasLiveCodexTmuxSession(runDir), "bridge liveness helper did not see A");
expectContacts(bridgeStatusTraceBefore, "bridge-status-schema", [
  { command: "has-session", target: identity.session },
]);
assert(
  bridgeStatus.runId === manifest.runId &&
    bridgeStatus.tmuxSession === identity.session &&
    bridgeStatus.hasTmuxSession &&
    bridgeStatus.hasLiveTmuxSession &&
    bridgeStatus.codexDeliveryMode === "tmux",
  "bridge status schema disagrees with producer manifest"
);
pass("bridge-status-schema", "run/session/route/liveness match producer A");

const manifestBeforeBridge = readFileSync(manifestPath, "utf8");
const bridgeTraceBefore = traceText();
const queued = enqueueBridgeMessage(
  runDir,
  "claude",
  "oss",
  "D027 two-server bridge sentinel",
  { dedupeKey: "d027-two-server" }
);
assert(queued.status === "queued", `bridge enqueue was ${queued.status}`);
assert(
  await submitTmuxBridgeMessage(runDir, queued.entry, 2),
  "bridge nudge was not submitted to A"
);
const bridgeTrace = expectContacts(
  bridgeTraceBefore,
  "bridge-capture-buffer-send",
  [
    { command: "has-session", target: identity.session },
    { command: "capture-pane", target: ossPane },
    { command: "load-buffer" },
    { command: "paste-buffer", target: ossPane },
    { command: "send-keys", target: ossPane },
  ]
);
assert(bridgeTrace.includes("\tcapture-pane\t"), "bridge issued no A capture");
pass("bridge-capture", "captured manifest-owned OSS pane on A");
assert(
  bridgeTrace.includes("\tload-buffer\t"),
  "bridge issued no A buffer load"
);
pass("bridge-buffer-load", "loaded bounded nudge buffer on A");
assert(
  bridgeTrace.includes("\tpaste-buffer\t"),
  "bridge issued no A buffer paste"
);
pass("bridge-buffer-paste", "pasted bounded nudge buffer to A pane");
assert(bridgeTrace.includes("\tsend-keys\t"), "bridge issued no A submit");
pass("bridge-send", "submitted nudge to manifest-owned A pane");
assert(
  !clearStaleTmuxBridgeState(runDir),
  "live bridge incorrectly cleared tmux topology"
);
assert(
  readFileSync(manifestPath, "utf8") === manifestBeforeBridge,
  "live bridge path mutated producer manifest topology"
);
pass("bridge-topology-non-effect", "live A topology bytes unchanged");

const project = manifest.cwd;
writeFileSync(
  registryPath,
  `${JSON.stringify({
    projects: {
      [project]: {
        mcpServers: {
          "loop-bridge-d027": {
            args: ["src/cli.ts", "__bridge-mcp", runDir, "claude"],
            command: process.execPath,
            type: "stdio",
          },
        },
      },
    },
  })}\n`
);
const gcTraceBefore = traceText();
const gc = gcStaleClaudeBridgeRegistrations({
  deps: {
    pathExists: existsSync,
    pidAlive: () => false,
    runCommand: () => {
      throw new Error("live registration must not be removed");
    },
    tmuxLiveness: (owned) => tmuxTargetLiveness(owned),
  },
  registryPath,
});
expectContacts(gcTraceBefore, "claude-config-gc", [
  { command: "has-session", target: identity.session },
]);
assert(
  gc.kept === 1 && gc.removed === 0,
  `Claude GC changed live registration ${JSON.stringify(gc)}`
);
pass("claude-config-gc", "live A registration preserved");

let processSignalAttempted = false;
const manifestBeforeProcessGc = readFileSync(manifestPath, "utf8");
const processGcTraceBefore = traceText();
const cleanup = gcAbandonedRunProcesses({
  deps: {
    pidAlive: () => false,
    signal: () => {
      processSignalAttempted = true;
    },
    tmuxLiveness: (owned) => tmuxTargetLiveness(owned),
  },
  log: () => undefined,
  repoId: manifest.repoId,
  storageRoot: join(home, ".loop", "runs"),
});
expectContacts(processGcTraceBefore, "run-process-cleanup", [
  { command: "has-session", target: identity.session },
]);
assert(
  cleanup.kept === 1 && cleanup.cleaned === 0,
  `process GC changed live run ${JSON.stringify(cleanup)}`
);
assert(!processSignalAttempted, "process GC attempted a destructive signal");
assert(
  readFileSync(manifestPath, "utf8") === manifestBeforeProcessGc,
  "process GC marked or rewrote the live producer manifest"
);
pass("run-process-cleanup", "live A run preserved with zero signals");

assert(
  manifest.workspaceBinding,
  "producer manifest omitted workspace binding"
);
const reservationOpts: Record<string, unknown> = {
  sessionId: manifest.runId,
  tmux: true,
};
const reservationTraceBefore = traceText();
const claim = await reservePairedLaunch(
  reservationOpts as never,
  manifest.workspaceBinding,
  {
    env: process.env,
    home,
    resolveSocket: () => {
      throw new Error("resume consulted hostile launch socket resolver");
    },
    tmuxLiveness: (owned) => tmuxTargetLivenessAsync(owned, spawn),
  }
);
expectContacts(reservationTraceBefore, "launch-reservation", [
  { command: "has-session", target: identity.session },
]);
assert(
  !claim.reserved && claim.storage.runId === manifest.runId,
  "reservation did not reuse A run"
);
pass(
  "launch-reservation",
  "resume reused manifest target without ambient resolution"
);

const pairedOpts: Record<string, unknown> = {
  agent: "oss",
  pairWith: "claude",
  sessionId: manifest.runId,
  tmux: true,
};
let pairedTarget: ReturnType<typeof describeTmuxTarget> | undefined;
const pairedTraceBefore = traceText();
preparePairedOptions(pairedOpts as never, manifest.cwd, false, (owned) => {
  pairedTarget = describeTmuxTarget(owned);
  return tmuxTargetLiveness(owned);
});
expectContacts(pairedTraceBefore, "paired-options", [
  { command: "has-session", target: identity.session },
]);
assert(
  pairedTarget?.socket === socketA && pairedTarget.session === identity.session,
  "paired options did not probe the A target"
);
assert(
  [pairedOpts.agent, pairedOpts.pairWith].sort().join(",") === "claude,oss",
  "paired options did not retain the manifest pair"
);
pass("paired-options", "live persisted pair retained");

const proxyDecisionTraceBefore = traceText();
const shutdownDecision = codexTmuxProxyInternals.requestedShutdownDecision(
  runDir,
  (owned) => tmuxTargetLiveness(owned)
);
expectContacts(proxyDecisionTraceBefore, "codex-tmux-proxy", [
  { command: "has-session", target: identity.session },
]);
assert(
  shutdownDecision === "rejected-active-tmux",
  `proxy decision was ${shutdownDecision}`
);
pass("codex-tmux-proxy", "active A target prevented shutdown");
const proxyStopTraceBefore = traceText();
const proxyStop = codexTmuxProxyInternals.proxyStopReason(
  runDir,
  (owned) => tmuxTargetLiveness(owned),
  { consecutiveDead: 0, sawSession: false },
  Date.now() + 10_000,
  Date.now()
);
expectContacts(proxyStopTraceBefore, "proxy-stop-non-effect", [
  { command: "has-session", target: identity.session },
]);
assert(
  proxyStop.reason === undefined,
  `proxy emitted destructive stop ${proxyStop.reason}`
);
pass("proxy-stop-non-effect", "live A evidence emitted no dead-tmux stop");

const panelTraceBefore = traceText();
const rows = await panelInternals.collectManifestTmuxRows(
  join(home, ".loop", "runs"),
  (argv) => {
    const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || "panel query failed");
    }
    return Promise.resolve(result.stdout);
  }
);
expectContacts(panelTraceBefore, "panel", [{ command: "list-sessions" }]);
const row = rows.find((candidate) => candidate.session === identity.session);
assert(
  row?.state === "live" && row.attachCommand?.includes(socketA),
  "panel row was not A-live/attachable"
);
pass("panel", "manifest row live and attachable on A");

const agentPane = ossPane;
const governess = defaultGovernessDeps(undefined, undefined, manifestPath);
const governessLivenessTraceBefore = traceText();
assert(governess.paneCommand(agentPane), "Governess pane read did not reach A");
const governessLivenessTrace = expectContacts(
  governessLivenessTraceBefore,
  "governess-liveness",
  [{ command: "display-message", target: agentPane }]
);
pass("governess-liveness", "pane command read manifest-owned A pane");
const governessEffectTraceBefore = traceText();
governess.setPaneLabel(agentPane, "D027-AUTHORITY");
const labelResult = spawnSync(
  "tmux",
  ["-S", socketA, "show-options", "-p", "-v", "-t", agentPane, "@loop_label"],
  { encoding: "utf8" }
);
assert(
  labelResult.status === 0 && labelResult.stdout.trim() === "D027-AUTHORITY",
  "Governess A label effect was not observed"
);
const governessEffectTrace = expectContacts(
  governessEffectTraceBefore,
  "governess-effect",
  [
    { command: "set-option", target: agentPane },
    { command: "show-options", target: agentPane },
  ]
);
pass("governess-effect", "manifest-owned A pane label changed");
const governessHandoverTraceBefore = traceText();
assert(
  governess.replacementSessionAlive(identity.session, manifestPath) === true,
  "Governess replacement liveness did not reach A"
);
const governessHandoverTrace = expectContacts(
  governessHandoverTraceBefore,
  "governess-handover",
  [{ command: "has-session", target: identity.session }]
);
pass("governess-handover", "replacement liveness bound to A");
assert(
  !/\t(?:kill-session|respawn-pane)\t/.test(
    `${governessLivenessTrace}${governessEffectTrace}${governessHandoverTrace}`
  ),
  "Governess issued a prohibited kill or respawn effect"
);
pass("governess-destructive-non-effect", "zero kill/respawn commands");

const governessPane = paneTargetFromManifest(handle, "tmuxPaneGoverness");
assert(governessPane, "producer manifest omitted Governess pane target");
const paneLivenessTraceBefore = traceText();
const paneSnapshot =
  defaultGovernessPaneLivenessDeps().inspectPane(governessPane);
expectContacts(paneLivenessTraceBefore, "governess-pane-liveness", [
  { command: "display-message", target: manifest.tmuxPaneGoverness },
]);
assert(
  paneSnapshot?.session === identity.session,
  "pane liveness inspected another session"
);
pass("governess-pane-liveness", `inspected ${paneSnapshot.id} on A`);

const doctorTraceBefore = traceText();
const doctor = governessDoctor(manifest.runId, manifest.cwd, home);
expectContacts(doctorTraceBefore, "governess-replay", [
  { command: "has-session", target: identity.session },
  { command: "list-panes", target: identity.session },
]);
assert(
  doctor.sessionLiveness === "live",
  "Governess replay/doctor did not see A live"
);
pass("governess-replay", "doctor session liveness live on A");

const trace = readFileSync(process.env.LOOP_SMOKE_TMUX_TRACE as string, "utf8");
assert(
  !trace.includes("\tREJECT"),
  "tmux wrapper rejected an ambient/cross-server contact"
);
pass("consumer-matrix", "all named consumers completed without B contact");
