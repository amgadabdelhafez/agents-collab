import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "bun";
import { writeGovernessEnvironmentFile } from "../../loop-fork/src/loop/governess-secure-env";
import { readUtilityJobsForObservability } from "../../loop-fork/src/loop/utility-store";

// Explicit, task-bound maintenance. No agent composer input or manifest edits.
const runDir = "/Users/amgad/.loop/runs/agents-collab-fa87e8608224/43";
const socket = "/tmp/tmux-501/default";
const binary = "/private/tmp/governess-qwen-location-v1/loop-fork/loop";
const expected =
  "f00d88d75b186c8be8f59bf5a902a08144072aa6f3f06647f3672b53cc5c0150";
const expectedPid = process.env.RUN43_EXPECT_GOV_PID ?? "57075";
if (!/^\d+$/.test(expectedPid)) {
  throw new Error("Exact expected PID required");
}
if (process.env.RUN43_ROUTE_ADOPT !== "yes") {
  throw new Error("Explicit Run43 adoption required");
}
if (
  createHash("sha256").update(readFileSync(binary)).digest("hex") !== expected
) {
  throw new Error("Candidate drift");
}
const manifest = JSON.parse(readFileSync(`${runDir}/manifest.json`, "utf8"));
if (
  manifest.tmuxSession !== "agents-collab-loop-43" ||
  manifest.tmuxPaneGoverness !== "%60"
) {
  throw new Error("Run target drift");
}
const tmux = (args: string[]) => {
  const result = spawnSync(["tmux", "-S", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error("Exact tmux operation refused");
  }
  return result.stdout.toString().trim();
};
if (
  tmux([
    "display-message",
    "-p",
    "-t",
    "%60",
    "#{session_name}|#{pane_pid}|#{pane_dead}",
  ]) !== `agents-collab-loop-43|${expectedPid}|0`
) {
  throw new Error("Governess process drift");
}
for (const pane of ["%58", "%59"]) {
  if (tmux(["display-message", "-p", "-t", pane, "#{pane_dead}"]) !== "0") {
    throw new Error("Agent not live");
  }
}
if (
  readUtilityJobsForObservability(runDir).some((job) =>
    ["claimed", "running"].includes(job.state)
  )
) {
  throw new Error("Active helper work");
}
const environmentPath = `${runDir}/governess-env-${randomUUID()}.json`;
writeGovernessEnvironmentFile(environmentPath, [
  "LOOP_GOVERNESS_MODEL=/Users/amgad/.local/share/loop/qwen38-27b/model-10c35caa",
  "LOOP_GOVERNESS_URL=http://127.0.0.1:8084",
  "LOOP_GOVERNESS_JUDGES=",
  "LOOP_NANNY_MODEL=/Users/amgad/.local/share/loop/qwen38-27b/model-10c35caa",
  "LOOP_NANNY_URL=http://127.0.0.1:8084",
  `LOOP_TMUX_SOCKET=${socket}`,
]);
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const command = `cd ${quote("/private/tmp/helper-observability-routing-v1")} && ${[binary, "__governess-secure", "43", environmentPath].map(quote).join(" ")}`;
tmux(["respawn-pane", "-k", "-t", "%60", command]);
console.log(
  JSON.stringify({
    action: "exact-governess-refresh",
    pane: "%60",
    agentSeats: "untouched",
    candidate: expected,
  })
);
