import { createHash } from "node:crypto";

const INTERCEPTOR_ASSIGNMENT =
  "exports.defaultWorkflowInterceptorModules = [require.resolve('../workflow-log-interceptor')];";
const EMPTY_INTERCEPTOR_ASSIGNMENT =
  "exports.defaultWorkflowInterceptorModules = [];";
export const TEMPORAL_NOOP_INTERCEPTOR_SHA256 =
  "aa03c7d6f9573d1021e2c6678f3d466233ba58af2f3d5731d01f5c50da89bc81";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const prepareTemporalWorkerForCompiledBundle = (
  bundlerSource: string,
  interceptorSource: string
): string => {
  const interceptorSha256 = sha256(interceptorSource);
  if (interceptorSha256 !== TEMPORAL_NOOP_INTERCEPTOR_SHA256) {
    throw new Error(
      `Temporal workflow interceptor is not the reviewed no-op: ${interceptorSha256}`
    );
  }
  const occurrences = bundlerSource.split(INTERCEPTOR_ASSIGNMENT).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Temporal worker interceptor marker count is ${occurrences}; refusing an unverified compile transform`
    );
  }
  return bundlerSource.replace(
    INTERCEPTOR_ASSIGNMENT,
    EMPTY_INTERCEPTOR_ASSIGNMENT
  );
};
