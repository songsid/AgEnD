/** #1629: volatile Try authority. An agent's preview_web_effect posts an offer card in its own chat; only an explicit local-admin click (POST /ui/effect-trials/start) plays the clipped sample. */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { canonicalText } from "./web-theme.js";
import { WebEffectLibrary, type EffectReference } from "./web-effect-library.js";
import type { CheckedWebEffect } from "./web-effect-bundle.js";

export const EFFECT_TRIAL_TTL_MS = 10 * 60 * 1000;
const ID = /^[0-9a-f]{32}$/;
const EPOCH = /^[0-9a-f]{16}$/;
const SESSION = /^[0-9a-f]{64}$/;
const LIMIT = 128;
type Failure = { ok: false; error: "trial_unavailable" | "trial_busy" | "trial_capacity" };
const denied = (): Failure => ({ ok: false, error: "trial_unavailable" });

/** Display metadata only. Neither the id nor this object grants a resource read. */
export interface EffectTrialOffer {
  readonly v: 1;
  readonly offer: string;
  readonly id: string;
  readonly title: string;
  readonly expiresAt: number;
}

/** Closed own data without invoking getters; output does not retain caller-owned objects. */
function data(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const names = Reflect.ownKeys(value);
    if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k))) return null;
    const out: Record<string, unknown> = Object.create(null);
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (!d || !Object.hasOwn(d, "value") || !d.enumerable) return null;
      out[k] = d.value;
    }
    return out;
  } catch { return null; }
}

/** Independent history/card codec: a card read back from chat history is display metadata, never a grant. */
export function effectTrialOffer(value: unknown): Readonly<EffectTrialOffer> | null {
  const d = data(value, ["v", "offer", "id", "title", "expiresAt"]);
  if (!d || d.v !== 1 || typeof d.offer !== "string" || !ID.test(d.offer) || typeof d.id !== "string" || !ID.test(d.id)
    || typeof d.title !== "string" || d.title.length > 400 || canonicalText(d.title, 1, 40) !== d.title
    || !Number.isSafeInteger(d.expiresAt) || (d.expiresAt as number) < 0) return null;
  return Object.freeze({ v: 1, offer: d.offer, id: d.id, title: d.title, expiresAt: d.expiresAt as number });
}

/** HOST INPUT ONLY: build afresh from the route's verified session verdict, never from JSON.
 * sessionHash is SessionRecord.idHash, not the cookie; epoch is its handle. Header tokens
 * have no actor. Owner CSS must be authoritatively off, including at each resource read.
 */
export interface EffectTrialActor {
  readonly via: "session";
  readonly surface: "local";
  readonly tier: "admin";
  readonly sessionHash: string;
  readonly epoch: string;
  readonly person: string;
  readonly ownerCss: "off";
}
function actor(value: unknown, requireCss = true): EffectTrialActor | null {
  const d = data(value, ["via", "surface", "tier", "sessionHash", "epoch", "person", "ownerCss"]);
  if (!d || d.via !== "session" || d.surface !== "local" || d.tier !== "admin"
    || typeof d.sessionHash !== "string" || !SESSION.test(d.sessionHash)
    || typeof d.epoch !== "string" || !EPOCH.test(d.epoch)
    || typeof d.person !== "string" || !d.person.length || d.person.length > 256
    || (requireCss ? d.ownerCss !== "off" : !["off", "on", "loading", "unknown"].includes(d.ownerCss as string))) return null;
  return Object.freeze({ ...d }) as unknown as EffectTrialActor;
}
interface Offer { readonly public: Readonly<EffectTrialOffer>; readonly instance: string; readonly until: number }
interface Trial { readonly token: string; readonly offer: Offer; readonly actor: EffectTrialActor }
const sameActor = (a: EffectTrialActor, b: EffectTrialActor): boolean => a.sessionHash === b.sessionHash && a.epoch === b.epoch && a.person === b.person;
export interface EffectTrialDeps {
  library: WebEffectLibrary;
  known(instance: string): boolean;
  monotonic?: () => number;
  now?: () => number;
}

/** One owner per library. Register before publishing the library or doing any collection.
 * No claims, preferences, files, exports or placements are written. Offers retain bytes
 * only; read() always rechecks the origin agent's CURRENT own/shared ACL.
 */
