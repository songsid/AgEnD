/**
 * #3190 Part 3a: the Runtime's side of "accounts on a computer", from the dashboard. One place decides, for every remote operation:
 *   1. is the matching switch on, on THIS computer (the server cannot change it);
 *   2. is the request in its closed form (names and ids; no argv, path or environment);
 *   3. does it stay inside what this Runtime created (profile ownership, Q4);
 *   4. is it recorded (`audit.jsonl`), before it runs and after.
 * Only our own refusal texts leave this module; any other failure is a generic sentence, so a path, a URL, a code, CLI output or an
 * e-mail address cannot travel in an error.
 *
 * Built-ins and shared Runtime modules only: part of the Runtime bundle.
 */
import {isNativeProviderId,nativeProvider} from "./windows-cli-providers.js";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CliInstallError } from "./runtime-cli-install.js";
import { parseAccountIdentity, type AccountIdentity } from "./claude-auth-status.js";
import { CredentialProfileRefusal, PROFILE_CLI_NAMES, credentialProfileCaseClash, credentialProfileDirectory, credentialProfileLaunch, credentialProfileStore, isCredentialProfileCli, rememberCredentialStatus, withCredentialProfile,
  type CredentialProfileCli } from "./runtime-credential-profiles.js";
import { ProfileOwnershipRefusal, createRuntimeProfile, deleteProfileBackups, removeOwnedProfile, requireOwnedProfile, withIsolatedOwnedProfile, type OwnedProfileOptions } from "./runtime-profile-ownership.js";
import { AuditLog, RemoteSetupRefusal, readRemoteSwitches, requireRemoteSwitch, validAuditActor, type AuditAction, type AuditEntry, type AuditReason, type RemoteSwitchName } from "./runtime-remote-setup.js";
import { ProcessNotConfirmedEnded, RuntimeSignIn, RuntimeSignInSlot, SignInRefusal, type SignInCli, type SignInDeps, type SignInMethod } from "./runtime-signin.js";
import { isRuntimeDefaultLoginCli, runtimeFacts, type RuntimeDefaultLoginCli } from "./cli-registry.js";
import { isRuntimeRemoteOperation, parseRuntimeRemotePayload, type RuntimeRemoteOperation, type RuntimeRemotePayloads, type RuntimeSwitchStates } from "./runtime-protocol.js";

/** What a CLI the server may name stands for here: the CLI's program, its sign-in, and its environment variable. */
export interface RemoteCliExecutable { path: string; command: string; args: string[] }
export interface RemoteStatusAnswer { loggedIn: boolean | null; identity?: AccountIdentity }
/**
 * What installs a CLI here. One object, so that an installer cannot be wired in without saying which CLI ids it has in its closed table: an id
 * outside it is refused BEFORE anything is recorded as started, and the installer is never asked about it.
 */
export interface RemoteInstaller {
  knows(cli: string): boolean;
  /** The CLI is already at the version this Runtime installs: a request for it would do nothing, so it is refused before anything is recorded as started. */
  installed?(cli: string): boolean;
  /**
   * `gate` throws when the local install switch is off or out of time, or the request's connection is no longer the live one: the installer calls it before every new
   * process and in the step that activates. `ended` in the answer settles when something the install still holds (the lock's release) has finished.
   */
  install(cli: string, gate?: () => void): Promise<{ version: string; ended?: Promise<unknown> }>;
  /** AGEND-153: the CLIs whose Update is the named exception (the vendor's newest release, not audited), and that update. Absent: this installer has none (and `cli.update` is refused). */
  knowsLatest?(cli: string): boolean;
  update?(cli: string, gate?: () => void): Promise<{ version: string; ended?: Promise<unknown> }>;
}
export interface RemoteAccountsDeps {
  /** This pairing's folder: the switches, the audit log and the credential profiles all live in it. */
  pairingDirectory: string;
  credentialRoot: string;
  now?: () => number;
  /** `claude auth status` under a profile folder, read by the shared parser. */
  models?(cli: string, directory: string | undefined, authorized: () => boolean): Promise<{ models: import("./windows-cli-providers.js").NativeModelOption[]; source: string }>;
  status(cli: CredentialProfileCli, directory: string): Promise<RemoteStatusAnswer>;
  find(cli: CredentialProfileCli | RuntimeDefaultLoginCli): Promise<RemoteCliExecutable | null>;
  /**
   * Antigravity's own login on this computer (`agy models`, by its exit code; never a login, never an e-mail address): true, false, or null when it could not be asked. Absent: this Runtime
   * cannot say, and a check answers "unknown". Asked only when an administrator's request says so (agy is never started on a timer or a read).
   */
  defaultStatus?(cli: RuntimeDefaultLoginCli): Promise<boolean | null>;
  /** The Windows CLI environment (an allowlist), to which the profile's variable is added here. */
  environment(): NodeJS.ProcessEnv;
  /** `claude auth logout` for a profile, with the profile's variable in `env`. Output is discarded by the caller. Resolves with the exit code. */
  runLogout(executable: RemoteCliExecutable, args: string[], env: NodeJS.ProcessEnv): Promise<number | null>;
  /**
   * AGEND-124: whether a CLI that is told its account by an argument (Antigravity) really keeps a folder's sign-in in that folder, asked with an EMPTY scratch folder under `scratchRoot` before a named
   * account's sign-in starts (windows-cli-worker.ts `probeCredentialIsolation`). Absent: this Runtime cannot prove it, so such an account's sign-in is refused.
   */
  isolated?(cli: CredentialProfileCli, scratchRoot: string): Promise<boolean>;
  /**
   * AGEND-124: removes a Credential Manager entry by its name (`cmdkey /delete:<name>`), for the computer's OWN login of a CLI whose spec says which entry holds it (`runtime.signOut.credential`). Resolves with
   * the exit code. Absent: this Runtime cannot sign that login out. Only ever asked with the name from the registry, never one from a request.
   */
  deleteCredential?(name: string): Promise<number | null>;
  /** A native task is running on this computer (the computer's own login must not be signed out under it). Absent: unknown, which refuses. */
  taskRunning?(): boolean | Promise<boolean>;
  /** Whether a task or terminal is running with this profile, which makes sign-out and remove refuse. */
  inUse(name: string): "task" | "pane" | "unknown" | undefined | Promise<"task" | "pane" | "unknown" | undefined>;
  /** The same question with no await (from what is already known in memory and on disk): asked once more, synchronously, immediately before a profile is renamed. */
  inUseNow(name: string): "task" | "pane" | "unknown" | undefined;
  /** The pairing's own default profile, known only here. THROWS when it cannot be read: an unreadable default is not "no default". */
  defaultProfile(): string | undefined;
  /** Takes a share of the Runtime's activity (the update fence waits for it): held for each request and for as long as a sign-in is open. Returns the release. */
  enter?: () => () => void;
  /**
   * A cached answer was written or forgotten: the caller re-reports the computer's inventory. With `authorized` (an account operation that is still waiting for its answer)
   * the new inventory is sent BEFORE this resolves, so that the dashboard reads the new state as soon as it has the answer; asked, before each of its steps, whether the
   * switch is still on and the request's connection still the live one. Without it (an install) the report is only started.
   */
  changed(authorized?: () => boolean): void | Promise<void>;
  /** AGEND-113: a check of a CLI's own login (no profile: Antigravity) was answered with a yes or a no: the inventory's row for that CLI says it from now on. */
  noteLogin?(cli: string, loggedIn: boolean): void;
  /** A CLI was installed: the caller detects again for real (not from its cache) and sends that inventory before this resolves. */
  installed?(authorized?: () => boolean): void | Promise<void>;
  /** Installs a CLI from the closed table and returns the version that landed. Absent: this Runtime cannot install (and does not claim to). */
  installer?: RemoteInstaller;
  /** A line for the person at this computer (the Runtime window). Never sent to AgEnD. */
  report?: (text: string) => void;
  signIn?: SignInDeps;
  ownership?: OwnedProfileOptions;
  /** How often a sign-in that is under way looks at its switch (default 3 s), so turning the switch off or letting it expire ends the sign-in. */
  switchWatchMs?: number;
}
// Defined next to `killTree` (the installer needs it too, and this module imports the installer's error): re-exported here for the existing importers.
export { ProcessNotConfirmedEnded };
/** What an operation knows about its own request: still the live connection of a Runtime that is not stopping. */
interface Ctx { alive(): boolean }
/** The key under which an install that could not be confirmed ended keeps the Runtime busy (no profile name can be this: it holds a NUL). */
const INSTALL_KEY = "\0cli-install";
/** What a CLI is called in a refusal (the registry's Runtime name for it). */
const cliName = (cli: string): string => runtimeFacts(cli, "provider")?.name ?? cli;
const NOT_AVAILABLE = "This computer's Runtime is stopping or its connection changed, so nothing was done";
/** At most this many `accounts.check` at a time on the computer: each one can start PowerShell and the CLI. */
export const MAX_CONCURRENT_CHECKS = 2;
const GENERIC = "The operation could not be completed on this computer. Check that computer's Runtime window.";
/** Text that may leave this computer: only our own refusals. Everything else (a filesystem error carries a path) becomes one fixed sentence. */
export function safeRemoteMessage(error: unknown): string {
  if (error instanceof RemoteSetupRefusal || error instanceof ProfileOwnershipRefusal || error instanceof SignInRefusal || error instanceof CredentialProfileRefusal || error instanceof CliInstallError) return error.message;
  return GENERIC;
}
function reasonOf(error: unknown): AuditReason {
  if (error instanceof RemoteSetupRefusal || error instanceof SignInRefusal || error instanceof ProfileOwnershipRefusal) return error.reason;
  if (error instanceof CliInstallError) return error.reason === "timed-out" ? "timeout" : error.reason === "busy" ? "busy" : "failed";
  return "failed";
}
const NEEDS_ACCOUNTS: readonly RuntimeRemoteOperation[] = ["models.refresh", "signin.start", "signin.capture", "signin.status", "signin.write", "accounts.check", "accounts.signout", "accounts.remove"];

