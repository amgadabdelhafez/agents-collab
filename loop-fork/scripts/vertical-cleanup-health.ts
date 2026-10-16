import { spawn } from "bun";

const child = spawn(
  [
    "/private/tmp/harness-vertical-release-928bd1db",
    "__bridge-mcp",
    "/Users/amgad/.loop/runs/agents-collab-fa87e8608224/50",
    "supervisor",
  ],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
);
for (const [index, target] of ["codex", "claude"].entries()) {
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: "send_message", arguments: { target, type: "work_request", dedupe_key: `vertical-run50-health-${target}-v1`, message: "Cleanup-only health proof. Receive this governed message and return HEALTH_ACK_RUN50 to supervisor, replying to this message. No writes, nested launches, credentials or lifecycle actions. Then remain ready for supervisor teardown." } } })}\n`
  );
}
child.stdin.end();
const output = await new Response(child.stdout).text();
if ((await child.exited) !== 0) {
  throw new Error("Health submission failed");
}
for (const line of output.trim().split("\n")) {
  const response = JSON.parse(line);
  if (response.error) {
    throw new Error("Health submission refused");
  }
  console.log(JSON.stringify(response));
}
