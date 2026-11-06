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
import { existsSync } from "node:fs";
import { CliInstallError } from "./runtime-cli-install.js";
import { parseAccountIdentity, type AccountIdentity } from "./claude-auth-status.js";
import { CredentialProfileRefusal, credentialProfileCaseClash, credentialProfileDirectory, isCredentialProfileCli, rememberCredentialStatus, withCredentialProfile,
  type CredentialProfileCli } from "./runtime-credential-profiles.js";
import { ProfileOwnershipRefusal, createRuntimeProfile, deleteProfileBackups, removeOwnedProfile, requireOwnedProfile, type OwnedProfileOptions } from "./runtime-profile-ownership.js";
import { AuditLog, RemoteSetupRefusal, readRemoteSwitches, requireRemoteSwitch, validAuditActor, type AuditAction, type AuditEntry, type AuditReason, type RemoteSwitchName } from "./runtime-remote-setup.js";
import { RuntimeSignIn, RuntimeSignInSlot, SignInRefusal, type SignInDeps, type SignInMethod } from "./runtime-signin.js";
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
  install(cli: string): Promise<{ version: string }>;
}
export interface RemoteAccountsDeps {
  /** This pairing's folder: the switches, the audit log and the credential profiles all live in it. */
  pairingDirectory: string;
  credentialRoot: string;
  now?: () => number;
  /** `claude auth status` under a profile folder, read by the shared parser. */
  status(cli: CredentialProfileCli, directory: string): Promise<RemoteStatusAnswer>;
  find(cli: CredentialProfileCli): Promise<RemoteCliExecutable | null>;
  /** The Windows CLI environment (an allowlist), to which the profile's variable is added here. */
  environment(): NodeJS.ProcessEnv;
  /** `claude auth logout` for a profile, with the profile's variable in `env`. Output is discarded by the caller. Resolves with the exit code. */
  runLogout(executable: RemoteCliExecutable, args: string[], env: NodeJS.ProcessEnv): Promise<number | null>;
  /** Whether a task or terminal is running with this profile, which makes sign-out and remove wait. */
  inUse(name: string): "task" | "pane" | "unknown" | undefined | Promise<"task" | "pane" | "unknown" | undefined>;
  /** The pairing's own default profile, known only here. */
  defaultProfile(): string | undefined;
  /** A cached answer was written or forgotten: the caller re-reports the computer's inventory. */
  changed(): void;
  /** Installs a CLI from the closed table and returns the version that landed. Absent: this Runtime cannot install (and does not claim to). */
  installer?: RemoteInstaller;
  /** A line for the person at this computer (the Runtime window). Never sent to AgEnD. */
  report?: (text: string) => void;
  signIn?: SignInDeps;
  ownership?: OwnedProfileOptions;
  /** How often a sign-in that is under way looks at its switch (default 3 s), so turning the switch off or letting it expire ends the sign-in. */
  switchWatchMs?: number;
}
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
const NEEDS_ACCOUNTS: readonly RuntimeRemoteOperation[] = ["signin.start", "signin.capture", "signin.status", "signin.write", "accounts.check", "accounts.signout", "accounts.remove"];

