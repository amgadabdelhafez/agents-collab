import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import {
  GOVERNESS_DEAD_PANE_BORDER_FORMAT,
  GOVERNESS_PANE_DIED_SUBCOMMAND,
  GOVERNESS_REMAIN_ON_EXIT_FORMAT,
} from "./governess-pane-liveness";
import {
  GOVERNESS_SECURE_SUBCOMMAND,
  writeGovernessEnvironmentFile,
} from "./governess-secure-env";
import { buildLaunchArgv } from "./launch";
import {
  isActiveRunState,
  loadRunState,
  readRunManifestHandle,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";
import {
  paneArgv,
  paneTargetFromManifest,
  targetArgv,
  targetFromManifest,
} from "./tmux-socket";

const PANE_ID_RE = /^%\d+$/u;
const PASSTHROUGH_ENV_RE =
  /^(?:CLAUDE_CONFIG_DIR|LOOP_GOVERNESS_[A-Z0-9_]+|LOOP_USAGE_TRACKER_[A-Z0-9_]+|USAGE_TRACKER_(?:SECRET|URL))$/u;

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const shellCommand = (argv: readonly string[]): string =>
  argv.map(shellQuote).join(" ");

export const governessControlPlaneRecoveryDeps = {
  buildLaunchArgv,
  now: () => new Date().toISOString(),
  spawnSync,
};

const commandResult = (argv: string[]): ReturnType<typeof spawnSync> =>
  governessControlPlaneRecoveryDeps.spawnSync(argv, {
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: 3000,
  });

const commandSucceeded = (result: ReturnType<typeof spawnSync>): boolean =>
  !result.signalCode && result.exitCode === 0;

const paneIsLive = (
  handle: NonNullable<ReturnType<typeof readRunManifestHandle>>,
  field: "tmuxPaneLeft" | "tmuxPaneRight"
): boolean => {
  const pane = paneTargetFromManifest(handle, field);
  if (!pane) {
    return false;
  }
  const result = commandResult(
    paneArgv(pane, "display-message", ["-p", "#{pane_dead}"])
  );
  return commandSucceeded(result) && result.stdout.toString().trim() === "0";
};

const recoveryEnvironment = (env: NodeJS.ProcessEnv): string[] =>
  Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        PASSTHROUGH_ENV_RE.test(entry[0]) && typeof entry[1] === "string"
    )
    .map(([key, value]) => `${key}=${value}`);

export type GovernessControlPlaneRecovery =
  | { pane: string; runId: string; status: "recovered" }
  | { reason: string; runId: string; status: "refused" };

const isRecoverableManifest = (
  manifest: ReturnType<typeof loadRunState>["manifest"]
): boolean =>
  Boolean(
    manifest && manifest.mode === "paired" && isActiveRunState(manifest.state)
  );

export const recoverGovernessControlPlane = (
  runId: string,
  cwd = process.cwd(),
  home = process.env.HOME ?? "",
  env = process.env
): GovernessControlPlaneRecovery => {
  const { manifest, storage } = loadRunState(runId, cwd, home);
  if (!isRecoverableManifest(manifest)) {
    return {
      reason: "run is not an active paired run",
      runId,
      status: "refused",
    };
  }
  if (manifest.tmuxPaneGoverness) {
    return {
      reason: "run already owns a Governess pane",
      runId,
      status: "refused",
    };
  }
  const handle = readRunManifestHandle(storage.manifestPath);
  const target = handle ? targetFromManifest(handle) : undefined;
  if (!(handle && target)) {
    return {
      reason: "run has no provenance-bound tmux target",
      runId,
      status: "refused",
    };
  }
  const session = commandResult(targetArgv(target, "has-session"));
  if (!commandSucceeded(session)) {
    return {
      reason: "run tmux session is not positively live",
      runId,
      status: "refused",
    };
  }
  if (
    !(paneIsLive(handle, "tmuxPaneLeft") && paneIsLive(handle, "tmuxPaneRight"))
  ) {
    return {
      reason: "both persisted agent panes are not positively live",
      runId,
      status: "refused",
    };
  }

  const environmentPath = join(
    storage.runDir,
    `governess-env-${randomUUID()}.json`
  );
  writeGovernessEnvironmentFile(environmentPath, recoveryEnvironment(env));
  const launchArgv = governessControlPlaneRecoveryDeps.buildLaunchArgv();
  const command = shellCommand([
    ...launchArgv,
    GOVERNESS_SECURE_SUBCOMMAND,
    runId,
    environmentPath,
  ]);
  let pane = "";
  try {
    const split = commandResult(
      targetArgv(target, "split-window", [
        "-v",
        "-f",
        "-P",
        "-F",
        "#{pane_id}",
        "-k",
        "-l",
        "25%",
        "-c",
        manifest.cwd,
        command,
      ])
    );
    pane = split.stdout.toString().trim();
    if (!(commandSucceeded(split) && PANE_ID_RE.test(pane))) {
      return {
        reason: "Governess pane split was not confirmed",
        runId,
        status: "refused",
      };
    }
  } finally {
    if (!pane) {
      rmSync(environmentPath, { force: true });
    }
  }

  const updated = updateRunManifest(storage.manifestPath, (current) => {
    if (
      !(
        current &&
        current.runId === manifest.runId &&
        current.tmuxSocket === manifest.tmuxSocket &&
        current.tmuxSession === manifest.tmuxSession &&
        !current.tmuxPaneGoverness &&
        isActiveRunState(current.state)
      )
    ) {
      return undefined;
    }
    return touchRunManifest(
      { ...current, governess: true, tmuxPaneGoverness: pane },
      governessControlPlaneRecoveryDeps.now()
    );
  });
  if (!updated) {
    return {
      reason: "run ownership changed while recovering",
      runId,
      status: "refused",
    };
  }

  const recoveredHandle = readRunManifestHandle(storage.manifestPath);
  const recoveredTarget = recoveredHandle
    ? targetFromManifest(recoveredHandle)
    : undefined;
  const recoveredPane = recoveredHandle
    ? paneTargetFromManifest(recoveredHandle, "tmuxPaneGoverness")
    : undefined;
  if (!(recoveredTarget && recoveredPane)) {
    return {
      reason: "recovered pane identity was not persisted",
      runId,
      status: "refused",
    };
  }
  const hookCommand = shellCommand([
    ...launchArgv,
    GOVERNESS_PANE_DIED_SUBCOMMAND,
    resolve(storage.runDir),
    manifest.tmuxSession ?? "",
    pane,
  ]);
  const setupCommands = [
    paneArgv(recoveredPane, "set-option", ["remain-on-exit", "on"]),
    paneArgv(recoveredPane, "set-option", [
      "remain-on-exit-format",
      GOVERNESS_REMAIN_ON_EXIT_FORMAT,
    ]),
    targetArgv(recoveredTarget, "set-option", ["pane-border-status", "top"]),
    targetArgv(recoveredTarget, "set-option", [
      "pane-border-format",
      GOVERNESS_DEAD_PANE_BORDER_FORMAT,
    ]),
    paneArgv(recoveredPane, "set-hook", [
      "pane-died",
      `run-shell -b ${shellQuote(hookCommand)}`,
    ]),
  ];
  if (!setupCommands.every((argv) => commandSucceeded(commandResult(argv)))) {
    return {
      reason: "Governess liveness hook was not fully armed",
      runId,
      status: "refused",
    };
  }
  return { pane, runId, status: "recovered" };
};
