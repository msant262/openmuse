type RunError = { error: unknown; context?: { agentId?: string } };
type SnapshotObserver = (params: { input: { threadId: string } }) => void;

/** CopilotKit emits run failures through onError even when runAgent resolves. */
export async function runConversationTurn(
  agentId: string,
  execute: () => Promise<unknown>,
  subscribe: (listener: (event: RunError) => void) => { unsubscribe: () => void },
) {
  let failure: Error | undefined;
  const subscription = subscribe((event) => {
    if (event.context?.agentId && event.context.agentId !== agentId) return;
    failure = event.error instanceof Error ? event.error : new Error(String(event.error));
  });
  try {
    await execute();
    if (failure) throw failure;
  } finally {
    subscription.unsubscribe();
  }
}

/** A live reconnect need not finish to confirm that its snapshot arrived. */
export async function connectConversationStream(
  agentId: string,
  agent: {
    threadId: string;
    subscribe(observer: {
      onMessagesSnapshotEvent?: SnapshotObserver;
      onStateSnapshotEvent?: SnapshotObserver;
    }): { unsubscribe: () => void };
  },
  execute: () => Promise<unknown>,
  subscribe: (listener: (event: RunError) => void) => { unsubscribe: () => void },
  restored: () => void,
) {
  const threadId = agent.threadId;
  let confirmed = false;
  const observe = ({ input }: { input: { threadId: string } }) => {
    if (confirmed || input.threadId !== threadId || agent.threadId !== threadId) return;
    confirmed = true;
    restored();
  };
  const snapshots = agent.subscribe({
    onMessagesSnapshotEvent: observe,
    onStateSnapshotEvent: observe,
  });
  try {
    await runConversationTurn(agentId, execute, subscribe);
  } finally {
    snapshots.unsubscribe();
  }
}
