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
import { parseAccountIdentity, type AccountIdentity } from "./claude-auth-status.js";
import { CredentialProfileRefusal, credentialProfileDirectory, isCredentialProfileCli, rememberCredentialStatus, withCredentialProfile,
  type CredentialProfileCli } from "./runtime-credential-profiles.js";
import { ProfileOwnershipRefusal, createRuntimeProfile, deleteProfileBackups, removeOwnedProfile, requireOwnedProfile, type OwnedProfileOptions } from "./runtime-profile-ownership.js";
import { RemoteSetupRefusal, appendAudit, readRemoteSwitches, requireRemoteSwitch, validAuditActor, type AuditAction, type AuditEntry, type AuditReason, type RemoteSwitchName } from "./runtime-remote-setup.js";
import { RuntimeSignIn, RuntimeSignInSlot, SignInRefusal, type SignInDeps, type SignInMethod } from "./runtime-signin.js";
import { isRuntimeRemoteOperation, parseRuntimeRemotePayload, type RuntimeRemoteOperation, type RuntimeRemotePayloads, type RuntimeSwitchStates } from "./runtime-protocol.js";

/** What a CLI the server may name stands for here: the CLI's program, its sign-in, and its environment variable. */
export interface RemoteCliExecutable { path: string; command: string; args: string[] }
export interface RemoteStatusAnswer { loggedIn: boolean | null; identity?: AccountIdentity }
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
  inUse(name: string): "task" | "pane" | undefined;
  /** The pairing's own default profile, known only here. */
  defaultProfile(): string | undefined;
  /** A cached answer was written or forgotten: the caller re-reports the computer's inventory. */
  changed(): void;
  /** Installs a CLI from the closed table and returns the version that landed. Absent: this Runtime cannot install (and does not claim to). */
  install?: (cli: string) => Promise<{ version: string }>;
  signIn?: SignInDeps;
  ownership?: OwnedProfileOptions;
}
const GENERIC = "The operation could not be completed on this computer. Check that computer's Runtime window.";
/** Text that may leave this computer: only our own refusals. Everything else (a filesystem error carries a path) becomes one fixed sentence. */
export function safeRemoteMessage(error: unknown): string {
  if (error instanceof RemoteSetupRefusal || error instanceof ProfileOwnershipRefusal || error instanceof SignInRefusal || error instanceof CredentialProfileRefusal) return error.message;
  return GENERIC;
}
function reasonOf(error: unknown): AuditReason {
  if (error instanceof RemoteSetupRefusal || error instanceof SignInRefusal || error instanceof ProfileOwnershipRefusal) return error.reason;
  return "failed";
}
const NEEDS_ACCOUNTS: readonly RuntimeRemoteOperation[] = ["signin.start", "signin.capture", "signin.status", "signin.write", "accounts.check", "accounts.signout", "accounts.remove"];

interface Meta { id: string; actor: string; cli: CredentialProfileCli; profile: string; signedIn?: boolean }

