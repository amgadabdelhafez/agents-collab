/**
 * A `temporalWorkflow` that schedules a timer, a command no recorded history
 * holds. The replay test uses it to pin down what Temporal's replay check
 * does not see on these histories: they hold no command events at all, and
 * this SDK's replay accepts a bundle that adds one.
 */
import { condition, sleep } from "@temporalio/workflow";

export async function temporalWorkflow(): Promise<never> {
  await sleep(1000);
  await condition(() => false);
  throw new Error("unreachable");
}
