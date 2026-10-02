import type { Config } from "./config.ts";

export type ApprovalPolicy = "money" | "all";
/** Samples intentionally retain their scripted review experience. */
export function approvalPolicy(config: Pick<Config, "mode" | "approvalPolicy">): ApprovalPolicy {
  return config.mode === "sample" ? "all" : (config.approvalPolicy ?? "money");
}
/** Only trusted adapters call this; classification is never a model parameter. */
export function requiresApproval(policy: ApprovalPolicy, money: boolean): boolean {
  return money || policy === "all";
}
