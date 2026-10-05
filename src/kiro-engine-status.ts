/**
 * kiro_engine_status: what each kiro instance runs on, and whether the
 * installed kiro-cli can still run it — the facts the kiro engine move works
 * from (#1109, kiro V1 → V3 migration). Read-only, and it runs nothing: it
 * reads the engine ledger, the V3 identity store, and the kiro-cli
 * compatibility AgEnD last probed for a launch (never probing itself — this
 * is a tool call on the fleet's event loop).
 */
import type { FleetConfig } from "./types.js";
import { lastKiroCompatibilitySnapshot, planKiroLaunch, type KiroCompatibilitySnapshot } from "./backend/kiro.js";
import { instanceCredentialProfile } from "./backend/credential-profile.js";
import { classicProfile, profileName } from "./classic-bindings.js";
import { readKiroLedger, type KiroLaunchRecord } from "./backend/kiro-engine-ledger.js";
import { readKiroV3Identity, type KiroV3Identity } from "./backend/kiro-v3-identity.js";
import { getAgendHome } from "./paths.js";
import { join } from "node:path";

type KiroUi = "legacy" | "tui" | "v3";
type BackendOptions = Record<string, Record<string, unknown>>;

/** A kiro instance as it is launched: fleet.yaml instances and ClassicBot channels alike. */
export interface KiroEngineCandidate {
  name: string;
  kiroUi: KiroUi;
  credentialProfile: string | null;
  classic: boolean;
}

interface ClassicRegistry {
  getAll(): { instanceName: string; backend?: string; backendOptions?: BackendOptions }[];
  getBackendByInstance?(name: string, fleetDefault?: string): string;
}

/**
 * Every instance whose effective backend is kiro-cli, with the UI and
 * credential profile its launch resolves to. A ClassicBot instance is launched
 * from the fleet defaults plus its channel's backend (startClassicInstance), so
 * that is what it is read with here.
 */
export function kiroEngineCandidates(fleet: FleetConfig | null | undefined, classic?: ClassicRegistry | null): KiroEngineCandidate[] {
  const defaults = fleet?.defaults as { backend?: string; kiro_ui?: KiroUi; backend_options?: BackendOptions } | undefined;
  const out: KiroEngineCandidate[] = [];
  for (const [name, raw] of Object.entries(fleet?.instances ?? {})) {
    const config = raw as { backend?: string; kiro_ui?: KiroUi; backend_options?: BackendOptions };
    if ((config.backend ?? defaults?.backend ?? "claude-code") !== "kiro-cli") continue;
    out.push({ name, kiroUi: config.kiro_ui ?? defaults?.kiro_ui ?? "legacy", credentialProfile: instanceCredentialProfile(config, defaults, "kiro-cli"), classic: false });
  }
  const fleetNames = new Set(Object.keys(fleet?.instances ?? {}));
  for (const channel of classic?.getAll() ?? []) {
    if (fleetNames.has(channel.instanceName) || out.some(c => c.name === channel.instanceName)) continue;
    const backend = channel.backend || classic?.getBackendByInstance?.(channel.instanceName, defaults?.backend) || defaults?.backend || "claude-code";
    if (backend !== "kiro-cli") continue;
    // A channel's own backend_options (#1220) come first, as startClassicInstance merges them.
    out.push({ name: channel.instanceName, kiroUi: defaults?.kiro_ui ?? "legacy", credentialProfile: profileName(classicProfile(channel.backendOptions, defaults?.backend_options, "kiro-cli")), classic: true });
  }
  return out;
}

export interface KiroEngineStatusInstance {
  name: string;
  classic: boolean;
  kiro_ui: KiroUi;
  credential_profile: string | null;
  /** What the kiro-cli last probed would launch it with, or why it refuses, or why that is not known. */
  next_launch: { flags: string[] } | { refused: string } | { unknown: string };
  /** The last launch AgEnD prepared, and when the instance was first seen; null before the first was recorded. */
  last_launch: KiroLaunchRecord | null;
  first_seen: string | null;
  /** Prepared launches, one per change of kiro-cli version, AgEnD version, UI or engine flags, oldest first. */
  history: KiroLaunchRecord[];
  v3: KiroV3Identity;
}

export interface KiroEngineStatus {
  /** The kiro-cli AgEnD last probed for a launch, and when; nulls before any kiro launch since the fleet started. */
  kiro_cli: { binary: string | null; version: string | null; probed_at: string | null };
  instances: KiroEngineStatusInstance[];
}

export interface KiroEngineStatusOptions {
  name?: string;
  agendHome?: string;
  /** Test seam: the compatibility snapshot (default: the one the last kiro launch published). */
  snapshot?: () => KiroCompatibilitySnapshot | null;
}

export function kiroEngineStatus(candidates: readonly KiroEngineCandidate[], opts: KiroEngineStatusOptions = {}): KiroEngineStatus {
  const agendHome = opts.agendHome ?? getAgendHome();
  const snapshot = (opts.snapshot ?? lastKiroCompatibilitySnapshot)();
  const compat = snapshot?.compatibility ?? null;
  const ledger = readKiroLedger(join(agendHome, "kiro-engine-ledger.json"));

  const instances = candidates.filter(c => !opts.name || c.name === opts.name).map((c): KiroEngineStatusInstance => {
    let nextLaunch: KiroEngineStatusInstance["next_launch"];
    if (!snapshot || !compat) {
      nextLaunch = { unknown: "no kiro instance has been launched since the fleet started, so kiro-cli has not been probed" };
    } else if (compat.source === "unknown") {
      nextLaunch = { unknown: `kiro-cli at ${snapshot.binaryPath} did not answer --version or chat --help (missing, or not responding) when last probed` };
    } else {
      const plan = planKiroLaunch(c.kiroUi, compat);
      nextLaunch = plan.kind === "refuse" ? { refused: plan.reason } : { flags: plan.flags };
    }
    const entry = ledger[c.name];
    return {
      name: c.name,
      classic: c.classic,
      kiro_ui: c.kiroUi,
      credential_profile: c.credentialProfile,
      next_launch: nextLaunch,
      last_launch: entry?.lastLaunch ?? null,
      first_seen: entry?.firstSeen ?? null,
      history: entry?.history ?? [],
      v3: readKiroV3Identity(c.name, agendHome),
    };
  });
  return {
    kiro_cli: { binary: snapshot?.binaryPath ?? null, version: compat?.version ?? null, probed_at: snapshot?.at ?? null },
    instances,
  };
}
