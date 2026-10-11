import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  publicSourceReadSchema,
  readPublicSource,
} from "../apps/server/src/public-source-cache.ts";
import { preservePublicSource } from "../apps/server/src/public-web.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a truncated source can be searched and read from its original bytes without browser or computer work", async (t) => {
  const f = await taskRuntime(t);
  const text = `${"Course description. ".repeat(4000)}All lessons are free. Optional certificate costs €20.\nNext section.`;
  const spill = await preservePublicSource(
    f.files,
    "owner",
  )({
    url: "https://courses.example/policy",
    text,
    mimeType: "text/plain",
  });
  const found = await readPublicSource(f.files, "owner", {
    fileId: spill.fileId,
    query: "ALL LESSONS",
    offset: 0,
    limit: 300,
  });
  assert.equal(found.url, "https://courses.example/policy");
  assert.match(found.text, /All lessons are free/);
  assert.equal(found.sha256, spill.sha256);
  assert.equal(found.observedAt, (await f.files.get("owner", spill.fileId)).createdAt);
  assert.equal(found.attachment, false);
  const first = await readPublicSource(f.files, "owner", {
    fileId: spill.fileId,
    offset: 0,
    limit: 100,
  });
  assert.equal(first.nextOffset, 100);
  const second = await readPublicSource(f.files, "owner", {
    fileId: spill.fileId,
    offset: first.nextOffset,
    limit: 100,
  });
  assert.equal(first.text + second.text, text.slice(0, 200));
  await assert.rejects(
    readPublicSource(f.files, "other-owner", { fileId: spill.fileId, offset: 0, limit: 100 }),
  );
});

test("source-cache reading cannot impersonate a public read using an ordinary attachment", async (t) => {
  const f = await taskRuntime(t);
  const file = await f.files.importAttachment(
    "owner",
    "notes.txt",
    Buffer.from("free"),
    "upload",
    "text/plain",
  );
  await assert.rejects(
    readPublicSource(f.files, "owner", { fileId: file.id, offset: 0, limit: 100 }),
    /preserved public source/,
  );
});

test("one preserved-source read finds multiple requested fields and later occurrences within a shared output budget", async (t) => {
  const f = await taskRuntime(t);
  const text = [
    "Contents: Course Atlas. Duration. Certificate.",
    "Overview only. ".repeat(100),
    "Course Atlas: lessons are free. Duration: three hours. Certificate: optional and paid.",
    "Syllabus. ".repeat(100),
    "Course Atlas FAQ: Language: Brazilian Portuguese. Certificate fee: 20 euros.",
  ].join("\n");
  const file = await f.files.importAttachment(
    "owner",
    "atlas.txt",
    Buffer.from(text),
    "web_fetch:https://courses.example/atlas",
    "text/plain",
    "batch-atlas-source",
    true,
  );
  const spill = { fileId: file.id, sha256: createHash("sha256").update(text).digest("hex") };
  const bytes = t.mock.method(f.files, "bytes", f.files.bytes.bind(f.files));
  const source = await readPublicSource(
    f.files,
    "owner",
    publicSourceReadSchema.parse({
      fileId: spill.fileId,
      queries: ["Course Atlas", "Language", "Certificate", "Spanish"],
      limit: 1200,
    }),
  );
  const result = source as typeof source & {
    matches: {
      query: string;
      found: boolean;
      truncated: boolean;
      occurrences: { matchOffset: number; offset: number; text: string }[];
    }[];
  };
  assert.deepEqual(
    result.matches?.map((entry) => entry.query),
    ["Course Atlas", "Language", "Certificate", "Spanish"],
    "one call must return each requested search, including a precise negative result",
  );
  assert.match(result.text, /Language: Brazilian Portuguese/);
  assert.match(result.text, /Certificate fee: 20 euros/);
  const atlas = result.matches.find((entry) => entry.query === "Course Atlas");
  assert.ok(atlas);
  assert.equal(atlas.occurrences.length, 3, "a contents entry must not hide later course sections");
  for (const entry of result.matches) {
    for (const occurrence of entry.occurrences) {
      assert.equal(
        occurrence.text,
        text.slice(occurrence.offset, occurrence.offset + occurrence.text.length),
        "each excerpt must remain an exact slice of the owned source bytes",
      );
      assert.equal(
        text.slice(occurrence.matchOffset, occurrence.matchOffset + entry.query.length),
        entry.query,
      );
    }
  }
  const absent = result.matches.find((entry) => entry.query === "Spanish");
  assert.ok(absent);
  assert.equal(absent.found, false);
  assert.deepEqual(absent.occurrences, []);
  assert.equal(bytes.mock.callCount(), 1, "all terms share one physical source read");
  assert.ok(result.text.length <= 1200, "limit bounds the combined text, not each query");
  assert.equal(result.sha256, spill.sha256);
  assert.equal(result.provenance.networkRead, false);
  assert.equal(result.url, "https://courses.example/atlas");
  assert.equal(result.observedAt, (await f.files.get("owner", spill.fileId)).createdAt);
  await assert.rejects(
    readPublicSource(
      f.files,
      "other-owner",
      publicSourceReadSchema.parse({ fileId: spill.fileId, queries: ["Course Atlas"] }),
    ),
  );
});

