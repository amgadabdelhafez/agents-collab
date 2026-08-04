#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixture.json");
const thresholdsPath = join(here, "thresholds.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const thresholds = JSON.parse(readFileSync(thresholdsPath, "utf8"));
const artifactDir = resolve(process.argv[2] ?? join(here, "artifacts"));
mkdirSync(artifactDir, { recursive: true });

const pickbrain = process.env.PICKBRAIN_BIN ?? "/Users/amgad/.local/bin/pickbrain";
const docker = process.env.DOCKER_BIN ?? "docker";
const honchoContainer = process.env.HONCHO_CONTAINER ?? "honcho-local-bakeoff-api-1";
const scratch = mkdtempSync(join(tmpdir(), "loop-memory-bakeoff-"));

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null;
};
const tokens = (text) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const stop = new Set(["a", "an", "and", "are", "be", "can", "do", "for", "from", "how", "in", "into", "is", "it", "may", "of", "or", "should", "the", "to", "what", "when", "why"]);
const meaningful = (text) => [...tokens(text)].filter((token) => !stop.has(token));
const recallAt5 = (rows) => rows.filter((row) => row.results.slice(0, 5).some((hit) => (hit.docId ?? hit) === row.expected)).length / rows.length;

function markdownResults() {
  return fixture.queries.map((query) => {
    const started = performance.now();
    const queryTokens = meaningful(query.text);
    const ranked = fixture.corpus
      .map((doc) => {
        const haystack = tokens(`${doc.title} ${doc.body}`);
        return { docId: doc.id, source: doc.source, sourceSha256: doc.sha256, score: queryTokens.filter((token) => haystack.has(token)).length };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
      .slice(0, 5);
    return { query: query.id, expected: query.expected, latencyMs: performance.now() - started, results: ranked };
  });
}

function writePiCorpus(home) {
  const sessions = join(home, ".pi", "agent", "sessions", "bakeoff");
  mkdirSync(sessions, { recursive: true });
  fixture.corpus.forEach((doc, index) => {
    const suffix = String(index + 1).padStart(12, "0");
    const id = `00000000-0000-4000-8000-${suffix}`;
    const timestamp = `2026-08-04T00:${String(index).padStart(2, "0")}:00.000Z`;
    const lines = [
      { type: "session", version: 3, id, timestamp, cwd: "/bakeoff/loop-memory" },
      { type: "session_info", id: `${id}-name`, parentId: null, timestamp, name: `${doc.id} ${doc.title}` },
      { type: "message", id: `${id}-user`, parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: `Record curated memory ${doc.id}.` }] } },
      { type: "message", id: `${id}-assistant`, parentId: `${id}-user`, timestamp, message: { role: "assistant", content: [{ type: "text", text: `[${doc.id}] ${doc.title}. ${doc.body} Provenance ${doc.source} ${doc.sha256}.` }] } },
    ];
    writeFileSync(join(sessions, `2026-08-04T00-${String(index).padStart(2, "0")}-00-000Z_${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  });
}

function pickbrainResults() {
  const home = join(scratch, "pickbrain-home");
  const db = join(scratch, "pickbrain-db");
  writePiCorpus(home);
  const env = { ...process.env, HOME: home, PICKBRAIN_DIR: db, NO_COLOR: "1" };
  const warm = spawnSync(pickbrain, ["-q", "--type", "pi", "-n", "5", "bridge delivery"], { env, encoding: "utf8", timeout: 120_000 });
  if (warm.status !== 0) throw new Error(`Pickbrain warmup failed: ${warm.stderr || warm.stdout}`);
  return fixture.queries.map((query) => {
    const started = performance.now();
    const run = spawnSync(pickbrain, ["-q", "--type", "pi", "-n", "5", query.text], { env, encoding: "utf8", timeout: 120_000 });
    if (run.status !== 0) throw new Error(`Pickbrain query ${query.id} failed: ${run.stderr || run.stdout}`);
    const seen = [];
    for (const match of run.stdout.matchAll(/MEM-\d{2}/g)) if (!seen.includes(match[0])) seen.push(match[0]);
    return { query: query.id, expected: query.expected, latencyMs: performance.now() - started, results: seen.slice(0, 5) };
  });
}

function dockerArgs(args) {
  return execFileSync(docker, args, { encoding: "utf8", timeout: 120_000 }).trim();
}

function honchoResults() {
  const remoteFixture = "/tmp/memory-bakeoff-fixture.json";
  const remoteClient = "/tmp/memory-bakeoff-client.py";
  const remoteOutput = "/tmp/memory-bakeoff-results.json";
  const localOutput = join(scratch, "honcho-results.json");
  dockerArgs(["cp", fixturePath, `${honchoContainer}:${remoteFixture}`]);
  dockerArgs(["cp", join(here, "honcho-client.py"), `${honchoContainer}:${remoteClient}`]);
  dockerArgs(["exec", honchoContainer, "/app/.venv/bin/python", remoteClient, remoteFixture, remoteOutput]);
  dockerArgs(["cp", `${honchoContainer}:${remoteOutput}`, localOutput]);
  return JSON.parse(readFileSync(localOutput, "utf8")).results;
}

function proveEgressDenied() {
  const run = spawnSync(docker, ["exec", honchoContainer, "/app/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('https://example.com', timeout=3).read()"], { encoding: "utf8", timeout: 10_000 });
  return { denied: run.status !== 0, exitCode: run.status, evidence: `${run.stderr}\n${run.stdout}`.trim().slice(-1200) };
}

function parseBytes(text) {
  const match = text.trim().match(/^([0-9.]+)([KMG]i?B)$/i);
  if (!match) return NaN;
  const power = { KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: 1024 ** 3 }[match[2].toUpperCase()];
  return Number(match[1]) * power;
}

function resources() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
  const lines = dockerArgs(["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}", "honcho-local-bakeoff-api-1", "honcho-local-bakeoff-deriver-1", "honcho-local-bakeoff-database-1", "honcho-local-bakeoff-redis-1", "honcho-local-bakeoff-embedding-proxy-1", "honcho-local-bakeoff-llm-proxy-1"]).split("\n");
  let cpu = 0;
  let bytes = 0;
  for (const line of lines) {
    const [, cpuText, memoryText] = line.split("|");
    cpu += Number.parseFloat(cpuText);
    bytes += parseBytes(memoryText.split("/")[0].trim());
  }
  return { cpuPercent: cpu, memoryMiB: bytes / 1024 ** 2, raw: lines };
}

function recovery() {
  const started = performance.now();
  dockerArgs(["restart", "honcho-local-bakeoff-api-1"]);
  let healthy = false;
  let probes = 0;
  while (performance.now() - started < 60_000) {
    probes += 1;
    const probe = spawnSync(docker, ["exec", honchoContainer, "/app/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).read()"], { encoding: "utf8", timeout: 5_000 });
    if (probe.status === 0) {
      healthy = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return { healthy, seconds: (performance.now() - started) / 1000, probes, operatorSteps: 1 };
}

function verifyProvenance(rows) {
  return rows.flatMap((row) => row.results).every((hit) => {
    const expected = fixture.corpus.find((doc) => doc.id === hit.docId);
    return expected && hit.source === expected.source && hit.sourceSha256 === expected.sha256;
  });
}

let report;
try {
  const markdown = markdownResults();
  const pickbrainRows = pickbrainResults();
  const honchoRows = honchoResults();
  const egress = proveEgressDenied();
  const service = resources();
  const recoveryResult = recovery();
  const scores = {
    markdownRecallAt5: recallAt5(markdown),
    pickbrainRecallAt5: recallAt5(pickbrainRows),
    honchoRecallAt5: recallAt5(honchoRows),
    honchoProvenanceAccuracy: verifyProvenance(honchoRows) ? 1 : 0,
    honchoP50Ms: percentile(honchoRows.map((row) => row.latencyMs), 0.5),
    honchoP95Ms: percentile(honchoRows.map((row) => row.latencyMs), 0.95),
  };
  const gate = thresholds.gates;
  const checks = {
    egressDenied: egress.denied === gate.egressDenied,
    provenanceAccuracy: scores.honchoProvenanceAccuracy >= gate.provenanceAccuracy,
    absoluteRecall: scores.honchoRecallAt5 >= gate.minimumHonchoRecallAt5,
    versusPickbrain: scores.honchoRecallAt5 + gate.maximumRecallDeficitVsPickbrain >= scores.pickbrainRecallAt5,
    versusMarkdown: scores.honchoRecallAt5 - scores.markdownRecallAt5 >= gate.minimumRecallGainVsMarkdown,
    latency: scores.honchoP95Ms <= gate.maximumWarmP95Ms,
    memory: service.memoryMiB <= gate.maximumServiceMemoryMiB,
    idleCpu: service.cpuPercent <= gate.maximumIdleCpuPercent,
    recovery: recoveryResult.healthy && recoveryResult.seconds <= gate.maximumRecoverySeconds,
    operatorSteps: 9 <= gate.maximumOperatorSteps,
  };
  report = {
    fixtureVersion: fixture.version,
    thresholds,
    systems: {
      markdown: { rows: markdown },
      pickbrain: { binary: pickbrain, rows: pickbrainRows },
      honcho: {
        upstreamCommit: "148f646796067bf7da9c7b7121a21cd47f86039e",
        rows: honchoRows,
        egress,
        service,
        recovery: recoveryResult,
        embeddingAdapter: "google/xtr-base-en normalized mean-pooled 768-dimensional vectors because Honcho accepts one vector per message; Pickbrain uses Witchcraft's native XTR retrieval",
        operatorSteps: 9,
        operatorStepInventory: [
          "start a Docker VM",
          "install/locate Compose and Buildx",
          "build the Honcho image",
          "configure local-only environment variables",
          "preload and verify two tokenizer blobs",
          "resize the fresh pgvector schema",
          "create an internal API/database/Redis network",
          "run two fixed-destination local-model relays",
          "start and health-check six services"
        ]
      },
    },
    scores,
    checks,
    decision: Object.values(checks).every(Boolean) ? "accept-honcho" : "reject-honcho",
    decisionReason: "All preregistered gates are conjunctive; a failed or unmeasured gate rejects additional service complexity.",
  };
  writeFileSync(join(artifactDir, "result.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify({ scores, checks, decision: report.decision }, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
