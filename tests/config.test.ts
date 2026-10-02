import assert from "node:assert/strict";
import { test } from "node:test";
import { browserWorkerUrl, shadowedEnvKeys } from "../apps/server/src/config.ts";

test("local thread storage needs no Intelligence key; nonblank keys remain optional", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = process.env.CPK_INTELLIGENCE_API_KEY;
  try {
    for (const key of ["", " \t\n"]) {
      process.env.CPK_INTELLIGENCE_API_KEY = key;
      assert.equal(readConfig().intelligenceApiKey, undefined);
    }
    delete process.env.CPK_INTELLIGENCE_API_KEY;
    assert.equal(readConfig().intelligenceApiKey, undefined);
    process.env.CPK_INTELLIGENCE_API_KEY = " project-key ";
    assert.equal(readConfig().intelligenceApiKey, "project-key");
  } finally {
    if (old === undefined) delete process.env.CPK_INTELLIGENCE_API_KEY;
    else process.env.CPK_INTELLIGENCE_API_KEY = old;
  }
});

test("Jev mode is off by default and validates explicit modes", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = {
    JEV_MODE: process.env.JEV_MODE,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    CPK_INTELLIGENCE_API_KEY: process.env.CPK_INTELLIGENCE_API_KEY,
  };
  try {
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    delete process.env.JEV_MODE;
    assert.equal(readConfig().jevMode, "off");
    process.env.JEV_MODE = "sample";
    assert.equal(readConfig().jevMode, "sample");
    process.env.JEV_MODE = "live";
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => readConfig(), /TYPESAFE_API_KEY/);
    process.env.TYPESAFE_API_KEY = "fixture-key";
    assert.equal(readConfig().typesafeApiKey, "fixture-key");
    process.env.JEV_MODE = "invalid";
    assert.throws(() => readConfig(), /JEV_MODE/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("browser worker URL keeps an existing scheme and adds http to host:port", () => {
  assert.equal(browserWorkerUrl(undefined), undefined);
  assert.equal(browserWorkerUrl("  "), undefined);
  assert.equal(browserWorkerUrl("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(browserWorkerUrl("https://browser.internal:8790"), "https://browser.internal:8790");
  assert.equal(browserWorkerUrl("openmuse-browser-h4fx:8790"), "http://openmuse-browser-h4fx:8790");
});

test("environment variables that override a different .env value are reported by name", () => {
  const file = { OPENAI_API_KEY: "sk-or-file", MODEL: "openai/gpt-5", PORT: "8787", EMPTY: "" };
  const env = { OPENAI_API_KEY: "sk-proj-system", MODEL: "openai/gpt-5", EMPTY: "set" };
  assert.deepEqual(shadowedEnvKeys(file, env), ["OPENAI_API_KEY", "EMPTY"]);
  assert.deepEqual(shadowedEnvKeys(file, {}), []);
});

test("approval policy defaults to money and accepts only money or all", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const previous = process.env.APPROVAL_POLICY;
  try {
    delete process.env.APPROVAL_POLICY;
    assert.equal(readConfig().approvalPolicy, "money");
    process.env.APPROVAL_POLICY = "all";
    assert.equal(readConfig().approvalPolicy, "all");
    process.env.APPROVAL_POLICY = "none";
    assert.throws(() => readConfig(), /APPROVAL_POLICY/);
  } finally {
    if (previous === undefined) delete process.env.APPROVAL_POLICY;
    else process.env.APPROVAL_POLICY = previous;
  }
});

test("server config rejects invalid numbers, origins and public URL paths or credentials", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  for (const [key, values] of Object.entries({
    PORT: ["0", "65536", "12.5", "oops"],
    SESSION_DEVICE_IDLE_DAYS: ["-1", "NaN", "0.1"],
    PUBLIC_API_URL: [
      "https://user:secret@example.com",
      "https://example.com/api",
      "https://example.com?query=1",
      "https://example.com/#hash",
      "ftp://example.com",
    ],
    ALLOWED_ORIGINS: ["*", "https://example.com/path", "https://user@example.com"],
  })) {
    const previous = process.env[key];
    try {
      for (const value of values) {
        process.env[key] = value;
        assert.throws(() => readConfig(), new RegExp(key));
      }
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
  assert.equal(readConfig().sessionDeviceIdleDays, 0);
});
