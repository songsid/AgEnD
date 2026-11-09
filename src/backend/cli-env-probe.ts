import { createBackend } from "./factory.js";
import type { CliBackendConfig, CliEnv, ModelOption } from "./types.js";

export type BackendProbeInput = {
  backend: string;
  instanceDir: string;
  config: CliBackendConfig;
} & ({ mode: "models" } | { mode: "env"; refreshVendorCatalog: boolean });

export type BackendProbeResult = Omit<CliEnv, "backend" | "probedAt"> | ModelOption[];

/** Called inside the existing isolate only; no construction on the fleet loop. */
export async function runBackendProbe(input: BackendProbeInput): Promise<BackendProbeResult | null> {
  // These backends have no scoped discovery contract. Refuse rather than probing another account/provider.
  if (input.mode === "env" && input.refreshVendorCatalog && ((input.config.backendOptions?.provider && input.backend !== "codex")
      || (input.config.credentialStoreHome && input.backend !== "claude-code" && input.backend !== "codex"))) return null;
  const backend = createBackend(input.backend, input.instanceDir);
  if (input.mode === "models") return await backend.listModels?.(input.config) ?? [];
  if (!backend.probeCLIEnv) return null;
  if (input.refreshVendorCatalog && backend.refreshModelCatalog) await backend.refreshModelCatalog(input.config);
  return backend.probeCLIEnv(input.refreshVendorCatalog ? { ...input.config, catalogDiscovery: true } : input.config);
}
