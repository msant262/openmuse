import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  type Credential,
  type CredentialStorage,
  CredentialStorageUnavailableError,
  normalizeServerOrigin,
} from "./auth-manager";

const options = {
  keychainService: "openmuse.device-session",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};
async function accessible<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch {
    throw new CredentialStorageUnavailableError();
  }
}
export function createCredentialStorage(serverOrigin: string): CredentialStorage {
  const key = Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    normalizeServerOrigin(serverOrigin),
  ).then((digest) => `openmuse.device-session.v1.${digest}`);
  return {
    read: () =>
      accessible(async () => {
        const value = await SecureStore.getItemAsync(await key, options);
        return value === null ? null : (JSON.parse(value) as Credential);
      }),
    write: (value) =>
      accessible(async () => {
        const encoded = JSON.stringify(value);
        if (encoded.length > 1800) throw new Error("Credential exceeds native storage limit");
        await SecureStore.setItemAsync(await key, encoded, options);
      }),
    remove: () => accessible(async () => SecureStore.deleteItemAsync(await key, options)),
  };
}
