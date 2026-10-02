import { z } from "zod";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import {
  type InteractionRequest,
  isCredentialIdentifier,
  type QuestionAnswer,
  type QuestionSchema,
  questionAnswerSchema,
  questionSchema,
  runtimeId,
} from "../../../packages/domain/src/runtime.ts";
import { bindingHash } from "./conversation-inbox.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export function validateQuestionAnswer(schema: QuestionSchema, raw: unknown): QuestionAnswer {
  questionSchema.parse(schema);
  const answer = questionAnswerSchema.parse(raw);
  for (const key of Object.keys(answer))
    if (!schema.fields.some((field) => field.id === key))
      throw new AppError("Unknown question field", 422);
  for (const field of schema.fields) {
    const value = answer[field.id];
    if (
      field.required &&
      (value === undefined || value === "" || (Array.isArray(value) && !value.length))
    )
      throw new AppError(`Enter ${field.label}`, 422);
    if (value === undefined) continue;
    if (field.type === "text" && typeof value !== "string")
      throw new AppError("Enter text for this field", 422);
    if (
      field.type === "single" &&
      (typeof value !== "string" || !field.options.some((option) => option.id === value))
    )
      throw new AppError("Choose one available option", 422);
    if (
      field.type === "multiple" &&
      (!Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some((item) => !field.options.some((option) => option.id === item)))
    )
      throw new AppError("Choose available options", 422);
  }
  return answer;
}
export class InteractionRequests {
  constructor(private readonly db: Store) {}
  async create(
    owner: string,
    raw: { taskId: string; revision: number; kind: "question"; schema: unknown },
    fieldBindings?: InteractionRequest["fieldBindings"],
  ) {
    const input = z
      .object({
        taskId: runtimeId,
        revision: z.number().int().min(0),
        kind: z.literal("question"),
        schema: questionSchema,
      })
      .strict()
      .parse(raw);
    const task = await this.db.get<AgentTask>(owner, "tasks", input.taskId);
    if (!task) throw new AppError("Task not found", 404);
    if (
      fieldBindings &&
      Object.values(fieldBindings).some((binding) => isCredentialIdentifier(binding.name))
    )
      throw new AppError("Credentials require a trusted connection form", 422);
    const id = bindingHash({
      taskId: input.taskId,
      revision: input.revision,
      schema: input.schema,
      fieldBindings,
    });
    const value: InteractionRequest = {
      ...input,
      id,
      threadId: task.originThreadId,
      status: "waiting",
      createdAt: new Date().toISOString(),
      ...(fieldBindings ? { fieldBindings } : {}),
    };
    const saved = await this.db.durableMutation<InteractionRequest>(
      owner,
      `question-create:${id}`,
      bindingHash({ input, fieldBindings }),
      [{ kind: "interaction-requests", id, mode: "insert", value: { ...value } }],
      value.threadId
        ? [
            {
              id: `question:${id}`,
              threadId: value.threadId,
              origin: "task",
              kind: "interaction",
              payload: value,
            },
          ]
        : [],
    );
    if (saved.status === "revision_conflict" || saved.status === "binding_conflict")
      throw new AppError("Question changed; reload the task", 409);
    return saved.values[0];
  }
  async forTask(owner: string, task: AgentTask) {
    const existing = (await this.db.list<InteractionRequest>(owner, "interaction-requests")).find(
      (request) =>
        request.taskId === task.id &&
        request.status === "waiting" &&
        request.revision === task.attempts,
    );
    if (existing) return existing;
    const missing = z
      .array(
        z.object({
          name: z.string().min(1).max(300),
          type: z.string(),
          required: z.boolean().optional(),
        }),
      )
      .safeParse(task.state.missingFields);
    if (task.kind === "document" && missing.success && missing.data.length) {
      const bindings: NonNullable<InteractionRequest["fieldBindings"]> = {};
      const fields = missing.data.map((field, index) => {
        const id = `field${index}`;
        bindings[id] = { name: field.name, checkbox: field.type === "checkbox" };
        return field.type === "checkbox"
          ? {
              id,
              label: field.name,
              type: "single" as const,
              required: field.required ?? false,
              options: [
                { id: "true", label: "Yes" },
                { id: "false", label: "No" },
              ],
            }
          : {
              id,
              label: field.name,
              type: "text" as const,
              required: field.required ?? false,
              multiline: false,
            };
      });
      return this.create(
        owner,
        {
          taskId: task.id,
          revision: task.attempts,
          kind: "question",
          schema: { title: task.question ?? task.title, fields },
        },
        bindings,
      );
    }
    return this.create(owner, {
      taskId: task.id,
      revision: task.attempts,
      kind: "question",
      schema: {
        title: task.question ?? task.title,
        fields: [
          { id: "reply", label: "Your answer", type: "text", required: true, multiline: true },
        ],
      },
    });
  }
  async status(owner: string, id: string): Promise<InteractionRequest> {
    const request = await this.db.get<InteractionRequest>(owner, "interaction-requests", id);
    if (!request) throw new AppError("Question not found", 404);
    if (request.status === "waiting") {
      const task = await this.db.get<AgentTask>(owner, "tasks", request.taskId);
      if (
        !task ||
        task.attempts !== request.revision ||
        ["succeeded", "failed", "cancelled"].includes(task.status)
      ) {
        const result = await this.db.durableMutation<InteractionRequest>(
          owner,
          `question-close:${id}`,
          bindingHash({ id, status: "superseded" }),
          [
            {
              kind: "interaction-requests",
              id,
              mode: "merge",
              expected: { status: "waiting" },
              value: { status: "superseded" },
            },
          ],
          request.threadId
            ? [
                {
                  id: `question-close:${id}`,
                  threadId: request.threadId,
                  origin: "task",
                  kind: "interaction",
                  payload: { ...request, status: "superseded" },
                },
              ]
            : [],
        );
        if (result.values?.[0]) return result.values[0];
        return (await this.db.get<InteractionRequest>(owner, "interaction-requests", id))!;
      }
    }
    return request;
  }
  async list(owner: string, threadId: string) {
    return Promise.all(
      (await this.db.list<InteractionRequest>(owner, "interaction-requests"))
        .filter((request) => request.threadId === threadId)
        .map((request) => this.status(owner, request.id)),
    );
  }
  async answer(
    owner: string,
    id: string,
    raw: unknown,
    options: { fields?: Record<string, string | boolean>; text?: string } = {},
  ) {
    const input = z
      .object({
        clientResponseId: runtimeId,
        revision: z.number().int().min(0),
        answer: questionAnswerSchema,
      })
      .strict()
      .parse(raw);
    const request = await this.status(owner, id);
    if (request.kind !== "question")
      throw new AppError(
        "Use the trusted credential or action approval channel for this card",
        422,
      );
    if (input.revision !== request.revision)
      throw new AppError("This question revision is no longer current", 409);
    const answer = validateQuestionAnswer(request.schema, input.answer);
    const task = await this.db.get<AgentTask>(owner, "tasks", request.taskId);
    if (!task) throw new AppError("Task not found", 404);
    if (
      Object.keys(options.fields ?? {}).some(isCredentialIdentifier) ||
      Object.values(request.fieldBindings ?? {}).some((binding) =>
        isCredentialIdentifier(binding.name),
      )
    )
      throw new AppError("Credentials cannot be submitted through task questions", 422);
    const fields = request.fieldBindings
      ? Object.fromEntries(
          Object.entries(request.fieldBindings).flatMap(([key, binding]) =>
            answer[key] === undefined
              ? []
              : [[binding.name, binding.checkbox ? answer[key] === "true" : answer[key]]],
          ),
        )
      : options.fields;
    const taskPatch = {
      status: "queued",
      question: null,
      input: { ...task.input, ...(fields ? { fields } : {}) },
      state: {
        ...task.state,
        answer: options.text ?? JSON.stringify(answer),
        interactionAnswer: answer,
        interactionRequestId: id,
      },
      updatedAt: new Date().toISOString(),
    };
    const answered = {
      ...request,
      status: "answered" as const,
      answer,
      answeredAt: new Date().toISOString(),
    };
    const result = await this.db.durableMutation<InteractionRequest | AgentTask>(
      owner,
      `question-answer:${input.clientResponseId}`,
      bindingHash({ id, ...input, options }),
      [
        {
          kind: "interaction-requests",
          id,
          mode: "replace",
          expected: { status: "waiting", revision: input.revision },
          value: answered,
        },
        {
          kind: "tasks",
          id: task.id,
          mode: "merge",
          expected: { status: "waiting_input", attempts: input.revision, state: task.state },
          value: taskPatch,
        },
      ],
      request.threadId
        ? [
            {
              id: `answered:${id}`,
              threadId: request.threadId,
              origin: "user",
              kind: "interaction",
              payload: answered,
            },
          ]
        : [],
    );
    if (result.status === "binding_conflict")
      throw new AppError("This response ID already has another answer", 409);
    if (result.status === "revision_conflict")
      throw new AppError("This task or question changed; reopen its current card", 409);
    return result.values[0] as InteractionRequest;
  }
}
