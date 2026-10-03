import {
  type CredentialAdapter,
  credentialAdapterSchema,
  type ValidCredentialAdapter,
} from "./contracts.ts";

/** Server-only browser instruction. Its values originate only in the vault. */
export type TrustedCredentialInput = {
  adapterId: string;
  origin: string;
  allowedRedirectOrigins: string[];
  fields: { selector: string; value: string }[];
  sensitiveSelectors: string[];
  submitSelector: string;
  authenticatedSelector?: string;
  invalidCredentialsSelector?: string;
  challengeSelectors: {
    kind: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown";
    selector: string;
  }[];
  challenge?: {
    id: string;
    kind: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown";
    submitSelector?: string;
  };
};
export type NativeCredentialPlan = Omit<TrustedCredentialInput, "fields"> & {
  credentialRefId: string;
  taskId: string;
  revision: number;
};

export function trustedCredentialInput(
  adapterValue: CredentialAdapter | ValidCredentialAdapter,
  values: Record<string, string>,
): TrustedCredentialInput {
  // Re-parse even when the caller is already typed; adapter data is trusted
  // configuration, but it crosses a privileged browser boundary.
  const adapter: ValidCredentialAdapter = credentialAdapterSchema.parse(adapterValue);
  if (Object.keys(values).some((key) => !adapter.fields.some((field) => field.id === key)))
    throw new Error("Saved credential contains unsupported fields");
  const fields = adapter.fields.flatMap((field) => {
    const value = values[field.id];
    if (value === undefined && !field.required) return [];
    if (typeof value !== "string") throw new Error("Saved credential fields are incomplete");
    return { selector: adapter.selectors[field.id], value };
  });
  const challengeSelectors: TrustedCredentialInput["challengeSelectors"] = [];
  if (adapter.challengeSelectors.captcha)
    challengeSelectors.push({ kind: "captcha", selector: adapter.challengeSelectors.captcha });
  if (adapter.challengeSelectors.otp)
    challengeSelectors.push({ kind: "otp", selector: adapter.challengeSelectors.otp });
  if (adapter.challengeSelectors.passkey)
    challengeSelectors.push({ kind: "webauthn", selector: adapter.challengeSelectors.passkey });
  return {
    adapterId: adapter.id,
    origin: adapter.origin,
    allowedRedirectOrigins: [...new Set([adapter.origin, ...adapter.allowedRedirectOrigins])],
    fields,
    sensitiveSelectors: fields.map((field) => field.selector),
    submitSelector: adapter.submitSelector,
    ...(adapter.authenticatedSelector
      ? { authenticatedSelector: adapter.authenticatedSelector }
      : {}),
    ...(adapter.invalidCredentialsSelector
      ? { invalidCredentialsSelector: adapter.invalidCredentialsSelector }
      : {}),
    challengeSelectors,
  };
}

export function trustedCredentialPlan(
  adapterValue: CredentialAdapter | ValidCredentialAdapter,
  credentialRefId: string,
  taskId: string,
  revision: number,
): NativeCredentialPlan {
  const adapter: ValidCredentialAdapter = credentialAdapterSchema.parse(adapterValue);
  const input = trustedCredentialInput(
    adapter,
    Object.fromEntries(
      adapter.fields.filter((field) => field.required).map((field) => [field.id, ""]),
    ),
  );
  const { fields: _fields, ...fixed } = input;
  return { ...fixed, credentialRefId, taskId, revision };
}

export function trustedCredentialChallengeInput(
  adapterValue: CredentialAdapter | ValidCredentialAdapter,
  challenge: { id: string; kind: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown" },
  value: string,
): TrustedCredentialInput {
  const adapter: ValidCredentialAdapter = credentialAdapterSchema.parse(adapterValue);
  const kind = challenge.kind === "totp" ? "otp" : challenge.kind;
  const selector =
    kind === "otp"
      ? adapter.challengeSelectors.otp
      : kind === "captcha"
        ? adapter.challengeSelectors.captcha
        : kind === "webauthn"
          ? adapter.challengeSelectors.passkey
          : undefined;
  if (!selector || !adapter.challengeSubmitSelector || !value.trim() || value.length > 4096)
    throw new Error("This adapter does not support the requested human challenge");
  const regular = trustedCredentialInput(adapter, {});
  return {
    ...regular,
    fields: [{ selector, value }],
    sensitiveSelectors: [...new Set([...regular.sensitiveSelectors, selector])],
    submitSelector: adapter.challengeSubmitSelector,
    challenge: {
      id: challenge.id,
      kind,
      submitSelector: adapter.challengeSubmitSelector,
    },
  };
}

export function trustedCredentialChallengePlan(
  adapterValue: CredentialAdapter | ValidCredentialAdapter,
  credentialRefId: string,
  taskId: string,
  revision: number,
  challenge: { id: string; kind: "totp" | "otp" | "push" | "captcha" | "webauthn" | "unknown" },
): NativeCredentialPlan {
  const adapter: ValidCredentialAdapter = credentialAdapterSchema.parse(adapterValue);
  const kind = challenge.kind === "totp" ? "otp" : challenge.kind;
  const selector =
    kind === "otp"
      ? adapter.challengeSelectors.otp
      : kind === "captcha"
        ? adapter.challengeSelectors.captcha
        : kind === "webauthn"
          ? adapter.challengeSelectors.passkey
          : undefined;
  if (!selector || !adapter.challengeSubmitSelector)
    throw new Error("This adapter does not support the requested human challenge");
  const { fields: _fields, ...base } = trustedCredentialInput(adapter, {});
  return {
    ...base,
    sensitiveSelectors: [...new Set([...base.sensitiveSelectors, selector])],
    submitSelector: adapter.challengeSubmitSelector,
    challenge: { id: challenge.id, kind, submitSelector: adapter.challengeSubmitSelector },
    credentialRefId,
    taskId,
    revision,
  };
}

export function matchesTrustedCredentialPlan(
  plan: NativeCredentialPlan,
  expected: NativeCredentialPlan,
) {
  return stable(plan) === stable(expected);
}

export function sameTrustedCredentialInput(
  left: TrustedCredentialInput,
  right: TrustedCredentialInput,
) {
  return stable(left) === stable(right);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
