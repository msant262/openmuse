/** Configured credentials only; this cannot recognize arbitrary encodings of secrets. */
export function configuredSecretScrubber(values: readonly string[]) {
  const secrets = [
    ...new Set(
      values
        .flatMap((value) => {
          const credential = /^(?:Bearer|Basic|Token|ApiKey)\s+([\s\S]+)$/i.exec(value)?.[1];
          return credential ? [value, credential] : [value];
        })
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text: string) => {
    for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
    return text;
  };
}
/** Scrub strings and keys before JSON escaping or truncation can split a secret. */
export function scrubConfiguredValue(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((part) => scrubConfiguredValue(part, scrub));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, part]) => [scrub(key), scrubConfiguredValue(part, scrub)]),
    );
  return value;
}
