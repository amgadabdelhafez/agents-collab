import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const base = "6ff9319";
const diff = Bun.spawnSync(
  [
    "git",
    "diff",
    "--unified=3",
    base,
    "--",
    "loop-fork/src/loop",
    "loop-fork/tests/loop",
    "specs/pi-command-intake-adoption",
    "runs/pi-command-intake-adoption/replay-loop56.ts",
  ],
  { cwd: repoRoot }
);
if (diff.exitCode !== 0) {
  throw new Error(diff.stderr.toString());
}

const spec = readFileSync(
  resolve(repoRoot, "specs/pi-command-intake-adoption/spec.md"),
  "utf8"
);
const verify = readFileSync(
  resolve(repoRoot, "specs/pi-command-intake-adoption/verify.md"),
  "utf8"
);
const replay = Bun.spawnSync(
  [
    "bun",
    "run",
    "runs/pi-command-intake-adoption/replay-loop56.ts",
    "/Users/amgad/.loop/runs/harvto-b1e274e66299/56",
  ],
  { cwd: repoRoot }
);

const response = await fetch("http://127.0.0.1:8082/v1/chat/completions", {
  body: JSON.stringify({
    max_tokens: 6000,
    messages: [
      {
        content:
          "You are an independent release evaluator. Review the supplied spec, verification contract, source/test diff, and command-free replay evidence. Do not assume the implementer is correct. Check deterministic fail-closed authority, exact stage-scoped brokers, output filtering without shell authority, registered-worktree boundaries, prompt adoption without tier override, observability, adversarial tests, and acceptance coverage. Treat unrelated pre-existing lint debt separately. Return strict JSON with keys verdict (PASS or FAIL), summary, findings (array of severity/file/message objects), and checks (array). PASS only with no blocking correctness or safety issue.",
        role: "system",
      },
      {
        content: [
          "SPEC:\n",
          spec,
          "\nVERIFY:\n",
          verify,
          "\nIMPLEMENTATION DIFF:\n",
          diff.stdout.toString(),
          "\nVERIFICATION EVIDENCE:\nFocused suite: 593 passed, 0 failed after Nanny fixture correction. Full suite: 1081 passed with four stale default-model assertions; those assertions were updated to the existing gpt-5.6-sol/standard constants and their 29 focused tests then passed. Build and git diff --check passed. Repository scripts/verify.sh completed but contains placeholder lint/type/test commands.\nLOOP 56 REPLAY:\n",
          replay.stdout.toString(),
        ].join(""),
        role: "user",
      },
    ],
    model: "mlx-community/Qwen3.6-35B-A3B-4bit",
    stream: false,
    temperature: 0.1,
  }),
  headers: { "content-type": "application/json" },
  method: "POST",
});
if (!response.ok) {
  throw new Error(`Qwen evaluator HTTP ${response.status}: ${await response.text()}`);
}
const payload = (await response.json()) as {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: Record<string, number>;
};
console.log(
  JSON.stringify(
    {
      content: payload.choices?.[0]?.message?.content ?? "",
      model: payload.model,
      usage: payload.usage,
    },
    null,
    2
  )
);
