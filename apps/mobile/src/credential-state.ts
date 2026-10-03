import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime.ts";

export type CredentialValues = Record<string, string>;

export function credentialFormError(
  request: CredentialInteractionRequest,
  values: CredentialValues,
) {
  let destination: URL;
  try {
    destination = new URL(request.schema.origin);
  } catch {
    return "This credential destination is invalid.";
  }
  if (
    destination.protocol !== "https:" ||
    destination.origin !== request.schema.origin ||
    destination.username ||
    destination.password
  )
    return "Credentials can only be sent to a trusted HTTPS destination.";
  if (request.status !== "waiting") return "This credential request is no longer open.";
  const fields = request.schema.fields;
  const ids = new Set(fields.map((field) => field.id));
  if (Object.keys(values).some((id) => !ids.has(id)))
    return "This form contains an unsupported field.";
  for (const field of fields) {
    const value = values[field.id];
    if (field.required && !value?.trim()) return `Enter ${field.label}.`;
    if (value !== undefined && (typeof value !== "string" || value.length > 4096))
      return `Enter a valid ${field.label}.`;
  }
  return "";
}

/** The ID stays in memory across a lost response; submitted values never enter storage. */
export class CredentialSubmission {
  private pending?: Promise<CredentialInteractionRequest>;
  private saved?: CredentialInteractionRequest;
  constructor(
    private readonly request: CredentialInteractionRequest,
    readonly clientResponseId: string,
  ) {}

  submit(
    values: CredentialValues,
    send: (body: {
      clientResponseId: string;
      values: CredentialValues;
    }) => Promise<CredentialInteractionRequest>,
  ) {
    if (this.saved) return Promise.resolve(this.saved);
    if (this.pending) return this.pending;
    const error = credentialFormError(this.request, values);
    if (error) return Promise.reject(new Error(error));
    this.pending = send({ clientResponseId: this.clientResponseId, values })
      .then((request) => {
        if (request.status === "saved") this.saved = request;
        return request;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
