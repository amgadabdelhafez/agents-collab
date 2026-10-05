import { expect, test } from "bun:test";
import {
  isGovernessProxyAdmissionRefusal,
  resolveUtilityRuntimeConfig,
  runPiConversationWithAdmissionRetry,
} from "../../src/loop/utility-runtime";

// The exact refusal ~/.loop/bin/governess-proxy.py returns while one judge
// POST is in flight, as Pi surfaced it in Harvto285 job 237793d9.
const BUSY = '503: {"message":"governess proxy busy: one judgment in flight"}';

type Attempt = Parameters<typeof runPiConversationWithAdmissionRetry>[1];
type Progress = Parameters<Parameters<Attempt>[1]>[0];
type Result = Awaited<ReturnType<Attempt>>;

const progress = (modelCalls: number, toolCalls: number): Progress => ({
  durationMs: 10,
  modelCalls,
  toolCalls,
  toolRounds: toolCalls,
  usage: {
    cachedInputTokens: 0,
    inputTokens: 100 * modelCalls,
    outputTokens: 10 * modelCalls,
    reasoningTokens: 0,
    totalTokens: 110 * modelCalls,
  },
});

const completed = (): Result => ({
  ...progress(2, 1),
  artifacts: [],
  checks: [],
  harness: "pi-sdk",
  provider: "loop-nanny",
  summary: "done",
});

const nannyConfig = (env: NodeJS.ProcessEnv = {}) =>
  resolveUtilityRuntimeConfig({
    LOOP_NANNY_URL: "http://127.0.0.1:8082/v1/chat/completions",
    LOOP_UTILITY_ADMISSION_RETRY_BASE_MS: "100",
    ...env,
  });

// Each scripted step reports progress, then either throws or completes.
const scripted = (
  steps: Array<{ error?: string; progress: Progress }>
): { attempt: Attempt; calls: () => number; runtimes: number[] } => {
  let index = 0;
  const runtimes: number[] = [];
  return {
    attempt: (config, onProgress) => {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      runtimes.push(config.maxJobRuntimeMs);
      onProgress(step?.progress ?? progress(0, 0));
      if (step?.error) {
        return Promise.reject(new Error(step.error));
      }
      return Promise.resolve(completed());
    },
    calls: () => index,
    runtimes,
  };
};

test("recognizes only the exact judge-proxy admission refusal", () => {
  expect(isGovernessProxyAdmissionRefusal(BUSY)).toBe(true);
  expect(isGovernessProxyAdmissionRefusal("503: Service Unavailable")).toBe(
    false
  );
  expect(
    isGovernessProxyAdmissionRefusal(
      '429: {"message":"governess proxy busy: one judgment in flight"}'
    )
  ).toBe(false);
  expect(
    isGovernessProxyAdmissionRefusal(
      '502: {"message":"governess proxy upstream failed: URLError"}'
    )
  ).toBe(false);
});

test("a Nanny admission refusal is retried with cumulative truthful counters", async () => {
  const waits: number[] = [];
  const reports: Progress[] = [];
  const script = scripted([
    { error: BUSY, progress: progress(1, 0) },
    { progress: progress(2, 1) },
  ]);
  const result = await runPiConversationWithAdmissionRetry(
    {
      assertActive: () => undefined,
      config: nannyConfig(),
      onProgress: (next) => reports.push(next),
      tierId: "utility-nanny",
    },
    script.attempt,
    (ms) => {
      waits.push(ms);
      return Promise.resolve();
    }
  );
  expect(script.calls()).toBe(2);
  expect(waits).toEqual([100]);
  expect(result).toMatchObject({
    admissionRetries: 1,
    modelCalls: 3,
    summary: "done",
    toolCalls: 1,
  });
  expect(result.usage.inputTokens).toBe(300);
  expect(reports.at(-1)).toMatchObject({ modelCalls: 3, toolCalls: 1 });
});

