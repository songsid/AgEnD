/**
 * #3212 PR 1: Settings → Agents → **Accounts**, one card per CLI. Each card lists the CLI's default sign-in and its named
 * credential profiles — the ones agents use AND the ones only on disk (a profile added but not used yet) — with its
 * state, which account it is (a masked e-mail and a plan, #3190 N1–N5: Claude Code only, from the host's own
 * `claude auth status`), who uses it (agents, ClassicBot channels, the fleet default) and its limits (every pool and window it
 * reports) where the usage panel has them.
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
import { hostFacts, hostIds, hostIdsByRank, runtimeFacts, runtimeIds } from "./cli-registry.js";
import type { UsageWindowKind } from "./cli-capability.js";
import type { AccountIdentity } from "./claude-auth-status.js";
import { cliUpdateView, versionOf, type CliUpdateView } from "./cli-audited.js";
import type { SignInTarget } from "./web-backend-login.js";

/** The CLIs the Accounts view shows, in its order (cli-registry.ts: `host.accountCard`). */
export const ACCOUNT_CLIS = Object.freeze(hostIdsByRank("accountCard"));
/**
 * AGEND-133: every CLI the Accounts view can list: the account-card CLIs in their order, then the ones that only have an install (the registry's `host.install`
 * without an `accountCard`: OpenCode today).
 */
const ACCOUNT_CLI_SET: ReadonlySet<string> = new Set(ACCOUNT_CLIS);
const VIEW_CLIS: readonly string[] = Object.freeze([...ACCOUNT_CLIS, ...hostIds("install").filter(id => !ACCOUNT_CLI_SET.has(id))]);
/** The CLIs that can have named credential profiles (src/backend/credential-profile.ts; cli-registry.ts: `host.namedAccounts`). */
export const PROFILE_CLIS: ReadonlySet<string> = new Set(hostIds("namedAccounts"));
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `namedAccounts` (AGEND-124): on a computer's row of a CLI that has named accounts there besides Claude Code (Antigravity), whether that computer's Runtime takes a new one (an older one, or a CLI that is
 * missing or too old, does not): the "+ Add account" under that computer's name follows it. Absent on every other row, and on a Claude Code row (as before).
 */
export type AccountScope = { kind: "host" } | { kind: "machine"; id: string; name: string; online: boolean; readOnlyReason?: string; namedAccounts?: boolean };
/**
 * Why a computer's row cannot be changed from the dashboard. The first five are about the whole computer (every row carries one of them); the last two are about
 * one row. Codes, not sentences: the page words them in its own language, and shows the command to run on that computer.
 */
export const MACHINE_READ_ONLY_REASONS = Object.freeze(["offline", "runtime_old", "accounts_off", "switch_unreadable", "not_installed", "not_created", "default_login", "cli_old", "cli_missing"] as const);
export type MachineReadOnlyReason = typeof MACHINE_READ_ONLY_REASONS[number];
/**
 * The CLIs whose NAMED accounts a paired computer shows (and adds, signs out and removes): `runtime.accountRows` that also has `runtime.namedAccounts` (cli-registry.ts; Claude Code;
 * Codex waits for #3212 PR 4).
 */
export const MACHINE_ACCOUNT_CLIS: ReadonlySet<string> = new Set(runtimeIds("accountRows").filter(id => runtimeFacts(id, "namedAccounts") !== null));
/**
 * AGEND-113: the CLIs whose DEFAULT login on a paired computer is signed in from the dashboard (cli-registry.ts: `runtime.accountRows.defaultRow === "sign-in"`). Antigravity keeps its Windows
 * login in the Credential Manager under one fixed name, so there is one per Windows user and no named profiles (no + Add account, no Sign out, no Remove): the card has one row per
 * computer, and signing it in changes that computer's own login.
 */
export const MACHINE_DEFAULT_LOGIN_CLIS: ReadonlySet<string> = new Set(runtimeIds("accountRows").filter(id => runtimeFacts(id, "accountRows")!.defaultRow === "sign-in"));
/**
 * AGEND-113: the quota pool a group of windows belongs to, when a provider has several (Antigravity: "Gemini", "Claude & others", "Gemini 4 Argon", each with limits of its own). `labelI18n` is the usage
 * panel's own reference (its words are the panel's, in both languages); `label` is the fallback. Only the shape and bounds below are passed on: whatever else a vendor's text carries is dropped.
 */
