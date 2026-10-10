/**
 * #1570: a browser that signed in before may ask the sign-in page for a fresh code, which goes privately to the person
 * whose `/dashboard` code it last redeemed. This deliberately bends `web-login.ts`'s "no outstanding code, nothing to
 * guess" rule, so the door is narrow (design baseline: #1570 issuecomment-6098782305):
 *
 * - **Only a returning device.** The cookie is set only after a sign-in whose code carried a `LoginCodeOwner` (a code
 *   `/dashboard` delivered privately). It is `<deviceId>.<HMAC>`: a 128-bit random id and a signature keyed from
 *   `web.token`. It names no chat or user; the owner lives in this registry, which keeps `sha256(deviceId)` only, so the
 *   file on disk cannot be replayed as a cookie.
 * - **Rotation and revoke.** The HMAC key and the recorded token epoch both come from `web.token`, so `agend web-token
 *   rotate` (from any process) makes every device cookie stop verifying. `/dashboard revoke` empties the registry.
 * - **Rate limits** live here too (`CodeRequestLimiter`), on a monotonic clock.
 *
 * Who receives the code, and whether they still may, is decided by the fleet (FleetManager.requestReturningCode).
 * Deliberately has no idea what an HTTP request is, beyond reading and building the cookie.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { LoginCodeOwner } from "./web-login.js";
import type { SessionSurface } from "./web-session.js";

export const DEVICE_COOKIE = "agend_device";
/** On https (and always on the public link): a `__Host-` cookie cannot be planted by a sibling site. */
export const DEVICE_COOKIE_SECURE = "__Host-agend_device";
export const DEVICE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_RETURNING_DEVICES = 16;

const ID_PATTERN = /^[0-9a-f]{32}$/;
const SIG_PATTERN = /^[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** What the registry knows about one returning device. No cookie value; the owner minus the live binding. */
export interface ReturningDevice {
  readonly idHash: string;
  readonly owner: { readonly adapterId: string; readonly userId: string; readonly chatId: string; readonly threadId?: string };
  readonly surface: SessionSurface;
  readonly label: string;
  readonly tokenEpoch: string;
  readonly created: number;
  readonly expires: number;
}

function signingKey(webToken: string): Buffer {
  return createHmac("sha256", webToken).update("agend returning device v1").digest();
}
function sign(deviceId: string, webToken: string): string {
  return createHmac("sha256", signingKey(webToken)).update(deviceId).digest("hex");
}
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function isDevice(v: unknown): v is ReturningDevice {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>, o = d.owner as Record<string, unknown> | undefined;
  return typeof d.idHash === "string" && HASH_PATTERN.test(d.idHash)
    && !!o && typeof o.adapterId === "string" && typeof o.userId === "string" && typeof o.chatId === "string"
    && (o.threadId === undefined || typeof o.threadId === "string")
    && (d.surface === "local" || d.surface === "gateway")
    && typeof d.label === "string" && d.label.length <= 80
    && typeof d.tokenEpoch === "string" && HASH_PATTERN.test(d.tokenEpoch)
    && typeof d.created === "number" && Number.isFinite(d.created) && typeof d.expires === "number" && Number.isFinite(d.expires);
}

export class ReturningDevices {
  private readonly byHash = new Map<string, ReturningDevice>();
  private readonly path: string | null;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(opts: { dataDir?: string; now?: () => number; onWarn?: (message: string) => void } = {}) {
    this.path = opts.dataDir ? join(opts.dataDir, "web-devices.json") : null;
    this.now = opts.now ?? Date.now;
    this.warn = opts.onWarn ?? (() => {});
    this.load();
  }

  get size(): number { return this.byHash.size; }

  /** Record this browser as a returning device of `owner`; the returned value is the cookie, given out once. */
  remember(owner: LoginCodeOwner, input: { surface: SessionSurface; label: string; tokenEpoch: string; webToken: string }): string {
    const deviceId = randomBytes(16).toString("hex");
    const now = this.now();
    const device: ReturningDevice = {
      idHash: sha256(deviceId),
      owner: { adapterId: owner.adapterId, userId: owner.userId, chatId: owner.chatId, ...(owner.threadId !== undefined ? { threadId: owner.threadId } : {}) },
      surface: input.surface, label: input.label.slice(0, 80), tokenEpoch: input.tokenEpoch, created: now, expires: now + DEVICE_MAX_AGE_MS,
    };
    this.byHash.set(device.idHash, device);
    while (this.byHash.size > MAX_RETURNING_DEVICES) {
      const oldest = [...this.byHash.values()].reduce((a, b) => (a.created <= b.created ? a : b));
      this.byHash.delete(oldest.idHash);
    }
    this.persist();
    return `${deviceId}.${sign(deviceId, input.webToken)}`;
  }

  /** The device a cookie value proves, or null: bad shape, bad signature (another token), unknown, expired, old epoch. */
  verify(value: string | undefined, webToken: string, tokenEpoch: string): ReturningDevice | null {
    if (!value) return null;
    const dot = value.indexOf(".");
    const id = value.slice(0, dot), sig = value.slice(dot + 1);
    if (dot < 0 || !ID_PATTERN.test(id) || !SIG_PATTERN.test(sig)) return null;
    const expected = Buffer.from(sign(id, webToken), "hex");
    if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return null;
    const device = this.byHash.get(sha256(id));
    if (!device || device.tokenEpoch !== tokenEpoch || this.now() >= device.expires) return null;
    return device;
  }

  /** `/dashboard revoke`: no browser may ask for a code any more. Whether that holds after a restart. */
  revokeAll(): { count: number; durable: boolean } {
    const count = this.byHash.size;
    this.byHash.clear();
    return { count, durable: this.persist() };
  }

  private load(): void {
    if (!this.path) return;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, "utf8")); } catch { return; }
    const devices = raw && typeof raw === "object" && Array.isArray((raw as { devices?: unknown }).devices) ? (raw as { devices: unknown[] }).devices : [];
    const now = this.now();
    for (const d of devices) if (isDevice(d) && d.expires > now) this.byHash.set(d.idHash, d);
  }

  /**
   * Write the registry; whether a restart now sees what memory sees. A failed write after a revoke must not leave the
   * old file to bring revoked devices back: then the file is removed (every browser loses its button — the safe side).
   */
  private persist(): boolean {
    if (!this.path) return true;
    const temp = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(temp, JSON.stringify({ version: 1, devices: [...this.byHash.values()] }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temp, this.path);
      try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
      return true;
    } catch (err) {
      try { unlinkSync(temp); } catch { /* never created */ }
      try { unlinkSync(this.path); return true; } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
        this.warn(`Returning-device registry could not be saved or removed (${(err as Error).message}); a restart may bring revoked devices back until the web token is rotated`);
        return false;
      }
    }
  }
}

