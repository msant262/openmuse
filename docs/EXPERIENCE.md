# OpenMuse interaction design

OpenMuse keeps conversation, ongoing work, and user control together in a shared native and web interface.

## Conversation and work

- One main conversation is the default. Its identifier and rich history persist in the workspace database; side chats have separate conversation context.
- The composer stays available during replies. Its send arrow changes to a stop square in the same position inside the input pill, then returns when the run ends. Stopping preserves the current draft.
- Follow-ups appear in a visible queue and run in order. Stopping a reply pauses that queue; it does not cancel delegated tasks. A new submission can continue immediately when no follow-ups are held. An existing paused queue resumes through **Send queued messages**.
- Open chats and their drafts remain mounted while navigating. Queued messages are held in the open app, not a server inbox; keep the app open until they are sent. Delegated tasks are durable server work.
- Reading older messages should not force a scroll to the latest reply. A latest-message control returns to the live conversation.

## Transparency and control

- Tap the avatar to see activity, reviews and receipts. Its status names the current work or the input it needs.
- Background updates show meaningful completions or requests for input. They link to the saved task and can be dismissed.
- Structured review screens retain the exact recipient, action and accept/reject controls. Reading a public page requires no extra review.
- The agent's name, tone and memory are editable in Apps. Goals, tracking and artifacts remain usable outside chat.

## Visual language

An airy canvas, distinct gray and sky-blue message bubbles, large touch targets, rounded input and navigation pills, and restrained artifact frames keep attention on the work. Email, browser and PDF previews show actual tool results. OpenMuse uses five original locally rendered 3D companions: a plush capybara, wolf, fox and cat, plus a ceramic robot. A compact portrait remains in the conversation; working, responding and idle poses follow real activity. Appearance customization provides live color, shape and accessory previews with explicit saving. Reduced motion and background pausing are respected. See [artwork provenance](../apps/mobile/assets/README.md).

## Boundaries

The computer provides persistent Chromium, documents, and an optional Linux container with a terminal and filesystem. The offline computer profile has no network access and 30-second commands. The guarded open profile permits public IPv4 network access, persistent workspace/home, foreground commands up to 30 minutes and explicit background jobs. Foreground tools own their bounded lifetime; the task model’s five-minute inference deadline pauses while tools execute. It is not a full operating-system VM or a graphical desktop. Model reasoning and Google accounts require credentials; rich conversations persist locally without a vendor key. See [computer setup](COMPUTER.md).


Image generation is installed as an optional provider adapter and remains disabled unless a compatible image endpoint/model is configured. Native APNs/FCM push adapters are installed; the phone must grant consent and the server needs provider credentials. Disable/logout orders revocation after pending registrations. Activity records provider acceptance, rejection or an uncertain outcome without notification payloads or device tokens; provider acceptance does not prove physical delivery. In-app updates remain available without native push. Signed builds, physical phone delivery and live provider eligibility require operator verification.
