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

// Regressions for run-151 Defect B. Producer evidence is checked in under
// tests/fixtures/utility/run-151-scope-evidence/; see
// specs/utility-scope-evidence-recovery/spec.md.
//
// Job b649045c (Nanny, qwen3.6-35b-a3b-vl, readScope ["03-Development"]) recorded
// ZERO tool events and failed 3.4s after starting with "Nanny task completed
// without repository tool evidence". search_repo was exposed AND satisfiable;
// the model simply answered in prose. That first prose-only completion is a
// recoverable slip, and today it is terminal.

const servers: Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

const event = (
  delta: Record<string, unknown>,
  finishReason: string | null = null
): string =>
  `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1,
    id: "chatcmpl-utility-recovery",
    model: "fake-nanny",
    object: "chat.completion.chunk",
  })}\n\n`;

const response = (events: string[]): Response =>
  new Response(`${events.join("")}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });

// A completion carrying no tool call at all: exactly the b649045c shape.
const proseOnly = (content: string): Response =>
  response([
    event({ role: "assistant" }),
    event({ content }),
    event({}, "stop"),
  ]);

const searchCall = (): Response =>
  response([
    event({ role: "assistant" }),
    event({
      tool_calls: [
        {
          function: {
            arguments: '{"query":"needle","paths":["src"]}',
            name: "search_repo",
          },
          id: "search-1",
          index: 0,
          type: "function",
        },
      ],
    }),
    event({}, "tool_calls"),
  ]);

const withNannyJob = async (
  fetchImpl: (
    bodies: Record<string, unknown>[]
  ) => Response | Promise<Response>,
  assertions: (input: {
    bodies: Record<string, unknown>[];
    job: unknown;
  }) => void
): Promise<void> => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-evidence-recovery-"));
  const runDir = join(repoRoot, ".loop", "runs", "recovery");
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
    acceptanceCriteria: ["return source-backed evidence"],
    authority: {},
    executionProfile: "search",
    id: "recovery-job",
    kind: "inspect",
    objective: "Find the declared needle",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 91);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-nanny",
    },
    routeEpoch: 91,
  });

  const bodies: Record<string, unknown>[] = [];
  const server = serve({
    fetch: async (incoming) => {
      bodies.push((await incoming.json()) as Record<string, unknown>);
      return await fetchImpl(bodies);
    },
    port: 0,
  });
  servers.push(server);

  try {
    await runUtilityWorker(runDir, 91, request.id, {
      LOOP_NANNY_ENABLED: "1",
      LOOP_NANNY_MODEL: "fake-nanny",
      LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
      LOOP_UTILITY_HARNESS: "pi-sdk",
    });
    assertions({ bodies, job: readUtilityJob(runDir, request.id) });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
};

test("a prose-only Nanny completion earns exactly one evidence-recovery turn", async () => {
  // Round 1 is the b649045c slip: prose, no tool call. The recovery turn must be
  // issued on the SAME live Pi session, and round 2 then supplies real evidence.
  await withNannyJob(
    (bodies) => {
      if (bodies.length === 1) {
        return proseOnly("The needle is probably in src/sample.ts.");
      }
      if (bodies.length === 2) {
        return searchCall();
      }
      return proseOnly("Needle found in src/sample.ts.");
    },
    ({ bodies, job }) => {
      expect(job).toMatchObject({ state: "completed" });
      // One original round, one recovery round, one post-tool summary round.
      expect(bodies).toHaveLength(3);
    }
  );
});

test("a second unsupported Nanny completion still fails closed", async () => {
  // The budget is one. Two consecutive prose-only completions must end exactly
  // as they do today, and must not earn a third round.
  await withNannyJob(
    () => proseOnly("Still no tool call."),
    ({ bodies, job }) => {
      expect(job).toMatchObject({
        result: {
          blocker: "Nanny task completed without repository tool evidence",
          status: "failed",
        },
        state: "failed",
      });
      expect(bodies).toHaveLength(2);
    }
  );
});

test("the evidence-recovery turn widens no tool beyond what was already exposed", async () => {
  // The recovery round must run inside the identical capability set. Compare the
  // tool lists the provider was offered on the original and recovery rounds.
  await withNannyJob(
    (bodies) => {
      if (bodies.length === 1) {
        return proseOnly("No tools used.");
      }
      if (bodies.length === 2) {
        return searchCall();
      }
      return proseOnly("Needle found in src/sample.ts.");
    },
    ({ bodies }) => {
      expect(bodies).toHaveLength(3);
      const original = JSON.stringify(bodies[0]?.tools);
      const recovery = JSON.stringify(bodies[1]?.tools);
      expect(recovery).toBe(original);
      // And nothing outside the brokered set leaked in on the recovery round.
      expect(recovery).not.toContain('"bash"');
      expect(recovery).not.toContain('"write"');
      expect(recovery).not.toContain('"edit"');
    }
  );
});

test("CONTEXT_INSUFFICIENT receives no recovery turn", async () => {
  // An escalation is not a recoverable slip. It must end the run on the first
  // completion, exactly as it does today.
  await withNannyJob(
    () =>
      proseOnly("CONTEXT_INSUFFICIENT: the declared scope excludes the file"),
    ({ bodies, job }) => {
      // The property that matters: exactly one round, no recovery.
      expect(bodies).toHaveLength(1);
      // And it escalates rather than failing or being retried.
      expect(job).toMatchObject({ state: "escalated" });
    }
  );
});

test("the recovery prompt names exposed tools and never a withheld run_check", async () => {
  // Codex's point: prove this in a test, not by construction. The prompt is
  // built from describeCapabilities().tools, so a tool withheld as
  // unsatisfiable cannot appear - but that must be observable.
  await withNannyJob(
    (bodies) => {
      if (bodies.length === 1) {
        return proseOnly("No tool call.");
      }
      if (bodies.length === 2) {
        return searchCall();
      }
      return proseOnly("Needle found in src/sample.ts.");
    },
    ({ bodies }) => {
      expect(bodies).toHaveLength(3);
      const recoveryBody = JSON.stringify(bodies[1]);
      const offered = JSON.parse(JSON.stringify(bodies[0]?.tools ?? [])) as {
        function?: { name?: string };
      }[];
      const offeredNames = offered
        .map((tool) => tool.function?.name)
        .filter((name): name is string => typeof name === "string");
      expect(offeredNames.length).toBeGreaterThan(0);
      // The recovery instruction must name at least one genuinely exposed tool.
      expect(offeredNames.some((name) => recoveryBody.includes(name))).toBe(
        true
      );
      // And must never advertise a tool the broker withheld for this job.
      if (!offeredNames.includes("run_check")) {
        const recoveryPromptText = recoveryBody.slice(
          recoveryBody.indexOf("no repository tool evidence")
        );
        expect(recoveryPromptText).not.toContain("run_check");
      }
    }
  );
});

test("the recovery turn reuses the same context and authority state", async () => {
  // No new broker, capsule, scope, or authority may appear on the second turn.
  await withNannyJob(
    (bodies) => {
      if (bodies.length === 1) {
        return proseOnly("No tool call.");
      }
      if (bodies.length === 2) {
        return searchCall();
      }
      return proseOnly("Needle found in src/sample.ts.");
    },
    ({ bodies }) => {
      expect(bodies).toHaveLength(3);
      const original = bodies[0] as Record<string, unknown>;
      const recovery = bodies[1] as Record<string, unknown>;
      // Identical tool definitions, byte for byte.
      expect(JSON.stringify(recovery.tools)).toBe(
        JSON.stringify(original.tools)
      );
      // Identical system context: same capsule, same declared scopes, same
      // authority framing. The recovery turn appends, it does not re-seed.
      const systemOf = (body: Record<string, unknown>): string => {
        const messages = (body.messages ?? []) as {
          content?: unknown;
          role?: string;
        }[];
        return JSON.stringify(
          messages.filter((message) => message.role === "system")
        );
      };
      expect(systemOf(recovery)).toBe(systemOf(original));
      // The recovery turn is a continuation: it carries strictly more messages.
      const countOf = (body: Record<string, unknown>): number =>
        ((body.messages ?? []) as unknown[]).length;
      expect(countOf(recovery)).toBeGreaterThan(countOf(original));
    }
  );
});
