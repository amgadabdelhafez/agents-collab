import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  classifyDelegationIntent,
  delegationWorkspaceHint,
} from "../../../../src/loop/delegation-policy";
import { resolveVerifiedUtilityWorkspaceRoot } from "../../../../src/loop/utility-workspace";

interface JournalRecord {
  agent?: string;
  at?: string;
  cwd?: string;
  detail?: string;
  disposition?: string;
  event?: string;
  operation?: string;
  reason?: string;
  sequence?: number;
  tool?: string;
  ts?: string;
}

const records = (path: string): JournalRecord[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JournalRecord];
      } catch {
        return [];
      }
    });

const runDir = resolve(process.argv[2] ?? "");
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
        (event.reason === "compound-or-unsafe-command" ||
          event.reason === "workspace-unverified")
    )
    .map((event) => [event.at, event] as const)
);

const counts: Record<string, number> = {};
const historicalWorktree = "/private/tmp/harvto-loop54-base";
const newlyRouted: Array<{
  operation?: string;
  scopes?: number;
  sequence?: number;
}> = [];
for (const hook of records(join(runDir, "hooks", "claude.jsonl"))) {
  const old = previous.get(hook.ts);
  if (
    !old ||
    hook.event !== "PreToolUse" ||
    hook.tool !== "Bash" ||
    !(hook.cwd && hook.detail)
  ) {
    continue;
  }
  counts[`old:${old.reason}`] = (counts[`old:${old.reason}`] ?? 0) + 1;
  if (
    old.reason === "workspace-unverified" &&
    delegationWorkspaceHint(hook.cwd, "Bash", { command: hook.detail })
  ) {
    counts["new:leading-worktree-hint-recovered"] =
      (counts["new:leading-worktree-hint-recovered"] ?? 0) + 1;
  }
  let replayCwd = hook.cwd;
  let replayCommand = hook.detail;
  let currentWorkspace = resolveVerifiedUtilityWorkspaceRoot(
    manifest.cwd,
    replayCwd
  );
  if (
    !(currentWorkspace || existsSync(historicalWorktree)) &&
    (replayCwd === historicalWorktree ||
      replayCwd.startsWith(`${historicalWorktree}/`))
  ) {
    const suffix = relative(historicalWorktree, replayCwd);
    replayCwd = resolve(manifest.cwd, suffix);
    replayCommand = replayCommand.replaceAll(historicalWorktree, manifest.cwd);
    currentWorkspace = manifest.cwd;
    counts["replay:normalized-deleted-worktree"] =
      (counts["replay:normalized-deleted-worktree"] ?? 0) + 1;
  }
  const hint = delegationWorkspaceHint(replayCwd, "Bash", {
    command: replayCommand,
  });
  const hintedWorkspace = hint
    ? resolveVerifiedUtilityWorkspaceRoot(manifest.cwd, hint)
    : undefined;
  const workspace = hintedWorkspace ?? currentWorkspace;
  if (!workspace) {
    counts["new:workspace-unverified"] =
      (counts["new:workspace-unverified"] ?? 0) + 1;
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
    counts[`new:${classification.reason}`] =
      (counts[`new:${classification.reason}`] ?? 0) + 1;
    continue;
  }
  counts["new:eligible"] = (counts["new:eligible"] ?? 0) + 1;
  newlyRouted.push({
    operation: classification.operation,
    scopes: classification.request.readScope.length,
    sequence: hook.sequence,
  });
}

console.log(
  JSON.stringify(
    {
      counts: Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      newlyRouted,
    },
    null,
    2
  )
);