test("batched source search reports omitted occurrences and supports their continuation without inventing absence", async (t) => {
  const f = await taskRuntime(t);
  const text = Array.from(
    { length: 5 },
    (_, index) => `Section ${index}: cost ${index} euros. ${"Details. ".repeat(40)}`,
  ).join("\n");
  const file = await f.files.importAttachment(
    "owner",
    "prices.txt",
    Buffer.from(text),
    "web_fetch:https://courses.example/prices",
    "text/plain",
    "batch-prices-source",
    true,
  );
  const spill = { fileId: file.id };
  const first = await readPublicSource(
    f.files,
    "owner",
    publicSourceReadSchema.parse({
      fileId: spill.fileId,
      queries: ["cost", "Nonexistent[regex]"],
      limit: 150,
      maxMatches: 1,
    }),
  );
  const results = (
    first as typeof first & {
      matches: { query: string; found: boolean; truncated: boolean; nextOffset: number | null }[];
    }
  ).matches;
  assert.ok(results, "batch search results must expose per-term coverage");
  const price = results.find((entry) => entry.query === "cost");
  assert.ok(price);
  assert.equal(price.found, true);
  assert.equal(price.truncated, true, "later occurrences exist beyond this selected match");
  assert.ok(price.nextOffset !== null);
  const next = await readPublicSource(
    f.files,
    "owner",
    publicSourceReadSchema.parse({
      fileId: spill.fileId,
      queries: ["cost"],
      offset: price.nextOffset,
      maxMatches: 1,
      limit: 150,
    }),
  );
  assert.match(next.text, /cost 1 euros/);
  assert.equal(results.find((entry) => entry.query === "Nonexistent[regex]")?.found, false);
});

