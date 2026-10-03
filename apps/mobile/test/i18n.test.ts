import assert from "node:assert/strict";
import { test } from "node:test";
import { LocaleStore, translate } from "../src/i18n-core.ts";
import { ptBR } from "../src/i18n-catalog.ts";

test("the app defaults to English and restores the language selected on this device", async () => {
  let saved: string | null = null;
  const storage = {
    read: async () => saved,
    write: async (_key: string, value: string) => {
      saved = value;
    },
  };
  const first = new LocaleStore(storage);
  assert.equal(first.get(), "en");
  await first.set("pt-BR");
  const reopened = new LocaleStore(storage);
  await reopened.restore();
  assert.equal(reopened.get(), "pt-BR");
});

test("an old asynchronous preference read cannot overwrite the user's latest selection", async () => {
  let release!: (value: string) => void;
  const store = new LocaleStore({
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    write: async () => {},
  });
  const restoring = store.restore();
  await store.set("pt-BR");
  release("en");
  await restoring;
  assert.equal(store.get(), "pt-BR");
});

test("storage failures report failure without changing the displayed preference", async () => {
  const store = new LocaleStore({
    read: async () => "pt-BR",
    write: async () => {
      throw new Error("Storage unavailable");
    },
  });
  await store.restore();
  await assert.rejects(store.set("en"), /Storage unavailable/);
  assert.equal(store.get(), "pt-BR");
});

test("only interface copy is translated; substitution values are preserved literally", () => {
  assert.equal(translate("en", ptBR, "Settings"), "Settings");
  assert.equal(translate("pt-BR", ptBR, "Settings"), "Configurações");
  assert.equal(
    translate("pt-BR", { "Hello, {name}": "Olá, {name}" }, "Hello, {name}", { name: "<Settings>" }),
    "Olá, <Settings>",
  );
  assert.equal(translate("pt-BR", ptBR, "User supplied title"), "User supplied title");
});
