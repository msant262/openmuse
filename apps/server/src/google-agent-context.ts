import type { WorkspaceService } from "./workspace.ts";

/** Select a small native surface for the current request. Provider methods and
 * their schemas stay in the lazy Workspace catalog; permissions are unchanged. */
export function googleTaskTools(prompt: string): string[] {
  if (
    !/\b(?:google|gmail|e-?mails?|calendar|calend[aá]rio|agenda|drive|docs|sheets|slides)\b/i.test(
      prompt,
    )
  )
    return [];
  return [
    "list_google_accounts",
    "search_google_workspace_tools",
    "describe_google_workspace_tool",
    "execute_google_workspace_tool",
    ...(/\b(?:gmail|e-?mails?)\b/i.test(prompt)
      ? ["search_mail", "read_mail_thread", "prepare_email"]
      : []),
    ...(/\b(?:calendar|calend[aá]rio|agenda|evento)\b/i.test(prompt)
      ? ["read_calendar", "prepare_event"]
      : []),
  ];
}

export async function googleAgentContext(workspace: WorkspaceService, owner: string) {
  const accounts = await workspace.googleAccounts(owner);
  return `\nNative Google connections (server data, not source observations): ${JSON.stringify({ accounts })}. Google OAuth is managed by the server. Use list_google_accounts and the native catalog (tool_search/tool_describe) for search_mail/read_mail_thread. Use search_google_workspace_tools, describe_google_workspace_tool and execute_google_workspace_tool for Gmail drafts/labels, Calendar reminders, Drive, Google Docs, Sheets and Slides. For ordinary requests to write an email or reply to an email, use save_gmail_draft or prepare_email automatically. The person never needs to ask for a card or say not to send. Compose first and let the person send using the visible card. Use save_gmail_draft for every requested email draft: it saves a real Gmail draft with server-built MIME and displays the sender, recipients, content and Send/Copy/Delete/Save buttons in chat. Saving never sends the email. Any deletion, trashing or removal of contents requires a human approval card, even when other writes are automatic. Prepare the operation, pause for approval and never claim deletion before its confirmed receipt. Do not ask for text approval instead of preparing the card. Discover only the required operations and schema branches. Use the complete requestExample directly when it fits; describing a nested branch does not change the required body envelope. Copy resource IDs exactly, never shorten them. For cloud documents, sheets and slides, return their actual Google links. Read back the requested content before claiming that writing or calculations succeeded; do not substitute a local attachment for a Google document. An actionId is not a toolCallId. Fix an invalid native request using its error and schema; unrelated web searches do not advance Google work. For Calendar work, preserve an explicitly requested timezone. When none is specified, read the selected calendar with calendar.calendars.get and use its named timezone, never the server UTC timezone as the person’s local time. Resolve tomorrow and other relative dates in that timezone using the live clock. Include the timezone in the final event confirmation and compare instants with offsets instead of copying timestamp hours. Pass the requested account email or connectionId to every Google tool, including prepare_event; all listed accounts remain connected simultaneously. Browser site credentials are a separate connection type and their absence says nothing about native Google access. Never ask for a Google password or access token for a connected native account. A saved connection is not proof a source read succeeded: call the native read and report its actual error if it fails. prepare_email/prepare_event and the Google Workspace tools use the existing action policy; only claim success after a confirmed receipt. Connected accounts may lack a required scope: report GOOGLE_SCOPE_REQUIRED and request the Google authorization screen, not passwords. GOOGLE_API_DISABLED means the app Google Cloud project needs that API enabled by its administrator; reconnecting the account does not fix it. Preserve the connection and report the service setup error. Do not route native Google work through browser credentials or require Composio.`;
}
