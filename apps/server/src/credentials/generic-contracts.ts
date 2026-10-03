import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { CredentialInteractionRequest } from "../../../../packages/domain/src/runtime.ts";
import { type CredentialRef, credentialFieldSchema } from "./contracts.ts";

const fieldId = z.string().regex(/^[a-zA-Z][\w-]{0,79}$/);
const headerName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/)
  .refine(
    (value) =>
      !/^(host|cookie|set-cookie|content-length|connection|transfer-encoding|proxy-.*|sec-.*|forwarded|x-forwarded-.*)$/i.test(
        value,
      ),
    "Choose an authentication header, not a transport header",
  );
const atomicAuthenticationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer"), fieldId }).strict(),
  z.object({ type: z.literal("header"), fieldId, headerName }).strict(),
  z
    .object({ type: z.literal("basic"), usernameFieldId: fieldId, passwordFieldId: fieldId })
    .strict(),
  z.object({ type: z.literal("query"), fieldId, parameterName: fieldId }).strict(),
  z.object({ type: z.literal("json_body"), fieldId, propertyName: fieldId }).strict(),
]);
export const credentialAuthenticationSchema = z.union([
  atomicAuthenticationSchema,
  z
    .object({
      type: z.literal("bindings"),
      bindings: z.array(atomicAuthenticationSchema).min(1).max(8),
    })
    .strict(),
]);
export function authenticationBindings(
  authentication: z.infer<typeof credentialAuthenticationSchema>,
) {
  return authentication.type === "bindings" ? authentication.bindings : [authentication];
}
export const genericCredentialRequestSchema = z
  .object({
    serviceName: z.string().trim().min(1).max(120),
    origin: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.origin === value &&
          !url.username &&
          !url.password &&
          !url.port
        );
      }, "Use the exact HTTPS origin of the service"),
    purpose: z.string().trim().min(1).max(600),
    fields: z.array(credentialFieldSchema).min(1).max(8),
    authentication: credentialAuthenticationSchema,
    replace: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const fields = new Map(input.fields.map((field) => [field.id, field]));
    if (
      fields.size !== input.fields.length ||
      input.fields.some((field) => /^(?:__proto__|prototype|constructor)$/i.test(field.id))
    )
      context.addIssue({
        code: "custom",
        message: "Credential field identifiers must be unique and safe",
      });
    const bindings = authenticationBindings(input.authentication);
    const ids = bindings.flatMap((auth) =>
      auth.type === "basic" ? [auth.usernameFieldId, auth.passwordFieldId] : [auth.fieldId],
    );
    if (ids.some((id) => !fields.has(id)) || fields.size !== new Set(ids).size)
      context.addIssue({
        code: "custom",
        message: "Every credential field must have an authentication binding",
      });
    const destinations = new Set<string>();
    for (const auth of bindings) {
      const secretId = auth.type === "basic" ? auth.passwordFieldId : auth.fieldId;
      if (fields.get(secretId)?.type !== "password")
        context.addIssue({ code: "custom", message: "Secret fields must be password fields" });
      if (auth.type === "basic" && auth.usernameFieldId === auth.passwordFieldId)
        context.addIssue({
          code: "custom",
          message: "Basic authentication needs distinct username and password fields",
        });
      const destination =
        auth.type === "header"
          ? `header:${auth.headerName.toLowerCase()}`
          : auth.type === "bearer" || auth.type === "basic"
            ? "header:authorization"
            : auth.type === "query"
              ? `query:${auth.parameterName}`
              : `body:${auth.propertyName}`;
      if (destinations.has(destination))
        context.addIssue({ code: "custom", message: "Authentication destinations must be unique" });
      destinations.add(destination);
    }
  });
export type GenericCredentialInput = z.input<typeof genericCredentialRequestSchema>;
export type CredentialSpecification = Omit<
  z.output<typeof genericCredentialRequestSchema>,
  "replace"
>;
export type GenericCredentialContext = {
  threadId?: string;
  taskId?: string;
  revision?: number;
  taskSeed?: AgentTask;
};
export type ServiceCredential = CredentialSpecification & {
  id: string;
  credentialRef: CredentialRef;
  status: "saved" | "invalid_credentials" | "revoked";
  createdAt: string;
  updatedAt: string;
};
export type ServiceCredentialRequest = {
  id: string;
  specification: CredentialSpecification;
  credentialRefId: string;
  replacesCredentialId?: string;
  expiresAt: string;
  clientResponseId?: string;
  interaction: CredentialInteractionRequest;
};
export const credentialHttpRequestSchema = z
  .object({
    credentialId: z.uuid(),
    path: z.string().min(1).max(4096),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z
      .record(
        headerName,
        z
          .string()
          .max(2048)
          .refine((value) => !/[\r\n]/.test(value) && !value.includes(String.fromCharCode(0))),
      )
      .optional(),
    body: z.unknown().optional(),
    intent: z.enum(["read", "write", "money"]).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type CredentialHttpInput = z.input<typeof credentialHttpRequestSchema>;
export type CredentialHttpResult = {
  status: number;
  ok: boolean;
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
};
