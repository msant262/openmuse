# Harness continuity and task progress

OpenClaw source: `b56ae70a5e7e302dc2165c96b60214e84e19c7b1`, MIT, [license](openclaw/LICENSE).
`apps/server/src/engine/openclaw/history-turns.ts` copies `limitHistoryTurns`
from `src/agents/embedded-agent-runner/history.ts`; only the host message type
is generalized. `delegated-context.ts` adapts the parent-transcript fork contract
from `src/agents/subagents/spawn/subagent-spawn-context.ts` to the authenticated
canonical transcript and existing durable task store. Source observations retain
URLs and timestamps; old operations never grant new effect authority.

Hermes source: `1298c8e74baa73e1a2b90124228d017261ac6bc4`, MIT,
[license](hermes-learning/LICENSE). `engine/hermes/todo-store.ts` ports executable
TodoStore write/merge, last-ID deduplication, active-step ordering, parent cleanup,
bounded snapshots and active-list reinjection from `tools/todo_tool.py`.
The native task checkpoint persists the list and its revision. There is no second
worker or independent effect dispatcher.

`engine/hermes/history-repair.ts` also ports
`_repair_invalid_tool_call_arguments` from `agent/agent_runtime_helpers.py` at
that Hermes revision: empty/corrupted historical arguments become valid JSON,
with an explicit corruption marker on the existing receipt (or an inert missing
receipt). This changes only the inherited projection. Canonical messages remain
untouched, and historical calls are never dispatched by the repair.
