import { describe, expect, it, vi } from "vitest";
import {
  AGEND_NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS,
  applyNetworkReliabilityDefaults,
} from "../src/network-family.js";

describe("network family reliability defaults", () => {
  it("keeps Happy Eyeballs enabled and only extends its attempt timeout", () => {
    let attemptTimeout = 250;
    const api = {
      getDefaultAutoSelectFamily: vi.fn(() => true),
      getDefaultAutoSelectFamilyAttemptTimeout: vi.fn(() => attemptTimeout),
      setDefaultAutoSelectFamilyAttemptTimeout: vi.fn((value: number) => { attemptTimeout = value; }),
    };

    const state = applyNetworkReliabilityDefaults(api);

    expect(api.setDefaultAutoSelectFamilyAttemptTimeout)
      .toHaveBeenCalledWith(AGEND_NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS);
    expect(state).toEqual({ autoSelectFamily: true, attemptTimeoutMs: 2_500 });
    expect(api.getDefaultAutoSelectFamily).toHaveBeenCalledOnce();
    expect(api).not.toHaveProperty("setDefaultAutoSelectFamily");
  });

  it("honors an explicit runtime override that disabled family autoselection", () => {
    let attemptTimeout = 250;
    const api = {
      getDefaultAutoSelectFamily: vi.fn(() => false),
      getDefaultAutoSelectFamilyAttemptTimeout: vi.fn(() => attemptTimeout),
      setDefaultAutoSelectFamilyAttemptTimeout: vi.fn((value: number) => { attemptTimeout = value; }),
    };

    expect(applyNetworkReliabilityDefaults(api)).toEqual({
      autoSelectFamily: false,
      attemptTimeoutMs: 2_500,
    });
  });

  it("does not shorten a longer connection-attempt timeout override", () => {
    let attemptTimeout = 5_000;
    const api = {
      getDefaultAutoSelectFamily: vi.fn(() => true),
      getDefaultAutoSelectFamilyAttemptTimeout: vi.fn(() => attemptTimeout),
      setDefaultAutoSelectFamilyAttemptTimeout: vi.fn((value: number) => { attemptTimeout = value; }),
    };

    expect(applyNetworkReliabilityDefaults(api)).toEqual({
      autoSelectFamily: true,
      attemptTimeoutMs: 5_000,
    });
    expect(api.setDefaultAutoSelectFamilyAttemptTimeout).toHaveBeenCalledWith(5_000);
  });
});