test("admission retry stops at its limit and keeps every refused call", async () => {
  const waits: number[] = [];
  const reports: Progress[] = [];
  const script = scripted([{ error: BUSY, progress: progress(1, 0) }]);
  await expect(
    runPiConversationWithAdmissionRetry(
      {
        assertActive: () => undefined,
        config: nannyConfig(),
        onProgress: (next) => reports.push(next),
        tierId: "utility-nanny",
      },
      script.attempt,
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      }
    )
  ).rejects.toThrow("governess proxy busy");
  expect(script.calls()).toBe(3);
  expect(waits).toEqual([100, 250]);
  expect(reports.at(-1)).toMatchObject({ admissionRetries: 2, modelCalls: 3 });
});

const expectNoRetry = async (
  input: Parameters<typeof runPiConversationWithAdmissionRetry>[0],
  step: { error: string; progress: Progress }
): Promise<void> => {
  const script = scripted([step, { progress: progress(1, 0) }]);
  let waited = false;
  await expect(
    runPiConversationWithAdmissionRetry(input, script.attempt, () => {
      waited = true;
      return Promise.resolve();
    })
  ).rejects.toThrow(step.error);
  expect(script.calls()).toBe(1);
  expect(waited).toBe(false);
};

test("Au Pair never retries even with the same refusal text", async () => {
  await expectNoRetry(
    {
      assertActive: () => undefined,
      config: nannyConfig(),
      onProgress: () => undefined,
      tierId: "utility-au-pair",
    },
    { error: BUSY, progress: progress(1, 0) }
  );
});

test("a non-loopback Nanny endpoint is not the proven judge-proxy boundary", async () => {
  await expectNoRetry(
    {
      assertActive: () => undefined,
      config: nannyConfig({
        LOOP_NANNY_ENABLED: "1",
        LOOP_NANNY_URL: "https://nanny.example.com/v1/chat/completions",
      }),
      onProgress: () => undefined,
      tierId: "utility-nanny",
    },
    { error: BUSY, progress: progress(1, 0) }
  );
});

test("a refusal after any tool execution is not retried", async () => {
  await expectNoRetry(
    {
      assertActive: () => undefined,
      config: nannyConfig(),
      onProgress: () => undefined,
      tierId: "utility-nanny",
    },
    { error: BUSY, progress: progress(2, 1) }
  );
});

test("runtime limits and other provider errors fail closed", async () => {
  for (const error of [
    "helper exceeded its runtime limit without completion",
    "503: Service Unavailable",
  ]) {
    await expectNoRetry(
      {
        assertActive: () => undefined,
        config: nannyConfig(),
        onProgress: () => undefined,
        tierId: "utility-nanny",
      },
      { error, progress: progress(1, 0) }
    );
  }
});

test("retry keeps one original deadline and honors cancellation", async () => {
  const tight = nannyConfig({ LOOP_UTILITY_MAX_RUNTIME_MS: "50" });
  await expectNoRetry(
    {
      assertActive: () => undefined,
      config: tight,
      onProgress: () => undefined,
      tierId: "utility-nanny",
    },
    { error: BUSY, progress: progress(1, 0) }
  );

  const script = scripted([
    { error: BUSY, progress: progress(1, 0) },
    { progress: progress(1, 0) },
  ]);
  await expect(
    runPiConversationWithAdmissionRetry(
      {
        assertActive: () => {
          throw new Error("Nanny stopped because job x is no longer active");
        },
        config: nannyConfig(),
        onProgress: () => undefined,
        tierId: "utility-nanny",
      },
      script.attempt,
      () => Promise.resolve()
    )
  ).rejects.toThrow("no longer active");
  expect(script.calls()).toBe(1);

  const deadline = scripted([
    { error: BUSY, progress: progress(1, 0) },
    { progress: progress(1, 0) },
  ]);
  await runPiConversationWithAdmissionRetry(
    {
      assertActive: () => undefined,
      config: nannyConfig({ LOOP_UTILITY_MAX_RUNTIME_MS: "60000" }),
      onProgress: () => undefined,
      tierId: "utility-nanny",
    },
    deadline.attempt,
    () => Promise.resolve()
  );
  // The retry gets what is left of the first attempt's deadline, not a fresh one.
  expect(deadline.runtimes[0]).toBeLessThanOrEqual(60_000);
  expect(deadline.runtimes[1]).toBeLessThanOrEqual(deadline.runtimes[0] ?? 0);
});