export interface AccountUsagePool { label: string; labelI18n?: { key: string; args?: string[] } }
/**
 * One window of an account's usage as the usage panel reports it: its kind (cli-capability.ts `UsageWindowKind`: the 5h is `session`; `unwindowed` is one number with no window of its own), the
 * percent used and, when the CLI says so, the window's length and when it resets. `resetPassed`: it has reset since the numbers were read, so its percent is the old window's and is not shown as current.
 */
export interface AccountUsageWindow { kind: UsageWindowKind; percent: number; windowMs?: number; resetsAt?: string; resetPassed?: true }
/** The windows of one pool, in the usage panel's own order; a provider with one set of limits has one group and no `pool`. */
export interface AccountUsageGroup { pool?: AccountUsagePool; windows: AccountUsageWindow[] }
/**
 * Why the numbers are the last known ones (AGEND-119): the usage panel's own `staleCause` (an expiry, a transient failure, another error), when they were read, and what the read said
 * (`hint`, with its reference into the panel's words). Only those four are passed on; no token, path or output of a CLI is in it.
 */
export interface AccountUsageStale { cause: "expired" | "transient" | "error"; cachedAt: string; hint?: string; hintI18n?: { key: string; args?: string[] } }
/** Everything an account reports about its limits: every pool and every window, none picked over another. `stale`: the last known numbers, the live read failed (`staleInfo`: why, and when they were read). */
export interface AccountUsage { groups: AccountUsageGroup[]; stale?: true; staleInfo?: AccountUsageStale }
export interface AccountRow {
  scope: AccountScope;
  /** AGEND-124: the computer's OWN login row of a CLI whose Runtime signs it out (Antigravity): the Sign out button is offered on it (never on Claude Code's, #3212 Q3). Only on such a row. */
  signOutOwn?: true;
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
  /** AGEND-136: the version the binary probe read for an installed host CLI (a host default row only). */
  version?: string;
  /** AGEND-136: where that version stands against AgEnD's audited release (cli-audited.ts), and whether the dashboard can update it (`button`). `via`: "dashboard", or "self" for a CLI that updates itself. */
  cliUpdate?: CliUpdateInfo;
  usedBy: { agents: string[]; classic: string[]; fleetDefault: boolean };
  /**
   * Every pool and every window the account reports (see `accountUsage`), as the page draws them: it is the page's to lay out, not the server's to pick from. A page that predates this field
   * ignores it (it used to be two fixed windows, `usage` and `shortUsage`, which hid every pool but one).
   */
  usageGroups?: AccountUsageGroup[];
  /** The numbers are the last known ones (the live read failed). */
  usageStale?: true;
  /** AGEND-119: why they are, and when they were read (the usage panel's `staleCause`/`cachedAt`/`hint`); absent from an older server's row, whose page then says only that they are old. */
  usageStaleInfo?: AccountUsageStale;
  /** #3292: "Keep sign-in alive" (Claude Code and Codex host rows): the setting, its last run, the dates the sign-in's file says. */
  keepAlive?: AccountKeepAlive;
  /** M-2825: not signed in because the sign-in is over (its file says so): the badge says to reconnect. */
  reconnect?: true;
}
/** Dates are ISO strings; `lastOutcome` is signin-keepalive.ts's Outcome. No token, path or output is in it. */
export interface AccountKeepAlive { enabled: boolean; fallback?: boolean; expiresAt?: string; lastAt?: string; lastOutcome?: string; planType?: string }
export interface CliUpdateInfo extends CliUpdateView { via: "dashboard" | "self" }
export interface AccountsCli {
  /** `profiles`: this host can have named accounts of the CLI (+ Add account on the card); `machineProfiles` (AGEND-119): a paired computer can too (+ Add account under its name) — a CLI whose named accounts exist only on the host has `profiles` and not this. */
  backend: string; profiles: boolean; machineProfiles?: boolean; installed: boolean;
  /** AGEND-133: a CLI with no account card of its own (OpenCode) is listed only to be installed (or while its install is shown); it has no sign-in rows. */
  installOnly?: boolean;
  fleetDefault: string | null; agents: Array<{ name: string; profile: string | null }>;
  /** M-2909: the ClassicBot rooms on this CLI (their key in classicBot.yaml), each with its account — Move lists them. */
  rooms: Array<{ key: string; profile: string | null }>; rows: AccountRow[];
}
export interface AccountsView { clis: AccountsCli[] }

