import type { EmailDraft } from "./index.ts";

export interface GoogleMailDraft {
  id: string;
  account: string;
  connectionId: string;
  draft: EmailDraft;
  gmailDraftId?: string;
  actionId?: string;
  operation: "save" | "send" | "delete";
  status:
    | "saved"
    | "sent"
    | "deleted"
    | "awaiting_review"
    | "executing"
    | "failed"
    | "outcome_unknown"
    | "denied"
    | "cancelled"
    | "expired";
  updatedAt: string;
  /** A handled card stays compact when the conversation is reopened. */
  collapsed?: boolean;
}

export type GoogleMailDraftSummary = Omit<GoogleMailDraft, "draft"> & {
  subject: string;
  to: string[];
};