test("the real worker reads a preserved source beyond the requested excerpt and uses it as quoted evidence", async (t) => {
  let f: Awaited<ReturnType<typeof taskRuntime>>;
  let reads = 0;
  await modelFixture(
    t,
    async (i) => {
      if (i === 0)
        return {
          name: "web_fetch",
          arguments: { url: "https://courses.example/policy", maxChars: 300 },
        };
      if (i === 1) {
        const source = (await f.db.list<{ id: string; source: string }>("owner", "files")).find(
          (file) => file.source.startsWith("web_fetch:"),
        );
        assert.ok(source);
        return {
          name: "read_web_source",
          arguments: { fileId: source.id, query: "All lessons", offset: 0, limit: 2000 },
        };
      }
      return {
        name: "finish_task",
        arguments: {
          summary:
            "Open AI: all lessons are free. Optional certificate costs €20. https://courses.example/policy",
        },
      };
    },
    {
      researchReview: () => ({
        complete: true,
        missing: [],
        nextSteps: [],
        needsMoreResearch: false,
        accessAudit: [
          {
            option: "Open AI",
            access: "free",
            sourceUrl: "https://courses.example/policy",
            quote: "All lessons are free.",
          },
        ],
      }),
    },
  );
  f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => {
    reads++;
    return {
      url,
      contentType: "text/html",
      body: `<article>${"Course description. ".repeat(3000)}All lessons are free. Optional certificate costs €20.</article>`,
    };
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Find a free AI course and tell me the optional certificate cost.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.equal(reads, 1);
  assert.ok(saved.evidence.some((evidence) => evidence.excerpt.includes("All lessons are free")));
  assert.equal(saved.question, "");
});

test("the native source tool advertises batch search, resolves its offered reference and journals exact matches", async (t) => {
  let reference = "";
  let advertisedAcceptsReference = false;
  let advertisedBatchSearch = false;
  const patterns = (value: unknown): string[] => {
    if (typeof value === "string") {
      try {
        return patterns(JSON.parse(value));
      } catch {
        return [];
      }
    }
    if (Array.isArray(value)) return value.flatMap(patterns);
    if (!value || typeof value !== "object") return [];
    const record = value as {
      properties?: { fileId?: { pattern?: string }; queries?: { type?: string | string[] } };
    };
    const pattern = record.properties?.fileId?.pattern;
    const queryType = record.properties?.queries?.type;
    if (
      pattern &&
      (queryType === "array" || (Array.isArray(queryType) && queryType.includes("array")))
    )
      advertisedBatchSearch = true;
    return [
      ...(typeof pattern === "string" ? [pattern] : []),
      ...Object.values(value).flatMap(patterns),
    ];
  };
  const fixture = await modelFixture(t, (i) => {
    if (i === 0)
      return {
        name: "web_fetch",
        arguments: { url: "https://courses.example/lesson", maxChars: 300 },
      };
    if (i === 1) {
      // Native discovery can add HTTP turns between logical fixture calls.
      const request = fixture.requests.at(-1);
      assert.ok(request);
      reference = /app_file_[a-f0-9]{12}/.exec(request.body)?.[0] ?? "";
      advertisedAcceptsReference = patterns(JSON.parse(request.body)).some((pattern) =>
        new RegExp(pattern).test(reference),
      );
      return {
        name: "read_web_source",
        arguments: {
          fileId: reference,
          queries: ["Original full lesson", "Missing phrase"],
          limit: 300,
        },
      };
    }
    return { name: "finish_task", arguments: { summary: "Original full lesson is available." } };
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let networkReads = 0;
  t.mock.method(f.agent.web, "document", async (url: string) => {
    networkReads++;
    return {
      url,
      contentType: "text/html",
      body: `<article>${"Introduction. ".repeat(2000)}Original full lesson is available.</article>`,
    };
  });
  const task = await f.agent.createTask("owner", {
    prompt:
      "Find the original full lesson on https://courses.example/lesson and tell me what it says.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.match(reference, /^app_file_[a-f0-9]{12}$/);
  assert.equal(
    advertisedAcceptsReference,
    true,
    "the advertised schema must accept its own offered ID",
  );
  assert.equal(networkReads, 1);
  assert.equal(
    advertisedBatchSearch,
    true,
    "the actual native inference must offer the batch schema",
  );
  const operation = (await f.agent.journal.operations("owner", task.id)).find(
    (entry) => entry.toolName === "read_web_source",
  );
  assert.ok(operation, "the worker must journal the actual source read");
  assert.equal(operation.status, "succeeded");
  assert.match((operation.args as { fileId: string }).fileId, /^[a-f0-9]{64}$/);
  assert.equal(
    (operation.receipt as { fileId: string }).fileId,
    (operation.args as { fileId: string }).fileId,
  );
  const result = operation.receipt as {
    text: string;
    matches: { query: string; found: boolean; occurrences: { text: string }[] }[];
    provenance: { networkRead: boolean };
  };
  assert.match(result.text, /Original full lesson is available/);
  assert.deepEqual(
    result.matches.map(({ query, found }) => ({ query, found })),
    [
      { query: "Original full lesson", found: true },
      { query: "Missing phrase", found: false },
    ],
  );
  assert.equal(result.provenance.networkRead, false);
});

test("a batch whose excerpt budget is too small retains the found match and a recovery offset", async (t) => {
  const f = await taskRuntime(t);
  const terms = [
    "First long exact field ".repeat(5).trim(),
    "Second long exact field ".repeat(5).trim(),
  ];
  const text = terms.join("\n");
  const file = await f.files.importAttachment(
    "owner",
    "long-fields.txt",
    Buffer.from(text),
    "web_fetch:https://courses.example/fields",
    "text/plain",
    "long-fields-source",
    true,
  );
  const source = await readPublicSource(
    f.files,
    "owner",
    publicSourceReadSchema.parse({
      fileId: file.id,
      queries: terms,
      limit: 100,
    }),
  );
  const matches = (
    source as typeof source & {
      matches: {
        query: string;
        found: boolean;
        truncated: boolean;
        nextOffset: number | null;
        occurrences: unknown[];
      }[];
    }
  ).matches;
  assert.ok(matches.every((entry) => entry.found && entry.truncated && entry.nextOffset !== null));
  assert.ok(matches.every((entry) => entry.occurrences.length === 0));
  assert.equal(
    source.text,
    "",
    "a partial phrase must not be presented as a complete matching excerpt",
  );
  const recovered = await readPublicSource(
    f.files,
    "owner",
    publicSourceReadSchema.parse({
      fileId: file.id,
      queries: [terms[1]],
      offset: matches[1].nextOffset,
      limit: 500,
    }),
  );
  assert.ok(recovered.text.includes(terms[1]));
  const context = await readPublicSource(
    f.files,
    "owner",
    publicSourceReadSchema.parse({ fileId: file.id, queries: [terms[1]], limit: 150 }),
  );
  assert.ok(
    context.text.includes(terms[1]),
    "surrounding context must not cut the matching phrase",
  );
  assert.equal(
    publicSourceReadSchema.safeParse({ fileId: file.id, query: terms[0], queries: terms }).success,
    false,
  );
});