/** AGEND-113: a computer's own login of a CLI without profiles (see `MachineAccountsInput.defaultLogins`). */
export interface MachineDefaultLogin { loggedIn: boolean | null; readOnlyReason?: Exclude<MachineReadOnlyReason, "not_created" | "default_login">; agents: string[]; /** The Runtime also signs it out and manages named accounts of the CLI (its `accounts-<id>` capability, AGEND-124). */ accounts?: true }

/** One paired computer's accounts for the view, as its Runtime reported them (names, signed in or not, a masked identity) and what its owner allows. */
export interface MachineAccountsInput {
  id: string;
  name: string;
  online: boolean;
  /** A whole-computer reason (offline, an older Runtime, the owner's `accounts` switch off or unreadable, no Claude Code there): every row is read-only with it. */
  readOnlyReason?: Exclude<MachineReadOnlyReason, "not_created" | "default_login">;
  /** The profiles this computer reported. `created`: this Runtime made and recorded the folder; absent means a Runtime that does not report it. */
  profiles: ReadonlyArray<{ name: string; loggedIn: boolean | null; identity?: AccountIdentity; created?: boolean }>;
  /** AGEND-124: the named accounts of the CLIs other than Claude Code (Antigravity), by CLI id, the agents that run there on each CLI, and the reason (if any) that CLI's named accounts cannot be changed from the dashboard. */
  profilesByCli?: Readonly<Record<string, ReadonlyArray<{ name: string; loggedIn: boolean | null; identity?: AccountIdentity; created?: boolean }>>>;
  agentsByCli?: Readonly<Record<string, ReadonlyArray<{ name: string; profile: string | null }>>>;
  cliReasons?: Readonly<Record<string, Exclude<MachineReadOnlyReason, "not_created" | "default_login">>>;
  /** The pairing's default profile, when one is set; else agents without a profile use the Windows user's own sign-in. */
  defaultProfile?: string;
  /** The Windows user's own Claude Code sign-in on that computer (`claude auth status`), as the Runtime reported it with its CLIs. */
  defaultLogin?: { loggedIn: boolean | null; identity?: AccountIdentity };
  /**
   * AGEND-113: a computer's own login of a CLI that has no profiles (Antigravity), when the computer has that CLI (or an agent there uses it). `readOnlyReason`: why it cannot be signed in from the
   * dashboard (the whole-computer reasons, an older Runtime that cannot do it, or a CLI too old for `acp --login`); absent means it can. No identity: nothing is shown about which account it is.
   */
  defaultLogins?: Partial<Record<string, MachineDefaultLogin>>;
  /** Agents that run on this computer, and the profile each names (null: none, so the computer's default). */
  agents: ReadonlyArray<{ name: string; profile: string | null }>;
}

export interface AccountsInput {
  /** backendSignInTargets(): every backend's default, and each profile an agent uses. */
  targets: readonly SignInTarget[];
  /** Profiles on disk an agent may not use yet, per backend, with their sign-in state and how to sign them in. */
  diskProfiles: ReadonlyMap<string, ReadonlyArray<{ profile: string; state: SignInTarget["state"]; signIn: boolean; hostCommand?: string; identity?: AccountIdentity; reconnect?: true }>>;
  /** Every fleet agent: its backend and its effective profile (its own, else the fleet default's; null = the default sign-in). */
  agents: ReadonlyArray<{ name: string; backend: string; profile: string | null }>;
  /** ClassicBot channels, as their key, backend and effective profile. */
  classic: ReadonlyArray<{ key: string; backend: string; profile: string | null }>;
  /** The fleet default's profile per backend (defaults.backend_options.<backend>.credential_profile). */
  fleetDefaults: ReadonlyMap<string, string>;
  /** Each row's usage, by `backend\0profile` ("" for the default). */
  usage?: ReadonlyMap<string, AccountUsage>;
  /** #3190 Part 3c: paired computers' accounts, as rows under their own scope. Absent: no computer. */
  machines?: readonly MachineAccountsInput[];
  /**
   * #3292: the keep-alive part per HOST row, by the same `backend\0profile` key. Never applied to a computer's rows: the key is the same for a host profile and a
   * computer's profile of that name (and for `claude-code\0` of the host's default and a computer's), so the one would show the other's setting.
   */
  keepAlive?: ReadonlyMap<string, AccountKeepAlive>;
  /** AGEND-133: the CLI whose dashboard install the page is showing (running, or ended within its keep time): its card stays even once it is installed, so the result stays beside it. */
  installShown?: string | null;
  /** AGEND-136: what the binary probe printed for each installed host CLI's `--version`, by backend (the availability snapshot's own reading). */
  versions?: ReadonlyMap<string, string | null>;
}

