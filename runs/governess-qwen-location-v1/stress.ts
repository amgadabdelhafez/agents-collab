import { spawn } from "bun";

const runDir = "/Users/amgad/.loop/runs/agents-collab-fa87e8608224/43";
const binary = "/private/tmp/governess-qwen-location-v1/loop-fork/loop";
async function call(name: string, args: Record<string, unknown>) {
  const p = spawn([binary, "__bridge-mcp", runDir, "supervisor"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  p.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`
  );
  p.stdin.end();
  const output = await new Response(p.stdout).text();
  const exit = await p.exited;
  console.log(JSON.stringify({ name, exit, response: output }));
}
for (let i = 1; i <= 3; i++) {
  await call("route_task", {
    requester: "claude",
    kind: "inspect",
    work_shape: "separable",
    risk: "low",
    objective: `RUN43_HELPER_STRESS_V3_N${i}: Read only loop-fork/src/loop/utility-execution-tier.ts and return the literal Nanny and Au Pair tier IDs with source line numbers. This is a supervisor-owned read-only stress probe; do not edit or apply patches.`,
    acceptance_criteria: [
      "Return utility-nanny and utility-au-pair exact literals with correct citations; no edits.",
    ],
    read_scope: ["loop-fork/src/loop/utility-execution-tier.ts"],
    write_scope: [],
    required_capabilities: ["inspect"],
    idempotency_key: `run43-qwen-stress-v3-n${i}-20261004`,
  });
}
if (process.env.NANNY_ONLY !== "1") {
  for (let i = 1; i <= 2; i++) {
    await call("route_task", {
      requester: "claude",
      kind: "review",
      review_mode: "utility-audit",
      work_shape: "separable",
      risk: "low",
      objective: `RUN43_HELPER_STRESS_V2_A${i}: Read only loop-fork/src/loop/utility-execution-tier.ts and loop-fork/src/loop/bridge-guidance.ts. Extract the helper tier IDs and one explicit prohibition on widening scope, with exact citations. This is a bounded evidence extraction stress probe, not a code review or authority verdict. No edits, patch proposals or independent review.`,
      acceptance_criteria: [
        "Literal tier IDs plus one cited scope prohibition only; no source changes.",
      ],
      read_scope: [
        "loop-fork/src/loop/utility-execution-tier.ts",
        "loop-fork/src/loop/bridge-guidance.ts",
      ],
      write_scope: [],
      required_capabilities: ["inspect"],
      idempotency_key: `run43-qwen-stress-v2-a${i}-20261004`,
    });
  }
}
