# Public research recovery — 2026-10-04

The production election task `d8fd762c6f3e1445383f31b5a90e386b9891292118120e452aecc023b3a291cb`
read a g1 results shell, never rendered the page, and reported verified completion
despite explicitly stating that votes and percentages were unavailable. TSE and
UOL HTTP reads returned 403. One Bing RSS query also returned unrelated German
cash-register results matching only the acronym TSE.

The earlier makeup task did obtain product prices from flaconi through the native
browser. A later native operation became uncertain, preventing subsequent reads;
the final report lost the useful facts already collected. Existing resource holds
were preserved during this work.

## Changes

- `web_fetch` tries HTTP first and automatically renders blocked HTTP responses
  and detectable application loading shells. Explicit `mode=browser` handles
  readable pages that still lack the requested facts; `mode=http` stays on HTTP.
- The browser reader waits for loading placeholders to resolve and text to settle,
  up to six seconds, independently of polling/analytics network connections.
- Reads expose extraction status, source links, timestamp and transport provenance.
  Partial pages cannot count as verified page evidence. Browser reads use public
  routing, cancellation and existing resource leases, including VPS fallback.
- HTTP extraction retains image alternative text, preserving product names and
  links that were previously lost alongside their prices.
- Bing RSS filtering requires multiple distinct topic terms for longer queries,
  preventing an ambiguous acronym alone from accepting unrelated results.
- Research instructions retain useful earlier observations after later failures.
  `finish_task(outcome="partial")` records an incomplete delivery even when an
  introductory article passed the generic observation criterion.

## Verification

- Failing reproductions established the original loading-shell, missing product
  name, irrelevant acronym match, premature browser read and false completion
  behaviors before implementing their fixes.
- Full server/mobile suite: **1,322 passed**, zero failures.
- Real Chromium suite: **20 passed**, including delayed application hydration.
- Fallback suite: **28 passed**, including public reading with the native executor
  offline. URL/redirect guards and cancellation remain covered.
- Server TypeScript/build and browser-worker TypeScript passed. Changed-file Biome
  check had no errors; existing warnings/info remained.
- Actual g1 HTTP shell reproduced locally and from the VPS. The corrected reader
  returned candidate votes and percentages on its first completed rendered read.
- Actual LOOKFANTASTIC Germany sale page returned product names, prices and direct
  links over HTTP after preserving image alternative text.
- Candidate images were tested on the VPS with the configured production model,
  a separate temporary database and isolated Chromium container. Both an election
  request and a three-product makeup request completed with observed source data,
  no questions and no production conversation writes. Credentials were copied
  privately for this test; OAuth refresh was blocked before dispatch.

Evidence and receipts are under ignored `artifacts/research-reliability/`.

## Release

Local implementation: `76c9dd8`, with fixture formatting in `6270731`.
Published source: **`ede0f07baaa23419572ca1bd08bc784056dacd63`**, based on the previous
production release `e507b8d`, on `release/research-reliability-20261004`.

- API image: `sha256:86f4b582ed7283322745453b0c2d66ce9361d128e4773ce87b0ad6bc694ff1aa`
- Browser image: `sha256:77cdbfecae33ab8c530fa796b869e7cf8a98552a2138872a184a0a25e65771e7`

Both services were replaced during deployment maintenance and recovered healthy.
Runtime pause revision and retained operations/resources were preserved;
maintenance was cleared. The web/mobile bundles did not require a change.

## Limits

This does not bypass site access controls: flaconi still presented a challenge in
the isolated browser. A blocked source can require another source. Loading
detection is heuristic; explicit browser mode remains available for undetected
dynamic content. A readable page is not a semantic guarantee that every requested
fact is present, so the agent must assess sufficiency and declare partial delivery.
The live tests established the two inspected paths, not universal crawling coverage.
