/**
 * "One login/install window per runtime at a time" reservation (AGEND-203).
 *
 * It used to be one window for the whole fleet, so a Claude Code sign-in nobody had finished refused a Grok sign-in. Each backend's credentials are
 * its own: two backends' windows never write the same files, so they no longer wait for each other. What stays exclusive:
 *   - a backend: sign-in, install, keep-alive, sign-out and Remove of ONE backend's accounts (default and named alike — they share its store and its CLI);
 *   - an install: at most one at a time on the host (one installer window, one handoff).
 * Callers that keep a single session of their own (the chat/terminal controller, the installer) say so themselves.
 *
 * Web login and the install `/login` runs all share this lock. The
 * claim is SYNCHRONOUS and must be taken before the caller's first await
 * (auth pre-check, tmux ensureSession, …) — a check-then-await-then-claim
 * sequence lets two concurrent starts both pass (sol B1, round 1).
 *
 * Ownership rules (sol round 2):
 *   - every post-claim exit must release, or transfer the claim to a published
 *     session that releases it on its own end — callers wrap the region in
 *     try/finally so a throwing factory/ensureSession cannot leak it;
 *   - release is identity-safe: only the exact claim object frees the slot;
 *   - `close()` (fleet shutdown) invalidates the current claim and refuses new
 *     ones; a continuation that resumes after an await must check
 *     `isCurrent(claim)` before publishing/starting anything. `reopen()`
 *     serves an in-process restart.
 */
import { t } from "./locale.js";

/** "keepalive" (#3292): a few seconds of `claude auth status` / `codex app-server` refreshing one idle sign-in. */
export type LoginWindowKind = "web" | "install" | "keepalive";

export interface LoginWindowClaim {
  readonly id: number;
  readonly kind: LoginWindowKind;
  readonly backend: string;
}

export class LoginWindowLock {
  private readonly owners = new Map<string, LoginWindowClaim>();
  private seq = 0;
  private closed = false;

  /** The window held on `backend`, if any. */
  heldFor(backend: string): LoginWindowClaim | null { return this.owners.get(backend) ?? null; }
  /** Every window held now (one per backend at most). */
  get held(): LoginWindowClaim[] { return [...this.owners.values()]; }
  get isHeld(): boolean { return this.owners.size > 0; }
  get isClosed(): boolean { return this.closed; }

  /** Take the backend's window now, or null when it is held (or an install is, for an install), or the lock is closed. Never awaits. */
  tryClaim(kind: LoginWindowKind, backend: string): LoginWindowClaim | null {
    if (this.closed || this.owners.has(backend)) return null;
    if (kind === "install" && [...this.owners.values()].some(o => o.kind === "install")) return null;
    const claim: LoginWindowClaim = { id: ++this.seq, kind, backend };
    this.owners.set(backend, claim);
    return claim;
  }

  /** True while `claim` is the live owner of its backend's window and the lock is open — the condition for continuing after an await. */
  isCurrent(claim: LoginWindowClaim | null | undefined): boolean {
    return !!claim && this.owners.get(claim.backend) === claim && !this.closed;
  }

  /** Release only if `claim` is the current owner. Returns whether it was. */
  release(claim: LoginWindowClaim | null | undefined): boolean {
    if (!claim || this.owners.get(claim.backend) !== claim) return false;
    this.owners.delete(claim.backend);
    return true;
  }

  /** Fleet shutdown: invalidate whatever is held (its continuation will see !isCurrent) and refuse new claims. */
  close(): void {
    this.closed = true;
    this.owners.clear();
  }

  /** In-process restart: accept claims again. */
  reopen(): void {
    this.closed = false;
  }

  /** The window a claim for `backend` is refused by: its own holder, else the install in progress (an install claim only). */
  holderFor(backend: string): LoginWindowClaim | null {
    return this.owners.get(backend) ?? [...this.owners.values()].find(w => w.kind === "install") ?? null;
  }

  /**
   * The user-facing reason a window for `backend` cannot open right now. An install claim that was refused because ANOTHER backend's install runs has no
   * window of its own on `backend`: the answer names the install.
   */
  busyMessage(backend?: string): string {
    if (this.closed) return t("login.web_shutting_down");
    const o = (backend !== undefined ? this.owners.get(backend) : undefined) ?? [...this.owners.values()].find(w => w.kind === "install") ?? [...this.owners.values()][0];
    if (!o) return t("login.no_session");
    return o.kind === "install" ? t("install.busy") : t("login.busy", o.backend);
  }
}
