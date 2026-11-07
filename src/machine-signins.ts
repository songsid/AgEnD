/**
 * #3190 Part 3c: dashboard sign-ins on a paired computer, for Settings → Accounts. This is #3212's `StructuredSignIn` (the one sign-in implementation: the same prompt
 * reader, the same TTL, the same single-writer reservation) with a `RuntimeSignInTransport` (runtime-signin-transport.ts) for ONE computer and ONE credential
 * profile; it adds no second sign-in flow and no screen of its own.
 *
 * What it owns, and no more:
 *  - one sign-in at a time per computer (the Runtime enforces its own limit whatever this says), under that computer's own `LoginWindowLock`: the host's lock guards
 *    the host's credential writers, and a profile on another computer is a different writer;
 *  - the checks that give the person a reason before anything starts: the computer is known and online, its Runtime reports `remote-signin`, its owner turned
 *    `accounts` on (read from the computer; the server cannot change it), and the profile is one this Runtime created (`created`, as it reports it);
 *  - a snapshot in the same shape the sign-in cards already read (`selected`, `pending`, `states`, `login`), plus which computer and profile it is for.
 *
 * Never kept or logged here: a sign-in URL, a code, the Runtime's output or an e-mail address. The view carries the URL and (for a device flow) the code to the one
 * admin session that started the sign-in, as on the host.
 */
import { StructuredSignIn, type SignInAction, type StructuredSignInView } from "./structured-signin.js";
import { LoginWindowLock } from "./login-window-lock.js";
import type { AuthCheckResult } from "./login-flows.js";
import { createRuntimeSignInTransport, runtimeAccountStatus, type AccountCaller } from "./runtime-signin-transport.js";
import { validCredentialProfileName } from "./runtime-credential-profiles.js";

/** The CLI a computer can sign in from the dashboard (Claude Code first; Codex waits for #3212 PR 4). */
export const MACHINE_SIGNIN_BACKEND = "claude-code" as const;
/** Why a request to a computer is refused before it starts, as codes the page turns into words and the command to run on that computer. */
export type MachineRefusal = "machine_unknown" | "machine_offline" | "machine_unsupported" | "machine_accounts_off" | "machine_unreachable"
  | "machine_profile_not_owned" | "machine_busy" | "invalid_machine_target";

