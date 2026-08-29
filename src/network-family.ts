import net from "node:net";

/**
 * Node's 250ms Happy Eyeballs attempt window is too short for some WSL, VPN,
 * cellular, and heavily-loaded hosts. Keep dual-stack family autoselection,
 * but give each non-final TCP attempt enough time to establish.
 */
export const AGEND_NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS = 2_500;

interface NetworkFamilyApi {
  getDefaultAutoSelectFamily(): boolean;
  getDefaultAutoSelectFamilyAttemptTimeout(): number;
  setDefaultAutoSelectFamilyAttemptTimeout(value: number): void;
}

export interface NetworkFamilyState {
  autoSelectFamily: boolean;
  attemptTimeoutMs: number;
}

export function getNetworkFamilyState(api: NetworkFamilyApi = net): NetworkFamilyState {
  return {
    autoSelectFamily: api.getDefaultAutoSelectFamily(),
    attemptTimeoutMs: api.getDefaultAutoSelectFamilyAttemptTimeout(),
  };
}

export function applyNetworkReliabilityDefaults(api: NetworkFamilyApi = net): NetworkFamilyState {
  // Deliberately do not call setDefaultAutoSelectFamily(): honor Node's native
  // Happy Eyeballs default and any explicit NODE_OPTIONS override.
  api.setDefaultAutoSelectFamilyAttemptTimeout(AGEND_NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS);
  return getNetworkFamilyState(api);
}
