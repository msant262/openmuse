# Conversation interaction and research repair — 5 October 2026

## Production failure

Task `8a93778776d4eed31437e67c255287fdc5b7af29fbc7052a703db4fcfd487365`
found alternative election-result sources but repeatedly fetched TSE's election
selector. It stopped after three delivery-review failures and 14/96 steps. Its
final answer contained neither totals nor candidates. The preceding SOUL-only
release fixed speaking instructions but did not fix this execution path.

Handoff composition removed every tool, including conversation reactions and
quoted replies. The six sticker choices rendered static posters. Social tool
results bypassed `MessageBubble`, so their own messages could not be quoted or
reacted to. Production browser inspection could quote ordinary assistant text
through the overflow menu; the missing affordance was discoverability, not an
absent handler for ordinary text.

## Implementation

- Handoff retains only bounded conversation actions, with current-user targeting
  adapted from Hermes. The profile is reread for composition. Already-spoken or
  quoted acknowledgments do not generate a duplicate task/status reply; sending
  a quote before delegation cannot suppress the requested work.
- Reactions support a single emoji rather than a six-value model enum. User
  quick reactions remain six convenient choices. Reactions retain owner/thread
  checks and one author-specific durable row.
- Quoted replies, stickers and GIF tool receipts render with the same Reply and
  reaction controls as ordinary messages. The server resolves their actual
  persisted tool-call identity when quoting; arbitrary tool output is excluded.
- Reply/react controls are visible within message bounds. Long press and the
  copy/share menu remain available. Stickers use the existing animated renderer,
  including visibility/reduced-motion handling.
- GIF discovery reads actual media metadata from returned Tenor pages. `send_gif`
  validates a public HTTPS target. Failed discovery can use an animated sticker;
  it never fabricates a media URL. Android's existing animated-GIF support is on.
- Search, fetch and batch extraction schemas are immediately visible. Extraction
  preserves per-source successes and errors, with bounded HTTP-to-headless rescue.
  The ordered merge ports Hermes executable code; MIT attribution is retained.
- Rejected research can read up to three untried ranked sources before terminating.
  Incidental analytics/consent JSON is excluded from automatic recovery. The
  reviewer distinguishes missing facts from wording/formatting/source-time repairs.

## Observed acceptance

The isolated real-model run used the production SOUL, subscription model and
saved conversation history, separate PGlite data and a separate browser container.
No real-user conversation received the test messages. Credentials were cloned,
refresh blocked, and temporary verification pairings revoked.

An exploratory run (`f964d33`) produced a celebration sticker, a quoted reply,
a durable reaction and a real Tenor GIF. The reserved profile produced a formal
reply without emoji or social actions. The original election question reached
BBC's article and its observed JSON results URL, extracting vote totals and
percentages. Review rejected treating the fetch time as the source update time;
the final answer explicitly attributed the earlier published timestamp. This
is evidence of successful source acquisition, not a promise of real-time data.

The initial live script mixed direct runner calls with inbox acceptance; that could dispatch a second test run. Final acceptance instead seeds canonical thread history and uses LocalThreads exactly once.

The exploratory run also revealed irrelevant analytics reads during recovery. The final
candidate restricts automatic alternatives to ranked search sources and skips
new research when existing facts only need presentation/time correction.

Browser acceptance at 740 and 390 pixels exercised visible Reply on an assistant
quote, a sticker reaction saved through the API, a sent reply to a GIF with the
canonical quote persisted, reload persistence, GIF rendering and an actually
playing sticker video. No browser exceptions were observed. This uses the actual
exported application and a separate seeded server, not component mocks.

Detailed private receipts are under ignored `artifacts/interaction-research/`.
Release and final verification receipts will be recorded after acceptance. A long GIF mood query could overconstrain discovery; lookup now broadens to the first two distinct mood keywords before returning no media, with a regression test.
