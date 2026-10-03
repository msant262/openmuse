export type ConnectionCategory = { id: string; name: string };
export type ConnectionToolkit = {
  slug: string;
  name: string;
  description: string;
  logo?: string;
  categories: ConnectionCategory[];
  authSchemes: string[];
  noAuth: boolean;
  deprecated: boolean;
  authGuideUrl?: string;
  appUrl?: string;
};
export type ComposioAccount = {
  id: string;
  toolkit: string;
  serviceName: string;
  status: string;
  alias?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type ConnectionCatalog = {
  configured: boolean;
  items: ConnectionToolkit[];
  categories: ConnectionCategory[];
  nextCursor: string | null;
  totalItems: number;
};

export function catalogPath(search: string, category: string, cursor?: string | null) {
  const query = new URLSearchParams({ limit: "24" });
  if (search.trim()) query.set("search", search.trim());
  if (category) query.set("category", category);
  if (cursor) query.set("cursor", cursor);
  return `/api/composio/catalog?${query}`;
}

export function appendCatalogPage(previous: ConnectionToolkit[], next: ConnectionToolkit[]) {
  return [...new Map([...previous, ...next].map((item) => [item.slug, item])).values()];
}

export function connectionStatusLabel(status: string) {
  switch (status.toLowerCase()) {
    case "active":
    case "connected":
      return "Connected";
    case "initiated":
    case "waiting":
      return "Waiting for authorization";
    case "expired":
      return "Reconnect to continue";
    case "disconnect_failed":
      return "Disconnect failed. Try again.";
    case "inactive":
    case "disabled":
      return "Disconnected";
    default:
      return "Needs connection";
  }
}

/** Only server-issued HTTPS Connect Links are opened from connection prompts. */
export function safeConnectionAuthorizationUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["connect.composio.dev", "app.composio.dev"].includes(url.hostname) ||
      !url.pathname.startsWith("/link/")
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function connectionRequestStatus(status: string) {
  return ["saved", "connected", "cancelled", "superseded"].includes(status);
}
