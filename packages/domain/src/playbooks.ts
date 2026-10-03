import { z } from "zod";
import { isCredentialIdentifier } from "./runtime.ts";

const text = z.string().trim().min(1);
export const procedureInputSchema = z
  .object({
    id: text.max(128).optional(),
    requestId: text.max(256),
    expectedVersion: z.number().int().min(0).default(0),
    sourceTaskId: text.max(128),
    title: text.max(160),
    inputs: z
      .array(
        z
          .object({
            name: text
              .max(40)
              .regex(/^[a-z][a-z0-9_]*$/)
              .refine(
                (value) => !isCredentialIdentifier(value),
                "Credentials require a private connection card",
              ),
            label: text
              .max(100)
              .refine(
                (value) => !isCredentialIdentifier(value),
                "Credentials require a private connection card",
              ),
            required: z.boolean().default(true),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    steps: z.array(text.max(800)).min(1).max(12),
    verification: z.array(text.max(300)).min(1).max(8),
    requiredTools: z
      .array(text.max(64).regex(/^[\w.-]+$/))
      .max(20)
      .default([]),
  })
  .strict()
  .refine(
    (value) => new Set(value.inputs.map((input) => input.name)).size === value.inputs.length,
    "Input names must be unique",
  );
export type ProcedureInput = z.infer<typeof procedureInputSchema>;
export type ProcedureVersion = Omit<ProcedureInput, "expectedVersion"> & {
  id: string;
  version: number;
  savedAt: string;
  binding: string;
};
export type Procedure = { id: string; version: number; versions: ProcedureVersion[] };
export const procedureRunSchema = z
  .object({
    version: z.number().int().positive(),
    requestId: text.max(256),
    inputs: z.record(z.string(), z.string().max(1000)).default({}),
  })
  .strict();