export class RemoteAccounts {
  private readonly slot: RuntimeSignInSlot;
  private meta: Meta | null = null;
  constructor(private readonly deps: RemoteAccountsDeps) { this.slot = new RuntimeSignInSlot(deps.now); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  /** The switches as they stand now (read-only; the server cannot change them). */
  switches(): RuntimeSwitchStates { return readRemoteSwitches(this.deps.pairingDirectory, this.now()); }
  /** True when this Runtime can install a CLI at all (the `cli-install` capability). */
  get canInstall(): boolean { return !!this.deps.install; }
  /** A profile with a sign-in under way, which makes sign-out and remove wait. */
  signInProfile(): string | undefined { return this.slot.current() ? this.meta?.profile : undefined; }

  private record(entry: AuditEntry, required: boolean): void {
    try { appendAudit(this.deps.pairingDirectory, entry, this.now()); }
    catch { if (required) throw new RemoteSetupRefusal("This computer could not write its audit log, so nothing was done", "failed"); }
  }
  /** Switch, then record the start, run, then record the end. The caller's refusals pass through with the reason in the record. */
  private async audited<T>(action: AuditAction, switchName: RemoteSwitchName, actor: string, subject: { cli?: string; profile?: string; detail?: (result: T) => string | undefined },
    run: () => Promise<T>, finish = true): Promise<T> {
    const base = { actor, action, ...(subject.cli ? { cli: subject.cli } : {}), ...(subject.profile ? { profile: subject.profile } : {}) };
    try { requireRemoteSwitch(this.deps.pairingDirectory, switchName, this.now()); }
    catch (error) { this.record({ ...base, outcome: "refused", reason: reasonOf(error) }, false); throw error; }
    this.record({ ...base, outcome: "started" }, true);
    try {
      const result = await run();
      if (finish) this.record({ ...base, outcome: "ok", ...(subject.detail && subject.detail(result) ? { detail: subject.detail(result) } : {}) }, false);
      return result;
    } catch (error) {
      this.record({ ...base, outcome: error instanceof RemoteSetupRefusal || error instanceof ProfileOwnershipRefusal || error instanceof SignInRefusal ? "refused" : "failed", reason: reasonOf(error) }, false);
      throw error;
    }
  }
  private cliOf(value: string): CredentialProfileCli {
    if (!isCredentialProfileCli(value)) throw new ProfileOwnershipRefusal("Only Claude Code accounts can be managed on a computer. Codex may keep its sign-in in the Windows Credential Manager, which a profile folder cannot hold or remove, so it is not offered yet", "unsupported");
    return value;
  }
  private busyProfile(cli: CredentialProfileCli, name: string): void {
    if (this.signInProfile()?.toLowerCase() === name.toLowerCase()) throw new SignInRefusal(`A sign-in for "${name}" is running; end it first`, "busy");
    const using = this.deps.inUse(name);
    if (using) throw new ProfileOwnershipRefusal(`Credential profile "${name}" is in use by a running ${using === "pane" ? "terminal" : "task"} on this computer; stop it first`, "in_use");
    void cli;
  }

  /** The one entry: a remote request already received from the server. Returns what the dashboard may see, or throws a message safe to send. */
  async handle(operation: string, payload: unknown): Promise<unknown> {
    if (!isRuntimeRemoteOperation(operation)) throw new Error("Unknown runtime operation");
    try { return await this.dispatch(operation, payload); }
    catch (error) { throw new Error(safeRemoteMessage(error)); }
  }
  private async dispatch(operation: RuntimeRemoteOperation, payload: unknown): Promise<unknown> {
    if (operation === "accounts.switches") { this.parse(operation, payload); return this.switches(); }
    if (operation === "signin.close") { const input = this.parse(operation, payload); return this.endSignIn(input.sessionId, "closed"); }
    if (operation === "cli.install") {
      const input = this.parse(operation, payload);
      if (!validAuditActor(input.actor)) throw new RemoteSetupRefusal("The request does not say who asked", "invalid_request");
      return this.audited("cli.install", "install", input.actor, { cli: input.cli, detail: (result: { version: string }) => result.version }, async () => {
        if (!this.deps.install) throw new ProfileOwnershipRefusal("This Runtime cannot install CLIs", "unsupported");
        const result = await this.deps.install(input.cli);
        return { version: result.version };
      });
    }
    // Everything below is "accounts". While its switch is off a sign-in that is still open ends, then the request is refused.
    if (NEEDS_ACCOUNTS.includes(operation) && !readRemoteSwitches(this.deps.pairingDirectory, this.now()).accounts.on && this.slot.current()) await this.endSignIn(this.meta!.id, "switch_off").catch(() => {});
    switch (operation) {
      case "signin.capture": { const input = this.parse(operation, payload); this.needSwitch(); return { screen: this.slot.find(input.sessionId).capture() }; }
      case "signin.status": { const input = this.parse(operation, payload); this.needSwitch(); return this.slot.find(input.sessionId).status(); }
      case "signin.write": { const input = this.parse(operation, payload); this.needSwitch(); await this.slot.find(input.sessionId).write(input.input); return { accepted: true }; }
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
    // A sign-in begins by creating the profile when it is new: this is "Add account". The record says so.
    return this.audited("signin", "accounts", actor, { cli, profile: input.profile }, async () => {
      const { credentialRoot, pairingDirectory } = this.deps;
      let directory: string;
      try { directory = credentialProfileDirectory(credentialRoot, cli, input.profile); } catch { throw new ProfileOwnershipRefusal("That is not a valid credential profile name", "invalid_request"); }
      if (!existsSync(directory)) {
        try { createRuntimeProfile(credentialRoot, cli, input.profile); }
        catch (error) { throw new ProfileOwnershipRefusal(error instanceof Error && /^Credential profile "[^"\\/]{1,64}" would be the same folder as "[^"\\/]{1,64}" on Windows/.test(error.message) ? error.message : "The profile folder could not be created", "invalid_request"); }
        this.record({ actor, action: "profile.add", outcome: "ok", cli, profile: input.profile }, false);
      }
      directory = requireOwnedProfile(pairingDirectory, credentialRoot, cli, input.profile, this.deps.ownership);
      this.busyProfile(cli, input.profile);
      const executable = await this.deps.find(cli);
      if (!executable) throw new SignInRefusal("Claude Code is not installed on this computer", "failed");
      const session = this.slot.start(() => new RuntimeSignIn({ command: executable.command, args: executable.args, method: input.method,
        env: withCredentialProfile(this.deps.environment(), cli, directory) }, { ...this.deps.signIn, now: this.deps.now,
        onTimeout: () => { void this.endSignIn(session.id, "timeout").catch(() => {}); } }));
      this.meta = { id: session.id, actor, cli, profile: input.profile };
      return { sessionId: session.id };
    }, false);
  }
  /** Ends the attempt, and records how it ended: signed in (ok) or not (failed), or a timeout or a switch turned off. */
  private async endSignIn(sessionId: string, how: "closed" | "timeout" | "switch_off"): Promise<{ closed: true }> {
    const meta = this.meta;
    await this.slot.close(sessionId);
    if (meta && meta.id === sessionId) {
      this.record({ actor: meta.actor, action: "signin", cli: meta.cli, profile: meta.profile, outcome: how === "closed" && meta.signedIn === true ? "ok" : "failed",
        ...(how === "closed" ? (meta.signedIn === true ? {} : { reason: "failed" as const }) : { reason: how === "timeout" ? "timeout" as const : "switch_off" as const }) }, false);
      this.meta = null;
    }
    return { closed: true };
  }
  private async check(input: { cli: string; profile: string }): Promise<{ loggedIn: boolean | null; identity?: AccountIdentity }> {
    this.needSwitch();
    const cli = this.cliOf(input.cli), directory = requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, this.deps.ownership);
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
    return this.audited("profile.signout", "accounts", actor, { cli, profile: input.profile }, async () => {
      const directory = requireOwnedProfile(this.deps.pairingDirectory, this.deps.credentialRoot, cli, input.profile, this.deps.ownership);
      this.busyProfile(cli, input.profile);
      const executable = await this.deps.find(cli);
      if (!executable) throw new SignInRefusal("Claude Code is not installed on this computer", "failed");
      await this.deps.runLogout(executable, ["auth", "logout"], withCredentialProfile(this.deps.environment(), cli, directory));
      // No old identity is left behind: Claude Code keeps copies of its settings file under backups\.
      deleteProfileBackups(directory);
      const answer = await this.deps.status(cli, directory);
      rememberCredentialStatus(this.deps.credentialRoot, cli, input.profile, { loggedIn: answer.loggedIn });
      this.deps.changed();
      if (answer.loggedIn !== false) throw new SignInRefusal(`Credential profile "${input.profile}" is still signed in after sign-out`, "failed");
      return { loggedIn: false as const };
    });
  }
  private async remove(input: { cli: string; profile: string; actor: string }): Promise<{ removed: true }> {
    const actor = this.actorOf(input.actor), cli = this.cliOf(input.cli);
    return this.audited("profile.remove", "accounts", actor, { cli, profile: input.profile }, async () => {
      const { pairingDirectory, credentialRoot, ownership } = this.deps;
      requireOwnedProfile(pairingDirectory, credentialRoot, cli, input.profile, ownership);
      const fallback = this.deps.defaultProfile();
      if (fallback && fallback.toLowerCase() === input.profile.toLowerCase()) throw new ProfileOwnershipRefusal(`Credential profile "${input.profile}" is this computer's default for agents; change it there first: agend-runtime profile default NAME`, "default_profile");
      this.busyProfile(cli, input.profile);
      removeOwnedProfile(pairingDirectory, credentialRoot, cli, input.profile, ownership);
      this.deps.changed();
      return { removed: true as const };
    });
  }
}
