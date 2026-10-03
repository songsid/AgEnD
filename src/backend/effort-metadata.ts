import { codexMetadataHomes, readCodexEffortLevels } from "./codex-metadata.js";

/** Capability data shared with backend getters; resolving it never launches a CLI. */
export const EFFORT_CAPABILITIES = {
  "claude-code": { strategy: "runtime", levels: ["low", "medium", "high", "xhigh", "max"] },
  "kiro-cli": { strategy: "restart", levels: ["low", "medium", "high", "xhigh", "max"] },
  grok: { strategy: "runtime", levels: ["low", "medium", "high"] },
  antigravity: { strategy: "runtime", levels: ["low", "medium", "high"] },
  muse: { strategy: "runtime", levels: ["low", "medium", "high", "xhigh", "max"] },
  codex: { strategy: "restart" },
} as const;

export interface EffortMetadata {
  strategy: "runtime" | "restart" | "unsupported";
  levels: string[];
}

/** Pure status/menu lookup: only existing Codex config/cache files may be read. */
export function readEffortMetadata(backend: string, instanceDir: string): EffortMetadata {
  if (backend === "codex") {
    return { strategy: EFFORT_CAPABILITIES.codex.strategy, levels: readCodexEffortLevels(codexMetadataHomes(instanceDir)) };
  }
  if (!Object.hasOwn(EFFORT_CAPABILITIES, backend)) return { strategy: "unsupported", levels: [] };
  const capability = EFFORT_CAPABILITIES[backend as Exclude<keyof typeof EFFORT_CAPABILITIES, "codex">];
  return { strategy: capability.strategy, levels: [...capability.levels] };
}
