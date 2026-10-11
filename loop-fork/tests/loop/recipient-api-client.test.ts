import { expect, test } from "bun:test";
import {
  callRecipientApi,
  callRecipientRoute,
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
      env: { ...env, LOOP_RECIPIENT_API_URL: "http://example.com/recipient" },
    })
  ).rejects.toThrow("https or loopback");
  // RA1: plaintext only on a loopback IP literal; never a name that could
  // resolve elsewhere, credentials, a query or a fragment.
  for (const url of [
    "http://localhost:7337/a2a/recipient",
    "http://10.0.0.5:7337/a2a/recipient",
    "https://user:pass@loop.home.lab/a2a/recipient",
    "https://loop.home.lab/a2a/recipient?to=elsewhere",
    "https://loop.home.lab/a2a/recipient#fragment",
    "ftp://loop.home.lab/a2a/recipient",
  ]) {
    await expect(
      callRecipientApi({
        ...input,
        env: { ...env, LOOP_RECIPIENT_API_URL: url },
      })
    ).rejects.toThrow("https or loopback");
  }
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

test("RA1: the recipient client reaches a configured https origin and [::1], with the same refusals", async () => {
  const urls: string[] = [];
  const fetchImpl = Object.assign(
    (url: Parameters<typeof fetch>[0]) => {
      urls.push(String(url));
      return Promise.resolve(
        Response.json({
          schema: "supervisor-message-recipient-receipt.v2",
          workflowId: "workflow:one",
          phase: "acknowledged",
          workResultCompleted: false,
        })
      );
    },
    { preconnect: fetch.preconnect }
  );
  const command = {
    operation: "acknowledge" as const,
    requestId: "request:one",
    workflowId: "workflow:one",
  };
  for (const url of [
    "https://loop.home.lab/a2a/recipient",
    "http://[::1]:7337/a2a/recipient",
  ]) {
    await expect(
      callRecipientRoute({ command, fetchImpl, token: "fixture", url })
    ).resolves.toMatchObject({ phase: "acknowledged" });
  }
  expect(urls).toEqual([
    "https://loop.home.lab/a2a/recipient",
    "http://[::1]:7337/a2a/recipient",
  ]);
});
