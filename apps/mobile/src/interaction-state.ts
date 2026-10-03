import {
  type InteractionRequest,
  type QuestionAnswer,
  questionAnswerSchema,
  questionSchema,
} from "../../../packages/domain/src/runtime";

/** Keep obsolete replay cards out of the active conversation, without deleting their receipts. */
export function partitionInteractions(requests: InteractionRequest[]) {
  const unique = new Map<string, InteractionRequest>();
  for (const request of requests) {
    if (request.kind !== "question" && request.kind !== "credential") continue;
    const saved = unique.get(request.id);
    if (!saved || saved.status === "waiting" || request.status !== "waiting")
      unique.set(request.id, request);
  }
  const ordered = [...unique.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const latest = new Map<string, InteractionRequest>();
  for (const request of ordered) {
    if (request.kind !== "question") continue;
    const previous = latest.get(request.taskId);
    if (!previous || request.revision >= previous.revision) latest.set(request.taskId, request);
  }
  const pending: InteractionRequest[] = [];
  const history: InteractionRequest[] = [];
  for (const request of ordered) {
    if (request.kind === "question") {
      if (request.status === "waiting" && latest.get(request.taskId)?.id === request.id)
        pending.push(request);
      else
        history.push(request.status === "waiting" ? { ...request, status: "superseded" } : request);
    } else if (["connected", "expired", "cancelled", "superseded"].includes(request.status))
      history.push(request);
    else pending.push(request);
  }
  return { pending, history };
}

/** React Native Web handles Enter on Pressable, but Space only for button roles. */
export function questionOptionSpace(
  event: { key: string; repeat?: boolean; preventDefault(): void },
  disabled: boolean,
  select: () => void,
) {
  if (event.key !== " " && event.key !== "Spacebar") return;
  event.preventDefault();
  if (!disabled && !event.repeat) select();
}

export function questionAnswerError(request: InteractionRequest, values: QuestionAnswer) {
  if (request.kind !== "question") return "Use the trusted connection or action review control.";
  if (!questionSchema.safeParse(request.schema).success)
    return "Credentials require the trusted connection form, never a generic question.";
  if (request.status !== "waiting") return "This question is already answered or superseded.";
  const parsed = questionAnswerSchema.safeParse(values);
  if (!parsed.success)
    return "Enter a valid answer. Secrets belong in the trusted connection form.";
  for (const field of request.schema.fields) {
    const value = values[field.id];
    if (
      field.required &&
      (value === undefined || value === "" || (Array.isArray(value) && !value.length))
    )
      return `Enter ${field.label}.`;
    if (value === undefined) continue;
    if (field.type === "text" && typeof value !== "string") return `Enter ${field.label}.`;
    if (
      field.type === "single" &&
      (typeof value !== "string" || !field.options.some((option) => option.id === value))
    )
      return `Choose ${field.label}.`;
    if (
      field.type === "multiple" &&
      (!Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some((item) => !field.options.some((option) => option.id === item)))
    )
      return `Choose ${field.label}.`;
  }
  return "";
}
/** Double taps share one request; a lost response retains the same response ID. */
export class QuestionSubmission {
  private pending?: Promise<InteractionRequest>;
  private answered?: InteractionRequest;
  constructor(
    private readonly request: InteractionRequest,
    readonly clientResponseId: string,
  ) {}
  submit(
    values: QuestionAnswer,
    send: (body: {
      clientResponseId: string;
      revision: number;
      answer: QuestionAnswer;
    }) => Promise<InteractionRequest>,
  ) {
    if (this.answered) return Promise.resolve(this.answered);
    if (this.pending) return this.pending;
    const error = questionAnswerError(this.request, values);
    if (error) return Promise.reject(new Error(error));
    this.pending = send({
      clientResponseId: this.clientResponseId,
      revision: this.request.revision,
      answer: values,
    })
      .then((request) => (this.answered = request))
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