const key = (backend: string, profile: string | null) => `${backend}\0${profile ?? ""}`;
const sorted = (xs: Iterable<string>) => [...xs].sort((a, b) => a.localeCompare(b));

const stateOf = (loggedIn: boolean | null): SignInTarget["state"] => loggedIn === true ? "usable" : loggedIn === false ? "not_signed_in" : "unknown";
/**
 * The rows of one computer for a CLI that has named accounts there: for Claude Code its default (the Windows user's own sign-in, never changed from here) and each reported profile; for
 * another CLI (Antigravity, AGEND-124) each reported profile only, because its own login is the separate row `machineDefaultRow` makes. Pure.
 */
function machineRows(backend: string, m: MachineAccountsInput): AccountRow[] {
  const claude = backend === "claude-code";
  const profiles = claude ? m.profiles : m.profilesByCli?.[backend] ?? [];
  const agents = claude ? m.agents : m.agentsByCli?.[backend] ?? [];
  // Claude Code's rows carry the computer's own reason (it includes "no Claude Code there"); another CLI's carry theirs (`cliReasons`: the whole-computer reasons and that CLI's own), never Claude Code's absence.
  const whole = claude ? m.readOnlyReason : undefined, cliReason = claude ? undefined : m.cliReasons?.[backend];
  const scope = (readOnlyReason?: MachineReadOnlyReason): AccountScope => ({ kind: "machine", id: m.id, name: m.name, online: m.online, ...(readOnlyReason ? { readOnlyReason } : {}), ...(claude ? {} : { namedAccounts: !cliReason }) });
  const same = (a: string | null | undefined, b: string | null) => (a ?? null) !== null && (b ?? null) !== null && a!.toLowerCase() === b!.toLowerCase();
  const usedBy = (profile: string | null, fallback: boolean) => ({
    agents: sorted(agents.filter(a => profile === null ? a.profile === null : same(a.profile, profile)).map(a => a.name)), classic: [] as string[], fleetDefault: fallback,
  });
  const hasDefault = claude && !!m.defaultProfile && profiles.some(p => same(p.name, m.defaultProfile!));
  const rows: AccountRow[] = claude ? [{
    // Q3 (#3212): the Windows user's own sign-in is read-only here: no Sign in, Switch or Sign out. Add account and Move agents are the way.
    scope: scope(whole ?? "default_login"), backend, profile: null, state: stateOf(m.defaultLogin?.loggedIn ?? null), signIn: false,
    ...(m.defaultLogin?.loggedIn === true && m.defaultLogin.identity ? { identity: m.defaultLogin.identity } : {}),
    usedBy: usedBy(null, !hasDefault),
  }] : [];
  for (const p of [...profiles].sort((a, b) => a.name.localeCompare(b.name))) {
    // Only a profile this Runtime created may be signed in, out or removed from here; an older Runtime that does not say is treated as "not known to be ours".
    const reason: MachineReadOnlyReason | undefined = whole ?? cliReason ?? (p.created === true ? undefined : "not_created");
    rows.push({
      scope: scope(reason), backend, profile: p.name, state: stateOf(p.loggedIn), signIn: !reason,
      ...(p.loggedIn === true && p.identity ? { identity: p.identity } : {}),
      // What to run on that computer when the dashboard cannot do it: the person at that computer signs the profile in themselves. (Only Claude Code has a command for that: an Antigravity account is signed in from here.)
      ...(reason && claude ? { hostCommand: `agend-runtime login ${backend} ${p.name}` } : {}),
      usedBy: usedBy(p.name, hasDefault && same(m.defaultProfile, p.name)),
    });
  }
  return rows;
}