interface Meta { id: string; actor: string; cli: CredentialProfileCli; profile: string; signedIn?: boolean }
/** The least time between two sign-outs or removes of one profile. It only slows a server that keeps asking; the switch and its time window are what bound the risk. */
export const PROFILE_OP_MIN_GAP_MS = 5_000;
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
  constructor(private readonly deps: RemoteAccountsDeps) { this.slot = new RuntimeSignInSlot(deps.now); this.audit = new AuditLog(deps.pairingDirectory, () => this.now()); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  /** The switches as they stand now (read-only; the server cannot change them). */
  switches(): RuntimeSwitchStates { return readRemoteSwitches(this.deps.pairingDirectory, this.now()); }
  /** True when this Runtime can install a CLI at all (the `cli-install` capability). */
  get canInstall(): boolean { return !!this.deps.installer; }
  /** A profile with a sign-in under way, which makes sign-out and remove refuse. */
  signInProfile(): string | undefined { return this.slot.current() ? this.meta?.profile : undefined; }
  /** The Runtime is stopping: nothing is left running, and the folded counts of the record are written. */
  async stop(): Promise<void> {
    if (this.meta && this.slot.current()) await this.endSignIn(this.meta.id, "closed").catch(() => {});
    this.audit.flush();
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
  private async audited<T>(action: AuditAction, switchName: RemoteSwitchName, actor: string, subject: { cli?: string; profile?: string; detail?: (result: T) => string | undefined },
    steps: { check?: () => void | Promise<void>; run: () => Promise<T>; /** The operation goes on after `run` (a sign-in): its own end is recorded later, so no `ok` here. */ openEnded?: boolean;
      /** Only one operation of this kind at a time on the computer, taken in the same synchronous step as the switch and profile checks (before any await). */ exclusive?: "signin-start" | "install" }): Promise<T> {
    const base = { actor, action, ...(subject.cli ? { cli: subject.cli } : {}), ...(subject.profile ? { profile: subject.profile } : {}) };
    // A failure in `check` changed nothing, so it is a refusal whatever threw (a `find` or `knows` that throws too): it joins the folded refusals instead of
    // writing one unmergeable `failed` line per request. Only a failure of `run` is `failed`.
    const refuse = (error: unknown, inCheck = false): never => { this.record({ ...base, outcome: inCheck || error instanceof RemoteSetupRefusal || error instanceof ProfileOwnershipRefusal || error instanceof SignInRefusal ? "refused" : "failed", reason: reasonOf(error) }, false); throw error; };
    const key = subject.profile?.toLowerCase();
    try { requireRemoteSwitch(this.deps.pairingDirectory, switchName, this.now()); } catch (error) { return refuse(error); }
    if (key !== undefined) { if (this.busy.has(key)) return refuse(new SignInRefusal(`Another operation on "${subject.profile}" is in progress; try again in a moment`, "busy")); this.busy.add(key); }
    const taken = steps.exclusive;
    if (taken !== undefined) {
      if (this.exclusive.has(taken)) { if (key !== undefined) this.busy.delete(key); return refuse(new SignInRefusal(taken === "install" ? "Another install is running on this computer" : "Another sign-in is starting on this computer", "busy")); }
      this.exclusive.add(taken);
    }
    try {
      try { await steps.check?.(); } catch (error) { return refuse(error, true); }
      this.record({ ...base, outcome: "started" }, true);
      try {
        const result = await steps.run();
        if (!steps.openEnded) this.record({ ...base, outcome: "ok", ...(subject.detail && subject.detail(result) ? { detail: subject.detail(result) } : {}) }, false);
        return result;
      } catch (error) { return refuse(error); }
    } finally { if (key !== undefined) this.busy.delete(key); if (taken !== undefined) this.exclusive.delete(taken); }
  }
  private cliOf(value: string): CredentialProfileCli {
    if (!isCredentialProfileCli(value)) throw new ProfileOwnershipRefusal("Only Claude Code accounts can be managed on a computer. Codex may keep its sign-in in the Windows Credential Manager, which a profile folder cannot hold or remove, so it is not offered yet", "unsupported");
    return value;
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

  /** The one entry: a remote request already received from the server. Returns what the dashboard may see, or throws a message safe to send. */
  async handle(operation: string, payload: unknown): Promise<unknown> {
    if (!isRuntimeRemoteOperation(operation)) throw new Error("Unknown runtime operation");
    try { return await this.dispatch(operation, payload); }
    catch (error) { throw new Error(safeRemoteMessage(error)); }
  }
  private async dispatch(operation: RuntimeRemoteOperation, payload: unknown): Promise<unknown> {
    // Two operations do not look at a switch, on purpose: `accounts.switches` only reads (a dashboard has to be able to say why a request would be
    // refused), and `signin.close` only ends something that is already running (turning a switch off must never leave a sign-in that cannot be closed).
    if (operation === "accounts.switches") { this.parse(operation, payload); return this.switches(); }
    if (operation === "signin.close") { const input = this.parse(operation, payload); return this.endSignIn(input.sessionId, "closed"); }
    if (operation === "cli.install") {
      const input = this.parse(operation, payload);
      return this.audited("cli.install", "install", this.actorOf(input.actor), { cli: input.cli, detail: (result: { version: string }) => result.version }, {
        exclusive: "install",
        check: () => {
          if (!this.deps.installer) throw new ProfileOwnershipRefusal("This Runtime cannot install CLIs", "unsupported");
          if (!this.deps.installer.knows(input.cli)) throw new ProfileOwnershipRefusal("That CLI is not in this Runtime's install list", "unsupported");
        },
        run: async () => {
          const result = await this.deps.installer!.install(input.cli);
          // The computer's CLI list changes now: the dashboard sees the new CLI without waiting for the next detection.
          this.deps.changed();
          return { version: result.version };
        },
      });
    }
    // Everything below is "accounts". A sign-in that is still open when its switch is off ends, whichever request finds it first (the watch also does).
    if (this.slot.current() && !readRemoteSwitches(this.deps.pairingDirectory, this.now()).accounts.on) await this.endSignIn(this.meta!.id, "switch_off").catch(() => {});
    switch (operation) {
      case "signin.capture": { const input = this.parse(operation, payload); this.needSwitch(); return { screen: this.slot.find(input.sessionId).capture() }; }
      case "signin.status": { const input = this.parse(operation, payload); this.needSwitch(); return this.slot.find(input.sessionId).status(); }
      case "signin.write": return this.writeCode(this.parse(operation, payload));
      case "signin.start": return this.startSignIn(this.parse(operation, payload));
      case "accounts.check": return this.check(this.parse(operation, payload));
      case "accounts.signout": return this.signOut(this.parse(operation, payload));
      case "accounts.remove": return this.remove(this.parse(operation, payload));
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

  private async startSignIn(input: { cli: string; profile: string; method: SignInMethod; actor: string }): Promise<{ sessionId: string }> {
    const actor = this.actorOf(input.actor), cli = this.cliOf(input.cli);
    let executable: RemoteCliExecutable | null = null;
    // A sign-in begins by creating the profile when it is new: this is "Add account". The record says so. Nothing is created until every refusal
    // that does not need a change has been made (the slot, the profile's state, the CLI), so refused requests leave no folder behind.
    return this.audited("signin", "accounts", actor, { cli, profile: input.profile }, {
      // The slot is only taken at the end of `run`; until then another start (under any name) must not get past `check`.
      exclusive: "signin-start",
      check: async () => {
        // Only a subscription sign-in: a Console sign-in may be kept outside the profile's folder, so a profile could not hold or remove it.
        if (input.method !== "subscription") throw new ProfileOwnershipRefusal(SUBSCRIPTION_ONLY, "unsupported");
        await this.settleEndedSignIn(); this.slot.check();
        let directory: string;
        try { directory = credentialProfileDirectory(this.deps.credentialRoot, cli, input.profile); } catch { throw new ProfileOwnershipRefusal("That is not a valid credential profile name", "invalid_request"); }
        if (existsSync(directory)) { await requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, this.deps.ownership); await this.busyProfile(input.profile); }
        else { const clash = credentialProfileCaseClash(this.deps.credentialRoot, cli, input.profile); if (clash) throw new ProfileOwnershipRefusal(`Credential profile "${input.profile}" would be the same folder as "${clash}" on Windows; use that name or choose another`, "invalid_request"); }
        executable = await this.deps.find(cli);
        if (!executable) throw new SignInRefusal("Claude Code is not installed on this computer", "failed");
      },
      run: async () => {
        const { credentialRoot, pairingDirectory } = this.deps;
        if (!existsSync(credentialProfileDirectory(credentialRoot, cli, input.profile))) {
          try { createRuntimeProfile(credentialRoot, cli, input.profile); }
          catch { throw new ProfileOwnershipRefusal("The profile folder could not be created", "invalid_request"); }
          this.record({ actor, action: "profile.add", outcome: "ok", cli, profile: input.profile }, false);
        }
        const directory = await requireOwnedProfile(pairingDirectory, credentialRoot, cli, input.profile, this.deps.ownership);
        const session = await this.slot.start(() => new RuntimeSignIn({ command: executable!.command, args: executable!.args, method: input.method,
          env: withCredentialProfile(this.deps.environment(), cli, directory) }, { ...this.deps.signIn, now: this.deps.now,
          onTimeout: () => { this.endWithRetry(session.id, "timeout"); } }));
        this.meta = { id: session.id, actor, cli, profile: input.profile };
        this.watchSwitch(session.id);
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
  private async writeCode(input: { sessionId: string; input: string }): Promise<{ accepted: true }> {
    const session = this.slot.find(input.sessionId), meta = this.meta;
    if (!meta || meta.id !== session.id) throw new SignInRefusal("That sign-in is no longer running", "invalid_request");
    return this.audited("signin.write", "accounts", meta.actor, { cli: meta.cli, profile: meta.profile }, {
      check: () => { session.assertWritable(input.input); },
      run: async () => { await session.write(input.input); return { accepted: true as const }; },
    });
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
  private endWithRetry(id: string, how: "timeout" | "switch_off", attempt = 0): void {
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
    const meta = this.meta;
    if (meta && meta.id === sessionId) {
      this.meta = null;
      this.record({ actor: meta.actor, action: "signin", cli: meta.cli, profile: meta.profile, outcome: how === "closed" && meta.signedIn === true ? "ok" : "failed",
        ...(how === "closed" ? (meta.signedIn === true ? {} : { reason: "failed" as const }) : { reason: how === "timeout" ? "timeout" as const : "switch_off" as const }) }, false);
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
  }
  /** Read-only (`auth status` under the profile), so not recorded. */
  private async check(input: { cli: string; profile: string }): Promise<{ loggedIn: boolean | null; identity?: AccountIdentity }> {
    this.needSwitch();
    const cli = this.cliOf(input.cli), directory = await requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, this.deps.ownership);
    const answer = await this.deps.status(cli, directory);
    // The shared parser already masked the address; check the masked form once more before anything is stored or sent.
    const identity = answer.loggedIn === true && answer.identity ? parseAccountIdentity(answer.identity) : undefined;
    rememberCredentialStatus(this.deps.credentialRoot, cli, input.profile, { loggedIn: answer.loggedIn, ...(identity ? { identity } : {}) });
    if (this.meta && this.meta.profile === input.profile) this.meta.signedIn = answer.loggedIn === true;
    this.deps.changed();
    return { loggedIn: answer.loggedIn, ...(identity ? { identity } : {}) };
  }
  private async signOut(input: { cli: string; profile: string; actor: string }): Promise<{ loggedIn: false }> {
    const actor = this.actorOf(input.actor), cli = this.cliOf(input.cli);
    let directory = "", executable: RemoteCliExecutable | null = null;
    return this.audited("profile.signout", "accounts", actor, { cli, profile: input.profile }, {
      check: async () => {
        this.paceCheck(input.profile);
        directory = await requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, this.deps.ownership);
        await this.busyProfile(input.profile);
        executable = await this.deps.find(cli);
        if (!executable) throw new SignInRefusal("Claude Code is not installed on this computer", "failed");
        this.paceMark(input.profile);
      },
      run: async () => {
        await this.deps.runLogout(executable!, ["auth", "logout"], withCredentialProfile(this.deps.environment(), cli, directory));
        // No old identity is left behind: Claude Code keeps copies of its settings file under backups\.
        deleteProfileBackups(directory);
        const answer = await this.deps.status(cli, directory);
        rememberCredentialStatus(this.deps.credentialRoot, cli, input.profile, { loggedIn: answer.loggedIn });
        this.deps.changed();
        if (answer.loggedIn !== false) throw new SignInRefusal(`Credential profile "${input.profile}" is still signed in after sign-out`, "failed");
        return { loggedIn: false as const };
      },
    });
  }
  private async remove(input: { cli: string; profile: string; actor: string }): Promise<{ removed: true }> {
    const actor = this.actorOf(input.actor), cli = this.cliOf(input.cli);
    return this.audited("profile.remove", "accounts", actor, { cli, profile: input.profile }, {
      check: async () => {
        this.paceCheck(input.profile);
        await requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, this.deps.ownership);
        const fallback = this.deps.defaultProfile();
        if (fallback && fallback.toLowerCase() === input.profile.toLowerCase()) throw new ProfileOwnershipRefusal(`Credential profile "${input.profile}" is this computer's default for agents; change it there first: agend-runtime profile default NAME`, "default_profile");
        await this.busyProfile(input.profile);
        this.paceMark(input.profile);
      },
      run: async () => {
        await removeOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, { ...this.deps.ownership, ...(this.deps.report ? { report: this.deps.report } : {}) });
        this.deps.changed();
        return { removed: true as const };
      },
    });
  }
}
