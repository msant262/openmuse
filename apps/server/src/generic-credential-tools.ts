import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { GenericCredentials } from "./credentials/generic.ts";
import {
  credentialHttpRequestSchema,
  genericCredentialRequestSchema,
} from "./credentials/generic-contracts.ts";

export const genericCredentialInstructions =
  " Credentials are a built-in capability for any service, not a fixed connector catalog. When the requested work needs an API key, token, username/password or other credential, use list_credentials to check saved connection metadata, then request_credentials to open the secure in-app modal if needed. Discover the service's documented HTTPS API origin and authentication scheme from its official documentation when unknown. Never ask for a secret in chat, ask_user, files, commands or tool arguments; request_credentials accepts field definitions only, never their values. The user enters values directly in the secure modal and the runtime saves them in the vault. A missing credential is a pause in the original task, not a new task or a questionnaire. Once the modal is saved, continue the original task using the saved opaque reference through credential_http_request; credentials are injected privately by the server. Use credential_http_request for the service API even if there is no dedicated connector. Do not claim a connection was tested, an API call succeeded, or work completed until its actual receipt confirms it. On rejected credentials the same task opens a new secure form automatically; do not ask the user to paste the value. For site login delegate the work to the task agent; it checks list_site_connections and uses request_site_connection plus authenticate_connection. Reuse a saved connection for the same site; use replace only when the user requests new credentials or the service rejected the previous ones. Never submit API credentials to a public search or generic browser/computer tool.";

export type GenericCredentialToolOptions = {
  request: (input: z.output<typeof genericCredentialRequestSchema>) => Promise<unknown>;
  http: (input: z.output<typeof credentialHttpRequestSchema>) => Promise<unknown>;
  before?: () => Promise<void>;
  stopped?: () => boolean;
  queue?: (operation: () => Promise<unknown>) => Promise<unknown>;
};

/** Only metadata and opaque references cross the model/tool boundary. */
export function genericCredentialTools(
  service: GenericCredentials | undefined,
  owner: string,
  options: GenericCredentialToolOptions,
) {
  if (!service) return [];
  const run = (operation: () => Promise<unknown>) => {
    const guarded = async () => {
      if (options.stopped?.())
        return { paused: true, message: "The original task is waiting for its secure form." };
      await options.before?.();
      return operation();
    };
    return options.queue ? options.queue(guarded) : guarded();
  };
  return [
    defineTool({
      name: "list_credentials",
      description:
        "List saved service connection metadata and opaque credential references. No secret values are returned. Services do not need a preconfigured connector.",
      parameters: z.object({}).strict(),
      execute: () => run(() => service.list(owner)),
    }),
    defineTool({
      name: "request_credentials",
      description:
        "Open the secure credential modal for any service required by the current task. Supply only the verified service HTTPS origin, purpose, field definitions and authentication binding. The person enters secret values privately. The original task resumes automatically after saving; never ask for credentials in chat.",
      parameters: genericCredentialRequestSchema,
      execute: (input) => run(() => options.request(genericCredentialRequestSchema.parse(input))),
    }),
    defineTool({
      name: "credential_http_request",
      description:
        "Call a saved service's HTTPS API using its opaque credential ID and a relative path. The server injects the saved credential privately and returns a bounded, sanitized response. Never include secret values, Authorization headers, tokens or passwords in arguments. A rejected credential opens the secure modal and pauses the original task.",
      parameters: credentialHttpRequestSchema,
      execute: (input) => run(() => options.http(credentialHttpRequestSchema.parse(input))),
    }),
  ];
}
