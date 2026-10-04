export type ToolCallRecord = {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  failureIdentityHash?: string;
  outcomeKind?: "argument-validation" | "tool-loop-veto" | "terminal-exec-failure";
  noProgress?: boolean;
};
