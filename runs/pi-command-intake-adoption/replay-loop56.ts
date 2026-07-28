import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  classifyDelegationIntent,
  delegationSkipCategory,
  delegationWorkspaceHint,
} from "../../loop-fork/src/loop/delegation-policy";
import { classifyUtilityExecution } from "../../loop-fork/src/loop/utility-execution-tier";
import { resolveVerifiedUtilityWorkspaceRoot } from "../../loop-fork/src/loop/utility-workspace";

interface RecordValue {
  agent?: string;
  at?: string;
  cwd?: string;
  detail?: string;
  disposition?: string;
  event?: string;
  reason?: string;
  sequence?: number;
  tool?: string;
  ts?: string;
}

const records = (path: string): RecordValue[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RecordValue];
      } catch {
        return [];
      }
    });

const increment = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const runDir = resolve(process.argv[2] ?? "");
const historicalWorktree = "/private/tmp/harvto-loop56-base";
const manifest = JSON.parse(
  readFileSync(join(runDir, "manifest.json"), "utf8")
) as { cwd?: string };
if (!manifest.cwd) {
  throw new Error("run manifest has no cwd");
}

const previous = new Map(
  records(join(runDir, "utility", "delegation.jsonl"))
    .filter(
      (event) =>
        event.agent === "claude" &&
        event.disposition === "skipped-candidate" &&
        Boolean(event.at && event.reason)
    )
    .map((event) => [event.at as string, event] as const)
);

const transitions: Record<string, number> = {};
const safetyRetained: Record<string, number> = {};
const newlyRouted: Array<{
  operation: string;
  planStages: number;
  scopes: number;
  sequence?: number;
  tier: string;
}> = [];

for (const hook of records(join(runDir, "hooks", "claude.jsonl"))) {
  const old = hook.ts ? previous.get(hook.ts) : undefined;
  if (
    !old?.reason ||
    hook.event !== "PreToolUse" ||
    hook.tool !== "Bash" ||
    !hook.cwd ||
    !hook.detail
  ) {
    continue;
  }
  let replayCwd = hook.cwd;
  let replayCommand = hook.detail;
  if (
    !existsSync(historicalWorktree) &&
    (replayCwd === historicalWorktree ||
      replayCwd.startsWith(`${historicalWorktree}/`))
  ) {
    replayCwd = resolve(manifest.cwd, relative(historicalWorktree, replayCwd));
    replayCommand = replayCommand.replaceAll(historicalWorktree, manifest.cwd);
  }
  const hinted = delegationWorkspaceHint(replayCwd, "Bash", {
    command: replayCommand,
  });
  const workspace = resolveVerifiedUtilityWorkspaceRoot(
    manifest.cwd,
    hinted ?? replayCwd
  );
  if (!workspace) {
    increment(transitions, `${old.reason} -> workspace-unverified`);
    increment(safetyRetained, "actionable-miss");
    continue;
  }
  const classification = classifyDelegationIntent({
    agent: "claude",
    cwd: replayCwd,
    repoRoot: workspace,
    toolInput: { command: replayCommand },
    toolName: "Bash",
  });
  if (!classification.eligible) {
    increment(transitions, `${old.reason} -> ${classification.reason}`);
    increment(
      safetyRetained,
      delegationSkipCategory("skipped-candidate", classification.reason)
    );
    continue;
  }
  increment(transitions, `${old.reason} -> eligible:${classification.operation}`);
  newlyRouted.push({
    operation: classification.operation,
    planStages: classification.request.executionPlan?.length ?? 1,
    scopes: classification.request.readScope.length,
    tier: classifyUtilityExecution(classification.request),
    ...(hook.sequence === undefined ? {} : { sequence: hook.sequence }),
  });
}

console.log(
  JSON.stringify(
    {
      newlyRouted,
      safetyRetained,
      transitions: Object.fromEntries(
        Object.entries(transitions).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
    },
    null,
    2
  )
);
