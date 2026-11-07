/**
 * #3190 Part 3c: Settings → Accounts for a paired computer. What the server knows and asks about a computer's accounts, in one place:
 *
 *  - `list()`: each approved computer as `MachineAccountsInput` (accounts-view.ts turns it into rows under the `machine` scope): its reported profiles, whether
 *    each is one its Runtime created, the pairing's default, the agents that run there, and the reason the whole computer is read-only when it is (offline, an older
 *    Runtime, its owner's `accounts` switch off, no Claude Code there). The switch is read from the computer (a short, cached call); the server cannot change it.
 *  - `add` / `remove` / `signOut`: the same operations and the same answers as the host's (`addAccountProfile`, `removeAccountProfile`, `signOutAccount`), for one
 *    computer, over `account.request` frames (`callAccount`: memory only, never the journal). The server sends a CLI id, a profile NAME and the asker's audit name;
 *    the Runtime decides everything else (ownership, default profile, tasks, terminals, the switch), and checks it again whatever the server says.
 *  - Sign-in is `MachineSignIns` (machine-signins.ts): #3212's `StructuredSignIn` over a `RuntimeSignInTransport`.
 *
 * Only the fleet's local admin session reaches this (web-api.ts checks it before the body is read and again after it). Nothing here keeps or logs a URL, a code,
 * the Runtime's output, a path or an e-mail address; an error from a computer is its own refusal sentence (bounded, no control characters) or one of ours.
 */
import { MACHINE_ACCOUNT_CLIS, type MachineAccountsInput, type MachineReadOnlyReason } from "./accounts-view.js";
import { inventoryProbed } from "./windows-cli.js";
import { validCredentialProfileName, type CredentialProfileStatus } from "./runtime-credential-profiles.js";
import type { RuntimeMachine } from "./runtime-protocol.js";
import type { AccountCaller } from "./runtime-signin-transport.js";
import type { MachineRefusal } from "./machine-signins.js";

/** Who asked, as the computer's audit log records them (`admin:<handle>`), and as the fleet log names them. */
export interface MachineActor { id: string; actor: string }
export interface MachineUsers { agents: string[]; classic: string[]; fleetDefault: boolean }
export type MachineAccountResult =
  | { ok: true }
  | { ok: false; error: string; /** A computer's own refusal sentence, or ours: bounded, no path, URL, code, output or e-mail. */ message?: string; clash?: string; users?: MachineUsers };

export interface MachineAccountsDeps {
  call: AccountCaller;
  machine(id: string): RuntimeMachine | undefined;
  machines(): readonly RuntimeMachine[];
  /** Agents that run on this computer and the profile each names (null: none). */
  agents(machineId: string): ReadonlyArray<{ name: string; profile: string | null }>;
  /** A dashboard sign-in for this computer and profile is running or not shown gone. */
  signingIn(machineId: string, profile: string): boolean;
  /** The fleet log. Names and ids only. */
  log(entry: { machine: string; machineName: string; profile: string; by: string; action: "added" | "add_checked" | "removed" | "signed_out"; outcome: "ok" | "refused"; reason?: string }): void;
  now?(): number;
}
const SWITCH_TTL_MS = 5_000;
const SWITCH_WAIT_MS = 3_000;
const OPERATION_WAIT_MS = 120_000;
const same = (a: string | null | undefined, b: string | null | undefined) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** What `accounts.switches` must answer: only these fields and types; anything else is "could not read". */
function accountsSwitchOn(value: unknown): boolean | null {
  const accounts = record(value) ? value.accounts : undefined;
  return record(accounts) && typeof accounts.on === "boolean" ? accounts.on : null;
}

/**
 * What a successful sign-out or remove changed, kept only until that computer's next inventory arrives. A Runtime sends its new inventory before it answers (so this is normally
 * not needed), but a Runtime that does not, or an inventory that is late, must not leave the Accounts view showing a profile that was just removed or one that was just signed out.
 * The marker is the computer's `inventoryUpdatedAt` when the operation finished: any later inventory moves it, and the inventory is then the truth again.
 */
