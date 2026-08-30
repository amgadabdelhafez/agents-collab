import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  prepareTemporalWorkerForCompiledBundle,
  TEMPORAL_NOOP_INTERCEPTOR_SHA256,
} from "../../scripts/temporal-worker-compile";

const workerRoot = join(
  import.meta.dir,
  "../../node_modules/@temporalio/worker"
);
const bundlerSource = readFileSync(
  join(workerRoot, "lib/workflow/bundler.js"),
  "utf8"
);
const interceptorSource = readFileSync(
  join(workerRoot, "lib/workflow-log-interceptor.js"),
  "utf8"
);

test("compiled Temporal worker removes only the exact pinned deprecated no-op interceptor", () => {
  expect(TEMPORAL_NOOP_INTERCEPTOR_SHA256).toBe(
    "aa03c7d6f9573d1021e2c6678f3d466233ba58af2f3d5731d01f5c50da89bc81"
  );
  const transformed = prepareTemporalWorkerForCompiledBundle(
    bundlerSource,
    interceptorSource
  );
  expect(transformed).not.toContain(
    "require.resolve('../workflow-log-interceptor')"
  );
  expect(transformed).toContain(
    "exports.defaultWorkflowInterceptorModules = [];"
  );
});

test("compiled Temporal worker refuses changed interceptor or bundler bytes", () => {
  expect(() =>
    prepareTemporalWorkerForCompiledBundle(
      bundlerSource,
      `${interceptorSource}\nchanged`
    )
  ).toThrow("is not the reviewed no-op");
  expect(() =>
    prepareTemporalWorkerForCompiledBundle(
      bundlerSource.replace(
        "require.resolve('../workflow-log-interceptor')",
        "require.resolve('../different-interceptor')"
      ),
      interceptorSource
    )
  ).toThrow("marker count is 0");
});
