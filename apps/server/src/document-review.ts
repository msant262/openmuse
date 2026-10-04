import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type DocumentReviewScope = { scope: string; revision: number };
const inspectionSchema = z
  .object({
    scope: z.string().min(1).max(300),
    revision: z.number().int().nonnegative(),
    fileId: z.string().min(1).max(128),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    pageCount: z.number().int().min(1).max(100),
    pages: z.array(z.number().int().positive()).min(1).max(4),
    previewFileId: z.string().min(1).max(128),
    rendererVersion: z.string().min(1).max(200),
  })
  .strict()
  .refine(
    (v) => new Set(v.pages).size === v.pages.length && v.pages.every((page) => page <= v.pageCount),
    "Invalid page coverage",
  );
export const documentReviewArgs = z
  .object({
    receiptId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe(
        "Copy the exact receiptId returned by inspect_document; fileId, previewFileId and SHA-256 values are different identifiers.",
      ),
    passed: z.boolean(),
    issues: z.array(z.string().trim().min(1).max(500)).max(20),
  })
  .strict()
  .refine(
    (v) => !v.passed || v.issues.length === 0,
    "Resolve reported issues before passing review",
  );
type Inspection = z.infer<typeof inspectionSchema> & {
  id: string;
  previewSha256: string;
  createdAt: string;
};
type Confirmation = DocumentReviewScope & {
  id: string;
  passed: boolean;
  issues: string[];
  previewSha256: string;
  sha256: string;
};

/** Evidence of rendered pixels received plus model assessment, not an objective aesthetic score. */
export class DocumentReview {
  constructor(
    private readonly db: Store,
    private readonly files: Files,
  ) {}

  async recordInspection(owner: string, input: z.input<typeof inspectionSchema>) {
    const args = inspectionSchema.parse(input);
    if (hash(await this.files.bytes(owner, args.fileId)) !== args.sha256)
      throw new AppError("Document changed before rendering was recorded", 409);
    await this.files.imageContent(owner, args.previewFileId);
    const previewSha256 = hash(await this.files.bytes(owner, args.previewFileId));
    const binding = { ...args, pages: [...args.pages].sort((a, b) => a - b), previewSha256 };
    const id = hash(JSON.stringify(binding));
    const receipt: Inspection = { id, ...binding, createdAt: new Date().toISOString() };
    await this.db.insertIfAbsent(owner, "document-inspections", receipt);
    return { receiptId: id, ...binding };
  }

  /** Called by the provider adapter only after image-bearing inference completes, before tools. */
  async recordObserved(owner: string, scope: DocumentReviewScope, previewFileId: string) {
    const inspections = (await this.db.list<Inspection>(owner, "document-inspections")).filter(
      (entry) =>
        entry.scope === scope.scope &&
        entry.revision === scope.revision &&
        entry.previewFileId === previewFileId,
    );
    if (!inspections.length) return;
    const previewSha256 = hash(await this.files.bytes(owner, previewFileId));
    for (const receipt of inspections) {
      if (receipt.previewSha256 !== previewSha256) continue;
      await this.db.put(owner, "document-image-observations", {
        id: receipt.id,
        ...scope,
        previewSha256,
        observedAt: new Date().toISOString(),
      });
    }
  }

  async confirm(owner: string, scope: DocumentReviewScope, raw: unknown) {
    const args = documentReviewArgs.parse(raw);
    const receipt = await this.db.get<Inspection>(owner, "document-inspections", args.receiptId);
    if (!receipt || receipt.scope !== scope.scope || receipt.revision !== scope.revision) {
      const available = (await this.db.list<Inspection>(owner, "document-inspections"))
        .filter((entry) => entry.scope === scope.scope && entry.revision === scope.revision)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 8)
        .map((entry) => ({
          receiptId: entry.id,
          documentFileId: entry.fileId,
          pages: entry.pages,
        }));
      throw new AppError(
        `Inspection does not belong to this task revision. Copy an exact receiptId from inspect_document, not a file ID or content hash. Current inspections: ${JSON.stringify(available)}. If none match the pages you reviewed, call inspect_document again.`,
        409,
      );
    }
    const seen = await this.db.get<{
      id: string;
      scope: string;
      revision: number;
      previewSha256: string;
    }>(owner, "document-image-observations", receipt.id);
    if (
      !seen ||
      seen.scope !== scope.scope ||
      seen.revision !== scope.revision ||
      seen.previewSha256 !== receipt.previewSha256
    )
      throw new AppError(
        "Inspect the rendered image in a completed model turn before recording review",
        409,
      );
    if (
      hash(await this.files.bytes(owner, receipt.fileId)) !== receipt.sha256 ||
      hash(await this.files.bytes(owner, receipt.previewFileId)) !== receipt.previewSha256
    )
      throw new AppError("Document or preview changed since inspection", 409);
    await this.db.put<Confirmation>(owner, "document-reviews", {
      id: receipt.id,
      ...scope,
      passed: args.passed,
      issues: args.issues,
      sha256: receipt.sha256,
      previewSha256: receipt.previewSha256,
    });
    return {
      receiptId: receipt.id,
      fileId: receipt.fileId,
      pages: receipt.pages,
      passed: args.passed,
      issues: args.issues,
    };
  }

  async check(owner: string, scope: DocumentReviewScope, fileId: string, sha256: string) {
    if (hash(await this.files.bytes(owner, fileId)) !== sha256)
      return { passed: false, pageCount: 0, missingPages: [], receiptIds: [] };
    const receipts = (await this.db.list<Inspection>(owner, "document-inspections"))
      .filter(
        (entry) =>
          entry.fileId === fileId &&
          entry.sha256 === sha256 &&
          entry.scope === scope.scope &&
          entry.revision === scope.revision,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const pageCount = receipts.at(-1)?.pageCount ?? 0;
    const latest = new Map<number, Inspection>();
    for (const receipt of receipts) {
      if (receipt.pageCount !== pageCount) continue;
      for (const page of receipt.pages) latest.set(page, receipt);
    }
    const reviews = new Map(
      (await this.db.list<Confirmation>(owner, "document-reviews")).map((entry) => [
        entry.id,
        entry,
      ]),
    );
    const missingPages: number[] = [],
      receiptIds = new Set<string>();
    for (let page = 1; page <= pageCount; page++) {
      const receipt = latest.get(page),
        review = receipt && reviews.get(receipt.id);
      if (
        !receipt ||
        !review?.passed ||
        review.issues.length ||
        review.sha256 !== sha256 ||
        review.previewSha256 !== receipt.previewSha256 ||
        review.scope !== scope.scope ||
        review.revision !== scope.revision
      ) {
        missingPages.push(page);
        continue;
      }
      receiptIds.add(receipt.id);
    }
    return {
      passed: pageCount > 0 && missingPages.length === 0,
      pageCount,
      missingPages,
      receiptIds: [...receiptIds],
    };
  }
}
