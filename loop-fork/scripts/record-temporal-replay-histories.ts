/**
 * Regenerates tests/fixtures/temporal-replay: Temporal histories of in-flight
 * executions recorded by earlier builds, which
 * tests/loop/temporal-bundle-replay.test.ts replays against this checkout's
 * workflow bundle.
 *
 *   bun run scripts/record-temporal-replay-histories.ts
 *
 * For each source in REPLAY_SOURCES it extracts that commit's loop-fork/src
 * with git archive, runs a worker on that commit's committed generated
 * bundle (what a host at that commit runs) on a local Temporal dev server,
 * drives every scenario of its family (tests/support/
 * temporal-replay-scenarios.ts) with that commit's own TemporalWorkflowPort
 * and id derivations, and writes each execution's history (left RUNNING, in
 * flight) as JSON, with a snapshot of every query its callers send. It also
 * rebuilds that commit's bundle from its source and records which modules of
 * the committed bundle differ from that build. For a source with a
 * `liveRef`, it checks that the two commits hold the same blob for every
 * file the live handoff test runs.
 *
 * Needs: the source commits in this clone (455ccc32 is on no remote: record
 * from a clone that holds it), and the Temporal CLI dev server that
 * TestWorkflowEnvironment.createLocal() starts. Touches no live service.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@temporalio/client";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import {
  bundleDigest,
  differingBundleModules,
  type ExtractedBuild,
  extractBuild,
  LIVE_HANDOFF_FILES,
  LOOP_FORK_ROOT,
  REPLAY_SOURCES,
  type ReplaySource,
  replayScenariosFor,
  repositoryTop,
  run,
} from "../tests/support/temporal-replay-builds";
import {
  type ReplayPort,
  replayCommandKey,
  snapshotPhaseOf,
  snapshotReplayScenario,
  startReplayScenario,
} from "../tests/support/temporal-replay-scenarios";

const workerVersion = (
  (await import("@temporalio/worker/package.json")) as { version: string }
).version;
const FIXTURE_DIR = join(LOOP_FORK_ROOT, "tests/fixtures/temporal-replay");
const IDENTITY = "temporal-replay-fixture-recorder";

const silentLogger = {
  debug: () => undefined,
  error: (message: string) => console.error(message),
  info: () => undefined,
  log: () => undefined,
  trace: () => undefined,
  warn: (message: string) => console.warn(message),
};

/** Rebuild a commit's bundle from its own source, as its build script does. */
const rebuildFromSource = async (build: ExtractedBuild): Promise<string> => {
  const cwd = process.cwd();
  // The bundler names modules relative to the working directory; the build
  // script runs from loop-fork, so rebuild from the extracted loop-fork, and
  // keep the linked node_modules path instead of resolving the link.
  process.chdir(build.root);
  try {
    const bundle = await bundleWorkflowCode({
      logger: silentLogger as never,
      webpackConfigHook: (config) => ({
        ...config,
        resolve: { ...config.resolve, symlinks: false },
      }),
      workflowsPath: join(build.root, "src/loop/temporal-workflow.ts"),
    });
    return bundle.code;
  } finally {
    process.chdir(cwd);
  }
};

/** A source's `liveRef` must hold `ref`'s blob for every file a handoff runs. */
const checkLiveRef = (source: ReplaySource): void => {
  if (!source.liveRef) {
    return;
  }
  const top = repositoryTop();
  for (const file of LIVE_HANDOFF_FILES) {
    const [recorded, live] = [source.ref, source.liveRef].map((ref) =>
      String(run("git", ["rev-parse", `${ref}:${file}`], { cwd: top })).trim()
    );
    if (recorded !== live) {
      throw new Error(
        `${source.label}: ${file} is ${recorded} at ${source.ref} but ${live} at ${source.liveRef}`
      );
    }
  }
};

const environment = await TestWorkflowEnvironment.createLocal();
// An explicit identity: the default one names this machine's host.
const client = new Client({
  connection: environment.connection,
  identity: IDENTITY,
  namespace: environment.namespace,
});

