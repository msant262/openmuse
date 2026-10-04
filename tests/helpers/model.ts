import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { modelProviderConfig } from "../../apps/server/src/providers/config.ts";

/** The synthetic endpoint accepts the complete rich chat/tool history. Its
 * declared capacity is fixture metadata, not a production model assumption. */
export function richChatFixtureProviders(dataDir: string, models = ["openai/fixture"]) {
  return modelProviderConfig(dataDir, {
    ...process.env,
    MODEL_CAPABILITIES: JSON.stringify(
      Object.fromEntries(
        models.map((model) => [
          model,
          {
            tools: true,
            vision: false,
            structuredOutput: true,
            contextTokens: 131072,
          },
        ]),
      ),
    ),
  });
}

type ModelCall = { name: string; arguments: object };

// Serve the provider protocol, leaving tool execution and AG-UI event emission to the real SDK.
export async function modelFixture(
  t: TestContext,
  reply: (index: number) => ModelCall | undefined | Promise<ModelCall | undefined>,
  options: {
    errorStatus?: (index: number) => number | undefined;
    dropAfterStart?: (index: number) => boolean;
    dropAfterText?: (index: number) => boolean;
    errorPart?: (index: number) => boolean;
    cleanEof?: (index: number) => boolean;
    incomplete?: (index: number) => boolean;
    partialTool?: (index: number) => boolean;
    retryAfter?: (index: number) => string | undefined;
    text?: (index: number) => string | undefined;
    lateFailure?: (index: number) => boolean;
    noArgumentDelta?: (index: number) => boolean;
    emptyCompletedOutput?: (index: number) => boolean;
    terminalStatus?: (index: number) => "completed" | "incomplete" | "failed" | "eof";
    toolNamespace?: string;
    chatFinishReason?: (index: number) => string | undefined;
    streamContentType?: string | null;
    researchReview?: (
      body: string,
      index: number,
    ) => { complete: boolean; missing: string[]; nextSteps: string[] };
  } = {},
) {
  const {
    errorStatus,
    dropAfterStart,
    dropAfterText,
    errorPart,
    cleanEof,
    incomplete,
    partialTool,
  } = options;
  const requests: { path: string; body: string }[] = [];
  const reviewRequests: { path: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const index = requests.length;
    const isReview = body.includes("PUBLIC_RESEARCH_DELIVERY_REVIEW");
    (isReview ? reviewRequests : requests).push({ path: request.url ?? "", body });
    const contentType =
      options.streamContentType === undefined ? "text/event-stream" : options.streamContentType;
    const streamHeaders = contentType === null ? {} : { "Content-Type": contentType };
    const status = errorStatus?.(index);
    if (status !== undefined) {
      const retryAfter = options.retryAfter?.(index);
      response.writeHead(status, {
        "Content-Type": "application/json",
        ...(retryAfter ? { "Retry-After": retryAfter } : {}),
      });
      response.end(
        JSON.stringify({
          error: { message: "Fixture provider failure", type: "server_error" },
        }),
      );
      return;
    }
    if (dropAfterStart?.(index)) {
      // Deliver a valid stream start, then fail the connection before any
      // assistant output reaches the client.
      response.writeHead(200, streamHeaders);
      response.write(
        `data: ${JSON.stringify({
          type: "response.created",
          response: {
            id: `drop-${index}`,
            created_at: 1000,
            model: "fixture",
            status: "in_progress",
          },
        })}\n\n`,
      );
      setTimeout(() => response.socket?.destroy(), 120);
      return;
    }
    if (dropAfterText?.(index)) {
      // Deliver real assistant output, then fail the connection. A retry
      // must not replay output the client already received.
      response.writeHead(200, streamHeaders);
      response.write(
        `data: ${JSON.stringify({
          type: "response.created",
          response: {
            id: `drop-text-${index}`,
            created_at: 1000,
            model: "fixture",
            status: "in_progress",
          },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: `msg-${index}`,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: `msg-${index}`,
          output_index: 0,
          delta: "Hello partial ",
        })}\n\n`,
      );
      setTimeout(() => response.socket?.destroy(), 120);
      return;
    }
    if (errorPart?.(index)) {
      response.writeHead(200, streamHeaders);
      response.write(
        `data: ${JSON.stringify({
          type: "response.failed",
          sequence_number: 1,
          response: {
            error: { code: "server_error", message: "Provider reported response.failed" },
          },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    const call = isReview ? undefined : await reply(index);
    // Existing tests isolate the execution loop. Dedicated review tests supply
    // rejection/repair decisions at this external model boundary.
    const text = isReview
      ? JSON.stringify(
          options.researchReview?.(body, reviewRequests.length - 1) ?? {
            complete: true,
            missing: [],
            nextSteps: [],
          },
        )
      : options.text?.(index);
    if (request.url?.endsWith("/chat/completions")) {
      response.writeHead(200, streamHeaders);
      const emit = (delta: object, finishReason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `completion-${index}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      emit({ role: "assistant", ...(text ? { content: text } : {}) });
      if (call)
        emit({
          tool_calls: [
            {
              index: 0,
              id: `call-${index}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        });
      if (!cleanEof?.(index) && !partialTool?.(index))
        emit({}, options.chatFinishReason?.(index) ?? (call ? "tool_calls" : "stop"));
      response.end("data: [DONE]\n\n");
      return;
    }
    const content = text ? [{ type: "output_text", text, annotations: [] }] : [];
    if (JSON.parse(body).stream === false) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: `response-${index}`,
          model: "fixture",
          status: "completed",
          output: [
            {
              id: `message-${index}`,
              type: "message",
              role: "assistant",
              status: "completed",
              content,
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
      return;
    }
    response.writeHead(200, streamHeaders);
    const emit = (type: string, value: object) =>
      response.write(`data: ${JSON.stringify({ type, ...value })}\n\n`);
    const base = { id: `response-${index}`, created_at: 1000, model: "fixture" };
    emit("response.created", { response: { ...base, status: "in_progress" } });
    if (cleanEof?.(index)) {
      response.end();
      return;
    }
    if (incomplete?.(index)) {
      emit("response.incomplete", { response: { ...base, status: "incomplete" } });
      response.end("data: [DONE]\n\n");
      return;
    }
    const item = call && {
      id: `item-${index}`,
      type: "function_call",
      call_id: `call-${index}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
      ...(options.toolNamespace ? { namespace: options.toolNamespace } : {}),
    };
    if (item) {
      emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } });
      if (!options.noArgumentDelta?.(index))
        emit("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        });
      if (partialTool?.(index)) {
        response.end();
        return;
      }
      emit("response.output_item.done", {
        output_index: 0,
        item: { ...item, status: "completed" },
      });
    }
    if (text) {
      emit("response.output_item.added", {
        output_index: 0,
        item: {
          id: `message-${index}`,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      emit("response.output_text.delta", {
        item_id: `message-${index}`,
        output_index: 0,
        delta: text,
      });
    }
    const terminalStatus = options.terminalStatus?.(index) ?? "completed";
    if (terminalStatus === "eof") {
      response.end("data: [DONE]\n\n");
      return;
    }
    emit(`response.${terminalStatus}`, {
      response: {
        ...base,
        status: terminalStatus,
        output: options.emptyCompletedOutput?.(index)
          ? []
          : item
            ? [{ ...item, status: "completed" }]
            : text
              ? [
                  {
                    id: `message-${index}`,
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content,
                  },
                ]
              : [],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    if (options.lateFailure?.(index)) {
      setTimeout(() => {
        emit("response.failed", {
          response: {
            ...base,
            status: "failed",
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "private late error",
            },
          },
        });
        response.end("data: [DONE]\n\n");
      }, 20);
      return;
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "local-test-fixture";
  t.after(async () => {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests };
}
