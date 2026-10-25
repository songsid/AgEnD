/** Shared pre-fleet/dashboard orchestration. Contains no fleet or HTTP authority. */
import { StructuredSignIn, structuredSignInSupported, type StructuredBackend,
  type SignInAction, type StructuredSignInTransport, type StructuredSignInView } from "./structured-signin.js";
import { LoginWindowLock } from "./login-window-lock.js";
import type { AuthCheckResult } from "./login-flows.js";
import { onboardingBackends, readPendingBackendSignIns, writePendingBackendSignIns,
  type OnboardingBackend, type PendingBackendSignIns } from "./backend-signin-pending.js";

export interface BrowserBackendSignInDeps {
  dataDir: string;
  selected?: readonly OnboardingBackend[];
  current(owner: object): boolean;
  installed(): Promise<readonly string[]>;
  checkAuth(backend: StructuredBackend): Promise<AuthCheckResult>;
  transport(backend: StructuredBackend): StructuredSignInTransport;
  lock?: LoginWindowLock;
  changed?(event: { backend: StructuredBackend; phase: string; reason?: string }, owner: object, launched: boolean): void;
}
export interface BrowserBackendSignInSnapshot {
  selected: OnboardingBackend[];
  pending: OnboardingBackend[];
  skipped: OnboardingBackend[];
  states: Partial<Record<OnboardingBackend, AuthCheckResult | "console_only" | "not_installed">>;
  login: StructuredSignInView | null;
  ready: boolean;
}
type Run = { owner: object; backend: StructuredBackend; session: StructuredSignIn };

export class BrowserBackendSignIns {
  private record: PendingBackendSignIns;
  private readonly skipped = new Set<OnboardingBackend>();
  private readonly states: BrowserBackendSignInSnapshot["states"] = {};
  private readonly lock: LoginWindowLock;
  private run: Run | null = null;
  private closed = false;
  private refreshInFlight: Promise<void> | null = null;
  private refreshed = false;
  private checklistRevision = 0;

