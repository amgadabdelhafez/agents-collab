import { expect, test } from "bun:test";
import {
  acknowledgeRecipientWorkflow,
  callRecipientApi,
  callRecipientRoute,
  RecipientAcknowledgementError,
  RecipientRouteError,
  recipientApiConfigured,
} from "../../src/loop/recipient-api-client";

const TOKEN = "test-only-fixture-secret";
const URL_ = "http://127.0.0.1:7337/a2a/v2/recipient";
const WORKFLOW = `supervisor-message-workflow:v2:${"a".repeat(64)}`;

/** A fetch that answers each request with the next scripted response. */
const scripted = (
  answer: (command: { operation: string; requestId: string }) => Response
) => {
  const seen: { operation: string; requestId: string }[] = [];
  const fetchImpl = Object.assign(
    (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const command = JSON.parse(String(init?.body)) as {
        operation: string;
        requestId: string;
      };
      seen.push({ operation: command.operation, requestId: command.requestId });
      return Promise.resolve(answer(command));
    },
    { preconnect: fetch.preconnect }
  );
  return { fetchImpl, seen };
};

const receipt = (operation: string) =>
  Response.json({
    phase: operation === "claim" ? "claimed" : "acknowledged",
    schema: "supervisor-message-recipient-receipt.v2",
    workflowId: WORKFLOW,
    workResultCompleted: false,
  });

test("a route refusal surfaces its code from the fixed set only, never a body's free text or a token", async () => {
  const refuseWith = (status: number, body: unknown) =>
    callRecipientRoute({
      command: {
        operation: "claim",
        requestId: "request:one",
        workflowId: WORKFLOW,
      },
      fetchImpl: scripted(() => Response.json(body, { status })).fetchImpl,
      token: TOKEN,
      url: URL_,
    }).catch((error: unknown) => error as RecipientRouteError);
  const denied = await refuseWith(403, { code: "assignment-denied" });
  expect(denied).toBeInstanceOf(RecipientRouteError);
  expect(denied.code).toBe("assignment-denied");
  expect(denied.message).toContain("(assignment-denied)");
  expect(
    (await refuseWith(503, { error: { code: "v2-unavailable" } })).code
  ).toBe("v2-unavailable");
  // An unknown code, a token echoed as a code, or text: just "refused".
  for (const body of [
    { code: "something-new" },
    { code: TOKEN },
    { code: "lifecycle-command-refused extra" },
    "plain text",
  ]) {
    const refused = await refuseWith(409, body);
    expect(refused.code).toBe("refused");
    expect(refused.message).not.toContain(TOKEN);
  }
  // A retry hint is believed only on an early refusal, and bounded.
  expect(
    (
      await refuseWith(409, {
        code: "delivery-not-recorded",
        retryAfterMs: 1500,
      })
    ).retryAfterMs
  ).toBe(1500);
  expect(
    (await refuseWith(409, { code: "not-claimed", retryAfterMs: 1e12 }))
      .retryAfterMs
  ).toBe(600_000);
  expect(
    (await refuseWith(409, { code: "assignment-denied", retryAfterMs: 5 }))
      .retryAfterMs
  ).toBeUndefined();
  const down = await callRecipientRoute({
    command: { operation: "claim", requestId: "r", workflowId: WORKFLOW },
    fetchImpl: Object.assign(() => Promise.reject(new Error(TOKEN)), {
      preconnect: fetch.preconnect,
    }),
    token: TOKEN,
    url: URL_,
  }).catch((error: unknown) => error as RecipientRouteError);
  expect(down.code).toBe("unavailable");
  expect(down.message).not.toContain(TOKEN);
});

