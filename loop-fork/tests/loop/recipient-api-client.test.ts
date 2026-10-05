import { expect, test } from "bun:test";
import {
  callRecipientApi,
  recipientApiConfigured,
} from "../../src/loop/recipient-api-client";

test("recipient client is run/seat bound, protects token and refuses remote or invalid receipts", async () => {
  const env = {
    LOOP_RECIPIENT_RUN_DIR: "/private/tmp/owned-run",
    LOOP_RECIPIENT_SEAT: "claude",
    LOOP_RECIPIENT_API_URL: "http://127.0.0.1:7337/a2a/recipient",
    LOOP_RECIPIENT_API_TOKEN: "test-only-fixture-secret",
  };
  let calls = 0;
  const fetchImpl = Object.assign(
    (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls++;
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-only-fixture-secret"
      );
      expect(init?.redirect).toBe("error");
      return Promise.resolve(
        Response.json({
          schema: "supervisor-message-recipient-receipt.v2",
          workflowId: "workflow:one",
          phase: "claimed",
          workResultCompleted: false,
          unexpectedBody: "not returned",
        })
      );
    },
    { preconnect: fetch.preconnect }
  );
  const input = {
    runDir: env.LOOP_RECIPIENT_RUN_DIR,
    seat: "claude",
    env,
    fetchImpl,
    command: {
      operation: "claim" as const,
      requestId: "request:one",
      workflowId: "workflow:one",
    },
  };
  expect(recipientApiConfigured(input.runDir, "supervisor", env)).toBe(false);
  await expect(
    callRecipientApi({ ...input, runDir: "/private/tmp/other-run" })
  ).rejects.toThrow("not enrolled");
  await expect(
    callRecipientApi({
      ...input,
      env: { ...env, LOOP_RECIPIENT_API_URL: "https://example.com/recipient" },
    })
  ).rejects.toThrow("loopback");
  expect(calls).toBe(0);
  const receipt = await callRecipientApi(input);
  expect(receipt).toEqual({
    schema: "supervisor-message-recipient-receipt.v2",
    workflowId: "workflow:one",
    phase: "claimed",
    workResultCompleted: false,
  });
  expect(JSON.stringify(receipt)).not.toContain(env.LOOP_RECIPIENT_API_TOKEN);
  expect(JSON.stringify(receipt)).not.toContain("unexpectedBody");
  await expect(
    callRecipientApi({
      ...input,
      command: {
        ...input.command,
        operation: "publish-result",
        taskId: "task:one",
      },
    })
  ).rejects.toThrow("no completion");
});
