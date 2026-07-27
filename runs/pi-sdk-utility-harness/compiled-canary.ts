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
import { createUtilityRouteRequest } from "../../loop-fork/src/loop/task-router";
import {
	activateUtilityEpoch,
	appendUtilityRouteRequest,
	readUtilityJob,
	transitionUtilityJob,
} from "../../loop-fork/src/loop/utility-store";

const event = (
	delta: Record<string, unknown>,
	finishReason: string | null = null,
	usage?: Record<string, number>,
): string =>
	`data: ${JSON.stringify({
		choices: [{ delta, finish_reason: finishReason, index: 0 }],
		created: 1,
		id: "chatcmpl-compiled-canary",
		model: "fake-nanny",
		object: "chat.completion.chunk",
		...(usage ? { usage } : {}),
	})}\n\n`;

const response = (events: string[]): Response =>
	new Response(`${events.join("")}data: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});

const repoRoot = mkdtempSync(join(tmpdir(), "loop-compiled-pi-"));
const runDir = join(repoRoot, ".loop", "runs", "compiled-pi");
const binary = join(import.meta.dir, "../../loop-fork/loop");
mkdirSync(join(repoRoot, "src"), { recursive: true });
mkdirSync(runDir, { recursive: true });
writeFileSync(join(repoRoot, "src", "sample.ts"), "export const needle = 1;\n");
writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ cwd: repoRoot }));

const request = createUtilityRouteRequest({
	acceptanceCriteria: ["return source-backed evidence"],
	authority: {},
	executionProfile: "search",
	id: "compiled-pi-nanny",
	kind: "inspect",
	objective: "Find the declared needle",
	readScope: ["src"],
	requester: "codex",
	requiredCapabilities: ["inspect"],
	risk: "low",
	writeScope: [],
});
appendUtilityRouteRequest(runDir, request);
activateUtilityEpoch(runDir, 92);
transitionUtilityJob(runDir, request.id, "routed-utility", {
	decision: {
		reason: "utility-eligible",
		target: "utility",
		tierId: "utility-nanny",
	},
	routeEpoch: 92,
});

let calls = 0;
const server = serve({
	fetch: () => {
		calls += 1;
		return calls === 1
			? response([
					event({ role: "assistant" }),
					event({
						tool_calls: [
							{
								function: {
									arguments: '{"query":"needle","paths":["src"]}',
									name: "search_repo",
								},
								id: "search-compiled",
								index: 0,
								type: "function",
							},
						],
					}),
					event({}, "tool_calls", {
						completion_tokens: 8,
						prompt_tokens: 40,
						total_tokens: 48,
					}),
				])
			: response([
					event({ role: "assistant" }),
					event({ content: "Compiled Nanny found src/sample.ts." }),
					event({}, "stop", {
						completion_tokens: 7,
						prompt_tokens: 70,
						total_tokens: 77,
					}),
				]);
	},
	port: 0,
});

try {
	const child = spawn({
		cmd: [binary, "__utility-worker", runDir, "92", request.id],
		cwd: repoRoot,
		env: {
			...process.env,
			LOOP_NANNY_ENABLED: "1",
			LOOP_NANNY_MODEL: "fake-nanny",
			LOOP_NANNY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
			LOOP_UTILITY_HARNESS: "pi-sdk",
		},
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	const job = readUtilityJob(runDir, request.id);
	const usage = readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8");
	const passed =
		exitCode === 0 &&
		job?.state === "completed" &&
		job.result?.summary === "Compiled Nanny found src/sample.ts." &&
		usage.includes('"harness":"pi-sdk"') &&
		usage.includes('"role":"Nanny"');
	console.log(
		JSON.stringify({
			calls,
			blocker: job?.result?.blocker,
			exitCode,
			passed,
			piVersion: "0.82.1",
			state: job?.state,
			stderr: stderr.trim(),
			summary: job?.result?.summary,
		}),
	);
	if (!passed) {
		process.exitCode = 1;
	}
} finally {
	server.stop(true);
	rmSync(repoRoot, { force: true, recursive: true });
}
