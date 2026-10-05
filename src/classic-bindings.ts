/**
 * A ClassicBot channel's backend_options and the subscription they put it on (#1220).
 *
 * One contract for every reader — the launch, the fleet's binding, the reload
 * comparison, kiro_engine_status and the usage panel — so they cannot disagree
 * about which login a channel runs on:
 *  - effective options are the fleet defaults' merged per backend with the
 *    channel's own, exactly what startClassicInstance launches with;
 *  - the profile is read from those options strictly: unset, null or "" is the
 *    shared login (an explicit "" overrides an inherited profile), a valid name
 *    is that profile, and anything else is INVALID — never quietly the shared
 *    login or the default, so a typo cannot put an agent on the wrong account.
 *
 * Pure: the usage panel also runs in the CLI, where the fleet's
 * ClassicChannelManager (its migrations and saves) must not be constructed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { credentialHomeSpec, resolveCredentialProfile } from "./backend/credential-profile.js";
import { KNOWN_BACKENDS } from "./config-validator.js";

export type BackendOptions = Record<string, Record<string, unknown>>;

export type ClassicProfile =
  | { state: "shared" }
  | { state: "profile"; name: string }
  | { state: "invalid"; reason: string };

export interface BackendOptionsProblem {
  path: string;
  message: string;
}

/**
 * The shape classicBot.yaml's `backend_options` is kept in, and what is wrong
 * with it. A mapping that is not one is dropped; a credential_profile is kept
 * as written, however wrong, because resolution — not this — decides it is
 * invalid, and an invalid one must stop the launch rather than vanish.
 */
export function normalizeBackendOptions(raw: unknown): { options?: BackendOptions; problems: BackendOptionsProblem[] } {
  const problems: BackendOptionsProblem[] = [];
  if (raw === undefined || raw === null) return { problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push({ path: "", message: "backend_options must be a mapping keyed by backend name — ignored" });
    return { problems };
  }
  const options: BackendOptions = {};
  for (const [backendName, settings] of Object.entries(raw as Record<string, unknown>)) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      problems.push({ path: backendName, message: "backend options must be a mapping — ignored" });
      continue;
    }
    if (!KNOWN_BACKENDS.includes(backendName)) {
      problems.push({ path: backendName, message: "unknown backend namespace — option will be ignored" });
    }
    const copy = { ...(settings as Record<string, unknown>) };
    if (copy.credential_profile !== undefined && copy.credential_profile !== null && copy.credential_profile !== "") {
      const profile = strictProfile(copy.credential_profile);
      if (profile.state === "invalid") {
        problems.push({ path: `${backendName}.credential_profile`, message: `${profile.reason} — this channel's agent will not start until it is fixed` });
      } else if (KNOWN_BACKENDS.includes(backendName) && !credentialHomeSpec(backendName)) {
        problems.push({ path: `${backendName}.credential_profile`, message: `${backendName} has no credential home yet — the profile will be ignored` });
      }
    }
    options[backendName] = copy;
  }
  return Object.keys(options).length > 0 ? { options, problems } : { problems };
}

/** The fleet defaults' options with the channel's own laid over them, per backend — what the launch uses. */
export function mergeBackendOptions(base: BackendOptions | undefined, over: BackendOptions | undefined): BackendOptions | undefined {
  if (!over) return base;
  const merged: BackendOptions = { ...(base ?? {}) };
  for (const [backendName, options] of Object.entries(over)) {
    merged[backendName] = { ...(merged[backendName] ?? {}), ...options };
  }
  return merged;
}

function strictProfile(raw: unknown): ClassicProfile {
  if (raw === undefined || raw === null || raw === "") return { state: "shared" };
  if (typeof raw !== "string") return { state: "invalid", reason: "credential_profile must be a string" };
  try {
    const name = resolveCredentialProfile({ credential_profile: raw });
    return name ? { state: "profile", name } : { state: "shared" };
  } catch (err) {
    return { state: "invalid", reason: (err as Error).message };
  }
}

/**
 * The login a backend runs on with these (already effective) options. A
 * backend with no credential home ignores a profile at launch, so it is the
 * shared login here too.
 */
export function profileOf(options: BackendOptions | undefined, backend: string): ClassicProfile {
  if (!credentialHomeSpec(backend)) return { state: "shared" };
  return strictProfile(options?.[backend]?.credential_profile);
}

/** A classic channel's login: its own options over the fleet defaults', read strictly. */
export function classicProfile(
  channelOptions: BackendOptions | undefined,
  defaultOptions: BackendOptions | undefined,
  backend: string,
): ClassicProfile {
  return profileOf(mergeBackendOptions(defaultOptions, channelOptions), backend);
}

/** Comparable form: two configurations put an agent on the same login exactly when these are equal. */
export function profileKey(profile: ClassicProfile): string {
  return profile.state === "shared" ? "shared"
    : profile.state === "profile" ? `profile:${profile.name}`
    : `invalid:${profile.reason}`;
}

/** The profile name, or null for the shared login or an invalid setting (which cannot run). */
export function profileName(profile: ClassicProfile): string | null {
  return profile.state === "profile" ? profile.name : null;
}

export interface ClassicBinding {
  /** The channel's key in classicBot.yaml: unique, and stable while it exists. */
  key: string;
  /** The channel's own backend, else the Classic default; undefined means the fleet default. */
  backend?: string;
  /** Normalized exactly as ClassicChannelManager keeps it. */
  backend_options?: BackendOptions;
}

/** Every channel in classicBot.yaml, read-only. Never throws: unreadable is "no classic channels". */
export function readClassicBindings(dataDir: string): ClassicBinding[] {
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(join(dataDir, "classicBot.yaml"), "utf8"));
  } catch {
    return [];
  }
  const doc = raw as { defaults?: { backend?: unknown }; channels?: Record<string, unknown> } | null;
  const defaultBackend = typeof doc?.defaults?.backend === "string" && doc.defaults.backend ? doc.defaults.backend : undefined;
  const out: ClassicBinding[] = [];
  for (const [key, value] of Object.entries(doc?.channels ?? {})) {
    if (!value || typeof value !== "object") continue;
    const channel = value as { backend?: unknown; backend_options?: unknown };
    const backend = typeof channel.backend === "string" && channel.backend ? channel.backend : defaultBackend;
    const { options } = normalizeBackendOptions(channel.backend_options);
    out.push({ key, ...(backend ? { backend } : {}), ...(options ? { backend_options: options } : {}) });
  }
  return out;
}
