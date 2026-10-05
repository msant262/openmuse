## Conversation actions and extraction recovery (5 October)

`engine/companion-social-tools.ts` ports the current-message default targeting and
one-reaction-per-author behavior of `tools/react_to_message_tool.py` at
`1298c8e74baa73e1a2b90124228d017261ac6bc4`. The implementation uses the existing
owner-scoped conversation store and replay stream. Current targets come from the
accepted turn, never from model-guessed database IDs. Tool descriptions adapt
Hermes's guidance to express a reaction without narrating it.

`public-extract.ts::mergeExtractResults` is a TypeScript port of
`tools/web_tools_extract.py::_merge_in_order` at the same revision. The batch
adapter also implements the partial-result preservation and one-call rescue
contract from `tools/web_tools_rescue.py::_rescue_extract`. Its backends are the
existing guarded HTTP reader and isolated VPS renderer, not Hermes's paid/keyless
provider ring. Cancellation and URL policy failures never trigger a rescue.
