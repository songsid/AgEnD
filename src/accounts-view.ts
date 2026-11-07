/**
 * #3212 PR 1: Settings → Agents → **Accounts**, one card per CLI. Each card lists the CLI's default sign-in and its named
 * credential profiles — the ones agents use AND the ones only on disk (a profile added but not used yet) — with its
 * state, which account it is (a masked e-mail and a plan, #3190 N1–N5: Claude Code only, from the host's own
 * `claude auth status`), who uses it (agents, ClassicBot channels, the fleet default) and its weekly usage where the
 * usage panel has it.
 *
 * Every row carries a `scope`. PR 1 filled in only `{ kind: "host" }`; #3190 Part 3c adds a paired computer's rows as
 * `{ kind: "machine", … }` (Claude Code first), as rows, never by reshaping these. An older page ignores a scope it does not know.
 * A machine row's `scope.readOnlyReason` is a CODE (`MachineReadOnlyReason`), which the page turns into words and the command to run on that computer.
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
/**
 * Why a computer's row cannot be changed from the dashboard. The first five are about the whole computer (every row carries one of them); the last two are about
 * one row. Codes, not sentences: the page words them in its own language, and shows the command to run on that computer.
 */
export const MACHINE_READ_ONLY_REASONS = Object.freeze(["offline", "runtime_old", "accounts_off", "switch_unreadable", "not_installed", "not_created", "default_login"] as const);
export type MachineReadOnlyReason = typeof MACHINE_READ_ONLY_REASONS[number];
/** The CLIs a paired computer's accounts are shown for (Claude Code first; Codex waits for #3212 PR 4). */
export const MACHINE_ACCOUNT_CLIS: ReadonlySet<string> = new Set(["claude-code"]);
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
  /** The week's usage (the window closest to a week; see `weeklyUsage`). */
  usage?: AccountUsage;
  /** #3212: the short window's usage (the "5h" one; see `shortUsage`), beside the week's. Absent when the CLI reports none. */
  shortUsage?: AccountUsage;
  /** #3292: "Keep sign-in alive" (Claude Code and Codex host rows): the setting, its last run, the dates the sign-in's file says. */
  keepAlive?: AccountKeepAlive;
}
/** Dates are ISO strings; `lastOutcome` is signin-keepalive.ts's Outcome. No token, path or output is in it. */
export interface AccountKeepAlive { enabled: boolean; fallback?: boolean; endsAt?: string; expiresAt?: string; lastAt?: string; lastOutcome?: string; planType?: string }
export interface AccountsCli { backend: string; profiles: boolean; installed: boolean; fleetDefault: string | null; agents: Array<{ name: string; profile: string | null }>; rows: AccountRow[] }
export interface AccountsView { clis: AccountsCli[] }

/** One paired computer's accounts for the view, as its Runtime reported them (names, signed in or not, a masked identity) and what its owner allows. */
export interface MachineAccountsInput {
  id: string;
  name: string;
  online: boolean;
  /** A whole-computer reason (offline, an older Runtime, the owner's `accounts` switch off or unreadable, no Claude Code there): every row is read-only with it. */
  readOnlyReason?: Exclude<MachineReadOnlyReason, "not_created" | "default_login">;
  /** The profiles this computer reported. `created`: this Runtime made and recorded the folder; absent means a Runtime that does not report it. */
  profiles: ReadonlyArray<{ name: string; loggedIn: boolean | null; identity?: AccountIdentity; created?: boolean }>;
  /** The pairing's default profile, when one is set; else agents without a profile use the Windows user's own sign-in. */
  defaultProfile?: string;
  /** The Windows user's own Claude Code sign-in on that computer (`claude auth status`), as the Runtime reported it with its CLIs. */
  defaultLogin?: { loggedIn: boolean | null; identity?: AccountIdentity };
  /** Agents that run on this computer, and the profile each names (null: none, so the computer's default). */
  agents: ReadonlyArray<{ name: string; profile: string | null }>;
}

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
  /** #3212: the short window's usage per row, by the same `backend\0profile` key. */
  shortUsage?: ReadonlyMap<string, AccountUsage>;
  /** #3190 Part 3c: paired computers' accounts, as rows under their own scope. Absent: no computer. */
  machines?: readonly MachineAccountsInput[];
  /**
   * #3292: the keep-alive part per HOST row, by the same `backend\0profile` key. Never applied to a computer's rows: the key is the same for a host profile and a
   * computer's profile of that name (and for `claude-code\0` of the host's default and a computer's), so the one would show the other's setting.
   */
  keepAlive?: ReadonlyMap<string, AccountKeepAlive>;
}

