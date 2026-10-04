# Structured research and headless readiness — 2026-10-04

This supersedes the automatic HTTP-to-browser escalation documented in
`2026-10-04-public-research-reliability.md`. The VPS browser already ran headless,
but the routing policy could prefer the personal native browser, and failed HTTP
reads could render before the model inspected published data endpoints.

## Behavior

1. Research instructions direct the model to discover relevant configured API/MCP
   tools and connected-app read tools first. Only actually available tools count
   as attempted integrations.
2. HTTP reads expose visible text, product data, application JSON and published
   JSON/feed/data URLs. Discovery parses literals without executing site scripts;
   following a URL still runs the existing public-address and redirect guards.
3. `web_fetch` in its default `auto` mode never dispatches a browser. The agent
   inspects the returned data and tries relevant published endpoints before
   explicitly requesting `mode=headless`. `mode=browser` remains a legacy alias.
4. Public headless observations require VPS transport, including while the native
   browser is online. VPS unavailability cannot silently open the native GUI.
   Legacy interactive browser tools remain available for work that requires a
   personal session or actual interaction; instructions reserve them for last.
5. Navigation allows 60 seconds. Reading allows another 60 seconds for pending
   document/application state and observed GET fetch/XHR requests, returning as
   soon as ready. Transport and proxy deadlines allow 90 seconds per request so
   they do not cut those waits short. No fixed minimum sleep or per-site delay
   is used. Incomplete data at the deadline is marked partial.

The headless reader also returns bounded URLs of successful JSON/CSV responses
already requested by the page. It does not replay requests, export headers or
request bodies, or return URLs containing recognized credential query fields.

## Verification

- Failing regressions demonstrated implicit rendering, native preference, missing
  data while a fetch was pending, the six-second deadline, and JSON discovery
  losing synchronization after empty configuration values.
- Targeted final public-research/deadline tests: **34 passed**.
- Full server/mobile run: **1,330 passed; one existing streaming-history timing
  test failed under concurrent load**. Its complete test file then passed
  independently: **17 passed**. No chat-history implementation was changed.
- Real Chromium suite: **21 passed**, including delayed application data and an
  actual pending JSON request with no loading CSS marker.
- Virtual-clock tests cover immediate completion, data arriving at 58 seconds,
  and a still-pending page marked partial at 60 seconds. A real HTTP transport
  test accepts a worker result after 46 seconds, beyond the former cutoff.
- Server and worker TypeScript, server build and changed-file formatting/lint
  passed; lint retained five warnings and two informational findings.
- Isolated candidate images with the configured real model completed both public
  research tasks without questions or production conversation writes. For g1 the
  model discovered tools, read HTTP, tried the published presidential-results
  JSON, received its size-limit error, then explicitly used headless and reported
  observed votes/percentages. Makeup returned three named products, current
  prices and links through HTTP, without browser dispatch.

The first live-test assertion incorrectly required successful HTTP provenance on
the oversized JSON request. Its journal already showed the attempted endpoint
before rendering. The corrected acceptance test checks that order, explicit
headless mode and successful observed results; both tasks passed on the rerun.

Evidence is under ignored `artifacts/research-strategy/`.

## Release

Implementation: `689cea5`. Published source:
**`87719d9aff8009000837b1eb8551efbc9483903c`**, applied to the previous production
release `ede0f07` on `release/research-strategy-20261004`.

- API image: `sha256:51fba0e4a7aa3a1e19d5044908a05c46d31f871a8244972fa9aa47e45e0990e5`
- Browser image: `sha256:3ed0c2d1eb3f91becd056da17da04a113cfcd553f013d333166af8152f76fe48`

Both production containers recovered healthy with these exact images. Maintenance
was cleared, pause revision 16 stayed unchanged, and the existing two held
resources, six retained operations and two native deliveries were preserved.

## Limits

WebMCP is not implemented as a new adapter in this change. Existing configured
MCP tools are prioritized; instructions do not claim unavailable WebMCP access.
Readiness remains an observation of document state and requests, not a semantic
proof that every requested fact was obtained. Sites can still be blocked or
remain incomplete after a minute. Public HTTP bodies retain the 2 MiB bound;
larger datasets can require a smaller published endpoint or headless fallback.
