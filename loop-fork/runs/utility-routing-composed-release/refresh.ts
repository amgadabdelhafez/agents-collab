import { readFileSync } from "node:fs";
import { spawn } from "bun";
import { readBridgeEvents } from "../../src/loop/bridge-store";

// Release-only supported API refresh. Never starts turns or sends composer keys.
async function refresh(url: string) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  ws.addEventListener("message", (event) => {
    for (const line of String(event.data).split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const frame = JSON.parse(line);
      const p = pending.get(frame.id);
      if (!p) {
        continue;
      }
      clearTimeout(p.timer);
      pending.delete(frame.id);
      if (frame.error) {
        p.reject(new Error(JSON.stringify(frame.error)));
      } else {
        p.resolve(frame.result);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("socket connection failed")),
      { once: true }
    );
  });
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    await rpc("initialize", {
      clientInfo: { name: "loop-routing-release", version: "1" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: "initialized", params: {} }));
    await rpc("config/mcpServer/reload", null);
    const status = await rpc("mcpServerStatus/list", {
      cursor: null,
      limit: 100,
      serverName: "loop-bridge",
    });
    const servers = status.data ?? [];
    const tools = servers.flatMap((s: any) => Object.values(s.tools ?? {}));
    const route = tools.find((t: any) => t.name === "route_task") as any;
    return {
      reloadAccepted: true,
      servers: servers.map((s: any) => s.name),
      updatedRouteContract:
        route?.description?.includes("not a quota of packets") ?? false,
    };
  } finally {
    ws.close();
  }
}

async function guidance(runDir: string, target: string) {
  const child = spawn(
    ["/Users/amgad/.local/bin/loop", "__bridge-mcp", runDir, "supervisor"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: {
          target,
          type: "message",
          subject:
            "Installed routing repair: useful delegation, no packet quota",
          dedupe_key: `routing-release-53be5d44-${target}`,
          message:
            "Human-authorized routing repair is installed (53be5d44). Delegate useful independent work, not a quota. Nanny: narrow evidence; Au Pair: cohesive evidence and bounded patch proposals, including Codex-primary runs. Driver remains sole reviewer/apply owner. Do not repeat unchanged refusals or disguise edits as reads. Keep active patch scopes reserved; use guarded apply after review. Existing goal, model settings and product authority are unchanged. Please acknowledge through the bridge when received. This is guidance refresh, not a new product task or a restart request.",
        },
      },
    }) + "\n"
  );
  child.stdin.end();
  const output = await new Response(child.stdout).text();
  const exit = await child.exited;
  const frame = output
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .find((f) => f.id === 1);
  if (exit !== 0 || frame?.error) {
    throw new Error("guidance bridge submission refused");
  }
  // Print only the submission metadata, never any returned private traffic.
  const message = readBridgeEvents(runDir).find(
    (event) =>
      event.kind === "message" &&
      event.source === "supervisor" &&
      event.target === target &&
      event.dedupeKey === `routing-release-53be5d44-${target}`
  );
  if (!message) {
    throw new Error("accepted guidance has no durable message record");
  }
  return { target, queued: true, id: message.id };
}

for (const runDir of process.argv.slice(2)) {
  const m = JSON.parse(readFileSync(`${runDir}/manifest.json`, "utf8"));
  if (m.status !== "running" || !m.codexRemoteUrl) {
    throw new Error("run is not live/bound");
  }
  console.log(
    JSON.stringify({ run: m.runId, refresh: await refresh(m.codexRemoteUrl) })
  );
  for (const target of ["codex", "claude"]) {
    console.log(
      JSON.stringify({ run: m.runId, guidance: await guidance(runDir, target) })
    );
  }
}