interface PendingChange { at: number | undefined; removed: Set<string>; signedOut: Set<string> }

export class MachineAccounts {
  private readonly changes = new Map<string, PendingChange>();
  private readonly switchCache = new Map<string, { at: number; on: boolean | null }>();
  private readonly switchReads = new Map<string, Promise<boolean | null>>();
  constructor(private readonly deps: MachineAccountsDeps) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Whether the computer's `accounts` switch is on, read from the computer (null: could not read). Cached briefly for the view; a write asks again (`fresh`). */
  private switchOn(machine: string, fresh: boolean): Promise<boolean | null> {
    const cached = this.switchCache.get(machine);
    if (!fresh && cached && this.now() - cached.at < SWITCH_TTL_MS) return Promise.resolve(cached.on);
    const running = this.switchReads.get(machine);
    if (running) return running;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = Promise.race([
      this.deps.call(machine, "accounts.switches", {}, 15_000).then(accountsSwitchOn, () => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SWITCH_WAIT_MS); timer.unref?.(); }),
    ]).then(on => { this.switchCache.set(machine, { at: this.now(), on }); return on; })
      .finally(() => { if (timer) clearTimeout(timer); this.switchReads.delete(machine); });
    this.switchReads.set(machine, read);
    return read;
  }
  /** The profiles a computer reported, with what this server has just changed on it applied until its next inventory arrives. */
  private profilesOf(machine: RuntimeMachine): readonly CredentialProfileStatus[] {
    const base = machine.inventory?.credentialProfiles?.profiles ?? [];
    const change = this.changes.get(machine.id);
    if (!change) return base;
    if (machine.inventoryUpdatedAt !== change.at) { this.changes.delete(machine.id); return base; }          // a newer inventory is the truth
    return base.filter(p => !change.removed.has(p.name.toLowerCase()))
      .map(p => (change.signedOut.has(p.name.toLowerCase()) ? { name: p.name, loggedIn: false, ...(p.created !== undefined ? { created: p.created } : {}) } : p));
  }
  private noteChange(machineId: string, profile: string, action: "removed" | "signed_out"): void {
    const at = this.deps.machine(machineId)?.inventoryUpdatedAt;
    let change = this.changes.get(machineId);
    if (!change || change.at !== at) this.changes.set(machineId, change = { at, removed: new Set(), signedOut: new Set() });
    const key = profile.toLowerCase();
    if (action === "removed") { change.removed.add(key); change.signedOut.delete(key); } else change.signedOut.add(key);
  }
  private static capable(machine: RuntimeMachine): boolean { return machine.runtimeInfo?.capabilities.includes("remote-signin") === true; }
  private static claude(machine: RuntimeMachine) { return machine.inventory?.clis.find(row => row.id === "claude-code"); }

  /** Each approved computer, for the Accounts view. Reads the switches of the online ones in parallel, each bounded. */
  async list(): Promise<MachineAccountsInput[]> {
    const shown = this.deps.machines().filter(machine => machine.status === "online" || machine.status === "offline");
    return Promise.all(shown.map(async (machine): Promise<MachineAccountsInput> => {
      const online = machine.status === "online";
      let readOnlyReason: MachineAccountsInput["readOnlyReason"];
      if (!online) readOnlyReason = "offline";
      else if (!MachineAccounts.capable(machine)) readOnlyReason = "runtime_old";
      else {
        const on = await this.switchOn(machine.id, false);
        readOnlyReason = on === null ? "switch_unreadable" : on ? undefined : "accounts_off";
      }
      const cli = MachineAccounts.claude(machine);
      if (!readOnlyReason && inventoryProbed(machine.inventory) && (!cli || cli.path === null)) readOnlyReason = "not_installed";
      const report = machine.inventory?.credentialProfiles;
      return { id: machine.id, name: machine.name, online, ...(readOnlyReason ? { readOnlyReason } : {}),
        profiles: this.profilesOf(machine).map(p => ({ name: p.name, loggedIn: p.loggedIn, ...(p.identity ? { identity: p.identity } : {}), ...(p.created !== undefined ? { created: p.created } : {}) })),
        ...(report?.default ? { defaultProfile: report.default } : {}),
        ...(cli ? { defaultLogin: { loggedIn: cli.authenticated, ...(cli.identity ? { identity: cli.identity } : {}) } } : {}),
        agents: this.deps.agents(machine.id) };
    }));
  }

  /**
   * Whether a request to this computer can be made now, and if not why: the computer is known and online, its Runtime reports `remote-signin`, and its owner turned
   * `accounts` on (asked of the computer itself, not cached). Null: it can.
   */
  async readiness(machineId: string): Promise<MachineRefusal | null> {
    const machine = this.deps.machine(machineId);
    if (!machine || (machine.status !== "online" && machine.status !== "offline")) return "machine_unknown";
    if (machine.status !== "online") return "machine_offline";
    if (!MachineAccounts.capable(machine)) return "machine_unsupported";
    const on = await this.switchOn(machineId, true);
    return on === null ? "machine_unreachable" : on ? null : "machine_accounts_off";
  }
  private refused(error: string, machine: RuntimeMachine | undefined, profile: string, by: string, action: "added" | "removed" | "signed_out", extra: Partial<Extract<MachineAccountResult, { ok: false }>> = {}): MachineAccountResult {
    if (machine) this.deps.log({ machine: machine.id, machineName: machine.name, profile, by, action, outcome: "refused", reason: error });
    return { ok: false, error, ...extra };
  }
  private users(machine: RuntimeMachine, profile: string): MachineUsers {
    const defaultProfile = machine.inventory?.credentialProfiles?.default;
    return { agents: this.deps.agents(machine.id).filter(a => same(a.profile, profile)).map(a => a.name).sort((a, b) => a.localeCompare(b)), classic: [], fleetDefault: same(defaultProfile, profile) };
  }
  private reported(machine: RuntimeMachine, profile: string): { name: string; created: boolean } | undefined {
    const row = this.profilesOf(machine).find(p => same(p.name, profile));
    return row ? { name: row.name, created: row.created === true } : undefined;
  }
  /** What a computer last reported about one profile (its inventory; the computer is not asked): has it, signed in or not, and did its Runtime create it. */
  profileState(machineId: string, profile: string): { exists: boolean; state: "valid" | "invalid" | "unknown"; created: boolean } {
    const machine = this.deps.machine(machineId);
    const row = machine ? this.profilesOf(machine).find(p => same(p.name, profile)) : undefined;
    return { exists: !!row, state: row?.loggedIn === true ? "valid" : row?.loggedIn === false ? "invalid" : "unknown", created: row?.created === true };
  }

  /**
   * + Add account on a computer. The Runtime creates the profile's folder, and records it, when its first sign-in starts; this checks what the dashboard can
   * check first (the CLI, the name, a name or a case variant already there, the computer and its switch) so the person is told before a dialog opens.
   */
  async add(backend: string, name: unknown, machineId: string, by: string): Promise<MachineAccountResult> {
    const machine = this.deps.machine(machineId);
    if (!MACHINE_ACCOUNT_CLIS.has(backend)) return { ok: false, error: "unsupported" };
    if (!validCredentialProfileName(name)) return { ok: false, error: "name" };
    const refusal = await this.readiness(machineId);
    if (refusal) return this.refused(refusal, machine, name, by, "added");
    const known = this.reported(machine!, name);
    if (known) return this.refused(known.name === name ? "exists" : "case_clash", machine, name, by, "added", known.name === name ? {} : { clash: known.name });
    // Only checked: the Runtime makes the folder when the first sign-in starts, so a dialog closed before that leaves nothing added, and the log must not say it was.
    this.deps.log({ machine: machineId, machineName: machine!.name, profile: name, by, action: "add_checked", outcome: "ok" });
    return { ok: true };
  }

  /** Remove a profile on a computer: the typed name, nobody using it, no sign-in for it; then the Runtime's own checks and its own deletion. */
  async remove(backend: string, name: unknown, confirm: unknown, machineId: string, who: MachineActor, by: string): Promise<MachineAccountResult> {
    const machine = this.deps.machine(machineId);
    if (!MACHINE_ACCOUNT_CLIS.has(backend)) return { ok: false, error: "unsupported" };
    if (!validCredentialProfileName(name)) return { ok: false, error: "name" };
    if (confirm !== name) return { ok: false, error: "confirm" };
    const refusal = await this.readiness(machineId);
    if (refusal) return this.refused(refusal, machine, name, by, "removed");
    const known = this.reported(machine!, name);
    if (!known) return this.refused("missing", machine, name, by, "removed");
    if (!known.created) return this.refused("machine_profile_not_owned", machine, name, by, "removed");
    // Who uses it: an agent on this computer (the server knows), and the computer's own default (also checked by the Runtime, which is the one that really knows).
    const users = this.users(machine!, name);
    if (users.agents.length || users.fleetDefault) return this.refused("in_use", machine, name, by, "removed", { users });
    if (this.deps.signingIn(machineId, name)) return this.refused("signing_in", machine, name, by, "removed");
    return this.operate("accounts.remove", machine!, name, who, by, "removed");
  }

  /** Sign a profile out on a computer: the Runtime runs the CLI's own logout under the profile and deletes the profile's backups. */
  async signOut(backend: string, profile: unknown, confirm: unknown, machineId: string, who: MachineActor, by: string): Promise<MachineAccountResult> {
    const machine = this.deps.machine(machineId);
    if (!MACHINE_ACCOUNT_CLIS.has(backend)) return { ok: false, error: "unsupported" };
    // The Windows user's own sign-in is never signed out from here (#3212 Q3): only a named profile.
    if (profile === null || !validCredentialProfileName(profile)) return { ok: false, error: profile === null ? "machine_default_login" : "name" };
    if (confirm !== true) return { ok: false, error: "confirm" };
    const refusal = await this.readiness(machineId);
    if (refusal) return this.refused(refusal, machine, profile, by, "signed_out");
    const known = this.reported(machine!, profile);
    if (!known) return this.refused("missing", machine, profile, by, "signed_out");
    if (!known.created) return this.refused("machine_profile_not_owned", machine, profile, by, "signed_out");
    if (this.deps.signingIn(machineId, profile)) return this.refused("signing_in", machine, profile, by, "signed_out");
    return this.operate("accounts.signout", machine!, profile, who, by, "signed_out");
  }
  private async operate(operation: "accounts.remove" | "accounts.signout", machine: RuntimeMachine, profile: string, who: MachineActor, by: string, action: "removed" | "signed_out"): Promise<MachineAccountResult> {
    try { await this.deps.call(machine.id, operation, { cli: "claude-code", profile, actor: who.actor }, OPERATION_WAIT_MS); }
    catch (error) {
      // The computer's own refusal sentence (or the coordinator's fixed one): bounded and free of control characters, with no path, URL, code or output in it.
      const message = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400) : "The operation failed on that computer";
      return this.refused("machine_refused", machine, profile, by, action, { message });
    }
    this.deps.log({ machine: machine.id, machineName: machine.name, profile, by, action, outcome: "ok" });
    this.switchCache.delete(machine.id);
    this.noteChange(machine.id, profile, action);
    return { ok: true };
  }
}

/** The agents of a fleet that run on a computer and the profile each names, from the fleet's own configuration. Pure. */
export function machineAgents(instances: Record<string, { runtime?: string; machine_id?: string; backend?: string }> | undefined, machineId: string, profileOf: (name: string) => string | null, defaultBackend = "claude-code"): Array<{ name: string; profile: string | null }> {
  return Object.keys(instances ?? {}).sort().filter(name => { const config = instances![name]!; return config.runtime === "windows" && config.machine_id === machineId && (config.backend ?? defaultBackend) === "claude-code"; })
    .map(name => ({ name, profile: profileOf(name) }));
}
