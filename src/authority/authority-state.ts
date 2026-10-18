/**
 * #1939 §10: what revokes web authority, kept beside the fleet in `web-authority.json`: the revocation epoch, and the
 * switch positions it was last seen at. Every web-session receipt carries the epoch it was granted under; delivery_status
 * reads it as none once the epoch has moved past it.
 *
 * The epoch moves on an explicit revocation (`/web revoke`, Settings), and whenever the configuration is seen to have
 * turned the switch on or off or turned "Only this computer can authorize" off — however it changed (Settings, an edited
 * fleet.yaml, even while the fleet was stopped: the last positions are on disk). So a receipt from before the switch went
 * off never comes back, and neither does a `lan` one after loopback_only was on. Fail-closed: while the new state cannot
 * be written, the switch counts as off. The file is never trusted to be behind the receipts: one deleted, or restored from
 * an older copy, whose epoch is below one a stored receipt carries is treated as unreadable.
 *
 * Limits (#2112 review): a state that could not be written is lost on a restart (the file read back is the one last
 * saved, so a revocation that never reached it is undone); and a change the fleet never sees (the switch turned off and
 * back on while it was stopped) moves nothing — `/web revoke` covers both.
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

  /** `floor`: the highest epoch a stored receipt carries (delivery-outbox maxWebAuthorityEpoch); the file must not be behind it. */
  constructor(private readonly path: string, private readonly log: { warn(obj: object, msg?: string): void }, private readonly io: AuthorityStateIo = fileIo,
    private readonly now: () => number = Date.now, private readonly floor: () => number = () => 0) {}

  private load(): Stored {
    if (this.want) return this.want;
    let raw: string | null = null, missing = false;
    try { raw = this.io.read(this.path); } catch (err) { missing = (err as NodeJS.ErrnoException).code === "ENOENT"; }
    let floor = 0;
    try { floor = this.floor(); } catch { floor = Number.MAX_SAFE_INTEGER; }        // unknown: never trust the file
    if (missing && floor === 0) { this.want = { v: 1, epoch: 0, enabled: false, loopback_only: false }; this.disk = { ...this.want }; return this.want; }
    try {
      const v = JSON.parse(raw ?? "") as Partial<Stored>;
      if (v.v === 1 && Number.isSafeInteger(v.epoch) && (v.epoch as number) >= floor && typeof v.enabled === "boolean" && typeof v.loopback_only === "boolean") {
        this.want = { v: 1, epoch: v.epoch as number, enabled: v.enabled, loopback_only: v.loopback_only };
        this.disk = { ...this.want };
        return this.want;
      }
    } catch { /* below */ }
    // Unreadable, missing or behind the receipts: the real epoch is unknown, so move past any it could have been (a
    // counter far below the clock's seconds), and start from off.
    this.log.warn({ path: this.path, missing, floor }, "Web authority state unreadable, missing or older than the receipts; every earlier web authority is revoked");
    this.want = { v: 1, epoch: Math.max(Math.floor(this.now() / 1000), floor === Number.MAX_SAFE_INTEGER ? 0 : floor + 1), enabled: false, loopback_only: false };
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
      if (!this.warned) this.log.warn({ err: (err as Error).message, path: this.path }, "Web authority state could not be written; web authority is off until it can be (a restart before then reads back the state last saved)");
      this.warned = true;
      return false;
    }
  }

  /** The state in force for this configuration. A switch change since last seen moves the epoch first. */
  current(config: WebVerifiedAuthorityConfig | undefined): AuthorityState {
    const s = this.load();
    const enabled = config?.enabled !== false, loopbackOnly = config?.loopback_only === true;            // §0.1: on by default
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
