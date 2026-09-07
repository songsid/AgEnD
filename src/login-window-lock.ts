/**
 * Fleet-wide "one login/install window at a time" reservation.
 *
 * Web login, the legacy relay login and /install-cli all share this lock. The
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

export type LoginWindowKind = "web" | "relay" | "install";

export interface LoginWindowClaim {
  readonly id: number;
  readonly kind: LoginWindowKind;
  readonly backend: string;
}

export class LoginWindowLock {
  private owner: LoginWindowClaim | null = null;
  private seq = 0;
  private closed = false;

  get current(): LoginWindowClaim | null { return this.owner; }
  get isHeld(): boolean { return this.owner !== null; }
  get isClosed(): boolean { return this.closed; }

  /** Take the window now, or null when it is held or the lock is closed. Never awaits. */
  tryClaim(kind: LoginWindowKind, backend: string): LoginWindowClaim | null {
    if (this.closed || this.owner) return null;
    this.owner = { id: ++this.seq, kind, backend };
    return this.owner;
  }

  /** True while `claim` is the live owner and the lock is open — the condition for continuing after an await. */
  isCurrent(claim: LoginWindowClaim | null | undefined): boolean {
    return !!claim && this.owner === claim && !this.closed;
  }

  /** Release only if `claim` is the current owner. Returns whether it was. */
  release(claim: LoginWindowClaim | null | undefined): boolean {
    if (!claim || this.owner !== claim) return false;
    this.owner = null;
    return true;
  }

  /** Fleet shutdown: invalidate whatever is held (its continuation will see !isCurrent) and refuse new claims. */
  close(): void {
    this.closed = true;
    this.owner = null;
  }

  /** In-process restart: accept claims again. */
  reopen(): void {
    this.closed = false;
  }

  /** The user-facing reason a new window cannot open right now. */
  busyMessage(): string {
    if (this.closed) return t("login.web_shutting_down");
    const o = this.owner;
    if (!o) return t("login.no_session");
    return o.kind === "install" ? t("install.busy") : t("login.busy", o.backend);
  }
}