export class WebEffectTrials {
  private readonly offers = new Map<string, Offer>();
  private readonly trials = new Map<string, Trial>();
  private readonly unregister: () => void;
  private busy = false;
  private clockBusy = false;
  private dead = false;
  private brokenClock = false;
  private previous = 0;
  constructor(private readonly deps: EffectTrialDeps) {
    this.unregister = deps.library.registerReferenceSource("effect-trials", () => this.references());
  }
  private clock(): number {
    if (this.brokenClock || this.clockBusy) throw Error("trial_clock");
    this.clockBusy = true;
    try {
      const at = (this.deps.monotonic ?? (() => performance.now()))();
      if (!Number.isFinite(at) || at < this.previous || at < 0 || at > Number.MAX_SAFE_INTEGER - EFFECT_TRIAL_TTL_MS) throw Error("trial_clock");
      this.previous = at;
      return at;
    } catch (e) { this.brokenClock = true; throw e; }
    finally { this.clockBusy = false; }
  }
  private references(): EffectReference[] {
    // Observational only. Do not prune, call the library or collect while it enumerates.
    const at = this.clock();
    return [...this.offers.values()].filter(o => at < o.until).map(o => ({ id: o.public.id, holder: `trial-offer:${o.public.offer}` }));
  }
  private prune(at: number): void {
    for (const [id, o] of this.offers) if (at >= o.until) this.offers.delete(id);
    for (const [id, t] of this.trials) if (this.offers.get(t.offer.public.offer) !== t.offer) this.trials.delete(id);
  }
  private run<T>(fn: () => T): T | Failure {
    if (this.busy || this.clockBusy) return { ok: false, error: "trial_busy" };
    if (this.dead || this.brokenClock) return denied();
    this.busy = true;
    try { this.prune(this.clock()); return fn(); }
    catch { return denied(); }
    finally { this.busy = false; }
  }
  private readable(o: Offer): CheckedWebEffect | null {
    if (!this.deps.known(o.instance) || this.dead) return null;
    const r = this.deps.library.read(o.public.id, { kind: "agent", id: o.instance });
    return r.ok && !this.dead && this.clock() < o.until ? r.entry : null;
  }
  /** Agent may OFFER only, using its current own/shared read rights. No appearance write or rate-limit record.
   * A repeat active offer is idempotent, never extends TTL, and needs no second card.
   */
  offer(instance: string, id: string): { ok: true; offer: Readonly<EffectTrialOffer>; created: boolean } | Failure {
    return this.run(() => {
      if (typeof instance !== "string" || !instance.length || instance.length > 128 || typeof id !== "string" || !ID.test(id) || !this.deps.known(instance) || this.dead) return denied();
      const r = this.deps.library.read(id, { kind: "agent", id: instance });
      if (!r.ok || this.dead) return denied();
      const at = this.clock(); this.prune(at);
      const old = [...this.offers.values()].find(o => o.instance === instance);
      if (old?.public.id === id) return { ok: true as const, offer: old.public, created: false };
      if (!old && this.offers.size >= LIMIT) return { ok: false as const, error: "trial_capacity" as const };
      const wall = (this.deps.now ?? Date.now)();
      if (!Number.isSafeInteger(wall) || wall < 0 || wall > Number.MAX_SAFE_INTEGER - EFFECT_TRIAL_TTL_MS || this.dead) return denied();
      const offer = effectTrialOffer({ v: 1, offer: randomBytes(16).toString("hex"), id, title: r.entry.manifest.title, expiresAt: wall + EFFECT_TRIAL_TTL_MS });
      if (!offer || this.offers.has(offer.offer) || this.clock() - at >= EFFECT_TRIAL_TTL_MS || this.dead) return denied();
      if (old) this.offers.delete(old.public.offer);
      this.prune(this.clock());
      this.offers.set(offer.offer, Object.freeze({ public: offer, instance, until: at + EFFECT_TRIAL_TTL_MS }));
      return { ok: true as const, offer, created: true };
    });
  }
  /** The CSRF-protected POST /ui/effect-trials/start only, after an explicit local-admin click. Never a tool or GET. */
  start(offer: string, instance: string, viewer: unknown): { ok: true; trial: string; offer: Readonly<EffectTrialOffer>; remainingMs: number } | Failure {
    return this.run(() => {
      const a = actor(viewer), o = this.offers.get(offer);
      if (!a || !o || o.instance !== instance || !this.readable(o)) return denied();
      const old = [...this.trials.values()].find(t => t.actor.sessionHash === a.sessionHash);
      if (!old && this.trials.size >= LIMIT) return { ok: false as const, error: "trial_capacity" as const };
      const token = randomBytes(16).toString("hex");
      const remainingMs = Math.floor(o.until - this.clock());
      if (this.trials.has(token) || remainingMs <= 0 || this.dead) return denied();
      if (old) this.trials.delete(old.token);
      this.trials.set(token, Object.freeze({ token, offer: o, actor: a }));
      return { ok: true as const, trial: token, offer: o.public, remainingMs };
    });
  }
  /** Each image/code/profile authorization supplies a FRESH verified viewer. Knowing a token is insufficient. */
  read(trial: string, instance: string, viewer: unknown): { ok: true; id: string; instance: string; entry: CheckedWebEffect } | Failure {
    return this.run(() => {
      const a = actor(viewer), t = this.trials.get(trial);
      if (!a || !t || t.offer.instance !== instance || !sameActor(a, t.actor)) return denied();
      const entry = this.readable(t.offer);
      return entry ? { ok: true as const, id: t.offer.public.id, instance: t.offer.instance, entry } : denied();
    });
  }
  /** An authenticated owner can stop even after CSS becomes on/unknown; never stops another session. */
  stop(trial: string, viewer: unknown): { ok: true } | Failure {
    return this.run(() => {
      const a = actor(viewer, false), t = this.trials.get(trial);
      if (!a || !t || !sameActor(a, t.actor)) return denied();
      this.trials.delete(trial); return { ok: true as const };
    });
  }
  /** Call only when this library owner ends. No collection here; the caller owns GC ordering. */
  dispose(): void {
    if (this.dead) return;
    this.dead = true; this.trials.clear(); this.offers.clear(); this.unregister();
  }
}
