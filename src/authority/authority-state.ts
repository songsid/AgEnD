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
import { quickLinkEffective } from "./web-authority.js";

export interface AuthorityState {
  /** The switch, as in force (false while the state cannot be written). */
  enabled: boolean;
  loopbackOnly: boolean;
  /** §0.2 (#2453): sessions over the admin's named tunnel may qualify (false while the state cannot be written). */
  namedLink: boolean;
  /** §0.3: sessions over the temporary public link may qualify (false while the state cannot be written). */
  quickLink: boolean;
  /** The current revocation epoch: authority granted under an older one reads as none. */
  epoch: number;
  /** #2453: this read saw the named-link option go off (the fleet then drops the named-link sessions' authorizations). */
  namedLinkClosed?: true;
  /** §0.3: this read saw the quick-link option go off (the fleet then drops the quick-link sessions' authorizations). */
  quickLinkClosed?: true;
}

/**
 * `named_link`: the option as last seen; `named_link_seen`: it has been on before. Turning it back on moves the epoch
 * (§0.2: a receipt read as none while it was off never comes back); the first time does not — no such receipt exists,
 * and nothing local is revoked by opening the option. `quick_link` (§0.3): the temporary public link's option as in
 * force (its explicit value, else the release default). Unlike the named link, EVERY time it goes from off to on — the
 * first included — moves the epoch: §0.3 has every widening bump it in the same write (#2525 review).
 */
interface Stored {
  v: 1; epoch: number; enabled: boolean; loopback_only: boolean; named_link?: boolean; named_link_seen?: boolean;
  quick_link?: boolean;
}

const same = (a: Stored, b: Stored) => a.epoch === b.epoch && a.enabled === b.enabled && a.loopback_only === b.loopback_only
  && !!a.named_link === !!b.named_link && !!a.named_link_seen === !!b.named_link_seen
  && !!a.quick_link === !!b.quick_link;
const optional = (v: unknown) => v === undefined || typeof v === "boolean";

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
      if (v.v === 1 && Number.isSafeInteger(v.epoch) && (v.epoch as number) >= floor && typeof v.enabled === "boolean" && typeof v.loopback_only === "boolean"
        && optional(v.named_link) && optional(v.named_link_seen) && optional(v.quick_link)) {
        this.want = { v: 1, epoch: v.epoch as number, enabled: v.enabled, loopback_only: v.loopback_only,
          ...(v.named_link ? { named_link: true } : {}), ...(v.named_link || v.named_link_seen ? { named_link_seen: true } : {}),
          ...(v.quick_link ? { quick_link: true } : {}) };
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
    const namedLink = config?.named_link === true;                                                       // §0.2: off by default
    const quickLink = quickLinkEffective(config);                                                        // §0.3: off by default
    const reopened = (namedLink && !s.named_link && !!s.named_link_seen) || (quickLink && !s.quick_link);   // §0.3: every widening
    const closed = !!s.named_link && !namedLink, quickClosed = !!s.quick_link && !quickLink;
    const revokes = s.enabled !== enabled || (s.loopback_only && !loopbackOnly) || reopened;
    if (revokes || s.loopback_only !== loopbackOnly || !!s.named_link !== namedLink || !!s.quick_link !== quickLink) {
      this.want = { v: 1, epoch: s.epoch + (revokes ? 1 : 0), enabled, loopback_only: loopbackOnly,
        ...(namedLink ? { named_link: true } : {}), ...(namedLink || s.named_link_seen ? { named_link_seen: true } : {}),
        ...(quickLink ? { quick_link: true } : {}) };
    }
    const durable = this.flush();
    // Not written: off, and still "only this computer" if it was (a loosening that did not stick does not apply).
    const seenClosed = { ...(closed ? { namedLinkClosed: true as const } : {}), ...(quickClosed ? { quickLinkClosed: true as const } : {}) };
    return durable ? { enabled, loopbackOnly, namedLink, quickLink, epoch: this.want!.epoch, ...seenClosed }
      : { enabled: false, loopbackOnly: loopbackOnly || (this.disk?.loopback_only ?? true), namedLink: false, quickLink: false, epoch: this.want!.epoch, ...seenClosed };
  }

  /** An explicit revocation: every web authority given so far reads as none. `durable`: it is on disk. */
  revoke(): { epoch: number; durable: boolean } {
    const s = this.load();
    this.want = { ...s, epoch: s.epoch + 1 };
    return { epoch: this.want.epoch, durable: this.flush() };
  }
}
