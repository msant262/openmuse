# Web and Android interface refresh

The user supplied six screenshots and requested fixes to stale companion-generation
results, a clearer desktop agent panel, discoverable memory and SOUL editing,
dark mode and understandable conversation navigation. Ship the changes to the
public web app and a newly signed Android APK, preserving the paired identity,
saved companion, memories, personality and conversations.

## Intended behavior

- Opening companion creation starts with an empty draft and the saved companion.
  Unselected historical options appear only through an explicit history action.
  In-flight generation remains recoverable; clearing a completed draft removes
  its options without deleting saved assets or triggering provider calls.
- The identity panel shows a compact identity/edit area and distinct SOUL and
  MEMORY cards. Each opens the real persisted editor with existing revision and
  history semantics. Do not invent physical files or add a second source of truth.
  Keep lengthy personality text in its editor, not the small inspector.
- Use a shared semantic light/dark palette across the app, persisted per device,
  with Light, Dark and System choices. Respect system changes in System mode and
  preserve component state, unsent drafts and authentication while switching.
  Theme the app chrome and controls; preserve document/image colors.
- Conversation navigation has a visible heading, prominent New conversation
  action, a separately described Main conversation and an Other conversations
  section. Selection uses a clear accent, border and accessible selected state;
  archive and per-conversation actions remain available.
- Keep web and native layouts responsive. Use the supplied Muse references for
  hierarchy and discoverability while retaining OkamiBot's identity and behavior.

## Delivery and validation

1. Reproduce stale generation through the real component and add a regression.
2. Implement persisted theme behavior and migrate shared/application surfaces.
3. Add direct identity editors and redesign conversation selection.
4. Exercise blank/history/in-flight avatar flows, memory edits and SOUL edits,
   theme persistence/system override, and main/other/new chat navigation in web
   and Android. Use isolated test data for writes; preserve live user content.
5. Run relevant regression tests, full suite, types, lint, web build and signed
   ARM64/x86 Android builds; test upgrade without removing existing app data.
6. Publish verified web and ARM64 APK, verify public bytes and runtime health,
   retain screenshots/receipts and state any remaining limitations.