const manifest: Record<string, unknown>[] = [];
try {
  for (const source of REPLAY_SOURCES) {
    checkLiveRef(source);
    const build = await extractBuild(source, source.ref);
    try {
      const rebuilt = await rebuildFromSource(build);
      const taskQueue = `replay-fixture-${source.label}`;
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        identity: IDENTITY,
        namespace: environment.namespace,
        taskQueue,
        workflowBundle: { code: build.bundleCode },
      });
      const running = worker.run();
      const histories: Record<string, unknown>[] = [];
      try {
        const portModule = (await import(
          join(build.root, "src/loop/temporal-workflow-port.ts")
        )) as {
          TemporalWorkflowPort: new (
            client: unknown,
            options: { now: () => string; taskQueue: string }
          ) => ReplayPort;
        };
        const clock = { at: "" };
        const port = new portModule.TemporalWorkflowPort(client.workflow, {
          now: () => clock.at,
          taskQueue,
        });
        const scenarios = replayScenariosFor({
          ...(build.contract ? { contract: build.contract } : {}),
          deployment: taskQueue,
          family: source.family,
          label: source.label,
          messageIdFormat: source.messageIdFormat,
        });
        const outcome = (workflowId: string, key: string) =>
          client.workflow
            .getHandle(workflowId)
            .query("workflow-port-command-outcome", key);
        const directory = join(FIXTURE_DIR, source.label);
        rmSync(directory, { force: true, recursive: true });
        mkdirSync(directory, { recursive: true });
        for (const scenario of scenarios) {
          await startReplayScenario(port, clock, scenario);
          const snapshot = await snapshotReplayScenario(
            port,
            outcome,
            scenario,
            scenario.before
          );
          const phase = snapshotPhaseOf(snapshot);
          if (
            snapshot.inspection.status !== scenario.inFlight.status ||
            phase !== scenario.inFlight.phase
          ) {
            throw new Error(
              `${source.label} ${scenario.name}: recorded ${snapshot.inspection.status}/${phase}, expected ${scenario.inFlight.status}/${scenario.inFlight.phase}`
            );
          }
          const history = await client.workflow
            .getHandle(scenario.workflowId)
            .fetchHistory();
          const file = `${scenario.name}.history.json`;
          writeFileSync(
            join(directory, file),
            `${JSON.stringify(JSON.parse(historyToJSON(history)), null, 2)}\n`
          );
          histories.push({
            commands: scenario.before.map(replayCommandKey),
            description: scenario.description,
            file: `${source.label}/${file}`,
            inFlight: scenario.inFlight,
            queries: scenario.queries,
            scenario: scenario.name,
            snapshot,
            workflowId: scenario.workflowId,
            workflowType: scenario.workflowType,
          });
          console.log(`${source.label} ${scenario.name}: recorded`);
        }
      } finally {
        worker.shutdown();
        await running;
      }
      manifest.push({
        bundleSha256: bundleDigest(build.bundleCode),
        // Modules whose committed (shipped) code differs from a build of that
        // commit's own source: empty when the committed bundle is current.
        committedBundleDiffersFromSourceIn: differingBundleModules(
          build.bundleCode,
          rebuilt
        ),
        family: source.family,
        histories,
        label: source.label,
        ...(source.liveRef ? { liveRef: source.liveRef } : {}),
        ref: source.ref,
        summary: source.summary,
      });
    } finally {
      build.close();
    }
  }
  writeFileSync(
    join(FIXTURE_DIR, "manifest.json"),
    `${JSON.stringify(
      {
        recordedWith: {
          sdk: `@temporalio/worker ${workerVersion}, TestWorkflowEnvironment.createLocal`,
          script: "scripts/record-temporal-replay-histories.ts",
        },
        schema: "temporal-replay-fixtures.v2",
        sources: manifest,
      },
      null,
      2
    )}\n`
  );
  // Write the fixtures in the repository's JSON format, so regenerating them
  // changes only what was recorded.
  const format = spawnSync(
    join(LOOP_FORK_ROOT, "node_modules/.bin/biome"),
    ["format", "--write", FIXTURE_DIR],
    { cwd: LOOP_FORK_ROOT, stdio: "inherit" }
  );
  if (format.status !== 0) {
    throw new Error("biome format of the fixtures failed");
  }
} finally {
  await environment.teardown();
}