/** `profile` is absent for Antigravity's sign-in: the computer's own default login (there is no profile folder for it). */
interface Meta { id: string; actor: string; cli: SignInCli; profile?: string; signedIn?: boolean; /** The command ended well but the account's folder holds no sign-in (AGEND-124). */ notIsolated?: true }
/** The key of "a CLI's own login" in the pace table (no profile name can hold a NUL). */
const DEFAULT_KEY = "\0default-login:";
/** Deletes one plain file of an account's folder, by the registry's exact name: not a link, not a folder, and nothing else. A file that is not there is already signed out. */
function removeSignInFile(directory: string, name: string): void {
  const path = join(directory, name);
  let stat; try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ProfileOwnershipRefusal("The account's sign-in file is not a plain file, so nothing is changed there", "link");
  unlinkSync(path);
}
/** The least time between two sign-outs or removes of one profile. It only slows a server that keeps asking; the switch and its time window are what bound the risk. */
export const PROFILE_OP_MIN_GAP_MS = 5_000;
/** Under this pairing's folder (never under a CLI's profile folder, so it is never listed as an account): where the isolation probe's empty scratch folders are made. */
export const ISOLATION_SCRATCH = "isolation-scratch";
const SUBSCRIPTION_ONLY = "Signing in with an Anthropic Console account is not supported from AgEnD, because that sign-in is kept outside the profile's folder. On that computer run: agend-runtime login claude-code NAME";

