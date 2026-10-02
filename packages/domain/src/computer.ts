export interface ComputerCommand {
  id: string;
  command: string;
  cwd: string;
  status:
    | "running"
    | "succeeded"
    | "failed"
    | "timed_out"
    | "interrupted"
    | "rejected_not_dispatched";
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string;
  completedAt?: string;
  background?: boolean;
  timeoutMs?: number;
  kind?: "command" | "transcribe" | "preview";
  result?: ComputerMediaResult;
}
export interface ComputerMediaResult {
  text?: string;
  language?: string;
  languageProbability?: number;
  duration?: number;
  textPath?: string;
  srtPath?: string;
  previewPath?: string;
  truncated?: boolean;
}
export interface ComputerSnapshot {
  enabled: boolean;
  provider: "docker" | "rpc";
  status: "unconfigured" | "stopped" | "running" | "error";
  workspacePath: "/workspace";
  network: "disabled" | "public-only";
  profile?: "offline" | "open";
  maxTimeoutMs?: number;
  message?: string;
  commands: ComputerCommand[];
}
export interface ComputerDirectory {
  path: string;
  entries: { name: string; path: string; type: "file" | "directory" | "symlink"; size: number }[];
}
