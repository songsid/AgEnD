import type { KiroCliCompatibility } from "../../src/backend/kiro.js";
/** Verified-format fixture; constructor-only unit tests must not probe an installed CLI. */
export const TEST_KIRO_COMPAT: KiroCliCompatibility = {
  version: "kiro-cli 2.27.1", supportsLegacyUi: true, supportsTui: true,
  supportsV3: true, agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, source: "version",
};
