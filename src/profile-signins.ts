/**
 * #3212: dashboard sign-in for a NAMED account (credential profile) on this host — the same controls as the default account's (#2599 `StructuredSignIn`: press
 * Sign in, open the provider's page, paste the code back), instead of the old web-terminal flow (a temporary public link, a terminal page, a one-time access code).
 *
 * It is `StructuredSignIn` with one more fact — which profile — and the host's own `LoginWindowLock`, so a named account's sign-in is exclusive with every other
 * credential writer on this host (the default account's sign-in, chat's `/login`, an install, a logout, a Keep-alive renewal). It owns:
 *  - one sign-in at a time on the host (the lock is host-wide whatever this says);
 *  - the name check, before anything starts (`structuredSignInProfileEnvironment` repeats it where the folder is made — the transport is never trusted with a name);
 *  - a snapshot in the shape the sign-in cards already read (`selected`, `pending`, `states`, `login`), plus which account it is for. It is NOT the default account's
 *    checklist: nothing here is written to the pending list, so signing a named account in never marks the default one done or "Needs you".
 *
 * Never kept or logged here: a sign-in URL, a code, the CLI's output or an e-mail address. The view carries the URL to the one admin session that started the sign-in.
 */
import { StructuredSignIn, structuredSignInSupported, type SignInAction, type StructuredBackend, type StructuredSignInTransport, type StructuredSignInView } from "./structured-signin.js";
import { LoginWindowLock } from "./login-window-lock.js";
import type { AuthCheckResult } from "./login-flows.js";
import { isCredentialProfileName } from "./backend/credential-profile.js";
import { STRUCTURED_PROFILE_BACKENDS } from "./structured-signin-transport.js";

export interface ProfileSignInTarget { backend: string; profile: string }
export interface ProfileSignInSnapshot {
  selected: [StructuredBackend];
  pending: StructuredBackend[];
  skipped: [];
  states: Partial<Record<StructuredBackend, AuthCheckResult | "not_installed">>;
  login: StructuredSignInView | null;
  ready: boolean;
  /** Which account this is (an older page ignores it). */
  target: ProfileSignInTarget;
}
export interface ProfileSignInDeps {
  /** The signed-in local admin session is still the one that asked. */
  current(owner: object): boolean;
  /** The host's own login window: the one every credential writer shares. */
  lock: LoginWindowLock;
  installed(backend: StructuredBackend): Promise<boolean>;
  /** A token-free probe of THIS account's login (its folder's variable), never the default one's. */
  checkAuth(backend: StructuredBackend, profile: string): Promise<AuthCheckResult>;
  /** The dedicated PTY for one attempt, given the target (so it can be built for that profile's folder). */
  transport(target: ProfileSignInTarget): StructuredSignInTransport;
  /** Safe event only: a backend, a profile NAME, a phase and a fixed reason. Never a URL, code, output or e-mail. */
  changed?(event: { backend: StructuredBackend; profile: string; phase: string; reason?: string }, owner: object, launched: boolean): void;
}
type Run = { owner: object; target: ProfileSignInTarget & { backend: StructuredBackend }; session: StructuredSignIn };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const keyOf = (backend: string, profile: string): string => `${backend}\0${profile.toLowerCase()}`;

export class ProfileSignIns {
  private run: Run | null = null;
  private closed = false;
  /** What the last probe said, by account; dropped when a run on it ends and when asked to read again (one probe per poll would be a process a second). */
  private readonly states = new Map<string, AuthCheckResult | "not_installed">();
  private reading: Promise<void> | null = null;

  constructor(private readonly deps: ProfileSignInDeps) {}

