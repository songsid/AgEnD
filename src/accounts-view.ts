/**
 * #3212 PR 1: Settings → Agents → **Accounts**, one card per CLI. Each card lists the CLI's default sign-in and its named
 * credential profiles — the ones agents use AND the ones only on disk (a profile added but not used yet) — with its
 * state, which account it is (a masked e-mail and a plan, #3190 N1–N5: Claude Code only, from the host's own
 * `claude auth status`), who uses it (agents, ClassicBot channels, the fleet default) and its weekly usage where the
 * usage panel has it.
 *
 * Every row carries a `scope`. PR 1 fills in only `{ kind: "host" }`; a paired computer's rows (#3190 Part 3c) are
 * `{ kind: "machine", … }` and are added as rows, never by reshaping these. An older page ignores a scope it does not know.
 *
 * Read-only and admin-only (web-api.ts serves it to the fleet's local admin session). No credential, path or full
 * e-mail is in it: names, states, the masked identity and a host command for what the dashboard cannot sign in.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AccountIdentity } from "./claude-auth-status.js";
import type { SignInTarget } from "./web-backend-login.js";

/** The CLIs the Accounts view shows, in its order. */
export const ACCOUNT_CLIS = Object.freeze(["claude-code", "codex", "kiro-cli", "antigravity", "grok", "muse"] as const);
/** The CLIs that can have named credential profiles (src/backend/credential-profile.ts). */
export const PROFILE_CLIS: ReadonlySet<string> = new Set(["claude-code", "codex", "kiro-cli"]);
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type AccountScope = { kind: "host" } | { kind: "machine"; id: string; name: string; online: boolean; readOnlyReason?: string };
export interface AccountUsage { percent: number; resetsAt?: string; windowMs?: number; stale?: boolean }
export interface AccountRow {
  scope: AccountScope;
  backend: string;
  /** null: the CLI's default sign-in. */
  profile: string | null;
  state: SignInTarget["state"];
  identity?: AccountIdentity;
  /** The dashboard can sign it in; else `hostCommand` (run on the machine) when there is one. */
  signIn: boolean;
  hostCommand?: string;
  install?: string;
  update?: string;
  usedBy: { agents: string[]; classic: string[]; fleetDefault: boolean };
  usage?: AccountUsage;
}
export interface AccountsCli { backend: string; profiles: boolean; installed: boolean; fleetDefault: string | null; agents: Array<{ name: string; profile: string | null }>; rows: AccountRow[] }
export interface AccountsView { clis: AccountsCli[] }

export interface AccountsInput {
  /** backendSignInTargets(): every backend's default, and each profile an agent uses. */
  targets: readonly SignInTarget[];
  /** Profiles on disk an agent may not use yet, per backend, with their sign-in state and how to sign them in. */
  diskProfiles: ReadonlyMap<string, ReadonlyArray<{ profile: string; state: SignInTarget["state"]; signIn: boolean; hostCommand?: string; identity?: AccountIdentity }>>;
  /** Every fleet agent: its backend and its effective profile (its own, else the fleet default's; null = the default sign-in). */
  agents: ReadonlyArray<{ name: string; backend: string; profile: string | null }>;
  /** ClassicBot channels, as their key, backend and effective profile. */
  classic: ReadonlyArray<{ key: string; backend: string; profile: string | null }>;
  /** The fleet default's profile per backend (defaults.backend_options.<backend>.credential_profile). */
  fleetDefaults: ReadonlyMap<string, string>;
  /** Weekly (or longer) usage per row, by `backend\0profile` ("" for the default). */
  usage?: ReadonlyMap<string, AccountUsage>;
}

const key = (backend: string, profile: string | null) => `${backend}\0${profile ?? ""}`;
const sorted = (xs: Iterable<string>) => [...xs].sort((a, b) => a.localeCompare(b));

