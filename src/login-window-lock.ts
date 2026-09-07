/**
 * Fleet-wide "one login/install window at a time" reservation.
 *
 * Web login, the legacy relay login and /install-cli all share this lock. The
 * claim is SYNCHRONOUS and must be taken before the caller's first await
 * (auth pre-check, tmux ensureSession, …) — a check-then-await-then-claim
 * sequence lets two concurrent starts both pass (sol B1). Release is
 * identity-safe: only the holder of the exact claim object can release it, so
 * a late failure of an old attempt can never free a newer owner's slot.
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

  get current(): LoginWindowClaim | null { return this.owner; }
  get isHeld(): boolean { return this.owner !== null; }

  /** Take the window now, or null when it is held. Never awaits. */
  tryClaim(kind: LoginWindowKind, backend: string): LoginWindowClaim | null {
    if (this.owner) return null;
    this.owner = { id: ++this.seq, kind, backend };
    return this.owner;
  }

  /** Release only if `claim` is the current owner. Returns whether it was. */
  release(claim: LoginWindowClaim | null | undefined): boolean {
    if (!claim || this.owner !== claim) return false;
    this.owner = null;
    return true;
  }

  /** The user-facing reason a new window cannot open right now. */
  busyMessage(): string {
    const o = this.owner;
    if (!o) return t("login.no_session");
    return o.kind === "install" ? t("install.busy") : t("login.busy", o.backend);
  }
}