/** AGEND-113: a computer's own login of a CLI that has one: a row, signed in from the dashboard where the computer allows it (and, AGEND-124, signed out where its Runtime can). Pure. */
function machineDefaultRow(backend: string, m: MachineAccountsInput): AccountRow | null {
  const d = m.defaultLogins?.[backend];
  if (!d) return null;
  const namedAccounts = backend !== "claude-code" && MACHINE_ACCOUNT_CLIS.has(backend);
  return {
    scope: { kind: "machine", id: m.id, name: m.name, online: m.online, ...(d.readOnlyReason ? { readOnlyReason: d.readOnlyReason } : {}), ...(namedAccounts ? { namedAccounts: !d.readOnlyReason && d.accounts === true } : {}) },
    backend, profile: null, state: stateOf(d.loggedIn), signIn: !d.readOnlyReason,
    ...(d.accounts === true && !d.readOnlyReason ? { signOutOwn: true as const } : {}),
    usedBy: { agents: sorted(d.agents), classic: [], fleetDefault: false },
  };
}

/** Build the view. Pure. */
export function buildAccountsView(input: AccountsInput): AccountsView {
  const clis: AccountsCli[] = [];
  for (const backend of VIEW_CLIS) {
    const installOnly = !ACCOUNT_CLI_SET.has(backend);
    const def = input.targets.find(t => t.backend === backend && !t.profile);
    const agents = input.agents.filter(a => a.backend === backend);
    const classic = input.classic.filter(c => c.backend === backend);
    const fleetDefault = PROFILE_CLIS.has(backend) ? input.fleetDefaults.get(backend) ?? null : null;
    // AGEND-133 (#3521): a CLI that is not installed is listed with its Install button — the dashboard's way in for a host that has no chat. One with no account
    // card (OpenCode) is listed for that alone: only while it is not installed, or while its install is shown.
    const installed = !!def && def.state !== "not_installed";
    const installable = !!def && def.state === "not_installed" && !!def.install;
    // Each computer's rows for this CLI, together: the computer's own login (a CLI that has one) first, then its named accounts. A computer with none of them is left out.
    const machineBlocks = installOnly ? [] : (input.machines ?? []).map(m => {
      const own = MACHINE_DEFAULT_LOGIN_CLIS.has(backend) ? machineDefaultRow(backend, m) : null;
      return [...(own ? [own] : []), ...(MACHINE_ACCOUNT_CLIS.has(backend) ? machineRows(backend, m) : [])];
    }).filter(block => block.length > 0);
    // AGEND-136: what the installed CLI's version is, and where it stands against the audited release (and whether an Update is offered).
    const printed = installed ? input.versions?.get(backend) ?? null : null;
    const updateFacts = hostFacts(backend, "update"), canUpdate = updateFacts !== null;
    const updateView = installed ? cliUpdateView(backend, printed, canUpdate, updateFacts?.release === "latest-unaudited") : null;
    const cliUpdate: CliUpdateInfo | null = updateView ? { ...updateView, via: canUpdate ? "dashboard" : "self" } : null;
    const hostRelevant = installOnly ? installable || (installed && !!cliUpdate) || (input.installShown === backend && !!def) : installed || installable || agents.length > 0 || classic.length > 0 || input.installShown === backend;
    if (!hostRelevant && !machineBlocks.length) continue;
    const rows: AccountRow[] = [];
    const usedBy = (profile: string | null) => ({
      agents: sorted(agents.filter(a => a.profile === profile).map(a => a.name)),
      classic: sorted(classic.filter(c => c.profile === profile).map(c => c.key)),
      fleetDefault: fleetDefault === profile || (profile === null && fleetDefault === null),
    });
    const usageOf = (profile: string | null) => { const u = input.usage?.get(key(backend, profile)); return u ? { usageGroups: u.groups, ...(u.stale ? { usageStale: true as const } : {}), ...(u.stale && u.staleInfo ? { usageStaleInfo: u.staleInfo } : {}) } : {}; };
    const keepAlive = (profile: string | null) => { const k = input.keepAlive?.get(key(backend, profile)); return k ? { keepAlive: k } : {}; };
    // A card that is only here for a paired computer (nothing on the host uses this CLI) shows no host rows.
    if (hostRelevant) rows.push({
      scope: { kind: "host" }, backend, profile: null, state: def?.state ?? "unknown", signIn: !!def?.signIn,
      ...(def?.identity ? { identity: def.identity } : {}), ...(def?.hostCommand ? { hostCommand: def.hostCommand } : {}),
      ...(def?.install ? { install: def.install } : {}), ...(def?.update ? { update: def.update } : {}), ...(def?.reconnect ? { reconnect: true as const } : {}),
      ...(installed && versionOf(printed) ? { version: versionOf(printed)! } : {}), ...(cliUpdate ? { cliUpdate } : {}),
      usedBy: usedBy(null), ...usageOf(null), ...keepAlive(null),
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
          ...(src?.identity ? { identity: src.identity } : {}), ...(src?.hostCommand ? { hostCommand: src.hostCommand } : {}), ...(src?.reconnect ? { reconnect: true as const } : {}),
          usedBy: usedBy(profile), ...usageOf(profile), ...keepAlive(profile),
        });
      }
    }
    // A paired computer's rows come after the host's, each computer's together (the page groups them by scope).
    for (const block of machineBlocks) rows.push(...block);
    clis.push({ backend, profiles: PROFILE_CLIS.has(backend), machineProfiles: MACHINE_ACCOUNT_CLIS.has(backend), installed, ...(installOnly ? { installOnly: true } : {}), fleetDefault, agents: agents.map(a => ({ name: a.name, profile: a.profile })), rooms: classic.map(c => ({ key: c.key, profile: c.profile })), rows });
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

