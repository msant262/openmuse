import assert from "node:assert/strict";
import test from "node:test";
import { googleAgentContext, googleTaskTools } from "../apps/server/src/google-agent-context.ts";
import type { WorkspaceService } from "../apps/server/src/workspace.ts";

const workspace = { googleAccounts: async () => [] } as unknown as WorkspaceService;

test("Calendar work keeps Gmail organization and Drive lookup behind discovery", () => {
  const tools = googleTaskTools("Crie amanhã um compromisso na minha agenda às 11h.");
  assert.ok(tools.includes("prepare_event"));
  assert.ok(tools.includes("execute_google_workspace_tool"));
  assert.ok(!tools.includes("organize_gmail"));
  assert.ok(!tools.includes("search_drive"));
});

test("Calendar context contains scheduling and approval rules without unrelated mail or Drive recipes", async () => {
  const context = await googleAgentContext(workspace, "owner", ["prepare_event", "read_calendar"]);
  assert.match(context, /Resolve tomorrow and other relative dates/);
  assert.match(context, /Dates in event titles, subjects, filenames/);
  assert.match(
    context,
    /Any deletion, trashing or removal of contents requires a human approval card/,
  );
  assert.doesNotMatch(context, /Gmail folders are labels|For Drive name lookup|save_gmail_draft/);
});

test("Gmail folders receive label, pagination and draft rules without Calendar scheduling", async () => {
  const tools = googleTaskTools("Organize meu Gmail em pastas e escreva uma resposta.");
  assert.ok(tools.includes("organize_gmail"));
  assert.ok(!tools.includes("search_drive"));
  const context = await googleAgentContext(workspace, "owner", tools);
  assert.match(context, /Gmail folders are labels/);
  assert.match(context, /remaining is zero/);
  assert.match(context, /Saving never sends the email/);
  assert.doesNotMatch(context, /For Calendar work|For Drive name lookup/);
});

test("Drive name lookup keeps cross-account, approximate-name and recursive read guidance", async () => {
  const tools = googleTaskTools("Veja os documentos na pasta MOVING DE do Google Drive.");
  assert.ok(tools.includes("search_drive"));
  assert.ok(!tools.includes("organize_gmail"));
  const context = await googleAgentContext(workspace, "owner", tools);
  assert.match(context, /MOVING DE versus MovingDE/);
  assert.match(context, /recursive:true/);
  assert.match(context, /Search every relevant connected account/);
  assert.doesNotMatch(context, /Gmail folders are labels|For Calendar work/);
});

test("lazy Workspace execution retains the request's service context", async () => {
  const context = await googleAgentContext(
    workspace,
    "owner",
    ["execute_google_workspace_tool"],
    "Atualize o compromisso na minha agenda para amanhã às 11h.",
  );
  assert.match(context, /Resolve tomorrow and other relative dates/);
  assert.match(context, /Pass the requested account email or connectionId/);
  assert.doesNotMatch(context, /Gmail folders are labels|For Drive name lookup/);
});

test("mixed mail and Calendar requests retain both workflows and deletion approval", async () => {
  const prompt = "Leia meu Gmail e coloque o compromisso na agenda.";
  const context = await googleAgentContext(workspace, "owner", googleTaskTools(prompt), prompt);
  assert.match(context, /Gmail folders are labels/);
  assert.match(context, /For Calendar work/);
  assert.match(context, /does not dispatch it before the human approves/);
  assert.doesNotMatch(context, /For Drive name lookup/);
});

test("a Portuguese cloud spreadsheet request retains provider links and readback guidance", async () => {
  const context = await googleAgentContext(
    workspace,
    "owner",
    ["execute_google_workspace_tool"],
    "Na minha conta, crie uma planilha chamada Resumo e me entregue o link.",
  );
  assert.match(context, /return their actual Google links/);
  assert.match(context, /Read back the requested content/);
  assert.doesNotMatch(context, /Gmail folders are labels|For Calendar work|For Drive name lookup/);
});
