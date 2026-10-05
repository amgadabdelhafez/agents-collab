import { judgeAgent } from "../../loop-fork/src/loop/governess-llm";
import { completePiText } from "../../loop-fork/src/loop/pi-runtime";

const url = process.env.QWEN_PROBE_URL;
const model = process.env.QWEN_PROBE_MODEL;
if (!(url && model)) {
  throw new Error("Explicit probe endpoint and model required");
}
const identity = await completePiText({
  provider: {
    endpoint: `${url}/v1/chat/completions`,
    model,
    provider: "nanny",
  },
  maxTokens: 32,
  systemPrompt: "Return only the requested literal text.",
  userPrompt: "Return QWEN_RUN43_OK.",
  temperature: 0,
  timeoutMs: 30_000,
});
console.log(
  JSON.stringify({
    kind: "identity",
    model: identity.model,
    text: identity.text,
    usage: identity.usage,
  })
);
for (const [expected, paneText] of [
  [
    "working",
    "Running focused unit tests, 18 of 20 complete. Active progress.",
  ],
  [
    "waiting-human",
    "Implementation complete. Awaiting human approval for deployment. No other work authorized.",
  ],
] as const) {
  const started = performance.now();
  const result = await judgeAgent({
    agent: "claude",
    hookTail: [],
    model,
    paneText,
    url,
  });
  console.log(
    JSON.stringify({
      kind: "judge",
      expected,
      elapsedMs: Math.round(performance.now() - started),
      result,
    })
  );
  if (!(result.ok && result.verdict.state === expected)) {
    process.exitCode = 1;
  }
}
