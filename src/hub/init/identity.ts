/**
 * Which Hub identity provider this build has. S1 (the Hub transport) owns key material: its provisionHubIdentity,
 * read helper and sealHubInitialization are wired here when it lands (hub-s48-init). Until then every entry point
 * (`agend hub init`, quickstart's team-Hub choice) sees `available: false` and asks nothing. Kept free of heavy imports:
 * quickstart loads it to decide whether to offer the Hub at all.
 */
import { HubInitError, type HubIdentityProvider } from "./types.js";

/** Until S1's provisioning lands: initialization refuses before writing anything. */
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

export function hubIdentityProvider(): HubIdentityProvider {
  return UNAVAILABLE_IDENTITY;
}