const TWO_DAYS = 2 * 86_400_000, TEN_DAYS = 10 * 86_400_000;
/** The pool of a metric, in the bounded form a page may be sent: a short label, and the panel's own word reference (`usage.metric.*`, up to three short string arguments). Else none. */
function poolOf(metric: Record<string, unknown>): AccountUsagePool | undefined {
  const pool = metric.pool;
  if (!pool || typeof pool !== "object" || Array.isArray(pool)) return undefined;
  const { label, labelI18n } = pool as { label?: unknown; labelI18n?: unknown };
  if (typeof label !== "string" || !label.trim() || label.length > 64) return undefined;
  const ref = labelI18n && typeof labelI18n === "object" && !Array.isArray(labelI18n) ? labelI18n as { key?: unknown; args?: unknown } : null;
  const args = ref && Array.isArray(ref.args) ? ref.args : [];
  const ok = ref && typeof ref.key === "string" && /^usage\.metric\.[a-z_]{1,48}$/.test(ref.key) && args.length <= 3 && args.every(a => typeof a === "string" && a.length <= 64);
  return { label: label.trim(), ...(ok ? { labelI18n: { key: ref!.key as string, ...(args.length ? { args: args as string[] } : {}) } } : {}) };
}
/** A usage metric's window kind (cli-capability.ts `UsageWindowKind`): by its length when the CLI gives one, else by the period the CLI names; a number with neither is `unwindowed`. */
export function usageWindowKind(m: Record<string, unknown>): UsageWindowKind {
  const ms = m.windowMs;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms < TWO_DAYS ? "session" : ms <= TEN_DAYS ? "weekly" : "monthly";
  const period = m.quotaPeriod;
  return period === "monthly" ? "monthly" : period === "weekly" ? "weekly" : period === "hourly" || period === "session" || period === "daily" ? "session" : "unwindowed";
}
/** A window whose reset time is already behind `now` — a reset, unlike an expiry (`resetKind: "expiry"`); an unreadable time is not one. */
const resetElapsed = (m: Record<string, unknown>, now: number): boolean => typeof m.resetsAt === "string" && m.resetKind !== "expiry" && Date.parse(m.resetsAt) <= now;

