import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, spawn } from "bun";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  applyUtilityJobPatch,
  processPendingUtilityRoutes,
} from "../../src/loop/utility-runtime";
import {
  appendUtilityRouteRequest,
  readUtilityJob,
} from "../../src/loop/utility-store";

test("composed binary runs Nanny and Au Pair children then driver guarded-applies", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-composed-proof-"));
  const runDir = join(repoRoot, ".loop", "runs", "proof");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const sample = join(repoRoot, "src", "sample.ts");
  writeFileSync(sample, "export const value = 1;\n");
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot, primaryAgent: "codex" })
  );
  const calls = new Map<string, number>();
  const patch =
    "diff --git a/src/sample.ts b/src/sample.ts\n--- a/src/sample.ts\n+++ b/src/sample.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (incoming) => {
      const body = (await incoming.json()) as { model: string };
      const n = (calls.get(body.model) ?? 0) + 1;
      calls.set(body.model, n);
      const edit = body.model === "controlled-au-pair";
      return Response.json({
        model: body.model,
        choices: [
          {
            finish_reason: n === 1 ? "tool_calls" : "stop",
            message:
              n === 1
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `${body.model}-1`,
                        type: "function",
                        function: {
                          name: edit ? "propose_patch" : "read_file",
                          arguments: JSON.stringify(
                            edit
                              ? { patch, summary: "increment only the sample" }
                              : { path: "src/sample.ts" }
                          ),
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: edit
                      ? "Bounded patch proposed."
                      : "Observed value = 1 in src/sample.ts.",
                  },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
    },
  });
  const env = {
    PATH: process.env.PATH,
    HOME: repoRoot,
    LOOP_UTILITY_HARNESS: "legacy",
    LOOP_NANNY_ENABLED: "1",
    LOOP_NANNY_MODEL: "controlled-nanny",
    LOOP_NANNY_URL: `${server.url}v1/chat/completions`,
    LOOP_AU_PAIR_ENABLED: "1",
    LOOP_AU_PAIR_MODEL: "controlled-au-pair",
    LOOP_AU_PAIR_URL: `${server.url}v1/chat/completions`,
  };
  const children: ReturnType<typeof spawn>[] = [];
  try {
    for (const kind of ["inspect", "edit"] as const) {
      const id = `proof-${kind}`;
      appendUtilityRouteRequest(
        runDir,
        createUtilityRouteRequest({
          id,
          kind,
          requester: "codex",
          objective:
            kind === "edit" ? "Increment sample to two" : "Read sample value",
          acceptanceCriteria: ["only the declared sample file"],
          authority: {},
          risk: "low",
          workShape: "separable",
          readScope: ["src/sample.ts"],
          writeScope: kind === "edit" ? ["src/sample.ts"] : [],
          requiredCapabilities:
            kind === "edit" ? ["inspect", "scoped-edit"] : ["inspect"],
        })
      );
      await processPendingUtilityRoutes(
        { currentDriver: "codex", peer: "claude", epoch: 1, repoRoot, runDir },
        env,
        {
          spawnWorker: (input) => {
            children.push(
              spawn(
                [
                  join(process.cwd(), "loop"),
                  "__utility-worker",
                  input.runDir,
                  String(input.epoch),
                  input.jobId,
                ],
                {
                  cwd: repoRoot,
                  env: input.env,
                  stdout: "pipe",
                  stderr: "pipe",
                }
              )
            );
            return true;
          },
        }
      );
      const child = children.at(-1);
      if (!child) {
        throw new Error("worker was not spawned");
      }
      const exit = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const job = readUtilityJob(runDir, id);
      expect(job?.state).toBe("completed");
      expect(job?.decision?.tierId).toBe(
        kind === "edit" ? "utility-au-pair" : "utility-nanny"
      );
      expect(readFileSync(sample, "utf8")).toBe("export const value = 1;\n");
    }
    const edit = readUtilityJob(runDir, "proof-edit");
    const artifact = edit?.result?.artifactRefs.find(
      (ref) => ref.kind === "diff"
    );
    if (!artifact) {
      throw new Error("no patch for driver review");
    }
    // Acceptance owner reviews the exact patch, rather than auto-applying output.
    expect(readFileSync(artifact.path, "utf8")).toBe(patch);
    expect(
      (
        await applyUtilityJobPatch(
          runDir,
          "proof-edit",
          artifact.sha256,
          "codex"
        )
      ).status
    ).toBe("applied");
    expect(readFileSync(sample, "utf8")).toBe("export const value = 2;\n");
    expect(readUtilityJob(runDir, "proof-edit")?.application?.appliedBy).toBe(
      "codex"
    );
    expect(calls.get("controlled-nanny")).toBe(2);
    expect(calls.get("controlled-au-pair")).toBe(2);
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
}, 30_000);
