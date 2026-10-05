import type { Message, SendMessageRequest, StreamResponse } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import {
  DefaultRequestHandler,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import {
  SupervisorA2ARequestValidationError,
  validateSupervisorA2ARequest,
} from "./a2a-supervisor-adapter";

/**
 * The SDK's `DefaultRequestHandler` creates and saves a follow-up task context
 * before it calls the executor. The adapter's deterministic request-shape
 * checks must therefore run here, before delegating to the SDK, rather than
 * in the executor where a malformed turn would terminalize an earlier task.
 *
 * Authentication and governance remain in the executor/runtime path. This
 * boundary only rejects shape errors that can be decided without touching a
 * task, workflow, receipt, or durable thread store.
 */
export class SupervisorA2ARequestHandler extends DefaultRequestHandler {
  override async sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext
  ) {
    assertSupervisorRequestShape(params.message);
    return await super.sendMessage(params, context);
  }

  /**
   * This deliberately is not an `async *` method. The synchronous assertion
   * must run while a transport constructs the stream, so JSON-RPC can map it
   * as a request error rather than deferring it until the first iteration.
   */
  override sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext
  ): AsyncGenerator<StreamResponse, void, undefined> {
    assertSupervisorRequestShape(params.message);
    return super.sendMessageStream(params, context);
  }
}

const assertSupervisorRequestShape = (message: Message | undefined): void => {
  // The SDK already reports a missing `message` as RequestMalformedError before
  // task creation. Leave that standard check to the parent implementation.
  if (!message) {
    return;
  }
  try {
    validateSupervisorA2ARequest(message);
  } catch (error) {
    if (error instanceof SupervisorA2ARequestValidationError) {
      throw new RequestMalformedError({
        cause: error,
        message: error.message,
      });
    }
    throw error;
  }
};