/**
 * An account's limits for its row: EVERY pool and EVERY window a usage payload (ProviderUsage) reports for it, in the order the usage panel's full card draws them (the payload's own order),
 * grouped by pool. Nothing is picked: a row that showed one window per kind hid Gemini's week behind Claude's and the other way round, and a pool is counted on its own.
 *  - The windows are the percent metrics with a number, never a per-model quota (`scope: "model"`) and never a count or an amount (the full card has those lines; a row draws meters).
 *  - A pool is named only for a CLI whose spec says it has several (cli-registry.ts `host.usage.pools`); for any other the payload's pool tags are ignored, so a vendor adding one to another
 *    CLI's payload changes nothing until its spec says so. A window that has no pool in such a payload sits in a group of its own with no name.
 *  - A window that has reset since the read (marked `resetPassed`, or its reset time is behind `now`: a snapshot is served unchanged inside its TTL) is kept, flagged, with no number to trust: the pool
 *    and the window are still there.
 *  - `kind` is `usageWindowKind`: what cli-capability.ts calls the kinds of window, which `host.usage.windows` lists for the CLI. tests/cli-registry-usage-shape.test.ts holds real payloads to it.
 * The percent is rounded and kept within 0–100. Undefined when the payload has no such window.
 */
export function accountUsage(backend: string, provider: { metrics?: ReadonlyArray<Record<string, unknown>>; stale?: boolean; staleCause?: unknown; cachedAt?: unknown; hint?: unknown; hintI18n?: unknown } | undefined, now: number = Date.now()): AccountUsage | undefined {
  if (!provider || !Array.isArray(provider.metrics)) return undefined;
  const several = hostFacts(backend, "usage")?.pools === "several";
  const groups = new Map<string, AccountUsageGroup>();
  for (const m of provider.metrics) {
    if (!m || m.scope === "model" || m.type !== "percent" || typeof m.used !== "number" || !Number.isFinite(m.used)) continue;
    const pool = several ? poolOf(m) : undefined;
    const name = pool?.label ?? "";
    let group = groups.get(name);
    if (!group) { group = { ...(pool ? { pool } : {}), windows: [] }; groups.set(name, group); }
    const resetsAt = typeof m.resetsAt === "string" ? m.resetsAt : undefined;
    group.windows.push({
      kind: usageWindowKind(m), percent: Math.max(0, Math.min(100, Math.round(m.used))),
      ...(typeof m.windowMs === "number" && Number.isFinite(m.windowMs) && m.windowMs > 0 ? { windowMs: m.windowMs } : {}),
      ...(resetsAt ? { resetsAt } : {}), ...(m.resetPassed === true || resetElapsed(m, now) ? { resetPassed: true as const } : {}),
    });
  }
  const staleInfo = provider.stale ? staleInfoOf(provider) : undefined;
  return groups.size ? { groups: [...groups.values()], ...(provider.stale ? { stale: true as const } : {}), ...(staleInfo ? { staleInfo } : {}) } : undefined;
}

/** The part of a stale usage row a page may show: its cause (one of the three words), when it was read (an ISO time) and what the read said (bounded text, and a reference into the panel's own words). */
function staleInfoOf(p: { staleCause?: unknown; cachedAt?: unknown; hint?: unknown; hintI18n?: unknown }): AccountUsageStale | undefined {
  const cause = p.staleCause;
  if (cause !== "expired" && cause !== "transient" && cause !== "error") return undefined;
  if (typeof p.cachedAt !== "string" || !Number.isFinite(Date.parse(p.cachedAt))) return undefined;
  const ref = p.hintI18n as { key?: unknown; args?: unknown } | null | undefined;
  const args = ref && Array.isArray(ref.args) ? ref.args : [];
  const refOk = !!ref && typeof ref.key === "string" && /^usage\.(?:hint|error)\.[a-z0-9_]{1,48}$/.test(ref.key) && args.length <= 3 && args.every(a => typeof a === "string" && a.length <= 64);
  return {
    cause, cachedAt: new Date(p.cachedAt).toISOString(),
    ...(typeof p.hint === "string" && p.hint.trim() ? { hint: p.hint.trim().slice(0, 240) } : {}),
    ...(refOk ? { hintI18n: { key: ref!.key as string, ...(args.length ? { args: args as string[] } : {}) } } : {}),
  };
}
