import type { WorkspaceService } from "./workspace.ts";

/** Select a small native surface for the current request. Provider methods and
 * their schemas stay in the lazy Workspace catalog; permissions are unchanged. */
export function googleTaskTools(prompt: string): string[] {
  if (
    !/\b(?:google|gmail|e-?mails?|calendar|calend[aá]rio|agenda|drive|docs|sheets|slides|inbox|caixa|marcador|rotulo|pasta)\b/i.test(
      prompt,
    )
  )
    return [];
  return [
    "organize_gmail",
    "list_google_accounts",
    "search_google_workspace_tools",
    "describe_google_workspace_tool",
    "execute_google_workspace_tool",
    ...(/\b(?:drive|pasta|folder|docs|sheets|slides)\b/i.test(prompt)
      ? ["search_drive", "read_drive_file"]
      : []),
    ...(/\b(?:gmail|e-?mails?)\b/i.test(prompt)
      ? ["search_mail", "read_mail_thread", "prepare_email"]
      : []),
    ...(/\b(?:calendar|calend[aá]rio|agenda|evento)\b/i.test(prompt)
      ? ["read_calendar", "prepare_event"]
      : []),
  ];
}

export async function googleAgentContext(
  workspace: WorkspaceService,
  owner: string,
  selectedTools?: readonly string[],
) {
  const accounts = await workspace.googleAccounts(owner);
  if (
    selectedTools &&
    !selectedTools.some((name) =>
      /^(?:search_drive|read_drive_file|search_mail|read_mail_thread|organize_gmail|read_calendar|prepare_email|prepare_event|save_gmail_draft|prepare_gmail_trash|search_google_workspace_tools|describe_google_workspace_tool|execute_google_workspace_tool)$/.test(
        name,
      ),
    )
  )
    return `\nNative Google connections (server data, not source observations): ${JSON.stringify({ accounts })}. For Google Workspace requests, discover the native connector tools. All listed accounts stay connected simultaneously; authentication is managed by the server.`;
  const driveGuidance =
    "For Drive name lookup, prefer search_drive with the person's ordinary name, not a hand-written API q. It searches all connected accounts when account is omitted, tolerates names such as MOVING DE versus MovingDE, and follows pages. Search every relevant connected account before claiming absence. Use kind:folders for a folder and then parentId to list its contents; keep the returned account. For reading or identifying documents inside a named folder, set recursive:true on that child inventory so subfolders and folder shortcuts are examined. Follow nextOffset when the metadata shortlist is paged. Ordinary file counts use direct children unless the user asks for the tree. Read the actual documents with read_drive_file using their returned IDs and account. Continue its nextOffset; use view_file for scans/images when needsVisualRead is true. Drive metadata is not document content. Do not use drive.files.download to read ordinary documents; that API starts a long-running download operation. The native reader fetches actual bytes without user downloads or reuploads. If a precise name returns empty, broaden the name and examine candidates, shared items and shortcuts before asking for a link. Empty results in the default account say nothing about the other accounts. If complete is false, report the actual limitation and recover; never claim the item does not exist. Native Drive access does not require a browser login. ";
  return `\n${driveGuidance}Native Google connections (server data, not source observations): ${JSON.stringify({ accounts })}. Google OAuth is managed by the server. Use list_google_accounts and the native catalog (tool_search/tool_describe) for search_mail/read_mail_thread. Use organize_gmail for Gmail cleanup, applying labels and moving messages into folders. Gmail folders are labels: specify labelNames and archive:true to remove messages from INBOX while keeping them in All Mail. The server selects every page, retains IDs and verifies each batch; continue with the returned cursor and identical operationId until remaining is zero. Creating a label alone never moves mail. Report actual matched/processed counts and the selected account. Never use Google browser login for native Gmail work. Use search_google_workspace_tools, describe_google_workspace_tool and execute_google_workspace_tool for Gmail drafts/labels, Calendar reminders, Drive, Google Docs, Sheets and Slides. For ordinary requests to write an email or reply to an email, use save_gmail_draft or prepare_email automatically. The person never needs to ask for a card or say not to send. Compose first and let the person send using the visible card. Use save_gmail_draft for every requested email draft: it saves a real Gmail draft with server-built MIME and displays the sender, recipients, content and Send/Copy/Delete/Save buttons in chat. Saving never sends the email. Any deletion, trashing or removal of contents requires a human approval card, even when other writes are automatic. Calling execute_google_workspace_tool with a destructive operation only prepares its exact approval card; the server does not dispatch it before the human approves. Identify the targets, call that tool directly, then pause on approvalRequired. Never call ask_user to obtain permission beforehand: that creates a redundant form instead of the action card. Ordinary Gmail deletion means recoverable Trash; use permanent delete only when explicitly requested. For deleting a group of emails, use prepare_gmail_trash(account,query,operationId). The server follows every page and freezes all matching IDs behind one approval card; do not copy IDs from search_mail samples or prepare individual trash calls. This is the preferred path even for a small selection and needs no Google schema discovery. Do not make parallel trash calls: preparing the first card pauses the task and later calls cannot run. Never claim deletion before its confirmed receipt. Discover only the required operations and schema branches. Use the complete requestExample directly when it fits; describing a nested branch does not change the required body envelope. Copy resource IDs exactly, never shorten them. For cloud documents, sheets and slides, return their actual Google links. Read back the requested content before claiming that writing or calculations succeeded; do not substitute a local attachment for a Google document. An actionId or operationId is not a toolCallId. Fix an invalid native request using its error and schema; unrelated web searches do not advance Google work. For Calendar work, preserve an explicitly requested timezone. When none is specified, read the selected calendar with calendar.calendars.get and use its named timezone, never the server UTC timezone as the person’s local time. Resolve tomorrow and other relative dates in that timezone using the live clock. Include the timezone in the final event confirmation and compare instants with offsets instead of copying timestamp hours. Pass the requested account email or connectionId to every Google tool, including prepare_event; all listed accounts remain connected simultaneously. Browser site credentials are a separate connection type and their absence says nothing about native Google access. Never ask for a Google password or access token for a connected native account. A saved connection is not proof a source read succeeded: call the native read and report its actual error if it fails. prepare_email/prepare_event and the Google Workspace tools use the existing action policy; only claim success after a confirmed receipt. Connected accounts may lack a required scope: report GOOGLE_SCOPE_REQUIRED and request the Google authorization screen, not passwords. GOOGLE_API_DISABLED means the app Google Cloud project needs that API enabled by its administrator; reconnecting the account does not fix it. Preserve the connection and report the service setup error. Do not route native Google work through browser credentials or require Composio.`;
}