  private current(owner: object): boolean { return !this.closed && this.deps.current(owner); }
  private terminal(run: Run | null): boolean {
    if (!run) return true;
    const view = run.session.view(run.owner);
    // A parser may report failed before its async cleanup finishes. Only the final safe reason (or done) proves that finish has settled the writer.
    return view.phase === "done" || (view.phase === "failed" && !!view.reason);
  }
  private cleanupFailed(run: Run | null): boolean { return !!run && run.session.view(run.owner).reason === "cleanup_failed"; }
  private valid(target: ProfileSignInTarget): asserts target is ProfileSignInTarget & { backend: StructuredBackend } {
    if (!target || typeof target.backend !== "string" || typeof target.profile !== "string" || !structuredSignInSupported(target.backend)
      || !STRUCTURED_PROFILE_BACKENDS.has(target.backend) || !isCredentialProfileName(target.profile)) throw new Error("invalid_signin_target");
  }

  /** The probe, once at a time per account, cached until `force`. A probe that throws is "unknown", never a dead end. */
  private async read(owner: object, target: ProfileSignInTarget & { backend: StructuredBackend }, force: boolean): Promise<void> {
    const key = keyOf(target.backend, target.profile);
    while (this.reading) await this.reading;   // one probe at a time on the host; a poll that waited then sees what the one before it found
    if (!force && this.states.has(key)) return;
    const mine = (async () => {
      let state: AuthCheckResult | "not_installed";
      try {
        if (!(await this.deps.installed(target.backend))) state = "not_installed";
        // While this account's own sign-in writes, its login is mid-change: say nothing rather than a half-written answer.
        else if (this.run && !this.terminal(this.run) && same(this.run.target.profile, target.profile) && this.run.target.backend === target.backend) state = "unknown";
        else state = await this.deps.checkAuth(target.backend, target.profile);
      } catch { state = "unknown"; }
      if (this.current(owner)) this.states.set(key, state);
    })().finally(() => { if (this.reading === mine) this.reading = null; });
    this.reading = mine;
    await mine;
  }

  snapshot(owner: object, target: ProfileSignInTarget): ProfileSignInSnapshot {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    this.valid(target);
    const run = this.run && this.run.target.backend === target.backend && same(this.run.target.profile, target.profile) ? this.run : null;
    const login = run?.session.view(owner) ?? null;
    // After a finished sign-in the account is signed in, whatever an older probe said.
    const known = this.states.get(keyOf(target.backend, target.profile)) ?? "unknown";
    const state = login?.phase === "done" ? "valid" : known;
    // `ready` is what the cards turn into "You can continue": here, only once the account is signed in and no attempt is in flight (as the default account's, whose
    // `ready` is "nothing is pending"), not merely because nothing is running.
    return { selected: [target.backend], pending: state === "valid" ? [] : [target.backend], skipped: [], states: { [target.backend]: state },
      login, ready: this.terminal(run) && state === "valid", target: { backend: target.backend, profile: target.profile } };
  }
  /** What the page polls (GET): the snapshot, reading the account's state first when it has not been read since the last change. */
  async refresh(owner: object, target: ProfileSignInTarget, force = false): Promise<ProfileSignInSnapshot> {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    this.valid(target);
    await this.read(owner, target, force);
    return this.snapshot(owner, target);
  }