const key = (backend: string, profile: string | null) => `${backend}\0${profile ?? ""}`;
const sorted = (xs: Iterable<string>) => [...xs].sort((a, b) => a.localeCompare(b));

const stateOf = (loggedIn: boolean | null): SignInTarget["state"] => loggedIn === true ? "usable" : loggedIn === false ? "not_signed_in" : "unknown";
/** The rows of one computer: its default (the Windows user's own sign-in, never changed from here) and each reported profile. Pure. */
function machineRows(backend: string, m: MachineAccountsInput): AccountRow[] {
  const scope = (readOnlyReason?: MachineReadOnlyReason): AccountScope => ({ kind: "machine", id: m.id, name: m.name, online: m.online, ...(readOnlyReason ? { readOnlyReason } : {}) });
  const same = (a: string | null | undefined, b: string | null) => (a ?? null) !== null && (b ?? null) !== null && a!.toLowerCase() === b!.toLowerCase();
  const usedBy = (profile: string | null, fallback: boolean) => ({
    agents: sorted(m.agents.filter(a => profile === null ? a.profile === null : same(a.profile, profile)).map(a => a.name)), classic: [] as string[], fleetDefault: fallback,
  });
  const hasDefault = !!m.defaultProfile && m.profiles.some(p => same(p.name, m.defaultProfile!));
  const rows: AccountRow[] = [{
    // Q3 (#3212): the Windows user's own sign-in is read-only here: no Sign in, Switch or Sign out. Add account and Move agents are the way.
    scope: scope(m.readOnlyReason ?? "default_login"), backend, profile: null, state: stateOf(m.defaultLogin?.loggedIn ?? null), signIn: false,
    ...(m.defaultLogin?.loggedIn === true && m.defaultLogin.identity ? { identity: m.defaultLogin.identity } : {}),
    usedBy: usedBy(null, !hasDefault),
  }];
  for (const p of [...m.profiles].sort((a, b) => a.name.localeCompare(b.name))) {
    // Only a profile this Runtime created may be signed in, out or removed from here; an older Runtime that does not say is treated as "not known to be ours".
    const reason: MachineReadOnlyReason | undefined = m.readOnlyReason ?? (p.created === true ? undefined : "not_created");
    rows.push({
      scope: scope(reason), backend, profile: p.name, state: stateOf(p.loggedIn), signIn: !reason,
      ...(p.loggedIn === true && p.identity ? { identity: p.identity } : {}),
      // What to run on that computer when the dashboard cannot do it: the person at that computer signs the profile in themselves.
      ...(reason ? { hostCommand: `agend-runtime login ${backend} ${p.name}` } : {}),
      usedBy: usedBy(p.name, hasDefault && same(m.defaultProfile, p.name)),
    });
  }
  return rows;
}

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
    const machines = MACHINE_ACCOUNT_CLIS.has(backend) ? input.machines ?? [] : [];
    const hostRelevant = installed || agents.length > 0 || classic.length > 0;
    if (!hostRelevant && !machines.length) continue;
    const rows: AccountRow[] = [];
    const usedBy = (profile: string | null) => ({
      agents: sorted(agents.filter(a => a.profile === profile).map(a => a.name)),
      classic: sorted(classic.filter(c => c.profile === profile).map(c => c.key)),
      fleetDefault: fleetDefault === profile || (profile === null && fleetDefault === null),
    });
    const usage = (profile: string | null) => input.usage?.get(key(backend, profile));
    const shortOf = (profile: string | null) => input.shortUsage?.get(key(backend, profile));
    const keepAlive = (profile: string | null) => { const k = input.keepAlive?.get(key(backend, profile)); return k ? { keepAlive: k } : {}; };
    // A card that is only here for a paired computer (nothing on the host uses this CLI) shows no host rows.
    if (hostRelevant) rows.push({
      scope: { kind: "host" }, backend, profile: null, state: def?.state ?? "unknown", signIn: !!def?.signIn,
      ...(def?.identity ? { identity: def.identity } : {}), ...(def?.hostCommand ? { hostCommand: def.hostCommand } : {}),
      ...(def?.install ? { install: def.install } : {}), ...(def?.update ? { update: def.update } : {}),
      usedBy: usedBy(null), ...(usage(null) ? { usage: usage(null) } : {}), ...(shortOf(null) ? { shortUsage: shortOf(null) } : {}), ...keepAlive(null),
    });
    if (hostRelevant && PROFILE_CLIS.has(backend)) {
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
          usedBy: usedBy(profile), ...(usage(profile) ? { usage: usage(profile) } : {}), ...(shortOf(profile) ? { shortUsage: shortOf(profile) } : {}), ...keepAlive(profile),
        });
      }
    }
    // A paired computer's rows come after the host's, each computer's together (the page groups them by scope).
    for (const m of machines) rows.push(...machineRows(backend, m));
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

