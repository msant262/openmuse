import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture } from "./helpers/model.ts";

for (const protocol of ["responses", "chat/completions"] as const)
  for (const name of ["ask_user", "finish_task", "web_fetch"] as const)
    test(`model fixture routes ${name} using the advertised ${protocol} surface`, async (t) => {
      const args =
        name === "ask_user"
          ? { question: "What are your fixed hours?" }
          : name === "finish_task"
            ? { summary: "Delivered", outcome: "completed" }
            : { url: "https://courses.example/course" };
      await modelFixture(t, async () => ({ name, arguments: args }));
      const directlyOffered = name !== "web_fetch";
      const response = await fetch(`${process.env.OPENAI_BASE_URL}/${protocol}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture",
          tools: [
            { type: "function", name: "tool_call", parameters: { type: "object" } },
            ...(directlyOffered
              ? [{ type: "function", name: `okami_${name}`, parameters: { type: "object" } }]
              : []),
          ],
        }),
      });
      assert.equal(response.status, 200);
      const events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)));
      const call =
        protocol === "responses"
          ? events.find((event) => event.type === "response.completed")?.response.output?.[0]
          : events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? [])[0]?.function;
      assert.ok(call);
      assert.equal(call.name, directlyOffered ? `okami_${name}` : "tool_call");
      assert.deepEqual(
        JSON.parse(call.arguments),
        directlyOffered ? args : { id: "okami_web_fetch", args },
      );
    });
