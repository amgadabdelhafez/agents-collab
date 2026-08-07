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

// Pull the recovery instruction out of the request body directly. The earlier
// version of this test searched JSON.stringify(body), where every offered tool
// name already appears inside the `tools` definitions - so it passed no matter
// what the prompt said. Codex caught that; this reads the appended user message.
// Pi sends message content as structured parts, not a bare string, so the
// content is serialized before matching. Discovered only once this assertion
// stopped being vacuous.
const contentText = (content: unknown): string =>
  typeof content === "string" ? content : JSON.stringify(content ?? "");

const recoveryMessageOf = (
  body: Record<string, unknown>
): string | undefined => {
  const messages = (body.messages ?? []) as {
    content?: unknown;
    role?: string;
  }[];
  const match = messages.find(
    (message) =>
      message.role === "user" &&
      contentText(message.content).includes("no repository tool evidence")
  );
  return match ? contentText(match.content) : undefined;
};

const offeredToolNames = (body: Record<string, unknown>): string[] =>
  ((body.tools ?? []) as { function?: { name?: string } }[])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === "string");

test("the recovery prompt names the currently exposed tools", async () => {
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
      const recovery = recoveryMessageOf(bodies[1] as Record<string, unknown>);
      // The message must exist at all - absence of evidence must fail.
      expect(recovery).toBeDefined();
      const prompt = recovery ?? "";
      const offered = offeredToolNames(bodies[0] as Record<string, unknown>);
      expect(offered.length).toBeGreaterThan(0);
      // Every currently offered tool is named in the instruction itself.
      for (const name of offered) {
        expect(prompt).toContain(name);
      }
      // And a tool the broker did not offer is never advertised.
      if (!offered.includes("run_check")) {
        expect(prompt).not.toContain("run_check");
      }
    }
  );
});

test("the recovery turn reuses the same capsule, scopes, and authority", async () => {
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
      expect(JSON.stringify(recovery.tools)).toBe(
        JSON.stringify(original.tools)
      );
      // The capsule, declared scopes, and authority live in the USER context
      // message, not the system message, so comparing system roles alone proved
      // nothing. Require the original message array to be an exact PREFIX of the
      // recovery request: same capsule bytes, nothing rewritten.
      const messagesOf = (
        body: Record<string, unknown>
      ): { content?: unknown; role?: string }[] =>
        (body.messages ?? []) as { content?: unknown; role?: string }[];
      const before = messagesOf(original);
      const after = messagesOf(recovery);
      expect(after.length).toBeGreaterThan(before.length);
      expect(JSON.stringify(after.slice(0, before.length))).toBe(
        JSON.stringify(before)
      );
      // The only additions are the first assistant completion and the recovery
      // instruction: no new system framing, no re-seeded context.
      const appended = after.slice(before.length);
      expect(appended).toHaveLength(2);
      expect(appended[0]?.role).toBe("assistant");
      expect(appended[1]?.role).toBe("user");
      expect(contentText(appended[1]?.content)).toContain(
        "no repository tool evidence"
      );
    }
  );
});
