/** The quickstart can inspect availability without loading key, filesystem or network modules. */
import { HubInitError, type HubIdentityProvider } from "./types.js";

/** Explicit unsupported-build/platform provider; initialization refuses before writing anything. */
export const UNAVAILABLE_IDENTITY: HubIdentityProvider = {
  available: false,
  provision: async () => {
    throw new HubInitError("Hub key generation is not available in this build yet");
  },
  read: async () => undefined,
  seal: () => {
    throw new HubInitError("Hub key generation is not available in this build yet");
  },
};

const S1_IDENTITY: HubIdentityProvider = {
  available: true,
  provision: async input => (await import("../tls.js")).provisionHubIdentity(input),
  read: async home => (await import("../tls.js")).readHubIdentityIfPresent(home),
  seal: async input => (await import("../initialization.js")).sealHubInitialization(input),
};
export function hubIdentityProvider(): HubIdentityProvider {
  // Native Windows needs a verified private-file ACL adapter. WSL uses its POSIX owner/mode boundary.
  return process.platform === "win32" ? UNAVAILABLE_IDENTITY : S1_IDENTITY;
}
