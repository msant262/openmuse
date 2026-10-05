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
- GIF discovery reads linked images in the public Tenor catalog first, then actual
  media metadata from search-discovered Tenor pages. This avoids general-search
  outages and overconstrained mood queries. `send_gif`
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
A canonical isolated run (`cc6cccb`, one admission, no inbox double dispatch)
found the actual count but still failed. Its first two rejected deliveries spent
the research retry allowance; its third delivery had the count and needed only
wording, attribution and removal of unsupported extras. That was incorrectly
terminal. Delivery repairs now have their own bounded allowance, and the tool
schema exposes only `finish_task` while those repairs run. The regression failed
before this change and passes afterwards. Voice composition preserves literal
number spellings and source URLs so that added guessed links cannot force a
fallback to the worker draft.

## Resumed validation

The interrupted final suite had no completion receipt. A new run passed 1,350
tests, including a regression added during the continuation: a delivery-only
review from a previous task revision must not hide research tools after the
request changes. TypeScript passed for server and mobile.

The first resumed live script incorrectly required a text reply alongside a
successful GIF receipt. The actual GIF was delivered; the script now accepts a
successful quoted reply, sticker or GIF as a visible answer and explicitly checks
requested media delivery.

Candidate `d7ebecc` exposed two further failures. Responses returned commentary
and a final acknowledgment in the same inference, creating two confirmations.
Reply composition now prefers final text, retaining commentary only when a
verified response contains no final text. Other turns preserve their existing
message boundaries, and tool receipts are unchanged. Tests exercise both phases,
commentary-only output, and the normal streaming behavior through the real SDK.

The research also treated an HTTP dashboard template as readable evidence:
BBC's initial HTML included a default 0% and unresolved `{day}`/`{time}` fields.
The task stopped without reading the populated widget. Script-backed content
with multiple unresolved bindings is now partial, triggering the existing batch
HTTP-to-headless recovery. Code/pre examples are excluded from detection. A test
reproduced the missed render before the change, and the captured BBC HTML now
returns partial. This does not change the source's data or assert a current count.

Candidate `595b764` completed the original question with the real subscription
model and saved history. It read G1's observed JSON endpoint, delivered candidate
vote totals and percentages in bullets, and attributed the source and consultation
time. The third review accepted the result. Reaction, quoted reply, requested
sticker and requested GIF all have successful receipts; handoff produced one
acknowledgment. The formal profile answered without emoji or visible reactions.

The live script's final assertion rejected even a reaction-removal call
(`emoji: null`). That call left no reaction, so the check was corrected to inspect
the actual persisted result. `live-verification.json` records this original exit
and the successful independent validation of all saved receipts; it is not
presented as a clean exit of the original script. The selected Tenor media was
also downloaded and verified as an animated GIF.

The final local suite passed **1,354 tests** with no failures. Server/mobile
TypeScript and the candidate image build passed. Biome on the changed code had
zero errors, six existing non-null warnings and one existing string-style notice.
The server candidate retains the deployed base's scope; unrelated local memory
and context-compaction work remains outside this release.

## Publication

Source commit: `d614930`. API: `595b764`, image
`sha256:e5fa0fbddc8e8987bb0084e4cbc8a06fdd61932b5452ea5ead216ac686522501`.
Web and Android: `b82d434`. The API was replaced with no active tasks,
conversations or admissions. Maintenance ended, pause revision 16 stayed
unchanged, and retained operations/resources were preserved. API and browser
containers are healthy; the public health endpoint returned HTTP 200.

Production browser acceptance at 740 and 390 px exercised the visible Reply
control and reaction picker without submitting messages/reactions. No JavaScript
errors or product writes were observed. Temporary verification pairings were
revoked. Profile revisions, SOUL, selected model and avatar retained digest
`f0e9bfb1b824e2f020869fc086ebb7cc300c7d924e3b2eff3fd26864740029ff`.

Both public web bundles match their build hashes. The signed ARM64 APK is
68,786,487 bytes, SHA-256
`f834ec2b076331de1a5097d281747bd618a2327be0138e2a2350f04fe8f76cdb`.
The public download matches the local artifact and preserves signer
`e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.
There was no new physical-device acceptance. Browser media/reply persistence
and animated-sticker acceptance remain documented above.

Receipts: `deployment-api.log`, `deployment-web.log`, `live-verification.json`,
`public-acceptance-resumed.json`, `public-downloads.json`, and
`production-after.json` under ignored `artifacts/interaction-research/`.