const TWO_DAYS = 2 * 86_400_000;
const usageOf = (m: Record<string, unknown>, provider: { stale?: boolean }): AccountUsage => {
  const resetsAt = typeof m.resetsAt === "string" ? m.resetsAt : undefined;
  return { percent: Math.max(0, Math.min(100, Math.round(m.used as number))), windowMs: m.windowMs as number, ...(resetsAt ? { resetsAt } : {}), ...(provider.stale ? { stale: true } : {}) };
};

/** A window whose reset time is already behind `now` — a reset, unlike an expiry (`resetKind: "expiry"`); an unreadable time is not one. */
const resetElapsed = (m: Record<string, unknown>, now: number): boolean => typeof m.resetsAt === "string" && m.resetKind !== "expiry" && Date.parse(m.resetsAt) <= now;

/**
 * The usage row's weekly metric: the percent metric whose window is closest to a week (at least two days). From a
 * usage payload's providers (ProviderUsage), by the provider id the usage panel gives a backend (and `:<profile>`).
 */
export function weeklyUsage(provider: { metrics?: ReadonlyArray<Record<string, unknown>>; stale?: boolean } | undefined): AccountUsage | undefined {
  if (!provider || !Array.isArray(provider.metrics)) return undefined;
  const WEEK = 7 * 86_400_000;
  let best: Record<string, unknown> | undefined;
  for (const m of provider.metrics) {
    if (m.scope === "model" || m.type !== "percent" || typeof m.used !== "number" || typeof m.windowMs !== "number" || m.windowMs < TWO_DAYS) continue;
    if (!best || Math.abs((m.windowMs as number) - WEEK) < Math.abs((best.windowMs as number) - WEEK)) best = m;
  }
  return best ? usageOf(best, provider) : undefined;
}

/**
 * #3212: the usage row's short window ("5h"): the percent metric whose window is under two days — the shortest one when
 * there are several — as the usage panel's compact line picks it (`compactSlots`). Never a per-model quota, and never a
 * window that has reset since the read (its percent would be the old window's): one already marked `resetPassed`, and one whose
 * `resetsAt` is not ahead of `now`. The usage snapshot is served unchanged inside its TTL and while it is revalidated, so a
 * window read just before it reset must not be projected after it. An expiry (`resetKind: "expiry"`) is not a reset and a
 * time that cannot be read says nothing, as `ageMetric` (usage-api.ts) has it. Same shape as `weeklyUsage`.
 */
export function shortUsage(provider: { metrics?: ReadonlyArray<Record<string, unknown>>; stale?: boolean } | undefined, now: number = Date.now()): AccountUsage | undefined {
  if (!provider || !Array.isArray(provider.metrics)) return undefined;
  let best: Record<string, unknown> | undefined;
  for (const m of provider.metrics) {
    if (m.scope === "model" || m.type !== "percent" || typeof m.used !== "number" || m.resetPassed || resetElapsed(m, now)) continue;
    if (typeof m.windowMs !== "number" || !(m.windowMs > 0) || m.windowMs >= TWO_DAYS) continue;
    if (!best || (m.windowMs as number) < (best.windowMs as number)) best = m;
  }
  return best ? usageOf(best, provider) : undefined;
}
