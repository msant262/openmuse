import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "@tanstack/ai";
import { ToolOutputStore } from "../apps/server/src/engine/tool-output.ts";
import { ToolProgress } from "../apps/server/src/engine/tool-progress.ts";

test("unchanged tool outcomes warn then veto execution, while novel arguments and progress remain usable", () => {
  const progress = new ToolProgress();
  for (let i = 0; i < 10; i++) progress.record("web_fetch", { url: "a" }, { text: "same" });
  assert.match(progress.check("web_fetch", { url: "a" })?.message ?? "", /WARNING/);
  for (let i = 0; i < 10; i++) progress.record("web_fetch", { url: "a" }, { text: "same" });
  assert.equal(progress.check("web_fetch", { url: "a" })?.blocked, true);
  assert.equal(progress.check("web_fetch", { url: "b" }), undefined);
  assert.equal(progress.check("finish_task", {}), undefined);
  progress.record("web_fetch", { url: "a" }, { text: "new facts" });
  assert.equal(progress.check("web_fetch", { url: "a" }), undefined);
});

test("canonical history restores no-progress evidence across a worker continuation", () => {
  const messages: ModelMessage[] = [];
  for (let i = 0; i < 20; i++)
    messages.push(
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: `call-${i}`,
            type: "function",
            function: { name: "computer_status", arguments: "{}" },
          },
        ],
      },
      { role: "tool", toolCallId: `call-${i}`, content: '{"connected":false}' },
    );
  const progress = new ToolProgress();
  progress.observe(messages);
  assert.equal(progress.check("computer_status", {})?.blocked, true);
  progress.observe([
    ...messages,
    { role: "user", content: "The computer is connected now, try again." },
  ]);
  assert.equal(progress.check("computer_status", {}), undefined);
});

test("identical concurrent calls observe previous outcomes, without serializing unrelated tools", async () => {
  const progress = new ToolProgress();
  let executions = 0;
  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      progress.exclusive("lookup", {}, async () => {
        if (progress.check("lookup", {})?.blocked) return "veto";
        executions++;
        await Promise.resolve();
        progress.record("lookup", {}, "same");
        return "executed";
      }),
    ),
  );
  assert.equal(executions, 20);
  assert.equal(results.filter((value) => value === "veto").length, 5);
  let release!: () => void;
  const pending = progress.exclusive(
    "slow",
    {},
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await progress.exclusive("other", {}, async () => {
    assert.equal(typeof release, "function");
    release();
  });
  await pending;
});

test("large observations are bounded only in provider context and can be paged without losing Unicode", () => {
  const full = `prefix ${"ação 🙂 漢字\n".repeat(20000)} END`;
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "large",
          type: "function",
          function: { name: "web_fetch", arguments: '{"url":"https://example.com"}' },
        },
      ],
    },
    { role: "tool", toolCallId: "large", content: full },
  ];
  const output = new ToolOutputStore();
  output.observe(messages);
  const projected = output.project(messages, []);
  assert.equal(messages[1].content, full);
  assert.notEqual(projected[1].content, full);
  assert.ok(Buffer.byteLength(String(projected[1].content)) <= 17000);
  assert.match(String(projected[1].content), /read_tool_output/);
  let recovered = "";
  let offset = 0;
  for (;;) {
    const page = output.read({ toolCallId: "large", offset, limit: 997 });
    assert.equal(page.content.includes("�"), false);
    recovered += page.content;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(recovered, full);
  assert.throws(
    () => new ToolOutputStore().read({ toolCallId: "large", offset: 0, limit: 100 }),
    /unavailable/,
  );
  assert.equal(
    output.project(messages, ["large"])[1].content,
    full,
    "required effect receipts stay complete",
  );
  const escaped: ModelMessage[] = [
    { role: "tool", toolCallId: "escaped", content: `${'"\n\u0001'.repeat(50000)} END` },
  ];
  const excerpt = String(output.project(escaped, [])[0].content);
  assert.ok(Buffer.byteLength(excerpt) <= 16000);
  assert.ok(JSON.parse(excerpt).tail.endsWith(" END"));
  output.observe(escaped);
  const page = output.read({ toolCallId: "escaped", offset: 0, limit: 8000 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16000);
  assert.equal(page.content, String(escaped[0].content).slice(0, page.nextOffset ?? undefined));
  const skill: ModelMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "skill",
          type: "function",
          function: { name: "skills_read", arguments: '{"name":"workflow"}' },
        },
      ],
    },
    { role: "tool", toolCallId: "skill", content: "complete workflow\n".repeat(1200) },
  ];
  assert.equal(
    output.project(skill, [])[1].content,
    skill[1].content,
    "bounded skills must be read whole before applying",
  );
});
