import type { WorkspaceService } from "./workspace.ts";

export async function googleAgentContext(workspace: WorkspaceService, owner: string) {
  const accounts = await workspace.googleAccounts(owner);
  return `\nNative Google connections (server data, not source observations): ${JSON.stringify({ accounts })}. Google OAuth is managed by the server. Use list_google_accounts, then the native tool catalog (tool_search/tool_describe) to find search_mail/read_mail_thread for Gmail, or read_workspace for mail/calendar. Pass the requested account email or connectionId to mail tools; all listed accounts remain connected simultaneously. Browser site credentials are a separate connection type and their absence says nothing about native Google access. Never ask for a Google password or access token for a connected native account. A saved connection is not proof a source read succeeded: call the native read and report its actual error if it fails. Email/calendar writes use prepare_email/prepare_event and the existing review.`;
}