/** Build the view. Pure. */
export function buildAccountsView(input: AccountsInput): AccountsView {
  const clis: AccountsCli[] = [];
  for (const backend of ACCOUNT_CLIS) {
    const def = input.targets.find(t => t.backend === backend && !t.profile);
    const agents = input.agents.filter(a => a.backend === backend);
    const classic = input.classic.filter(c => c.backend === backend);
    const fleetDefault = PROFILE_CLIS.has(backend) ? input.fleetDefaults.get(backend) ?? null : null;
    // A CLI nobody uses and that is not installed is left out (its install lives in the backend list, not here).
    const installed = !!def && def.state !== "not_installed";
    if (!installed && !agents.length && !classic.length) continue;
    const rows: AccountRow[] = [];
    const usedBy = (profile: string | null) => ({
      agents: sorted(agents.filter(a => a.profile === profile).map(a => a.name)),
      classic: sorted(classic.filter(c => c.profile === profile).map(c => c.key)),
      fleetDefault: fleetDefault === profile || (profile === null && fleetDefault === null),
    });
    const usage = (profile: string | null) => input.usage?.get(key(backend, profile));
    rows.push({
      scope: { kind: "host" }, backend, profile: null, state: def?.state ?? "unknown", signIn: !!def?.signIn,
      ...(def?.identity ? { identity: def.identity } : {}), ...(def?.hostCommand ? { hostCommand: def.hostCommand } : {}),
      ...(def?.install ? { install: def.install } : {}), ...(def?.update ? { update: def.update } : {}),
      usedBy: usedBy(null), ...(usage(null) ? { usage: usage(null) } : {}),
    });
    if (PROFILE_CLIS.has(backend)) {
      const names = new Set<string>();
      for (const t of input.targets) if (t.backend === backend && t.profile) names.add(t.profile);
      for (const d of input.diskProfiles.get(backend) ?? []) names.add(d.profile);
      for (const a of agents) if (a.profile) names.add(a.profile);
      for (const c of classic) if (c.profile) names.add(c.profile);
      if (fleetDefault) names.add(fleetDefault);
      for (const profile of sorted(names)) {
        const t = input.targets.find(x => x.backend === backend && x.profile === profile);
        const d = (input.diskProfiles.get(backend) ?? []).find(x => x.profile === profile);
        const src = t ?? d;
        rows.push({
          scope: { kind: "host" }, backend, profile, state: src?.state ?? "not_signed_in", signIn: !!src?.signIn,
          ...(src?.identity ? { identity: src.identity } : {}), ...(src?.hostCommand ? { hostCommand: src.hostCommand } : {}),
          usedBy: usedBy(profile), ...(usage(profile) ? { usage: usage(profile) } : {}),
        });
      }
    }
    clis.push({ backend, profiles: PROFILE_CLIS.has(backend), installed, fleetDefault, agents: agents.map(a => ({ name: a.name, profile: a.profile })), rows });
  }
  return { clis };
}

/**
 * The named profiles in `<AGEND_HOME>/credential-profiles/<backend>/`: real directories (never a symlink) with a valid
 * profile name. Anything else there is ignored. Never throws.
 */
export function profilesOnDisk(dataDir: string, backend: string): string[] {
  if (!PROFILE_CLIS.has(backend)) return [];
  const root = join(dataDir, "credential-profiles", backend);
  try {
    const rootSt = lstatSync(root);
    if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) return [];
    return sorted(readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink() && PROFILE_NAME.test(e.name)).map(e => e.name));
  } catch { return []; }
}

/**
 * The usage row's weekly metric: the percent metric whose window is closest to a week (at least two days). From a
 * usage payload's providers (ProviderUsage), by the provider id the usage panel gives a backend (and `:<profile>`).
 */
export function weeklyUsage(provider: { metrics?: ReadonlyArray<Record<string, unknown>>; stale?: boolean } | undefined): AccountUsage | undefined {
  if (!provider || !Array.isArray(provider.metrics)) return undefined;
  const WEEK = 7 * 86_400_000;
  let best: Record<string, unknown> | undefined;
  for (const m of provider.metrics) {
    if (m.scope === "model" || m.type !== "percent" || typeof m.used !== "number" || typeof m.windowMs !== "number" || m.windowMs < 2 * 86_400_000) continue;
    if (!best || Math.abs((m.windowMs as number) - WEEK) < Math.abs((best.windowMs as number) - WEEK)) best = m;
  }
  if (!best) return undefined;
  const resetsAt = typeof best.resetsAt === "string" ? best.resetsAt : undefined;
  return { percent: Math.max(0, Math.min(100, Math.round(best.used as number))), windowMs: best.windowMs as number, ...(resetsAt ? { resetsAt } : {}), ...(provider.stale ? { stale: true } : {}) };
}