/** The device cookie a request presents: the `__Host-` one first; the plain one only off the public link. */
export function readDeviceCookie(cookieHeader: string | undefined, publicLink: boolean): string | undefined {
  const jar = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar.get(DEVICE_COOKIE_SECURE) ?? (publicLink ? undefined : jar.get(DEVICE_COOKIE));
}

export function buildDeviceCookie(value: string, secure: boolean): string {
  return [`${secure ? DEVICE_COOKIE_SECURE : DEVICE_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict",
    `Max-Age=${Math.floor(DEVICE_MAX_AGE_MS / 1000)}`, ...(secure ? ["Secure"] : [])].join("; ");
}

/** Per device: one request a minute and five an hour. For the whole fleet: one every 20 s and twenty an hour. */
export const CODE_REQUEST_LIMITS = { deviceGapMs: 60_000, devicePerHour: 5, globalGapMs: 20_000, globalPerHour: 20 } as const;
const HOUR_MS = 60 * 60 * 1000;

/** Rate limits for code requests, on a monotonic clock (a wall-clock jump neither opens nor closes them). */
export class CodeRequestLimiter {
  private readonly byDevice = new Map<string, number[]>();
  private global: number[] = [];
  constructor(private readonly now: () => number = () => performance.now(), private readonly limits = CODE_REQUEST_LIMITS) {}

  /** Admit one request for `deviceKey` now, or say how long until one would be admitted. */
  admit(deviceKey: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.byDevice.get(deviceKey) ?? []).filter(t => now - t < HOUR_MS);
    this.global = this.global.filter(t => now - t < HOUR_MS);
    const waits: number[] = [];
    const last = recent.at(-1), lastGlobal = this.global.at(-1);
    if (last !== undefined && now - last < this.limits.deviceGapMs) waits.push(this.limits.deviceGapMs - (now - last));
    if (recent.length >= this.limits.devicePerHour) waits.push(HOUR_MS - (now - recent[0]!));
    if (lastGlobal !== undefined && now - lastGlobal < this.limits.globalGapMs) waits.push(this.limits.globalGapMs - (now - lastGlobal));
    if (this.global.length >= this.limits.globalPerHour) waits.push(HOUR_MS - (now - this.global[0]!));
    if (waits.length) { this.byDevice.set(deviceKey, recent); return { ok: false, retryAfterMs: Math.max(...waits) }; }
    recent.push(now); this.global.push(now);
    this.byDevice.set(deviceKey, recent);
    return { ok: true };
  }
}
