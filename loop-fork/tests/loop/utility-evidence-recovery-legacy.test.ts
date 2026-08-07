import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server, serve } from "bun";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import { runUtilityWorker } from "../../src/loop/utility-runtime";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

// Legacy-harness half of the run-151 Defect B regressions. Split into its own
// file: co-locating these with the Pi SSE servers made the suite unstable
// (one 5001ms timeout, one SIGTRAP) even though the legacy loop itself is
// bounded by both maxJobRuntimeMs and EMERGENCY_MAX_MODEL_CALLS.

const servers: Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

// The legacy harness uses plain JSON completions rather than SSE.
const legacyJob = async (
  input: {
    fetchImpl: (bodies: Record<string, unknown>[]) => Response;
    kind: "edit" | "inspect";
  },
  assertions: (result: {
    bodies: Record<string, unknown>[];
    job: unknown;
  }) => void
): Promise<void> => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-legacy-recovery-"));
  const runDir = join(repoRoot, ".loop", "runs", "legacy-recovery");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    "export const needle = 1;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect with evidence"],
    authority: {},
    // An execution profile plus the explicit tier and legacy env below is what
    // reaches runLegacyUtilityConversation unambiguously. (Absence of a profile
    // does not by itself select Direct: directUtilityCalls only returns calls
    // for fully specified deterministic profiles.)
    executionProfile: "search",
    id: "legacy-recovery-job",
    kind: input.kind,
    objective: "Inspect the sample",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: input.kind === "edit" ? ["scoped-edit"] : ["inspect"],
    risk: "low",
    workShape: "separable",
    writeScope: input.kind === "edit" ? ["src"] : [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 8);
  // An explicit conversational tier is required: without it the router can pick
  // the deterministic Direct path, which escalates without ever calling a model.
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-au-pair",
    },
    routeEpoch: 8,
  });
  const bodies: Record<string, unknown>[] = [];
  const server = serve({
    fetch: async (incoming) => {
      bodies.push((await incoming.json()) as Record<string, unknown>);
      return input.fetchImpl(bodies);
    },
    port: 0,
  });
  servers.push(server);
  try {
    await runUtilityWorker(runDir, 8, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_HARNESS: "legacy",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    assertions({ bodies, job: readUtilityJob(runDir, request.id) });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
};

const legacyProse = (content: string): Response =>
  Response.json({
    choices: [
      { finish_reason: "stop", message: { content, role: "assistant" } },
    ],
    model: "local-test",
    usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
  });

const legacySearch = (): Response =>
  Response.json({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          // parseCompletion (openai-compatible.ts:388-396) accepts only a
          // string or null here; `undefined` is rejected as an invalid choice.
          content: null,
          role: "assistant",
          tool_calls: [
            {
              function: {
                arguments: '{"query":"needle","paths":["src"]}',
                name: "search_repo",
              },
              id: "search-legacy-1",
              type: "function",
            },
          ],
        },
      },
    ],
    model: "local-test",
    usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
  });

test("the legacy harness also earns exactly one evidence-recovery turn", async () => {
  await legacyJob(
    {
      fetchImpl: (bodies) => {
        if (bodies.length === 1) {
          return legacyProse("Trust me, it exists.");
        }
        if (bodies.length === 2) {
          return legacySearch();
        }
        return legacyProse("Needle found in src/sample.ts.");
      },
      kind: "inspect",
    },
    ({ bodies, job }) => {
      expect(job).toMatchObject({ state: "completed" });
      expect(bodies).toHaveLength(3);
    }
  );
});

test("an edit completing without a patch artifact stays terminal with no recovery", async () => {
  // The edit assertion is not routed through the generic recovery branch.
  await legacyJob(
    {
      fetchImpl: () => legacyProse("I would change the file like so."),
      kind: "edit",
    },
    ({ bodies, job }) => {
      expect(bodies).toHaveLength(1);
      expect(job).toMatchObject({
        result: {
          blocker: "Au Pair edit completed without a validated patch artifact",
          status: "failed",
        },
        state: "failed",
      });
    }
  );
});