test("an ACK waits out early refusals with the same request ids, and reports every other refusal at once with its codes", async () => {
  // Early: the delivery is recorded only on the third claim.
  let claims = 0;
  const early = scripted((command) => {
    if (command.operation === "claim") {
      claims++;
      return claims < 3
        ? Response.json(
            { code: "delivery-not-recorded", retryAfterMs: 900 },
            { status: 409 }
          )
        : receipt("claim");
    }
    return receipt("acknowledge");
  });
  const slept: number[] = [];
  let clock = 0;
  const waits = {
    now: () => clock,
    sleep: (ms: number) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
  expect(
    await acknowledgeRecipientWorkflow({
      ...waits,
      fetchImpl: early.fetchImpl,
      token: TOKEN,
      url: URL_,
      workflowId: WORKFLOW,
    })
  ).toMatchObject({ phase: "acknowledged", workResultCompleted: false });
  // The server's hint plus a margin; no acknowledge while the claim was early.
  expect(slept).toEqual([1000, 1000]);
  expect(early.seen).toEqual([
    { operation: "claim", requestId: `a2a-ack:claim:${WORKFLOW}` },
    { operation: "claim", requestId: `a2a-ack:claim:${WORKFLOW}` },
    { operation: "claim", requestId: `a2a-ack:claim:${WORKFLOW}` },
    { operation: "acknowledge", requestId: `a2a-ack:acknowledge:${WORKFLOW}` },
  ]);

  // An acknowledge before the claim is recorded (a claim that timed out on
  // its way in) is early too: claim and acknowledge again.
  let acknowledges = 0;
  const notClaimed = scripted((command) => {
    if (command.operation === "claim") {
      return Response.json({ code: "unavailable" }, { status: 504 });
    }
    acknowledges++;
    return acknowledges < 2
      ? Response.json({ code: "not-claimed" }, { status: 409 })
      : receipt("acknowledge");
  });
  slept.length = 0;
  expect(
    await acknowledgeRecipientWorkflow({
      ...waits,
      fetchImpl: notClaimed.fetchImpl,
      token: TOKEN,
      url: URL_,
      workflowId: WORKFLOW,
    })
  ).toMatchObject({ phase: "acknowledged" });
  expect(slept).toEqual([250]);
  expect(notClaimed.seen.map((entry) => entry.operation)).toEqual([
    "claim",
    "acknowledge",
    "claim",
    "acknowledge",
  ]);

  // The wait is bounded: past it, the early refusal is the reported one.
  const never = scripted(() =>
    Response.json(
      { code: "delivery-not-recorded", retryAfterMs: 30_000 },
      { status: 409 }
    )
  );
  slept.length = 0;
  const bounded = (await acknowledgeRecipientWorkflow({
    ...waits,
    earlyWaitMs: 45_000,
    fetchImpl: never.fetchImpl,
    token: TOKEN,
    url: URL_,
    workflowId: WORKFLOW,
  }).catch((error: unknown) => error)) as RecipientAcknowledgementError;
  expect(bounded).toBeInstanceOf(RecipientAcknowledgementError);
  expect(bounded.reason).toBe("claim: delivery-not-recorded");
  expect(slept).toEqual([30_100]);

  // Anything not early is reported at once, with both codes, never retried.
  for (const [claimBody, ackBody, reason] of [
    [
      { code: "assignment-denied" },
      { code: "assignment-denied" },
      "acknowledge: assignment-denied; claim: assignment-denied",
    ],
    [
      { code: "lifecycle-command-refused" },
      { code: "lifecycle-command-refused" },
      "acknowledge: lifecycle-command-refused; claim: lifecycle-command-refused",
    ],
  ] as const) {
    const refused = scripted((command) =>
      Response.json(command.operation === "claim" ? claimBody : ackBody, {
        status: 409,
      })
    );
    slept.length = 0;
    const error = (await acknowledgeRecipientWorkflow({
      ...waits,
      fetchImpl: refused.fetchImpl,
      token: TOKEN,
      url: URL_,
      workflowId: WORKFLOW,
    }).catch((caught: unknown) => caught)) as RecipientAcknowledgementError;
    expect(error.reason).toBe(reason);
    expect(error.message).toContain(reason);
    expect(error.message).not.toContain(TOKEN);
    expect(slept).toEqual([]);
    expect(refused.seen).toHaveLength(2);
  }
});

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
