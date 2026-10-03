import type { CredentialGrantBroker, NativeCredentialSession } from "./grants.ts";
import type { NativeCredentialPlan } from "./trusted-input.ts";

type NativeCredentialDesktop = {
  configureCredentialInjector(
    injector: (
      owner: string,
      session: NativeCredentialSession,
      plan: NativeCredentialPlan,
      signal?: AbortSignal,
    ) => Promise<unknown>,
  ): void;
  trustedBrowserRequest(
    owner: string,
    session: NativeCredentialSession,
    operation: "credentials",
    body: { grantId: string; adapterId: string; origin: string; challengeId?: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
};

/** The native durable operation contains only grant metadata. Values cross to
 * the node only on its authenticated, claimed one-use consume request. */
export function configureNativeCredentialInjector(
  desktop: NativeCredentialDesktop,
  grants: CredentialGrantBroker,
) {
  desktop.configureCredentialInjector(async (owner, session, plan, signal) => {
    const grantId = await grants.issue(owner, session, plan);
    return desktop.trustedBrowserRequest(
      owner,
      session,
      "credentials",
      {
        grantId,
        adapterId: plan.adapterId,
        origin: plan.origin,
        ...(plan.challenge ? { challengeId: plan.challenge.id } : {}),
      },
      signal,
    );
  });
}
