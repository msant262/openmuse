import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { CredentialInteractionRequest } from "../../../../packages/domain/src/runtime.ts";

export const composioSlug = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const composioCatalogSchema = z.object({
  search: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
export const composioRequestSchema = z
  .object({
    toolkit: composioSlug,
    purpose: z.string().trim().min(1).max(600),
    replace: z.boolean().optional(),
  })
  .strict();
export type ComposioRequestInput = z.infer<typeof composioRequestSchema>;
export type ComposioContext = {
  taskId?: string;
  revision?: number;
  taskSeed?: AgentTask;
  threadId?: string;
};
export type ComposioCategory = { id: string; name: string };
export type ComposioToolkit = {
  slug: string;
  name: string;
  description: string;
  logo?: string;
  categories: ComposioCategory[];
  authSchemes: string[];
  noAuth: boolean;
  deprecated: boolean;
  authGuideUrl?: string;
  appUrl?: string;
};
export type ComposioConnection = {
  id: string;
  toolkit: string;
  serviceName: string;
  status: string;
  alias?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type ComposioFlow = {
  id: string;
  toolkit: string;
  serviceName: string;
  status: "waiting" | "connected" | "cancelled" | "expired" | "error" | "superseded";
  authorizationUrl?: string;
  createdAt: string;
  expiresAt: string;
  connectionId?: string;
  message?: string;
};
export type ComposioFlowRecord = ComposioFlow & {
  interaction: CredentialInteractionRequest;
  purpose: string;
  taskBound: boolean;
  keyVersion?: number;
  sessionId?: string;
};
export type ComposioTool = {
  slug: string;
  toolkit: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  version?: string;
  tags: string[];
  noAuth: boolean;
};
export type ComposioExecutionInput = {
  sessionId: string;
  toolSlug: string;
  toolkit: string;
  arguments: Record<string, unknown>;
  accountId?: string;
  version?: string;
};
export type ComposioExecutionContext = {
  signal?: AbortSignal;
  beforeDispatch?: () => Promise<void>;
  effect: "read" | "write" | "money";
};
export type ComposioExecutionResult = { data: unknown; error: string | null; logId?: string };