  constructor(private readonly deps: BrowserBackendSignInDeps) {
    const old = readPendingBackendSignIns(deps.dataDir);
    const selected = onboardingBackends(deps.selected ? [...deps.selected] : old.selected);
    if (!selected) throw new Error("invalid_signin_checklist");
    // Probes, not an old record, decide which credentials can be reused.
    this.record = { version: 1, selected, pending: [...selected] };
    this.lock = deps.lock ?? new LoginWindowLock();
  }
  private current(owner: object): boolean { return !this.closed && this.deps.current(owner); }
  private terminal(run: Run | null): boolean {
    if (!run) return true;
    const view = run.session.view(run.owner);
    // A parser may report failed before its async cleanup finishes. Only the
    // final safe reason (or done) proves that finish has settled the writer.
    return view.phase === "done" || (view.phase === "failed" && !!view.reason);
  }
  get activeBackend(): StructuredBackend | null { return this.run && !this.terminal(this.run) ? this.run.backend : null; }
  private loginMayWrite(backend: OnboardingBackend): boolean {
    return this.lock.current?.backend === backend || (this.run?.backend === backend
      && (!this.terminal(this.run) || this.run.session.view(this.run.owner).reason === "cleanup_failed"));
  }
  get ready(): boolean {
    return this.terminal(this.run) && this.run?.session.view(this.run.owner).reason !== "cleanup_failed"
      && this.record.pending.every(backend => this.skipped.has(backend));
  }
  private persist(): void { writePendingBackendSignIns(this.deps.dataDir, this.record); }
  snapshot(owner: object): BrowserBackendSignInSnapshot {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    return { selected: [...this.record.selected], pending: [...this.record.pending], skipped: [...this.skipped],
      states: { ...this.states }, login: this.run?.session.view(owner) ?? null, ready: this.ready };
  }
  async refresh(owner: object, force = false): Promise<BrowserBackendSignInSnapshot> {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    do {
      if ((!this.refreshed || force) && !this.refreshInFlight) {
        const revision = this.checklistRevision, selected = [...this.record.selected];
        const current = () => this.current(owner) && revision === this.checklistRevision;
        this.refreshInFlight = (async () => {
          const installed = await this.deps.installed();
          if (!current()) return;
          const checked: BrowserBackendSignInSnapshot["states"] = {};
          for (const backend of selected) {
            const status = !installed.includes(backend) ? "not_installed" : !structuredSignInSupported(backend)
              ? "console_only" : this.loginMayWrite(backend) ? "unknown" : await this.deps.checkAuth(backend);
            if (!current()) return;
            checked[backend] = status;
          }
          // Publish the whole scan only while it still owns this checklist.
          Object.assign(this.states, checked);
          this.record.pending = selected.filter(backend => checked[backend] !== "valid");
          this.persist(); this.refreshed = true;
        })().finally(() => { this.refreshInFlight = null; });
      }
      force = false;
      await this.refreshInFlight;
      if (!this.current(owner)) throw new Error("signin_session_expired");
      // A select or completed login superseded the scan: join one fresh scan.
    } while (!this.refreshed);
    return this.snapshot(owner);
  }
  async select(owner: object, values: unknown): Promise<BrowserBackendSignInSnapshot> {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    const selected = onboardingBackends(values);
    if (!selected) throw new Error("invalid_signin_checklist");
    if (this.run && !selected.includes(this.run.backend)) await this.cancel(owner);
    if (!this.current(owner)) throw new Error("signin_session_expired");
    this.checklistRevision++;
    for (const backend of this.record.selected) if (!selected.includes(backend)) delete this.states[backend];
    const prior = this.record.selected;
    this.record = { version: 1, selected, pending: selected.filter(backend => !prior.includes(backend) || this.record.pending.includes(backend)) };
    this.persist(); this.refreshed = false;
    return this.refresh(owner);
  }
  async begin(owner: object, backend: string, relogin = false): Promise<BrowserBackendSignInSnapshot> {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    if (!structuredSignInSupported(backend) || !this.record.selected.includes(backend)) throw new Error("signin_console_only");
    if (this.run?.session.view(this.run.owner).reason === "cleanup_failed") throw new Error("signin_cleanup_failed");
    if (this.run && !this.terminal(this.run)) return this.snapshot(owner); // refresh/double click joins
    const session = new StructuredSignIn(backend, owner, {
      lock: this.lock, current: () => this.current(owner), transport: this.deps.transport(backend),
      checkAuth: () => this.deps.checkAuth(backend),
      changed: event => {
        if ((event.phase === "done" || (event.phase === "failed" && event.reason))
          && this.current(owner) && this.run?.session === session) {
          this.checklistRevision++; this.refreshed = false;
          this.states[backend] = event.phase === "done" ? "valid" : "unknown";
          this.record.pending = event.phase === "done" ? this.record.pending.filter(value => value !== backend)
            : [...new Set([...this.record.pending, backend])];
          this.persist();
        }
        this.deps.changed?.(event, owner, session.launched);
      },
    });
    const run: Run = { session, owner, backend }; this.run = run; // reserve before the installed await
    this.checklistRevision++; this.refreshed = false;
    this.record.pending = [...new Set([...this.record.pending, backend])]; this.skipped.delete(backend); this.persist();
    const installed = await this.deps.installed();
    if (!this.current(owner) || this.run !== run) { await session.cancel(); throw new Error("signin_session_expired"); }
    if (!installed.includes(backend)) { await session.cancel(); this.states[backend] = "not_installed"; return this.snapshot(owner); }
    await session.start(relogin);
    return this.snapshot(owner);
  }
  async input(owner: object, id: string, revision: number, action: SignInAction): Promise<BrowserBackendSignInSnapshot> {
    if (!this.current(owner) || !this.run || this.run.owner !== owner) throw new Error("signin_session_expired");
    const result = await this.run.session.action(owner, id, revision, action);
    if (result !== "accepted") throw new Error(`signin_action_${result}`);
    return this.snapshot(owner);
  }
  async cancel(owner: object): Promise<BrowserBackendSignInSnapshot> {
    if (!this.current(owner)) throw new Error("signin_session_expired");
    const run = this.run;
    if (run) await run.session.cancel();
    if (run?.session.view(owner).reason === "cleanup_failed") throw new Error("signin_cleanup_failed");
    return this.snapshot(owner);
  }
  async skip(owner: object, backend: string): Promise<BrowserBackendSignInSnapshot> {
    if (!this.current(owner) || !this.record.selected.includes(backend as OnboardingBackend)) throw new Error("invalid_signin_checklist");
    if (this.run?.backend === backend) await this.cancel(owner);
    if (!this.current(owner)) throw new Error("signin_session_expired");
    this.skipped.add(backend as OnboardingBackend); this.persist();
    return this.snapshot(owner);
  }
  /** False means a credential writer may still exist: the caller must not hand over. */
  async close(): Promise<boolean> {
    this.closed = true;
    const run = this.run;
    if (run) await run.session.cancel();
    return run?.session.view(run.owner).reason !== "cleanup_failed";
  }
}