export class RemoteAccounts {
  private readonly slot: RuntimeSignInSlot;
  private readonly audit: AuditLog;
  private meta: Meta | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  /** Profiles (lower-case: on Windows `Work` and `work` are one folder) with an operation in flight. */
  private readonly busy = new Set<string>();
  /** Operations of which only one may be in progress on the whole computer (its `check` and `run` are separated by awaits). */
  private readonly exclusive = new Set<string>();
  /** When a sign-out or remove of a profile (lower-case name) last passed its checks. Only profiles this Runtime created get here. */
  private readonly lastChange = new Map<string, number>();
  /** Closed to new work by `stop()`; and the connection the requests in flight belong to (a change ends the old ones' right to start anything). */
  private stopped = false;
  private connectionEpoch = 0;
  /** Requests being handled, so `stop()` can wait for every one of them to unwind. */
  private readonly pending = new Set<Promise<unknown>>();
  /** Profiles kept busy after a process that was killed was not confirmed gone, until it is. */
  private readonly retained = new Set<string>();
  private activeChecks = 0;
  private hold: (() => void) | null = null;
  constructor(private readonly deps: RemoteAccountsDeps) { this.slot = new RuntimeSignInSlot(deps.now); this.audit = new AuditLog(deps.pairingDirectory, () => this.now()); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  /** The switches as they stand now (read-only; the server cannot change them). */
  switches(): RuntimeSwitchStates { return readRemoteSwitches(this.deps.pairingDirectory, this.now()); }
  /** True when this Runtime can install a CLI at all (the `cli-install` capability). */
  get canInstall(): boolean { return !!this.deps.installer; }
  /** A profile with a sign-in under way, which makes sign-out and remove refuse. */
  signInProfile(): string | undefined { return this.slot.current() ? this.meta?.profile : undefined; }
  /**
   * The Runtime is stopping. Admission closes first (synchronously, so a request that is waiting for a lookup finds the door shut when it wakes), then every
   * request in flight is waited for until it has unwound, then any sign-in (open, or whose child was not confirmed gone) is ended, then the folded
   * counts of the record are written.
   */
  async stop(): Promise<void> {
    this.stopped = true; this.connectionEpoch++; this.stopWatching();
    await Promise.allSettled([...this.pending]);
    let failure: unknown;
    try {
      if (this.meta && this.slot.current()) await this.endSignIn(this.meta.id, "closed");
      else if (this.slot.current()) await this.slot.recover();
    } catch (error) { failure = error; }
    this.refreshHold(); this.audit.flush();
    // A sign-in or logout process that was told to stop and is not confirmed gone is still this module's to own. Stopping is then NOT complete: the caller keeps
    // everything it holds (the pairing's lock, this module), and calling stop() again tries again, which succeeds once the process has really ended.
    if (failure !== undefined || this.slot.current() || this.retained.size > 0) throw new Error("Account process shutdown was not confirmed; inspect processes before stopping or restarting");
  }
  /** The connection to AgEnD changed: requests of the old one may not start anything more, and a sign-in that was opened over it is ended. */
  connectionChanged(): void {
    this.connectionEpoch++;
    if (this.meta && this.slot.current()) this.endWithRetry(this.meta.id, "closed");
  }
  /** Nothing of this module is running or being held: the update fence may ask. */
  idle(): boolean { return this.pending.size === 0 && !this.slot.current() && this.busy.size === 0 && this.retained.size === 0 && this.activeChecks === 0 && this.exclusive.size === 0; }
  /** A change to this profile has been reserved or is under way: a task or terminal must not start under it now. */
  profileReserved(name: string): boolean { const key = name.toLowerCase(); return this.busy.has(key) || this.retained.has(key); }
  private refreshHold(): void { if (this.hold && !this.slot.current()) { const leave = this.hold; this.hold = null; leave(); } }
  private retainBusy(key: string, ended: Promise<unknown>): void { this.retained.add(key); const done = (): void => { this.retained.delete(key); }; ended.then(done, done); }
  /** Both the live-request check and the switch, immediately before anything that changes something. */
  private gate(ctx: Ctx, switchName: RemoteSwitchName): void {
    if (!ctx.alive()) throw new RemoteSetupRefusal(NOT_AVAILABLE, "failed");
    requireRemoteSwitch(this.deps.pairingDirectory, switchName, this.now());
  }
  /** The last, synchronous look before a profile is renamed: the switch, the default, tasks and terminals, and a sign-in, all as they are at this instant. */
  private finalLook(ctx: Ctx, name: string, forRemove: boolean, cli: CredentialProfileCli = "claude-code"): void {
    this.gate(ctx, "accounts");
    if (forRemove && cli === "claude-code") {
      let fallback: string | undefined;
      try { fallback = this.deps.defaultProfile(); } catch { throw new ProfileOwnershipRefusal("This computer could not confirm which credential profile is the default, so nothing was changed. Check that computer's Runtime folder", "unconfirmed"); }
      if (fallback && fallback.toLowerCase() === name.toLowerCase()) throw new ProfileOwnershipRefusal(`Credential profile "${name}" is this computer's default for agents; change it there first: agend-runtime profile default NAME`, "default_profile");
    }
    if (this.signInProfile()?.toLowerCase() === name.toLowerCase()) throw new SignInRefusal(`A sign-in for "${name}" is running; end it first`, "busy");
    const using = this.deps.inUseNow(name);
    if (using === "unknown") throw new ProfileOwnershipRefusal("This computer could not confirm whether a terminal is running under this profile, so nothing was changed. Check that computer's terminals and Runtime folder", "unconfirmed");
    if (using) throw new ProfileOwnershipRefusal(`Credential profile "${name}" is in use by a running ${using === "pane" ? "terminal" : "task"} on this computer; stop it first`, "in_use");
  }

  /**
   * Re-reports the computer's inventory and waits for it to be sent, so that an account operation's answer reaches the server AFTER the inventory it changed (#3190 Part 3c):
   * the Accounts view reads the inventory the moment it has the answer. A revoked consent (the switch off, a changed connection) stops it, and a failed report is not a failed
   * operation: the change was made, and the next detection shows it.
   */
  private async refreshed(ctx: Ctx): Promise<void> {
    const authorized = (): boolean => { try { this.gate(ctx, "accounts"); return true; } catch { return false; } };
    try { await this.deps.changed(authorized); } catch { /* the change was made; the next detection reports it */ }
  }
  private record(entry: AuditEntry, required: boolean): void {
    try { this.audit.append(entry); }
    catch { if (required) throw new RemoteSetupRefusal("This computer could not write its audit log, so nothing was done", "failed"); }
  }
  /**
   * The order of every operation that changes something:
   *   1. its switch is on (else a refusal, recorded);
   *   2. no other operation on the same profile is in flight (else `busy`);
   *   3. `check`: everything that can be refused without changing anything (ownership, in use, a free sign-in slot, the CLI being there);
   *   4. `started` is recorded, and must be written, so a refusal costs one folded line and only real work leaves `started` entries;
   *   5. `run`, then `ok` or the reason it failed.
   */
  private async audited<T>(action: AuditAction, switchName: RemoteSwitchName, actor: string, subject: { cli?: string; profile?: string; detail?: (result: T) => string | undefined }, ctx: Ctx,
    steps: { check?: () => void | Promise<void>; run: () => Promise<T>; /** The operation goes on after `run` (a sign-in): its own end is recorded later, so no `ok` here. */ openEnded?: boolean;
      /** Only one operation of this kind at a time on the computer, taken in the same synchronous step as the switch and profile checks (before any await). */ exclusive?: "signin-start" | "install" }): Promise<T> {
    const base = { actor, action, ...(subject.cli ? { cli: subject.cli } : {}), ...(subject.profile ? { profile: subject.profile } : {}) };
    // A failure in `check` changed nothing, so it is a refusal whatever threw (a `find` or `knows` that throws too): it joins the folded refusals instead of
    // writing one unmergeable `failed` line per request. Only a failure of `run` is `failed`.
    const refuse = (error: unknown, inCheck = false): never => { this.record({ ...base, outcome: inCheck || error instanceof RemoteSetupRefusal || error instanceof ProfileOwnershipRefusal || error instanceof SignInRefusal ? "refused" : "failed", reason: reasonOf(error) }, false); throw error; };
    const key = subject.profile?.toLowerCase();
    try { requireRemoteSwitch(this.deps.pairingDirectory, switchName, this.now()); } catch (error) { return refuse(error); }
    if (key !== undefined) { if (this.busy.has(key) || this.retained.has(key)) return refuse(new SignInRefusal(`Another operation on "${subject.profile}" is in progress; try again in a moment`, "busy")); this.busy.add(key); }
    const taken = steps.exclusive;
    if (taken !== undefined) {
      if (this.exclusive.has(taken)) { if (key !== undefined) this.busy.delete(key); return refuse(new SignInRefusal(taken === "install" ? "Another install is running on this computer" : "Another sign-in is starting on this computer", "busy")); }
      this.exclusive.add(taken);
    }
    try {
      // The switch and the connection are looked at again after the checks, which can wait a long time (PowerShell, a CLI lookup): a switch turned off or
      // run out meanwhile, or a connection that has gone, stops the operation here, before anything is recorded as started.
      try { await steps.check?.(); this.gate(ctx, switchName); } catch (error) { return refuse(error, true); }
      this.record({ ...base, outcome: "started" }, true);
      try {
        const result = await steps.run();
        if (!steps.openEnded) this.record({ ...base, outcome: "ok", ...(subject.detail && subject.detail(result) ? { detail: subject.detail(result) } : {}) }, false);
        return result;
      } catch (error) { return refuse(error); }
    } finally { if (key !== undefined) this.busy.delete(key); if (taken !== undefined) this.exclusive.delete(taken); }
  }
  private cliOf(value: string): CredentialProfileCli {
    if (!isCredentialProfileCli(value)) throw new ProfileOwnershipRefusal(`Only ${PROFILE_CLI_NAMES()} accounts can be managed on a computer. Codex may keep its sign-in in the Windows Credential Manager, which a profile folder cannot hold or remove, so it is not offered yet`, "unsupported");
    return value;
  }
  /** Whether a CLI is told its named account by an argument (Antigravity), which is why its sign-in is proven isolated first and its sign-out removes a file. */
  private static byArgument(cli: CredentialProfileCli): boolean { const facts = runtimeFacts(cli, "namedAccounts"); return !!facts && "arg" in facts; }
  /**
   * AGEND-124: before a NAMED account of a CLI told its account by an argument is signed in, two things that need no change to be refused: the folder has a path the CLI can be given (a relative one: not
   * across drives), and an empty scratch folder answers "signed out" under that launch (the CLI keeps a folder's sign-in in that folder, not in the Credential Manager that every folder shares). Anything
   * else is `not_isolated`, and nothing is started. A CLI that moves its home with a variable needs neither.
   */
  private async proveIsolated(cli: CredentialProfileCli, directory: string): Promise<void> {
    if (!RemoteAccounts.byArgument(cli)) return;
    credentialProfileLaunch(this.deps.environment(), cli, directory);       // throws a refusal of our own when there is no relative path
    const scratch = join(this.deps.pairingDirectory, ISOLATION_SCRATCH);
    if (!this.deps.isolated || !(await this.deps.isolated(cli, scratch)))
      throw new ProfileOwnershipRefusal(`not_isolated: ${cliName(cli)} could not be shown to keep this account's sign-in in its own folder on this computer, so nothing was started (signing in would replace this Windows user's own login)`, "not_isolated");
  }
  private async busyProfile(name: string): Promise<void> {
    if (this.signInProfile()?.toLowerCase() === name.toLowerCase()) throw new SignInRefusal(`A sign-in for "${name}" is running; end it first`, "busy");
    const using = await this.deps.inUse(name);
    if (using === "unknown") throw new ProfileOwnershipRefusal("This computer could not confirm whether a terminal is running under this profile, so nothing was changed. Check that computer's terminals and Runtime folder", "unconfirmed");
    if (using) throw new ProfileOwnershipRefusal(`Credential profile "${name}" is in use by a running ${using === "pane" ? "terminal" : "task"} on this computer; stop it first`, "in_use");
  }
  /**
   * At least `PROFILE_OP_MIN_GAP_MS` between two sign-outs/removes of one profile. Asked first (it only looks, so a request that is too soon never costs
   * the ownership check, which can start PowerShell); the time is taken by `paceMark` only when every check has passed, so a refused try does not extend it.
   */
  private paceCheck(name: string): void {
    const last = this.lastChange.get(name.toLowerCase());
    if (last !== undefined && this.now() - last < PROFILE_OP_MIN_GAP_MS) throw new SignInRefusal(`"${name}" was just changed; wait a few seconds`, "rate_limited");
  }
  private paceMark(name: string): void { this.lastChange.set(name.toLowerCase(), this.now()); }

  /**
   * The one entry: a remote request already received from the server. Returns what the dashboard may see, or throws a message safe to send.
   * `current` says whether the connection the request arrived on is still the live one. A request is admitted only while the Runtime is not stopping and
   * the connection is current, is counted until it has completely unwound (`stop()` waits for it), and carries the same question into every step that
   * can change something.
   */
  async handle(operation: string, payload: unknown, current?: () => boolean): Promise<unknown> {
    if (!isRuntimeRemoteOperation(operation)) throw new Error("Unknown runtime operation");
    const epoch = this.connectionEpoch, ctx: Ctx = { alive: () => !this.stopped && this.connectionEpoch === epoch && (current ? current() : true) };
    if (!ctx.alive()) throw new Error(NOT_AVAILABLE);
    const work = (async (): Promise<unknown> => { try { return await this.dispatch(operation, payload, ctx); } catch (error) { throw new Error(safeRemoteMessage(error)); } })();
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); }
  }
  private async dispatch(operation: RuntimeRemoteOperation, payload: unknown, ctx: Ctx): Promise<unknown> {
    // Two operations do not look at a switch, on purpose: `accounts.switches` only reads (a dashboard has to be able to say why a request would be
    // refused), and `signin.close` only ends something that is already running (turning a switch off must never leave a sign-in that cannot be closed).
    if (operation === "accounts.switches") { this.parse(operation, payload); return this.switches(); }
    if (operation === "signin.close") { const input = this.parse(operation, payload); return this.endSignIn(input.sessionId, "closed"); }
    if (operation === "cli.install" || operation === "cli.update") {
      const input = this.parse(operation, payload);
      // AGEND-153: `cli.update` is the named exception's update (the vendor's newest release, not audited): the same switch, the same one-at-a-time rule, the same audit trail under its own action name,
      // and only for a CLI the installer says it takes to the newest release. An `install` of such a CLI is the pinned install, as before.
      const latest = operation === "cli.update";
      return this.audited(operation, "install", this.actorOf(input.actor), { cli: input.cli, detail: (result: { version: string }) => result.version }, ctx, {
        exclusive: "install",
        check: () => {
          if (!this.deps.installer) throw new ProfileOwnershipRefusal("This Runtime cannot install CLIs", "unsupported");
          if (!this.deps.installer.knows(input.cli)) throw new ProfileOwnershipRefusal("That CLI is not in this Runtime's install list", "unsupported");
          if (latest && !(this.deps.installer.update && this.deps.installer.knowsLatest?.(input.cli))) throw new ProfileOwnershipRefusal("That CLI is not updated to a latest release from here", "unsupported");
          // An install whose child process could not be confirmed ended is still the Runtime's work: nothing else starts until it really ends.
          if (this.retained.has(INSTALL_KEY)) throw new SignInRefusal("A CLI install on this computer has not finished ending; try again in a moment", "busy");
          // Nothing to do, or done a moment ago: refused here, before `started`, so that a coordinator that keeps asking can only add one folded `refused` line per minute to
          // the audit log, and cannot push real operations out of it. (The dashboard offers no button for a CLI that is already at this version.)
          if (!latest && this.deps.installer.installed?.(input.cli)) throw new SignInRefusal("That CLI is already installed at the version this Runtime installs", "rate_limited");
          const last = this.lastChange.get(`${INSTALL_KEY}${input.cli}`);
          if (last !== undefined && this.now() - last < PROFILE_OP_MIN_GAP_MS) throw new SignInRefusal("An install of that CLI was just tried; wait a few seconds", "rate_limited");
          this.lastChange.set(`${INSTALL_KEY}${input.cli}`, this.now());
        },
        run: async () => {
          this.gate(ctx, "install");
          // What the install still holds when it ends (a lock whose release has to be retried, a program that could not be confirmed ended) keeps the Runtime busy, and the
          // update fence held, until that has finished, whatever the connection does or the server's own deadline says.
          const holdUntil = (until: Promise<unknown>): void => {
            this.retainBusy(INSTALL_KEY, until);
            let leave: (() => void) | undefined;
            try { leave = this.deps.enter?.(); } catch { /* the Runtime is stopping: its stop waits for idle() */ }
            if (leave) { const release = leave; until.then(() => release(), () => release()); }
          };
          let result: { version: string; ended?: Promise<unknown> };
          try { result = await (latest ? this.deps.installer!.update!(input.cli, () => this.gate(ctx, "install")) : this.deps.installer!.install(input.cli, () => this.gate(ctx, "install"))); }
          catch (error) {
            const ended = (error as { ended?: unknown } | null)?.ended;
            if (error instanceof ProcessNotConfirmedEnded) holdUntil(error.ended);
            else if (ended instanceof Promise) holdUntil(ended);
            throw error;
          }
          if (result.ended) holdUntil(result.ended);
          // The computer's CLI list changes now. A fresh detection is made and sent BEFORE the answer, so that the dashboard sees the new CLI when the install reports done,
          // without a "Detect again" (the ordinary cache change below only re-reads what is cached). A failed detection does not undo a finished install.
          // That detection starts programs and writes the cache, so it is the same kind of effect as the install: it is asked, before each of its steps, whether the
          // switch is still on and the request's connection still the live one. A revoked consent stops it; the finished install is still answered.
          const authorized = (): boolean => { try { this.gate(ctx, "install"); return true; } catch { return false; } };
          this.deps.changed();
          if (authorized()) { try { await this.deps.installed?.(authorized); } catch { /* the next detection shows it */ } }
          return { version: result.version };
        },
      });
    }
    // Everything below is "accounts". A sign-in that is still open when its switch is off ends, whichever request finds it first (the watch also does).
    if (this.slot.current() && !readRemoteSwitches(this.deps.pairingDirectory, this.now()).accounts.on) await this.endSignIn(this.meta!.id, "switch_off").catch(() => {});
    switch (operation) {
      case "signin.capture": { const input = this.parse(operation, payload); this.needSwitch(); return { screen: this.slot.find(input.sessionId).capture() }; }
      case "signin.status": { const input = this.parse(operation, payload); this.needSwitch(); return this.signInStatus(input.sessionId); }
      case "signin.write": return this.writeCode(this.parse(operation, payload), ctx);
      case "signin.start": return this.startSignIn(this.parse(operation, payload), ctx);
      case "models.refresh": return this.models(this.parse(operation, payload), ctx);
      case "accounts.check": return this.check(this.parse(operation, payload), ctx);
      case "accounts.signout": return this.signOut(this.parse(operation, payload), ctx);
      case "accounts.remove": return this.remove(this.parse(operation, payload), ctx);
      default: throw new Error("Unknown runtime operation");
    }
  }
  /** The closed check; its error names the field only, so it may be shown. */
  private parse<K extends RuntimeRemoteOperation>(operation: K, payload: unknown): RuntimeRemotePayloads[K] {
    try { return parseRuntimeRemotePayload(operation, payload); }
    catch (error) { throw new RemoteSetupRefusal(error instanceof Error ? error.message : "Invalid request", "invalid_request"); }
  }
  private needSwitch(): void { requireRemoteSwitch(this.deps.pairingDirectory, "accounts", this.now()); }
  private actorOf(actor: string): string {
    if (!validAuditActor(actor)) throw new RemoteSetupRefusal("The request does not say who asked", "invalid_request");
    return actor;
  }

  /**
   * The one place that says which sign-in a request is. A request with a profile name is a NAMED account's: a CLI with named accounts here (Claude Code, Antigravity), in a folder this Runtime
   * creates or created. A request without one is the computer's OWN login, and only a CLI whose spec says it has one (`runtime.signIn` `none` or `both`: Antigravity) is signed in that way; every
   * other CLI needs a name, and a request without it is refused.
   */
  private async startSignIn(input: { cli: string; profile?: string; method: SignInMethod; actor: string }, ctx: Ctx): Promise<{ sessionId: string }> {
    if (input.profile === undefined && isRuntimeDefaultLoginCli(input.cli)) return this.startDefaultSignIn(input.cli, input, ctx);
    if (input.profile === undefined) { this.actorOf(input.actor); this.cliOf(input.cli); throw new RemoteSetupRefusal("A sign-in names the credential profile it is for", "invalid_request"); }
    return this.startProfileSignIn({ ...input, profile: input.profile }, ctx);
  }
  /** Common to both: the child is the Runtime's work while it lives, so the update fence waits for it; the watch ends it if the switch goes off. */
  private holdSignIn(session: RuntimeSignIn, ctx: Ctx): Promise<void> | void {
    // The sign-in is the Runtime's work for as long as its child lives: the update fence waits for it. If the Runtime stopped or the connection went
    // while the child was being started, it is ended at once, over the same path as any other end.
    try { if (!ctx.alive()) throw new RemoteSetupRefusal(NOT_AVAILABLE, "failed"); this.hold = this.deps.enter?.() ?? null; }
    catch (error) { return this.endSignIn(session.id, "closed").catch(() => {}).then(() => { throw error; }); }
    this.watchSwitch(session.id);
  }
  /**
   * AGEND-113: Antigravity's default login. `agy acp --login` under the Windows user's own login, with no profile, no folder and no ownership record: the one exception to "named
   * profiles only", and only for this CLI. Everything else is the same as a profile's sign-in, because it is the same `audited` path: the local `accounts` switch, one sign-in at a
   * time on this computer (`exclusive` and the slot), the start-rate limit, the ten-minute timeout and the switch watch, and a record in `audit.jsonl` before and after.
   */
  private async startDefaultSignIn(cli: RuntimeDefaultLoginCli, input: { cli: string; profile?: string; method: SignInMethod; actor: string }, ctx: Ctx): Promise<{ sessionId: string }> {
    const actor = this.actorOf(input.actor);
    let executable: RemoteCliExecutable | null = null;
    return this.audited("signin", "accounts", actor, { cli }, ctx, {
      exclusive: "signin-start",
      check: async () => {
        // A Google account (subscription) only: no Google Cloud project, no API key.
        if (input.method !== "subscription") throw new ProfileOwnershipRefusal(`Only a subscription sign-in is supported for ${cliName(cli)} from AgEnD`, "unsupported");
        await this.settleEndedSignIn(); this.slot.check();
        executable = await this.deps.find(cli);
        if (!executable) throw new SignInRefusal(`${cliName(cli)} is not installed on this computer`, "failed");
      },
      run: async () => {
        const session = await this.slot.start(() => { this.gate(ctx, "accounts"); return new RuntimeSignIn({ command: executable!.command, args: executable!.args, method: "subscription", cli,
          env: this.deps.environment() }, { ...this.deps.signIn, now: this.deps.now, onTimeout: () => { this.endWithRetry(session.id, "timeout"); } }); });
        this.meta = { id: session.id, actor, cli };
        await this.holdSignIn(session, ctx);
        return { sessionId: session.id };
      },
      openEnded: true,
    });
  }
  private async startProfileSignIn(input: { cli: string; profile: string; method: SignInMethod; actor: string }, ctx: Ctx): Promise<{ sessionId: string }> {
    const actor = this.actorOf(input.actor), cli = this.cliOf(input.cli);
    let executable: RemoteCliExecutable | null = null, directory: string;
    // A sign-in begins by creating the profile when it is new: this is "Add account". The record says so. Nothing is created until every refusal
    // that does not need a change has been made (the slot, the profile's state, the CLI), so refused requests leave no folder behind.
    return this.audited("signin", "accounts", actor, { cli, profile: input.profile }, ctx, {
      // The slot is only taken at the end of `run`; until then another start (under any name) must not get past `check`.
      exclusive: "signin-start",
      check: async () => {
        // Only a subscription sign-in: a Console sign-in may be kept outside the profile's folder, so a profile could not hold or remove it.
        if (input.method !== "subscription") throw new ProfileOwnershipRefusal(cli === "claude-code" ? SUBSCRIPTION_ONLY : `Only a subscription sign-in is supported for ${cliName(cli)} from AgEnD`, "unsupported");
        await this.settleEndedSignIn(); this.slot.check();
        try { directory = credentialProfileDirectory(this.deps.credentialRoot, cli, input.profile); } catch { throw new ProfileOwnershipRefusal("That is not a valid credential profile name", "invalid_request"); }
        if (existsSync(directory)) { await requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, this.deps.ownership); await this.busyProfile(input.profile); }
        else { const clash = credentialProfileCaseClash(this.deps.credentialRoot, cli, input.profile); if (clash) throw new ProfileOwnershipRefusal(`Credential profile "${input.profile}" would be the same folder as "${clash}" on Windows; use that name or choose another`, "invalid_request"); }
        executable = await this.deps.find(cli);
        if (!executable) throw new SignInRefusal(`${cliName(cli)} is not installed on this computer`, "failed");
        await this.proveIsolated(cli, directory);
      },
      run: async () => {
        const { credentialRoot, pairingDirectory } = this.deps;
        if (!existsSync(credentialProfileDirectory(credentialRoot, cli, input.profile))) {
          this.gate(ctx, "accounts");                                   // immediately before the folder is created
          try { createRuntimeProfile(credentialRoot, cli, input.profile); }
          catch { throw new ProfileOwnershipRefusal("The profile folder could not be created", "invalid_request"); }
          this.record({ actor, action: "profile.add", outcome: "ok", cli, profile: input.profile }, false);
          await this.refreshed(ctx);                                    // the new profile is in the report before the dashboard is answered
        }
        const directory = await requireOwnedProfile(pairingDirectory, credentialRoot, cli, input.profile, this.deps.ownership);
        // The switch and the connection once more, in the same synchronous step as the child is started (the slot waits before it calls this).
        // The launch of this account: its variable (Claude Code), or the pin and `--app_data_dir <folder>` that go with the sign-in command (Antigravity).
        const launch = credentialProfileLaunch(this.deps.environment(), cli, directory);
        const session = await this.slot.start(() => { this.gate(ctx, "accounts"); return new RuntimeSignIn({ command: executable!.command, args: executable!.args, profileArgs: launch.args, method: input.method, cli,
          env: launch.env }, { ...this.deps.signIn, now: this.deps.now,
          onTimeout: () => { this.endWithRetry(session.id, "timeout"); } }); });
        this.meta = { id: session.id, actor, cli, profile: input.profile };
        await this.holdSignIn(session, ctx);
        return { sessionId: session.id };
      },
      openEnded: true,
    });
  }
  /**
   * `signin.write`: one code to the CLI, recorded (who, when, which profile; never the code). Every refusal that changes nothing (the code's form, a code
   * already written, no prompt showing, the child gone) is made in `check`, before `started`, so a flood of bad writes folds into one line; `started` is
   * only for the one write that really reaches the CLI.
   */
  private async writeCode(input: { sessionId: string; input: string }, ctx: Ctx): Promise<{ accepted: true }> {
    const session = this.slot.find(input.sessionId), meta = this.meta;
    if (!meta || meta.id !== session.id) throw new SignInRefusal("That sign-in is no longer running", "invalid_request");
    return this.audited("signin.write", "accounts", meta.actor, { cli: meta.cli, profile: meta.profile }, ctx, {
      check: () => { session.assertWritable(input.input); },
      run: async () => { this.gate(ctx, "accounts"); await session.write(input.input); return { accepted: true as const }; },
    });
  }
  /**
   * `signin.status`, and (AGEND-124) the proof after the fact for a NAMED account of a CLI told its account by an argument: when its command has ended with exit 0, the account's own folder must hold the CLI's
   * sign-in file as a plain file. The pre-flight probe only shows the pin worked for an EMPTY folder while the Windows user was signed in; a CLI that stopped honouring the pin would have kept this login in the
   * Credential Manager, as the Windows user's OWN login. Then the answer carries `isolated: false`, the dashboard ends the sign-in as `not_isolated`, and the record says so.
   */
  private signInStatus(sessionId: string): { alive: boolean; exitCode?: number; isolated?: false } {
    const session = this.slot.find(sessionId), status = session.status(), meta = this.meta;
    if (meta && meta.id === sessionId && meta.profile !== undefined && !status.alive && status.exitCode === 0 && isCredentialProfileCli(meta.cli) && RemoteAccounts.byArgument(meta.cli)) {
      const store = credentialProfileStore(meta.cli);
      let kept = false;
      try { const stat = lstatSync(join(credentialProfileDirectory(this.deps.credentialRoot, meta.cli, meta.profile), store!)); kept = stat.isFile() && !stat.isSymbolicLink(); } catch { kept = false; }
      if (!kept) { meta.notIsolated = true; meta.signedIn = false; return { ...status, isolated: false }; }
    }
    return status;
  }
  /** While a sign-in is open, look at its switch every few seconds: a switch that was turned off, or that ran out, ends it and says so in the record. */
  private watchSwitch(id: string): void {
    this.stopWatching();
    this.watch = setInterval(() => {
      if (!this.slot.current() || this.meta?.id !== id) { this.stopWatching(); return; }
      if (!readRemoteSwitches(this.deps.pairingDirectory, this.now()).accounts.on) { this.stopWatching(); this.endWithRetry(id, "switch_off"); }
    }, this.deps.switchWatchMs ?? 3000);
    this.watch.unref?.();
  }
  private stopWatching(): void { if (this.watch) { clearInterval(this.watch); this.watch = null; } }
  /** Ends a sign-in on this Runtime's own initiative (timeout, switch); a child that cannot be shown gone is tried again, not forgotten. */
  private endWithRetry(id: string, how: "timeout" | "switch_off" | "closed", attempt = 0): void {
    void this.endSignIn(id, how).catch(() => {
      if (attempt >= 5 || this.meta?.id !== id) return;
      const timer = setTimeout(() => this.endWithRetry(id, how, attempt + 1), this.deps.switchWatchMs ?? 3000); timer.unref?.();
    });
  }
  /**
   * Ends the attempt, and records how it ended: signed in (ok) or not (failed), or a timeout or a switch turned off. The record is written once, by
   * whichever call finds the attempt's metadata still there after the close: two closes at the same time write one line.
   */
  private async endSignIn(sessionId: string, how: "closed" | "timeout" | "switch_off"): Promise<{ closed: true }> {
    this.stopWatching();
    await this.slot.close(sessionId);
    this.refreshHold();
    const meta = this.meta;
    if (meta && meta.id === sessionId) {
      this.meta = null;
      this.record({ actor: meta.actor, action: "signin", cli: meta.cli, profile: meta.profile, outcome: how === "closed" && meta.signedIn === true ? "ok" : "failed",
        ...(how === "closed" ? (meta.signedIn === true ? {} : { reason: meta.notIsolated ? "not_isolated" as const : "failed" as const }) : { reason: how === "timeout" ? "timeout" as const : "switch_off" as const }) }, false);
    }
    return { closed: true };
  }
  /**
   * Before a new sign-in: an attempt whose child has ended on its own and was never closed (a lost `signin.close`) is ended the normal way, which
   * records how it went and clears its metadata; then the slot closes anything else that cannot go on (a close that failed earlier), and metadata left
   * without a live attempt is recorded as failed and dropped.
   */
  private async settleEndedSignIn(): Promise<void> {
    const current = this.slot.current();
    if (current?.childEnded && this.meta?.id === current.id) await this.endSignIn(current.id, "closed").catch(() => {});
    await this.slot.recover();
    const meta = this.meta;
    if (meta && !this.slot.current()) {
      this.meta = null; this.stopWatching();
      this.record({ actor: meta.actor, action: "signin", cli: meta.cli, profile: meta.profile, outcome: "failed", reason: "failed" }, false);
    }
    this.refreshHold();
  }
  /**
   * Read-only toward the profile (`auth status` under it), so not recorded; it still starts PowerShell and the CLI, so it is bounded: a profile that is
   * being changed is `busy`, and only `MAX_CONCURRENT_CHECKS` run at once on the computer (the slot is taken before anything is started, and given
   * back only when the last child of this check is done).
   */
  /** Read-only catalog discovery uses the computer owner's existing accounts consent, never broadens it. */
  private async models(input: { cli: string; profile: string; actor: string }, ctx: Ctx) {
    this.gate(ctx, "accounts");
    if (!isNativeProviderId(input.cli) || input.cli !== "claude-code" && input.cli !== "codex" && !nativeProvider(input.cli).modelProbe || !this.deps.models) throw new ProfileOwnershipRefusal("This Runtime cannot refresh models for that CLI", "unsupported");
    if (input.cli !== "claude-code" && input.profile) throw new ProfileOwnershipRefusal("Native Codex named accounts are not supported", "unsupported");
    const selected = input.profile || (input.cli === "claude-code" ? this.deps.defaultProfile() : undefined);
    const key = selected?.toLowerCase() ?? `\0models:${input.cli}`;
    if (key && (this.busy.has(key) || this.retained.has(key)) || this.activeChecks >= MAX_CONCURRENT_CHECKS) throw new SignInRefusal("Other account operations are running; try again shortly", "busy");
    if (key) this.busy.add(key); this.activeChecks++;
    try {
      const directory = selected ? await requireOwnedProfile(this.deps.pairingDirectory,this.deps.credentialRoot,"claude-code",selected,this.deps.ownership) : undefined;
      const current = (): boolean => { try { this.gate(ctx,"accounts"); return !!input.profile || input.cli !== "claude-code" || this.deps.defaultProfile() === selected; } catch { return false; } };
      if (!current()) throw new SignInRefusal("The selected account changed; refresh it again", "failed");
      this.record({actor:this.actorOf(input.actor),action:"models.refresh",outcome:"started",cli:input.cli,...(selected?{profile:selected}:{})},true);
      const answer = await this.deps.models(input.cli,directory,current);
      if (selected) await requireOwnedProfile(this.deps.pairingDirectory,this.deps.credentialRoot,"claude-code",selected,this.deps.ownership);
      if (!current()) throw new SignInRefusal("The account or connection changed; refresh it again", "failed");
      this.record({actor:input.actor,action:"models.refresh",outcome:"ok",cli:input.cli,...(selected?{profile:selected}:{})},false);
      return {...answer,cli:input.cli,profile:selected??null};
    } catch(error) { this.record({actor:input.actor,action:"models.refresh",outcome:"failed",cli:input.cli,...(selected?{profile:selected}:{}),reason:"failed"},false); throw error; } finally { if (key) this.busy.delete(key); this.activeChecks--; }
  }

  private async check(input: { cli: string; profile?: string }, ctx: Ctx): Promise<{ loggedIn: boolean | null; identity?: AccountIdentity }> {
    if (input.profile === undefined && isRuntimeDefaultLoginCli(input.cli)) return this.checkDefault(input.cli, input, ctx);
    this.gate(ctx, "accounts");
    this.cliOf(input.cli);
    if (input.profile === undefined) throw new RemoteSetupRefusal("A check names the credential profile it is for", "invalid_request");
    return this.checkProfile({ cli: input.cli, profile: input.profile }, ctx);
  }
  /**
   * Antigravity's own login: `agy models` read by its exit code, nothing else (no e-mail, no plan). Not recorded, like a profile's check, and bounded the same way. Asked only
   * because a person's request says so: the dashboard's page reads the last detection instead (agy is never started on a read).
   */
  private async checkDefault(cli: RuntimeDefaultLoginCli, input: { cli: string; profile?: string }, ctx: Ctx): Promise<{ loggedIn: boolean | null }> {
    this.gate(ctx, "accounts");
    if (this.activeChecks >= MAX_CONCURRENT_CHECKS) throw new SignInRefusal("Other account checks are running on this computer; try again in a moment", "busy");
    if (!this.deps.defaultStatus) return { loggedIn: null };
    this.activeChecks++;
    try {
      const loggedIn = await this.deps.defaultStatus(cli);
      this.gate(ctx, "accounts");
      if (this.meta && this.meta.cli === cli) this.meta.signedIn = loggedIn === true;
      // A yes or a no is the newest word on this login: the Runtime's inventory carries it, and is re-sent BEFORE the answer (as for a profile's check), so that a later report of the cached
      // inventory (a reconnect, another account's change) does not bring back what was true before. "Could not be asked" says nothing and changes nothing.
      if (loggedIn !== null) { try { this.deps.noteLogin?.(cli, loggedIn); } catch { /* the answer is still given */ } await this.refreshed(ctx); }
      return { loggedIn };
    } finally { this.activeChecks--; }
  }
  private async checkProfile(input: { cli: string; profile: string }, ctx: Ctx): Promise<{ loggedIn: boolean | null; identity?: AccountIdentity }> {
    this.gate(ctx, "accounts");
    const cli = this.cliOf(input.cli), key = input.profile.toLowerCase();
    if (this.busy.has(key) || this.retained.has(key)) throw new SignInRefusal(`Another operation on "${input.profile}" is in progress; try again in a moment`, "busy");
    if (this.activeChecks >= MAX_CONCURRENT_CHECKS) throw new SignInRefusal("Other account checks are running on this computer; try again in a moment", "busy");
    this.activeChecks++;
    try {
      const directory = await requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, this.deps.ownership);
      this.gate(ctx, "accounts");
      const answer = await this.deps.status(cli, directory);
      this.gate(ctx, "accounts");                                      // before anything is written
      // The shared parser already masked the address; check the masked form once more before anything is stored or sent.
      const identity = answer.loggedIn === true && answer.identity ? parseAccountIdentity(answer.identity) : undefined;
      rememberCredentialStatus(this.deps.credentialRoot, cli, input.profile, { loggedIn: answer.loggedIn, ...(identity ? { identity } : {}) });
      // A sign-in that ended without leaving its file in the account's folder (`notIsolated`) stays failed: a later check that reads "signed in" from a store every folder shares must not turn it into a success.
      if (this.meta && this.meta.profile === input.profile && !this.meta.notIsolated) this.meta.signedIn = answer.loggedIn === true;
      await this.refreshed(ctx);
      return { loggedIn: answer.loggedIn, ...(identity ? { identity } : {}) };
    } finally { this.activeChecks--; }
  }
  /**
   * Sign-out. A request with a profile name signs that NAMED account out; one without signs the computer's OWN login out (`signOutDefault`).
   * A named account: the checks come first (ownership, in use, the CLI, the pace); then, with the folder taken out of reach of a swap (renamed and re-checked, as for a
   * removal), the CLI's own logout runs against the renamed folder (`claude auth logout`) or — for a CLI with none (Antigravity) — the account's token file is removed, the folder is
   * verified again, and the answer is the CLI's own status probe under that folder. So a folder replaced by a junction to the user's own sign-in after the checks is found before anything is
   * run against it or deleted in it. The switch and the connection are looked at again immediately before the logout starts and before the backups or the file go.
   */
  private async signOut(input: { cli: string; profile?: string; actor: string }, ctx: Ctx): Promise<{ loggedIn: false }> {
    if (input.profile === undefined) return this.signOutDefault(input.cli, input.actor, ctx);
    const profile = input.profile, actor = this.actorOf(input.actor), cli = this.cliOf(input.cli), key = profile.toLowerCase();
    const facts = runtimeFacts(cli, "signOut");
    if (!facts) throw new ProfileOwnershipRefusal(`${cliName(cli)} accounts cannot be signed out from AgEnD`, "unsupported");
    let executable: RemoteCliExecutable | null = null;
    return this.audited("profile.signout", "accounts", actor, { cli, profile }, ctx, {
      check: async () => {
        this.paceCheck(profile);
        await requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, profile, this.deps.ownership);
        await this.busyProfile(profile);
        executable = await this.deps.find(cli);
        if (!executable) throw new SignInRefusal(`${cliName(cli)} is not installed on this computer`, "failed");
        this.paceMark(profile);
      },
      run: async () => {
        const answer = await withIsolatedOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, profile,
          { ...this.deps.ownership, ...(this.deps.report ? { report: this.deps.report } : {}), beforeCommit: () => this.finalLook(ctx, profile, false) },
          async (directory, verify) => {
            this.gate(ctx, "accounts");
            if ("remove" in facts) {
              // The sign-in is a file in the account's folder: proven to be this folder (verify), then removed (only a plain file of that exact name), and the CLI is asked.
              await verify(); this.gate(ctx, "accounts");
              for (const name of facts.remove) removeSignInFile(directory, name);
              return this.deps.status(cli, directory);
            }
            try { await this.deps.runLogout(executable!, [...facts.args], withCredentialProfile(this.deps.environment(), cli, directory)); }
            catch (error) {
              if (error instanceof ProcessNotConfirmedEnded) {
                // The old logout may still be running: the profile stays busy, and keeps its temporary name, until that process really ends.
                this.retainBusy(key, error.ended);
                throw Object.assign(new SignInRefusal("The sign-out process could not be confirmed ended, so this profile stays busy until it is", "failed"), { ended: error.ended });
              }
              throw error;
            }
            await verify(); this.gate(ctx, "accounts");
            // No old identity is left behind: Claude Code keeps copies of its settings file under backups\.
            deleteProfileBackups(directory);
            return this.deps.status(cli, directory);
          });
        rememberCredentialStatus(this.deps.credentialRoot, cli, profile, { loggedIn: answer.loggedIn });
        await this.refreshed(ctx);
        if (answer.loggedIn !== false) throw new SignInRefusal(`Credential profile "${profile}" is still signed in after sign-out`, "failed");
        return { loggedIn: false as const };
      },
    });
  }
  /**
   * AGEND-124: the computer's OWN login of a CLI that has one (Antigravity), signed out: the Credential Manager entry the registry names (`runtime.signOut.credential`; `cmdkey /delete:<name>` deletes the
   * entry agy's own `/logout` does, measured on a decoy entry), then `agy models` says whether it took. Everything a sign-in of that login needs applies: the local `accounts` switch, no sign-in under way on
   * this computer, one at a time, a pause between two, a record in `audit.jsonl`; and no native task running (it would lose its login under it). The entry's name is the registry's, never the request's.
   */
  private async signOutDefault(cliId: string, actorId: string, ctx: Ctx): Promise<{ loggedIn: false }> {
    const actor = this.actorOf(actorId);
    if (!isRuntimeDefaultLoginCli(cliId)) { this.cliOf(cliId); throw new RemoteSetupRefusal("A sign-out names the credential profile it is for", "invalid_request"); }
    const cli = cliId, facts = runtimeFacts(cli, "signOut");
    if (!facts || !("credential" in facts)) throw new ProfileOwnershipRefusal(`${cliName(cli)}'s own login on a computer cannot be signed out from AgEnD`, "unsupported");
    const paceKey = `${DEFAULT_KEY}${cli}`;
    return this.audited("login.signout", "accounts", actor, { cli }, ctx, {
      exclusive: "signin-start",
      check: async () => {
        await this.settleEndedSignIn();
        if (this.slot.current()) throw new SignInRefusal("A sign-in is running on this computer; end it first", "busy");
        if (!this.deps.deleteCredential || !this.deps.defaultStatus) throw new ProfileOwnershipRefusal("This Runtime cannot sign this computer's own login out", "unsupported");
        // Asked with `await`: the Runtime reads the computer's boot identity first, so a terminal recorded under an earlier boot is not counted as running.
        if ((await this.deps.taskRunning?.()) !== false) throw new ProfileOwnershipRefusal(`A task is running on this computer (or this Runtime could not tell), and it would lose its ${cliName(cli)} login; wait for it to finish`, "in_use");
        const last = this.lastChange.get(paceKey);
        if (last !== undefined && this.now() - last < PROFILE_OP_MIN_GAP_MS) throw new SignInRefusal(`${cliName(cli)} was just signed out here; wait a few seconds`, "rate_limited");
        this.lastChange.set(paceKey, this.now());
      },
      run: async () => {
        this.gate(ctx, "accounts");
        if (this.slot.current() || (await this.deps.taskRunning?.()) !== false) throw new ProfileOwnershipRefusal("A sign-in or a task started on this computer; nothing was changed", "in_use");
        // 0: deleted. Any other exit is not by itself a failure (an entry that was not there is already signed out): `agy models` below is what answers.
        await this.deps.deleteCredential!(facts.credential);
        this.gate(ctx, "accounts");
        const loggedIn = await this.deps.defaultStatus!(cli);
        this.gate(ctx, "accounts");
        if (loggedIn !== null) { try { this.deps.noteLogin?.(cli, loggedIn); } catch { /* the answer is still given */ } }
        await this.refreshed(ctx);
        if (loggedIn !== false) throw new SignInRefusal(`${cliName(cli)} is still signed in on this computer after sign-out`, "failed");
        return { loggedIn: false as const };
      },
    });
  }
  private async remove(input: { cli: string; profile: string; actor: string }, ctx: Ctx): Promise<{ removed: true }> {
    const actor = this.actorOf(input.actor), cli = this.cliOf(input.cli);
    return this.audited("profile.remove", "accounts", actor, { cli, profile: input.profile }, ctx, {
      check: async () => {
        this.paceCheck(input.profile);
        await requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, this.deps.ownership);
        // The pairing's default profile is Claude Code's (an Antigravity account has none), so only a Claude profile is held back by it.
        if (cli === "claude-code") {
          let fallback: string | undefined;
          try { fallback = this.deps.defaultProfile(); } catch { throw new ProfileOwnershipRefusal("This computer could not confirm which credential profile is the default, so nothing was changed. Check that computer's Runtime folder", "unconfirmed"); }
          if (fallback && fallback.toLowerCase() === input.profile.toLowerCase()) throw new ProfileOwnershipRefusal(`Credential profile "${input.profile}" is this computer's default for agents; change it there first: agend-runtime profile default NAME`, "default_profile");
        }
        await this.busyProfile(input.profile);
        this.paceMark(input.profile);
      },
      run: async () => {
        this.gate(ctx, "accounts");
        // The protection (the default profile, tasks, terminals, the switch) is asked again, synchronously, immediately before the rename: `beforeCommit`.
        await removeOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile,
          { ...this.deps.ownership, ...(this.deps.report ? { report: this.deps.report } : {}), beforeCommit: () => this.finalLook(ctx, input.profile, true, cli), beforeDelete: () => this.finalLook(ctx, input.profile, true, cli) });
        await this.refreshed(ctx);
        return { removed: true as const };
      },
    });
  }
}
