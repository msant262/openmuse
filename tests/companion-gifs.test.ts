import assert from "node:assert/strict";
import test from "node:test";
import { findConversationGifs } from "../apps/server/src/companion-gifs.ts";
import { PublicWeb } from "../apps/server/src/public-web.ts";
import type { SearchBackend } from "../apps/server/src/search.ts";

test("GIF discovery returns actual advertised GIFs and rejects static thumbnails/private targets", async () => {
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<meta property="og:image" content="https://media.example/reaction.gif"><meta property="twitter:image" content="https://media.example/still.png"><meta property="og:image" content="http://127.0.0.1/private.gif">`,
    }),
  });
  const search = {
    search: async () => ({
      sources: [{ url: "https://tenor.com/view/celebrate", title: "Celebrate" }],
    }),
  } as unknown as SearchBackend;
  const result = await findConversationGifs(search, web, "owner", "celebrate");
  assert.deepEqual(result.gifs, [
    {
      url: "https://media.example/reaction.gif",
      alt: "Celebrate",
      sourceUrl: "https://tenor.com/view/celebrate",
    },
  ]);
});

test("GIF lookup broadens an over-specified mood before returning no media", async () => {
  const queries: string[] = [];
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<meta property="og:image" content="https://media.example/confetti.gif">',
    }),
  });
  const search = {
    search: async ({ query }: { query: string }) => {
      queries.push(query);
      return {
        sources: query.includes("queen")
          ? []
          : [{ url: "https://tenor.com/view/party", title: "Party" }],
      };
    },
  } as unknown as SearchBackend;
  const result = await findConversationGifs(
    search,
    web,
    "owner",
    "celebration confetti fabulous queen drag celebration GIF",
  );
  assert.equal(queries.length, 2);
  assert.equal(result.gifs.length, 1);
  assert.equal(queries[1], "celebration confetti gif site:tenor.com/view");
});

test("GIF discovery reads the public catalog when general search has no relevant results", async () => {
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<a href="/view/party-gif-42"><img src="https://media.tenor.com/party.gif" alt="Confetti celebration"></a><img src="https://ads.example/tracker.gif" alt="ad">',
    }),
  });
  let searches = 0;
  const search = {
    search: async () => {
      searches++;
      return { sources: [] };
    },
  } as unknown as SearchBackend;
  const result = await findConversationGifs(search, web, "owner", "celebration fabulous queen");
  assert.equal(searches, 0);
  assert.deepEqual(result.gifs, [
    {
      url: "https://media.tenor.com/party.gif",
      alt: "Confetti celebration",
      sourceUrl: "https://tenor.com/view/party-gif-42",
    },
  ]);
});