  async begin(owner: object, target: ProfileSignInTarget, relogin = false): Promise<ProfileSignInSnapshot> {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    this.valid(target);
    const previous = this.run;
    if (this.cleanupFailed(previous)) throw new Error("signin_cleanup_failed");
    if (previous && !this.terminal(previous)) {
      if (previous.owner === owner && previous.target.backend === target.backend && same(previous.target.profile, target.profile)) return this.snapshot(owner, target);   // a refresh or a double click joins
      throw new Error("signin_busy");
    }
    const key = keyOf(target.backend, target.profile);
    const session: StructuredSignIn = new StructuredSignIn(target.backend, owner, {
      lock: this.deps.lock, current: () => this.current(owner), transport: this.deps.transport({ backend: target.backend, profile: target.profile }), profile: target.profile,
      checkAuth: () => this.deps.checkAuth(target.backend, target.profile),
      changed: event => {
        if (event.phase === "done" || (event.phase === "failed" && event.reason)) {
          // Done: signed in. Failed or cancelled: what it was before is not known any more — the next read probes again.
          if (this.current(owner) && this.run?.session === session) { if (event.phase === "done") this.states.set(key, "valid"); else this.states.delete(key); }
        }
        this.deps.changed?.({ backend: target.backend, profile: target.profile, phase: event.phase, ...(event.reason ? { reason: event.reason } : {}) }, owner, session.launched);
      },
    });
    const run: Run = { session, owner, target: { backend: target.backend, profile: target.profile } };
    this.run = run;   // reserved before the awaits
    this.states.delete(key);
    let installed: boolean;
    try { installed = await this.deps.installed(target.backend); } catch { installed = false; }
    if (!this.current(owner) || this.run !== run) { await session.cancel(); throw new Error("signin_session_expired"); }
    if (!installed) { await session.cancel(); this.states.set(key, "not_installed"); return this.snapshot(owner, target); }
    await session.start(relogin);
    return this.snapshot(owner, target);
  }
  async input(owner: object, target: ProfileSignInTarget, id: string, revision: number, action: SignInAction): Promise<ProfileSignInSnapshot> {
    this.valid(target);
    const run = this.run;
    if (!this.current(owner) || !run || run.owner !== owner || run.target.backend !== target.backend || !same(run.target.profile, target.profile)) throw new Error("signin_session_expired");
    const result = await run.session.action(owner, id, revision, action);
    if (result !== "accepted") throw new Error(`signin_action_${result}`);
    return this.snapshot(owner, target);
  }
  async cancel(owner: object, target: ProfileSignInTarget): Promise<ProfileSignInSnapshot> {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    this.valid(target);
    const run = this.run;
    if (run && run.target.backend === target.backend && same(run.target.profile, target.profile)) {
      await run.session.cancel();
      if (this.cleanupFailed(run)) throw new Error("signin_cleanup_failed");
    }
    return this.snapshot(owner, target);
  }
  /**
   * End whatever sign-in this runs, whoever started it (`/login cancel`, "Cancel sign-in and remove"). Resolves to the account it was for, null when there was none;
   * false in `confirmed` means the CLI could not be shown gone (its slot stays reserved).
   */
  async cancelActive(): Promise<{ target: ProfileSignInTarget; confirmed: boolean } | null> {
    const run = this.run;
    if (!run || (this.terminal(run) && !this.cleanupFailed(run))) return null;
    await run.session.cancel();
    return { target: { ...run.target }, confirmed: !this.cleanupFailed(run) };
  }
  /**
   * #3321 review: end the running sign-in of exactly this account (`backend`, and `profile` compared as Remove compares it: case-insensitively) — what Remove's
   * "Cancel sign-in and remove" asks for — and nothing else: another account's sign-in is left alone. True when there was one to end (a child that could not be
   * shown gone is tried again; `signingIn` still says so afterwards, and Remove refuses on it).
   */
  async cancelAccount(backend: string, profile: string): Promise<boolean> {
    const run = this.run;
    if (!run || (this.terminal(run) && !this.cleanupFailed(run)) || run.target.backend !== backend || !same(run.target.profile, profile)) return false;
    await run.session.cancel();
    return true;
  }
  /** Whether a sign-in for this account is running (Remove and Sign out refuse while it is), or its child was not shown gone. */
  signingIn(backend: string, profile: string): boolean {
    const run = this.run;
    return !!run && (!this.terminal(run) || this.cleanupFailed(run)) && run.target.backend === backend && same(run.target.profile, profile);
  }
  /** The account being signed in, if any (null once it ended). */
  get active(): ProfileSignInTarget | null { return this.run && !this.terminal(this.run) ? { ...this.run.target } : null; }
  /** False means a credential writer may still exist: the caller must not hand over. */
  async close(): Promise<boolean> {
    this.closed = true;
    const run = this.run;
    if (run) await run.session.cancel();
    return !this.cleanupFailed(run);
  }
}
