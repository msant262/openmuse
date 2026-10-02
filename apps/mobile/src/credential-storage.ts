import type { CredentialStorage } from "./auth-manager";

/** Web refresh stays in the server cookie. This adapter persists no credentials. */
export const createCredentialStorage = (_serverOrigin: string): CredentialStorage => ({
  read: async () => null,
  write: async () => {
    throw new Error("Web credentials belong to the HttpOnly cookie");
  },
  remove: async () => {},
});