export interface MachineSignInTarget { machine: string; profile: string }
export interface MachineSignInSnapshot {
  selected: [typeof MACHINE_SIGNIN_BACKEND];
  pending: Array<typeof MACHINE_SIGNIN_BACKEND>;
  skipped: [];
  states: Partial<Record<typeof MACHINE_SIGNIN_BACKEND, AuthCheckResult>>;
  login: StructuredSignInView | null;
  ready: boolean;
  /** Which computer and profile this is (an older page ignores it). */
  target: MachineSignInTarget;
}
export interface MachineSignInDeps {
  call: AccountCaller;
  /** The signed-in local admin session is still the one that asked. */
  current(owner: object): boolean;
  /** What that computer last reported about this profile (the inventory it sent, never asked again): whether it has the profile, if it is signed in, and whether its Runtime created it. */
  reported(machineId: string, profile: string): { exists: boolean; state: AuthCheckResult; created: boolean };
  /** Whether a request to this computer can be made now (known, online, its Runtime reports `remote-signin`, its owner's `accounts` switch is on), else why not. */
  readiness(machineId: string): Promise<MachineRefusal | null>;
  /** The name the computer's audit log records for this person (`admin:<handle>`); null refuses. */
  actor(owner: object): string | null;
  /** Safe event only: a computer's id, a profile name, a phase and a fixed reason. Never a URL, code, output or e-mail. */
  changed?(event: { machine: string; profile: string; phase: string; reason?: string }, owner: object, launched: boolean): void;
}
type Run = { owner: object; target: MachineSignInTarget; session: StructuredSignIn; transport: ReturnType<typeof createRuntimeSignInTransport>; lock: LoginWindowLock };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class MachineSignIns {
  private readonly runs = new Map<string, Run>();
  private readonly locks = new Map<string, LoginWindowLock>();
  private closed = false;
  constructor(private readonly deps: MachineSignInDeps) {}

  private lockOf(machine: string): LoginWindowLock { let lock = this.locks.get(machine); if (!lock) this.locks.set(machine, lock = new LoginWindowLock()); return lock; }
  private current(owner: object): boolean { return !this.closed && this.deps.current(owner); }
  private terminal(run: Run | undefined): boolean {
    if (!run) return true;
    const view = run.session.view(run.owner);
    return view.phase === "done" || (view.phase === "failed" && !!view.reason);
  }
  private cleanupFailed(run: Run | undefined): boolean { return !!run && run.session.view(run.owner).reason === "cleanup_failed"; }
  private validTarget(target: MachineSignInTarget): void {
    if (!target || typeof target.machine !== "string" || !/^[a-f0-9-]{36}$/.test(target.machine) || !validCredentialProfileName(target.profile)) throw new Error("invalid_machine_target");
  }
  /** Everything that can be refused before anything starts, with its reason (a short call to the computer for its switch, and nothing else). */
  async preflight(owner: object, target: MachineSignInTarget): Promise<void> {
    this.validTarget(target);
    const known = this.deps.reported(target.machine, target.profile);
    if (known.exists && !known.created) throw new Error("machine_profile_not_owned");
    const refusal = await this.deps.readiness(target.machine);
    if (!this.current(owner)) throw new Error("signin_session_expired");
    if (refusal) throw new Error(refusal);
  }

  snapshot(owner: object, target: MachineSignInTarget): MachineSignInSnapshot {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    this.validTarget(target);
    const run = this.runs.get(target.machine);
    const mine = run && same(run.target.profile, target.profile) ? run : undefined;
    const login = mine?.session.view(owner) ?? null;
    // After a finished sign-in the profile is signed in, whatever the inventory (re-reported by the computer a moment later) still says.
    const state: AuthCheckResult = login?.phase === "done" ? "valid" : this.deps.reported(target.machine, target.profile).state;
    return { selected: [MACHINE_SIGNIN_BACKEND], pending: state === "valid" ? [] : [MACHINE_SIGNIN_BACKEND], skipped: [], states: { [MACHINE_SIGNIN_BACKEND]: state },
      login, ready: this.terminal(mine), target: { machine: target.machine, profile: target.profile } };
  }

  /**
   * One start at a time per computer: a second request for the same computer waits for the first to be settled (running, joined or refused) and then looks at what is
   * there. Without it two starts that both find an attempt whose child could not be shown gone would both retry its close, and the one that finished last would reset the
   * lock and the run the other had just taken.
   */
  private readonly starting = new Map<string, Promise<unknown>>();
  begin(owner: object, target: MachineSignInTarget, relogin = false): Promise<MachineSignInSnapshot> {
    if (!this.current(owner)) return Promise.reject(new Error("signin_session_expired"));
    try { this.validTarget(target); } catch (error) { return Promise.reject(error); }
    const after = this.starting.get(target.machine) ?? Promise.resolve();
    const mine = after.then(() => this.beginNow(owner, target, relogin));
    const tail = mine.then(() => undefined, () => undefined);
    this.starting.set(target.machine, tail);
    void tail.then(() => { if (this.starting.get(target.machine) === tail) this.starting.delete(target.machine); });
    return mine;
  }
  private async beginNow(owner: object, target: MachineSignInTarget, relogin: boolean): Promise<MachineSignInSnapshot> {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    const previous = this.runs.get(target.machine);
    if (previous && !this.terminal(previous)) {
      if (previous.owner === owner && same(previous.target.profile, target.profile)) return this.snapshot(owner, target);   // a refresh or a double click joins
      throw new Error("machine_busy");
    }
    if (previous && this.cleanupFailed(previous)) {
      // The last attempt's child could not be shown gone (the computer was offline). Ask again; only a confirmed end frees the computer.
      try { await previous.transport.close(); } catch { throw new Error("signin_cleanup_failed"); }
      // Only if it is still the attempt that was retried: whatever took its place owns the lock and the run now.
      if (this.runs.get(target.machine) === previous) { previous.lock.close(); previous.lock.reopen(); this.runs.delete(target.machine); }
    }
    await this.preflight(owner, target);
    if (!this.current(owner)) throw new Error("signin_session_expired");
    const actor = this.deps.actor(owner);
    if (!actor) throw new Error("signin_session_expired");
    // Re-checked after the awaits: another request may have started one meanwhile (the reservation below is taken in the same step as this look).
    const racing = this.runs.get(target.machine);
    if (racing && !this.terminal(racing)) { if (racing.owner === owner && same(racing.target.profile, target.profile)) return this.snapshot(owner, target); throw new Error("machine_busy"); }
    const lock = this.lockOf(target.machine);
    const transport = createRuntimeSignInTransport({ machineId: target.machine, profile: target.profile, actor, call: this.deps.call });
    const session: StructuredSignIn = new StructuredSignIn(MACHINE_SIGNIN_BACKEND, owner, {
      lock, current: () => this.current(owner), transport, profile: target.profile,
      checkAuth: async () => (await runtimeAccountStatus(this.deps.call, target.machine, target.profile)).state,
      changed: event => { this.deps.changed?.({ machine: target.machine, profile: target.profile, phase: event.phase, ...(event.reason ? { reason: event.reason } : {}) }, owner, session.launched); },
    });
    const run: Run = { owner, target: { machine: target.machine, profile: target.profile }, session, transport, lock };
    this.runs.set(target.machine, run);
    await session.start(relogin);
    return this.snapshot(owner, target);
  }
  async input(owner: object, target: MachineSignInTarget, id: string, revision: number, action: SignInAction): Promise<MachineSignInSnapshot> {
    const run = this.runs.get(target.machine);
    if (!this.current(owner) || !run || run.owner !== owner || !same(run.target.profile, target.profile)) throw new Error("signin_session_expired");
    const result = await run.session.action(owner, id, revision, action);
    if (result !== "accepted") throw new Error(`signin_action_${result}`);
    return this.snapshot(owner, target);
  }
  async cancel(owner: object, target: MachineSignInTarget): Promise<MachineSignInSnapshot> {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    const run = this.runs.get(target.machine);
    if (run && same(run.target.profile, target.profile)) {
      await run.session.cancel();
      if (this.cleanupFailed(run)) throw new Error("signin_cleanup_failed");
    }
    return this.snapshot(owner, target);
  }
  /** Whether a sign-in on this computer is running for this profile (Remove and Sign out refuse while it is). */
  signingIn(machine: string, profile: string): boolean {
    const run = this.runs.get(machine);
    return !!run && (!this.terminal(run) || this.cleanupFailed(run)) && same(run.target.profile, profile);
  }
  /** Any sign-in on this computer that is running or whose child was not shown gone. */
  busy(machine: string): boolean { const run = this.runs.get(machine); return !!run && (!this.terminal(run) || this.cleanupFailed(run)); }
  /** False means a credential writer may still exist on a computer: the caller must not report a clean shutdown. */
  async close(): Promise<boolean> {
    this.closed = true;
    let confirmed = true;
    for (const run of this.runs.values()) {
      await run.session.cancel();
      if (this.cleanupFailed(run)) confirmed = false;
    }
    for (const lock of this.locks.values()) lock.close();
    return confirmed;
  }
}
