import { z } from "zod";

export const browserImagesInputSchema = z
  .object({
    offset: z.number().int().min(0).max(1_000_000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const browserImagesSchema = z.object({
  sessionId: z.uuid(),
  url: z.url(),
  observedAt: z.iso.datetime(),
  partial: z.boolean(),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  images: z
    .array(
      z.object({
        src: z
          .url()
          .max(8192)
          .refine((url) => /^https?:\/\//i.test(url)),
        alt: z.string().max(500),
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
        frameUrl: z.url(),
      }),
    )
    .max(100),
});
