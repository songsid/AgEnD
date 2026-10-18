/**
 * #1939 §10: what revokes web authority, kept beside the fleet in `web-authority.json`: the revocation epoch, and the
 * switch positions it was last seen at. Every web-session receipt carries the epoch it was granted under; delivery_status
 * reads it as none once the epoch has moved past it.
 *
 * The epoch moves on an explicit revocation (`/web revoke`, Settings), and whenever the configuration is seen to have
 * turned the switch on or off or turned "Only this computer can authorize" off — however it changed (Settings, an edited
 * fleet.yaml, even while the fleet was stopped: the last positions are on disk). So a receipt from before the switch went
 * off never comes back, and neither does a `lan` one after loopback_only was on. Fail-closed: while the new state cannot
 * be written, the switch counts as off.
 */
import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../atomic-write.js";
import type { WebVerifiedAuthorityConfig } from "../types.js";

export interface AuthorityState {
  /** The switch, as in force (false while the state cannot be written). */
  enabled: boolean;
  loopbackOnly: boolean;
  /** The current revocation epoch: authority granted under an older one reads as none. */
  epoch: number;
}

interface Stored { v: 1; epoch: number; enabled: boolean; loopback_only: boolean }

const same = (a: Stored, b: Stored) => a.epoch === b.epoch && a.enabled === b.enabled && a.loopback_only === b.loopback_only;

export interface AuthorityStateIo {
  read(path: string): string;
  write(path: string, data: string): void;
}
const fileIo: AuthorityStateIo = { read: p => readFileSync(p, "utf8"), write: (p, d) => atomicWriteFileSync(p, d, { mode: 0o600 }) };

export class AuthorityStateStore {
  /** What should be on disk. */
  private want: Stored | null = null;
  /** What was last read from or written to disk (null: nothing yet, or unreadable). */
  private disk: Stored | null = null;
  private warned = false;

  constructor(private readonly path: string, private readonly log: { warn(obj: object, msg?: string): void }, private readonly io: AuthorityStateIo = fileIo, private readonly now: () => number = Date.now) {}

  private load(): Stored {
    if (this.want) return this.want;
    let raw: string | null = null;
    try { raw = this.io.read(this.path); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") { this.want = { v: 1, epoch: 0, enabled: false, loopback_only: false }; this.disk = { ...this.want }; return this.want; }
    }
    try {
      const v = JSON.parse(raw ?? "") as Partial<Stored>;
      if (v.v === 1 && Number.isSafeInteger(v.epoch) && (v.epoch as number) >= 0 && typeof v.enabled === "boolean" && typeof v.loopback_only === "boolean") {
        this.want = { v: 1, epoch: v.epoch as number, enabled: v.enabled, loopback_only: v.loopback_only };
        this.disk = { ...this.want };
        return this.want;
      }
    } catch { /* below */ }
    // Unreadable: the old epoch is unknown, so move past any it could have been (a counter far below the clock's seconds).
    this.log.warn({ path: this.path }, "Web authority state unreadable; every earlier web authority is revoked");
    this.want = { v: 1, epoch: Math.floor(this.now() / 1000), enabled: false, loopback_only: false };
    return this.want;
  }

  /** Write what should be on disk; false when it could not be (the caller then fails closed). */
  private flush(): boolean {
    const want = this.want!;
    if (this.disk && same(this.disk, want)) return true;
    try {
      this.io.write(this.path, JSON.stringify(want) + "\n");
      this.disk = { ...want };
      this.warned = false;
      return true;
    } catch (err) {
      if (!this.warned) this.log.warn({ err: (err as Error).message, path: this.path }, "Web authority state could not be written; web authority is off until it can be");
      this.warned = true;
      return false;
    }
  }

  /** The state in force for this configuration. A switch change since last seen moves the epoch first. */
  current(config: WebVerifiedAuthorityConfig | undefined): AuthorityState {
    const s = this.load();
    const enabled = config?.enabled === true, loopbackOnly = config?.loopback_only === true;
    const revokes = s.enabled !== enabled || (s.loopback_only && !loopbackOnly);
    if (revokes || s.loopback_only !== loopbackOnly) this.want = { v: 1, epoch: s.epoch + (revokes ? 1 : 0), enabled, loopback_only: loopbackOnly };
    const durable = this.flush();
    // Not written: off, and still "only this computer" if it was (a loosening that did not stick does not apply).
    return durable ? { enabled, loopbackOnly, epoch: this.want!.epoch }
      : { enabled: false, loopbackOnly: loopbackOnly || (this.disk?.loopback_only ?? true), epoch: this.want!.epoch };
  }

  /** An explicit revocation: every web authority given so far reads as none. `durable`: it is on disk. */
  revoke(): { epoch: number; durable: boolean } {
    const s = this.load();
    this.want = { ...s, epoch: s.epoch + 1 };
    return { epoch: this.want.epoch, durable: this.flush() };
  }
}
