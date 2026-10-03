import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialLogin,
  credentialLoginInputSchema,
  type CredentialPage,
} from "../src/credential-login.ts";

const secret = "canary-login-password-92841";
const input = (overrides: Record<string, unknown> = {}) =>
  credentialLoginInputSchema.parse({
    adapterId: "fixture-login",
    origin: "https://login.fixture.test",
    allowedRedirectOrigins: ["https://login.fixture.test", "https://account.fixture.test"],
    fields: [
      { selector: "#username", value: "fixture@example.test" },
      { selector: "#password", value: secret },
    ],
    sensitiveSelectors: ["#username", "#password"],
    submitSelector: "#submit",
    authenticatedSelector: "#signed-in",
    invalidCredentialsSelector: "#invalid",
    challengeSelectors: [{ kind: "otp", selector: "#otp" }],
    ...overrides,
  });

class FakePage {
  currentUrl = "https://login.fixture.test/sign-in";
  readonly values = new Map<string, string>();
  readonly visible = new Set<string>();
  submitCount = 0;
  submitFailsAfterDispatch = false;
  routeHandler?: (route: never) => Promise<void>;
  readonly locators = new Map<string, { count: number; visible?: boolean; enabled?: boolean }>();

  constructor() {
    this.locators.set("#username", { count: 1, visible: true, enabled: true });
    this.locators.set("#password", { count: 1, visible: true, enabled: true });
  }

  url() {
    return this.currentUrl;
  }
  locator(selector: string) {
    const page = this;
    return {
      async count() {
        return page.locators.get(selector)?.count ?? 0;
      },
      async isVisible() {
        return page.locators.get(selector)?.visible ?? page.visible.has(selector);
      },
      async isEnabled() {
        return page.locators.get(selector)?.enabled ?? true;
      },
      async fill(value: string) {
        page.values.set(selector, value);
      },
      async click() {
        page.submitCount += 1;
        if (page.submitFailsAfterDispatch) throw new Error("response lost after submit");
        page.locators.set("#signed-in", { count: 1, visible: true });
        if (page.values.has("#otp")) page.locators.set("#otp", { count: 1, visible: false });
      },
    };
  }
  async evaluate<T, A>(_operation: (args: A) => T, _args: A): Promise<T> {
    return { ready: true, actionOrigin: "https://login.fixture.test" } as T;
  }
  async route(_pattern: string, handler: (route: never) => Promise<void>) {
    this.routeHandler = handler;
  }
  async unroute() {
    this.routeHandler = undefined;
  }
  async waitForLoadState() {}
  async waitForTimeout() {}
  asPage() {
    return this as unknown as CredentialPage;
  }
}

const readyForm = () => new FakePage();

test("fills only fixed trusted fields and returns a redacted authenticated receipt", async () => {
  const page = readyForm();
  page.locators.set("#submit", { count: 1, visible: true, enabled: true });
  page.locators.set("#signed-in", { count: 1, visible: false });
  const protections: { selectors: string[]; suspended: boolean }[] = [];
  const result = await credentialLogin(page.asPage(), input(), {
    sessionId: "a67e4034-71fc-4e20-8965-28c64f75f2c9",
    protect: async (selectors, suspended) => {
      protections.push({ selectors, suspended });
    },
  });
  assert.equal(result.status, "authenticated");
  assert.equal(page.values.get("#password"), secret);
  assert.equal(page.submitCount, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(
    protections.map((value) => value.suspended),
    [true, false],
  );
  assert.equal(page.routeHandler, undefined);
});

test("confirms an already authenticated profile without refilling stored credentials", async () => {
  const page = readyForm();
  page.locators.set("#signed-in", { count: 1, visible: true });
  const result = await credentialLogin(page.asPage(), input(), {
    sessionId: "a67e4034-71fc-4e20-8965-28c64f75f2c9",
    protect: async () =>
      assert.fail("already authenticated profiles do not need credential masking"),
  });
  assert.equal(result.status, "authenticated");
  assert.equal(page.values.size, 0);
  assert.equal(page.submitCount, 0);
});

test("rejects a wrong login origin before filling any field", async () => {
  const page = readyForm();
  page.currentUrl = "https://attacker.fixture.test/sign-in";
  const result = await credentialLogin(page.asPage(), input(), {
    sessionId: "a67e4034-71fc-4e20-8965-28c64f75f2c9",
    protect: async () => assert.fail("origin mismatch must not mask or fill"),
  });
  assert.equal(result.status, "manual_required");
  assert.equal(result.reasonCode, "ORIGIN_MISMATCH");
  assert.equal(page.values.size, 0);
  assert.equal(page.submitCount, 0);
});

test("keeps one-time code inputs masked and reports a challenge without submitting it", async () => {
  const page = readyForm();
  page.locators.set("#submit", { count: 1, visible: true, enabled: true });
  page.locators.set("#otp", { count: 1, visible: true });
  const protections: { selectors: string[]; suspended: boolean }[] = [];
  const result = await credentialLogin(page.asPage(), input(), {
    sessionId: "a67e4034-71fc-4e20-8965-28c64f75f2c9",
    protect: async (selectors, suspended) => {
      protections.push({ selectors, suspended });
    },
  });
  assert.equal(result.status, "challenge");
  assert.equal(result.challengeKind, "otp");
  assert.ok(protections.at(-1)?.selectors.includes("#otp"));
  assert.equal(page.submitCount, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("returns outcome_unknown after an uncertain submit and never retries it", async () => {
  const page = readyForm();
  page.locators.set("#submit", { count: 1, visible: true, enabled: true });
  page.submitFailsAfterDispatch = true;
  const result = await credentialLogin(page.asPage(), input(), {
    sessionId: "a67e4034-71fc-4e20-8965-28c64f75f2c9",
    protect: async () => {},
  });
  assert.equal(result.status, "outcome_unknown");
  assert.equal(page.submitCount, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("does not fill a form whose trusted selectors resolve outside the adapter origin", async () => {
  const page = readyForm();
  page.evaluate = async function <T, A>(): Promise<T> {
    return { ready: true, actionOrigin: "https://attacker.fixture.test" } as T;
  };
  page.locators.set("#submit", { count: 1, visible: true, enabled: true });
  const result = await credentialLogin(page.asPage(), input(), {
    sessionId: "a67e4034-71fc-4e20-8965-28c64f75f2c9",
    protect: async () => {},
  });
  assert.equal(result.status, "manual_required");
  assert.equal(result.reasonCode, "LOGIN_FORM_UNAVAILABLE");
  assert.equal(page.values.size, 0);
  assert.equal(page.submitCount, 0);
});

test("submits one human verification code through its fixed challenge selector", async () => {
  const page = readyForm();
  page.locators.set("#submit", { count: 1, visible: true, enabled: true });
  page.locators.set("#otp", { count: 1, visible: true });
  const code = "761204";
  const challengeId = "f615e0c0-d561-47e9-9302-cac8a5cd955c";
  const result = await credentialLogin(
    page.asPage(),
    input({
      fields: [{ selector: "#otp", value: code }],
      sensitiveSelectors: ["#otp"],
      challenge: { id: challengeId, kind: "otp", submitSelector: "#submit" },
    }),
    {
      sessionId: "a67e4034-71fc-4e20-8965-28c64f75f2c9",
      protect: async () => {},
    },
  );
  assert.equal(result.status, "authenticated");
  assert.equal(result.challengeId, challengeId);
  assert.equal(page.values.get("#otp"), code);
  assert.equal(page.submitCount, 1);
  assert.equal(JSON.stringify(result).includes(code), false);
});
