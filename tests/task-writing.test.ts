import assert from "node:assert/strict";
import { test } from "node:test";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("original writing can finish with its text without unrelated research or external effects", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Escreva uma breve saudação em português para receber meus convidados",
  });
  assert.equal(task.criteria?.[0].kind, "response");
  assert.equal(
    (
      await server.agent.verification.assess(
        "owner",
        task.id,
        0,
        "Sejam bem-vindos! É um prazer receber vocês para este encontro.",
      )
    ).status,
    "verified",
  );
  assert.equal(
    (await server.agent.verification.assess("owner", task.id, 0, "Pronto.")).status,
    "unverified",
  );
  const poem = await server.agent.createTask("owner", { prompt: "Crie um poema sobre o mar" });
  assert.equal(
    poem.criteria?.some((criterion) => criterion.kind === "receipt"),
    false,
  );
  const send = await server.agent.createTask("owner", {
    prompt: "Escreva uma mensagem e envie por email para amiga@example.test",
  });
  assert.equal(
    send.criteria?.some((criterion) => criterion.effect === "email.send"),
    true,
  );
  assert.notEqual(
    (
      await server.agent.verification.assess(
        "owner",
        send.id,
        0,
        "Olá! Espero encontrar você em breve.",
      )
    ).status,
    "verified",
  );
});
