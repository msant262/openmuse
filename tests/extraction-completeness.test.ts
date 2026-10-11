import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { IntegrationService } from "../apps/server/src/integrations.ts";
import { extractPublicSources } from "../apps/server/src/public-extract.ts";
import { PublicWeb } from "../apps/server/src/public-web.ts";

const url = "https://courses.example/introduction";
const incomplete =
  "# Introduction\nEnroll for free\n\n## Frequently asked questions\n\n### Can I access all lessons?\n\n### Is the certificate included?\n\nShow all frequently asked questions\n\n### More questions\n[Help](https://courses.example/help)";
const complete =
  "# Introduction\nEnroll for free\n\n## Frequently asked questions\n\n### Can I access all lessons?\n\nFull lessons require a paid enrollment.\n\n### Is the certificate included?\n\nYes, it is included in paid enrollment.";

for (const mode of ["recovered", "partial", "failed", "aborted"])
  test(`collapsed FAQ extraction handles ${mode} recovery without claiming public absence`, async (t) => {
    const db = await createStore();
    t.after(() => db.close());
    const secret = "extraction-secret-must-never-appear";
    const controller = new AbortController();
    const depths: string[] = [];
    await db.put("owner", "integrations", {
      id: "tavily",
      credentialRef: "extract",
      status: "connected",
    });
    const integrations = new IntegrationService(
      db,
      {
        read: async () => ({ version: 1, data: { apiKey: secret } }),
        write: async () => 1,
        delete: async () => {},
      },
      {
        available: true,
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          depths.push(body.extract_depth);
          assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${secret}`);
          assert.equal(init?.redirect, "error");
          if (body.extract_depth === "advanced" && mode === "failed")
            throw new Error("Provider unavailable");
          if (body.extract_depth === "advanced" && mode === "aborted") {
            controller.abort(new Error("User cancelled extraction"));
            controller.signal.throwIfAborted();
          }
          return Response.json({
            results: [
              {
                url,
                raw_content:
                  body.extract_depth === "advanced" && mode === "recovered" ? complete : incomplete,
              },
            ],
          });
        },
      },
    );
    if (mode === "aborted") {
      await assert.rejects(
        integrations.extract(url, { owner: "owner", signal: controller.signal }),
        /User cancelled/,
      );
      assert.deepEqual(depths, ["basic", "advanced"]);
      return;
    }
    const page = await integrations.extract(url, { owner: "owner", signal: controller.signal });
    assert.deepEqual(
      depths,
      ["basic", "advanced"],
      "retry only the structurally incomplete source, once",
    );
    assert.equal(page?.url, url);
    assert.equal(page?.extraction?.status, mode === "recovered" ? "readable" : "partial");
    assert.equal(JSON.stringify(page).includes(secret), false);
    if (mode === "recovered")
      assert.match(page?.text ?? "", /Full lessons require a paid enrollment/);
    else {
      assert.match(page?.text ?? "", /Can I access all lessons/);
      assert.match(page?.extraction?.reason ?? "", /answer|question|incomplete/i);
    }
  });

test("an incomplete provider excerpt retains its observed text and permits the existing browser rescue", async () => {
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({ status: 403, headers: {}, body: "Forbidden" }),
  });
  let rendered = 0;
  const pages = await extractPublicSources(
    web,
    [url],
    undefined,
    async (source) => {
      rendered++;
      return { url: source, title: "Introduction", text: complete, truncated: false };
    },
    {
      extract: async (source) => ({
        url: source,
        title: "Introduction",
        text: incomplete,
        truncated: false,
        extraction: { status: "partial", reason: "Question answers were omitted by extraction." },
      }),
    },
  );
  assert.equal(rendered, 1);
  assert.match(pages[0].text, /Full lessons require a paid enrollment/);
  assert.equal(pages[0].extraction?.status, "readable");
  const partial = await web.read(url, undefined, {
    extract: async (source) => ({
      url: source,
      title: "Introduction",
      text: incomplete,
      truncated: false,
      extraction: { status: "partial", reason: "Question answers were omitted by extraction." },
    }),
  });
  assert.match(
    partial.text,
    /Can I access all lessons/,
    "a failed fallback must not erase actual partial source data",
  );
  assert.equal(partial.extraction?.status, "partial");
});
