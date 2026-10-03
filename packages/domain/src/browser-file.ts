import { z } from "zod";

export const browserUploadLimit = 5 * 1024 * 1024;
export const nativeDownloadLimit = 8 * 1024 * 1024;
export const browserUploadMetadataSchema = z
  .object({
    artifactId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    snapshotId: z.uuid(),
    element: z.number().int().min(1).max(150),
    name: z
      .string()
      .min(1)
      .max(180)
      .refine(
        (value) =>
          !value.includes("/") &&
          !value.includes("\\") &&
          Array.from(value).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
        "A safe filename is required",
      ),
    mimeType: z.string().min(1).max(128),
    size: z.number().int().min(1).max(browserUploadLimit),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const browserUploadSchema = browserUploadMetadataSchema
  .extend({
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(browserUploadLimit / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
export const nativeUploadReferenceSchema = browserUploadMetadataSchema
  .extend({ fileReference: z.uuid() })
  .strict();
export type BrowserUpload = z.infer<typeof browserUploadSchema>;
