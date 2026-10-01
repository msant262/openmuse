# CopilotKit Rich Threads and the agent computer

OpenMuse uses `@copilotkit/react-native/headless` for its custom native and web interface. Chat messages, tool cards and task-linked documents render through CopilotKit's AG-UI agent and tool hooks.

## Rich Threads

Conversations use OpenMuse's own database by default: embedded PGlite in `.openmuse/postgres`, or Postgres via `DATABASE_URL`. No CopilotKit project or key is required. Existing runtime/mobile packages remain at 1.70.1; the additive `apps/server/src/threads.ts` runner preserves the AG-UI protocol and native hooks.

The native `useThreads` hook lists, renames, archives, restores and paginates conversations through authenticated local REST routes. No WebSocket join code or CopilotKit cloud URL is returned. The server provisions a stable owner-bound main thread before its first message. The main conversation cannot be archived; side chats have independent context and persist on their first run.

Selecting a saved conversation mounts its own `useAgent` instance and calls `copilotkit.connectAgent` to replay durable AG-UI events. Tool results, custom panels and state are preserved. Task/document/browser IDs remain in rich messages; fresh signed links come from the authenticated workspace API. Visited chats preserve drafts and queues. The composer stays editable during replies; a failed or stopped reply pauses queued sends. The queue lives in the open app, while delegated tasks remain durable server work. See [interaction design](EXPERIENCE.md).

Each event is committed before streaming to the client. Database-clock leases prevent competing runs even across API processes using Postgres. Reconnecting follows persisted events, including an active reply; closing the app detaches its stream without stopping the agent. Event replay and lease activity come from the same database snapshot, so a finishing reply cannot lose its final events. Stop requests cancel the run (including across API processes) and preserve partial text/receipts in both replay and the next turn's context. After a crash, a run becomes interrupted once its lease expires (at most 30 seconds); recovery finalizes the run and releases its matching lease atomically, and also repairs orphan running records from older versions. It does not restart tools automatically. A later turn keeps its durable partial history. PGlite must still be opened by only one process; use Postgres for a separate task worker or multiple API processes.

Thread metadata lives in owner-scoped `records` with `kind=threads`. Ordered event logs, input messages/state and applied snapshots live in `kind=thread-runs`. `LocalThreads.ensure(owner, id)` provisions a conversation; `history(owner, id)` returns durable events/messages/state for server integrations. Names are edited in the app; automatic naming remains disabled. Legacy `/api/conversation` history is retained but is not automatically imported into the rich thread database.

To use legacy CopilotKit Intelligence instead, set the optional server-only key and restart:

```dotenv
CPK_INTELLIGENCE_API_KEY=your-project-key
```

Never put the key in an `EXPO_PUBLIC_`, `NEXT_PUBLIC_` or `VITE_` variable. A nonblank key selects the original Intelligence runner with verified OpenMuse owner identity. Its cloud calls are deliberate only in this optional mode. Local and cloud history are separate; switching does not migrate conversations. CopilotKit telemetry is disabled in both modes. Intelligence is a separate hosted service; see [runtime setup](https://docs.copilotkit.ai/intelligence/connect-your-runtime).

## Agent computer

The Computer control below the avatar opens a persistent workspace with browser sessions and files. Browser cards show actual worker screenshots; **Open browser** opens the existing interactive console for takeover. PDFs open in the native/web readers. Tasks can read public pages, monitor changes and collect PDFs using the same worker.

Opening a session renews its short-lived console access. **Refresh connection** renews access without navigating; **Reopen** keeps the saved profile and uses the address in the input. The console reports live/disconnected state, preserves unsent text after an error, and pauses preview polling when hidden. Closing a session retains its profile and downloads.

Run the browser worker using the `BROWSER_WORKER_URL` and `WORKER_TOKEN` setup in the [README](../README.md). Browser profiles persist on disk. The optional [Linux computer](COMPUTER.md) adds real command execution, saved output, editable files, and PDF transfer. CopilotKit's built-in conversation and task-worker tools use this same computer; remote AG-UI backends must supply their own equivalent tools. Interactive reservations still require user takeover; autonomous booking, checkout, graphical desktops and per-user VM isolation are not implemented. The OpenBot adapter remains an extension point for other computer backends.

## Validation scope

Local tests run through the real runtime, persist/reopen PGlite, and reconstruct rich messages/state/custom panels. They cover network-free operation, session/owner enforcement, pagination, rename/archive/restore, main-thread protection, competing claims, cross-instance stop and crash recovery. The optional Intelligence tests still mock its boundary. Live Postgres across hosts, physical-device acceptance and optional Intelligence WebSocket replay remain unverified.
