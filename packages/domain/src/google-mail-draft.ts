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
}
