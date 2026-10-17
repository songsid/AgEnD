/** #1629: human-session effects and retained-placement runtime reads. No page is mounted here. */
import { WebEffectLibrary } from "./web-effect-library.js";
import { ThemeStore } from "./web-theme-store.js";
import { EFFECT_REGION, WEB_EFFECT_ID, chatCompatible, resolveEffectParams } from "./web-effect.js";
import { effectRasterAssets } from "./web-effect-bundle.js";
import { staticEffectPoster, staticEffectCursor } from "./web-effect-poster.js";
import { decodeEffectFiles } from "./web-effect-upload.js";
import type { WebEffectProfiles } from "./web-effect-profiles.js";
import type { WebEffectTrials } from "./web-effect-trials.js";
import { isOwnerEffectKey, OWNER_EFFECT_KEYS, type OwnerEffectKey, type WebPrefsStore } from "./web-prefs.js";

type Answer = Record<string, unknown>;
const fail = (error: string): Answer => ({ error });
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
const fields = (x: unknown, allowed: string[]): x is Record<string, unknown> => plain(x) && Object.keys(x).every(k => allowed.includes(k));
export interface EffectServiceDeps {
  library: WebEffectLibrary;
  themes: ThemeStore;
  profiles: WebEffectProfiles;
  prefs?: WebPrefsStore;
  trials?: WebEffectTrials;
  known(name: string): boolean;
  changed(): void;
  monotonic?: () => number;
}
/** Host routes provide the authenticated human key. Neither a body nor an agent tool supplies it. */
export class WebEffectService {
  private readonly reports = new Map<string, number>();
  private previous: number | null = null;
  constructor(private readonly deps: EffectServiceDeps) {}
  private principal(person: string) { return { kind: "human" as const, id: person }; }
  private validPerson(person: string): boolean { return typeof person === "string" && person.length > 0 && person.length <= 256; }
  private readable(person: string, id: unknown) {
    return this.validPerson(person) && typeof id === "string" && WEB_EFFECT_ID.test(id) ? this.deps.library.read(id, this.principal(person)) : { ok: false as const, error: "not_found" };
  }
  list(person: string): Answer {
    if (!this.validPerson(person)) return fail("not_found");
    const result = this.deps.library.managementList(this.principal(person));
    if (!result.ok) return fail(result.error);
    const profiles = this.profileSummaries(result.entries.map(e => e.id));
    return { effects: result.entries.map(e => ({ ...e, profiles: profiles[e.id] })) };
  }
  profileSummaries(ids: readonly string[]): Record<string, Answer> {
    if (!ids.length) return {};
    const r = this.deps.profiles.readSummaries();
    return Object.fromEntries(ids.map(id => {
      if (!r.ok) return [id, fail(r.error)];
      const summary = r.summaries[id];
      return [id, { status: summary?.status ?? "unmeasured", records: summary?.records ?? [] }];
    }));
  }
  profileSummary(id: string): Answer {
    const r = this.deps.profiles.read(id);
    if (!r.ok) return fail(r.error);
    return { status: r.status, records: [r.records.filter(p => p.device === "standard").at(-1), r.records.filter(p => p.device === "constrained").at(-1)].filter(Boolean) };
  }
  profile(person: string, id: string): Answer {
    return this.readable(person, id).ok ? this.deps.profiles.read(id) : fail("not_found");
  }
  upload(person: string, bytes: Uint8Array): Answer {
    if (!this.validPerson(person)) return fail("not_found");
    const files = decodeEffectFiles(bytes); if (!files) return fail("invalid_effect");
    const staged = this.deps.library.stage(files, this.principal(person)); if (!staged.ok) return fail(staged.error);
    const committed = this.deps.library.commit(staged.stageId);
    if (!committed.ok) { this.deps.library.abort(staged.stageId); return fail(committed.error); }
    this.deps.changed(); return { id: committed.ids[0], warnings: staged.entries[0]!.warnings };
  }
  apply(person: string, args: unknown): Answer {
    if (!fields(args, ["instance", "id", "params"]) || typeof args.instance !== "string" || !this.deps.known(args.instance) || typeof args.id !== "string") return fail("effect_args");
    const r = this.readable(person, args.id); if (!r.ok) return fail("not_found");
    if (!chatCompatible(r.entry.manifest)) return { ...EFFECT_REGION };                 // #2017: the agent's rule, before any write
    const params = resolveEffectParams(r.entry.manifest, args.params === undefined ? {} : args.params); if (!params.ok) return fail("effect_params");
    if (!this.deps.themes.readable()) return fail("themes_unreadable");
    const before = this.deps.themes.get(args.instance).placements.effects;
    const target = { id: args.id, ...(Object.keys(params.overrides).length ? { params: params.overrides } : {}) };
    const next = before.map(p => p.id === args.id ? target : p.id); if (!before.some(p => p.id === args.id)) next.push(target);
    const written = this.deps.themes.setPlacements(args.instance, { effects: next }, "human", what => {
      const entry = what.id === args.id ? r : this.deps.library.readReferenced(what.id, `instance:${args.instance}`);
      if (!entry.ok) return entry.error;
      return resolveEffectParams(entry.entry.manifest, what.id === args.id ? params.overrides : before.find(p => p.id === what.id)?.params ?? {}).ok ? null : "effect_params";
    });
    if (!written.ok) return fail(written.error);
    this.deps.changed(); return { id: args.id, rev: written.rev, params: params.overrides };
  }
  remove(person: string, args: unknown): Answer {
    if (!this.validPerson(person) || !fields(args, ["instance", "id"]) || typeof args.instance !== "string" || !this.deps.known(args.instance) || args.id !== undefined && (typeof args.id !== "string" || !WEB_EFFECT_ID.test(args.id))) return fail("effect_args");
    if (!this.deps.themes.readable()) return fail("themes_unreadable");
    const before = this.deps.themes.get(args.instance).placements.effects, removed = before.filter(p => args.id === undefined || p.id === args.id).map(p => p.id);
    if (!removed.length) return { removed: [] };
    const result = this.deps.themes.setPlacements(args.instance, { effects: before.filter(p => !removed.includes(p.id)).map(p => p.id) }, "human", what => this.deps.library.readReferenced(what.id, `instance:${args.instance}`).ok ? null : "not_found");
    if (!result.ok) return fail(result.error);
    this.deps.library.collectUnreferenced(removed); this.deps.changed(); return { removed, rev: result.rev };
  }
  share(person: string, args: unknown): Answer {
    if (!fields(args, ["id", "shared"]) || typeof args.id !== "string" || typeof args.shared !== "boolean" || !this.validPerson(person)) return fail("effect_args");
    const r = this.deps.library.setShared(args.id, this.principal(person), args.shared); if (!r.ok) return fail(r.error);
    this.deps.changed(); return { id: args.id, shared: args.shared };
  }
  delete(person: string, id: string): Answer {
    if (!this.validPerson(person)) return fail("not_found"); const r = this.deps.library.deleteClaim(id, this.principal(person));
    if (!r.ok) return fail(r.error); this.deps.changed(); return { deleted: id };
  }
  /** A selection never acquires a claim or borrows chat retention. Null clears need no library read. */
  validateOwnerSelection(person: string, key: OwnerEffectKey, id: string): string | null {
    const r = this.readable(person, id);
    return r.ok && this.ownerCompatible(r.entry, key) ? null : "not_found";
  }
  private ownerCompatible(entry: { manifest: import("./web-effect.js").WebEffectManifest; files: ReadonlyMap<string, Uint8Array> }, key: OwnerEffectKey): boolean {
    if (!isOwnerEffectKey(key)) return false;
    if (key === "fx.cursor") return !!entry.manifest.cursor && entry.files.has("cursor.png");
    const region = key.slice(3) as "sidebar" | "header" | "page" | "box";
    return entry.manifest.regions.includes(region) && (region !== "box" || !!entry.manifest.box);
  }
  collectOwnerReplaced(ids: string[]): void { this.deps.library.collectUnreferenced(ids); }
  ownerSelections(person: string): Answer {
    if (!this.validPerson(person)) return fail("not_found");
    const view = this.deps.prefs?.readForViewer(person); if (!view || view.unreadable) return fail("prefs_unreadable");
    return { rev: view.rev, slots: Object.fromEntries(OWNER_EFFECT_KEYS.map(key => {
      const id = view.values[key]; if (id === undefined) return [key, { status: "none", id: null }];
      const r = this.readable(person, id);
      return [key, r.ok && this.ownerCompatible(r.entry, key) ? { status: "available", id, manifest: r.entry.manifest } : { status: "unavailable", id }];
    })) };
  }
  private ownerSelected(person: string, id: string, slot: unknown) {
    if (!this.validPerson(person) || typeof slot !== "string" || !isOwnerEffectKey(slot)) return { ok: false as const, error: "not_found" };
    const view = this.deps.prefs?.readForViewer(person);
    if (!view || view.unreadable || view.values[slot] !== id) return { ok: false as const, error: "not_found" };
    const r = this.readable(person, id);
    return r.ok && this.ownerCompatible(r.entry, slot) ? r : { ok: false as const, error: "not_found" };
  }
  /** Personal runtime authorizations always recheck current own/shared ACL. Cursor selection grants no code read. */
  ownerResource(person: string, id: string, slot: unknown): Answer {
    if (slot === "fx.cursor") return fail("not_found");
    const r = this.ownerSelected(person, id, slot); if (!r.ok) return fail("not_found");
    const params = resolveEffectParams(r.entry.manifest); if (!params.ok) return fail("not_found");
    return this.resourceAnswer(id, r.entry, params.values);
  }
  ownerImage(person: string, id: string, kind: "poster" | "cursor", slot: unknown): { ok: true; bytes: Uint8Array } | { ok: false; error: "not_found" } {
    const r = this.ownerSelected(person, id, slot), bytes = r.ok ? r.entry.files.get(`${kind}.png`) : undefined;
    // Runtime images are output copies; stripping animation must not rewrite the stored content id.
    const image = bytes && (kind === "cursor" ? staticEffectCursor(bytes) : bytes);
    return image ? { ok: true, bytes: image } : { ok: false, error: "not_found" };
  }
  private resourceAnswer(id: string, entry: import("./web-effect-bundle.js").CheckedWebEffect, params: Record<string, unknown>): Answer {
    return { id, manifest: entry.manifest, params, wants: entry.manifest.wants, code: new TextDecoder("utf-8", { fatal: true }).decode(entry.files.get("worker.js")!),
      assets: effectRasterAssets(entry).map(({ name, mime, bytes }) => ({ name, mime, data_b64: Buffer.from(bytes).toString("base64") })) };
  }
  /** Host-only trial routes supply a fresh verified actor, never a JSON body actor. No placement/claim writes. */
  trialStart(offer: string, instance: string, viewer: unknown): Answer {
    const t = this.deps.trials?.start(offer, instance, viewer); if (!t?.ok) return fail("not_found");
    const r = this.deps.trials!.read(t.trial, instance, viewer);
    const params = r.ok ? resolveEffectParams(r.entry.manifest) : null;
    if (!r.ok || !params?.ok) { this.deps.trials!.stop(t.trial, viewer); return fail("not_found"); }
    return { trial: t.trial, offer: t.offer, remainingMs: t.remainingMs, manifest: r.entry.manifest, params: params.values };
  }
  trialStop(trial: string, viewer: unknown): Answer {
    return this.deps.trials?.stop(trial, viewer).ok ? { ok: true } : fail("not_found");
  }
  trialResource(trial: string, instance: string, viewer: unknown): Answer {
    const r = this.deps.trials?.read(trial, instance, viewer); if (!r?.ok) return fail("not_found");
    const params = resolveEffectParams(r.entry.manifest); if (!params.ok) return fail("not_found");
    return this.resourceAnswer(r.id, r.entry, params.values);
  }
  trialPoster(trial: string, instance: string, viewer: unknown): { ok: true; bytes: Uint8Array } | { ok: false } {
    const r = this.deps.trials?.read(trial, instance, viewer), source = r?.ok ? r.entry.files.get("poster.png") : undefined;
    const bytes = source ? staticEffectPoster(source) : null;
    return bytes ? { ok: true, bytes } : { ok: false };
  }
  trialProfile(trial: string, instance: string, viewer: unknown): Answer {
    const r = this.deps.trials?.read(trial, instance, viewer); return r?.ok ? this.deps.profiles.read(r.id) : fail("not_found");
  }
  /** A runtime resource is not an export grant. An exact currently retained placement is independently required. */
  private retained(id: string, instance: string) {
    if (!this.deps.known(instance) || !WEB_EFFECT_ID.test(id) || !this.deps.themes.readable()) return { ok: false as const, error: "not_found" };
    const placement = this.deps.themes.get(instance).placements.effects.find(p => p.id === id);
    if (!placement) return { ok: false as const, error: "not_found" };
    const r = this.deps.library.readReferenced(id, `instance:${instance}`); if (!r.ok) return r;
    const params = resolveEffectParams(r.entry.manifest, placement.params ?? {}); if (!params.ok) return { ok: false as const, error: "effect_params" };
    return { ...r, placement, params: params.values };
  }
  /** Public/local visual projection: current chat placements only, no principal, code, params or claim grant. */
  posterPlacements(instance: string): Answer {
    if (!this.deps.known(instance)) return fail("not_found");
    if (!this.deps.themes.readable()) return fail("themes_unreadable");
    return { rev: this.deps.themes.rev(), posters: this.deps.themes.get(instance).placements.effects.flatMap(p => {
      const r = this.retained(p.id, instance), bytes = r.ok ? r.entry.files.get("poster.png") : undefined;
      return r.ok && r.entry.manifest.regions.includes("chat") && bytes && staticEffectPoster(bytes)
        ? [{ id: p.id, title: r.entry.manifest.title }] : [];
    }) };
  }
  placedPoster(id: string, instance: string): { ok: true; bytes: Uint8Array } | { ok: false; error: "not_found" } {
    const r = this.retained(id, instance);
    const source = r.ok && r.entry.manifest.regions.includes("chat") ? r.entry.files.get("poster.png") : undefined;
    const bytes = source ? staticEffectPoster(source) : null;
    return bytes ? { ok: true, bytes } : { ok: false, error: "not_found" };
  }
  resource(person: string, id: string, instance?: string): Answer {
    if (!this.validPerson(person)) return fail("not_found");
    const binding = instance === undefined ? null : this.retained(id, instance);
    const r = binding ?? this.readable(person, id); if (!r.ok) return fail("not_found");
    const defaults = resolveEffectParams(r.entry.manifest); if (!defaults.ok) return fail("not_found");
    return this.resourceAnswer(id, r.entry, binding?.ok ? binding.params : defaults.values);
  }
  image(person: string, id: string, kind: "poster" | "cursor", instance?: string): { ok: true; bytes: Uint8Array } | { ok: false; error: "not_found" } {
    if (!this.validPerson(person)) return { ok: false, error: "not_found" };
    const r = instance === undefined ? this.readable(person, id) : this.retained(id, instance);
    const bytes = r.ok ? r.entry.files.get(`${kind}.png`) : undefined;
    return bytes ? { ok: true, bytes } : { ok: false, error: "not_found" };
  }
  placements(person: string, instance: string): Answer {
    if (!this.validPerson(person) || !this.deps.known(instance)) return fail("not_found"); if (!this.deps.themes.readable()) return fail("themes_unreadable");
    return { rev: this.deps.themes.rev(), effects: this.deps.themes.get(instance).placements.effects.flatMap(p => {
      const r = this.retained(p.id, instance); return r.ok ? [{ ...p, manifest: r.entry.manifest, params: r.params }] : [];
    }) };
  }
  /** Diagnostic writes only: a validated report never changes safety, admission or a placement. */
  report(person: string, id: string, input: unknown, instance?: string): Answer {
    if (!this.validPerson(person) || !(instance === undefined ? this.readable(person, id) : this.retained(id, instance)).ok) return fail("not_found");
    let now: number; try { now = (this.deps.monotonic ?? (() => performance.now()))(); } catch { return fail("profile_clock"); }
    if (!Number.isFinite(now) || now < 0 || this.previous !== null && now < this.previous) return fail("profile_clock"); this.previous = now;
    for (const [key, t] of this.reports) if (now - t >= 60_000) this.reports.delete(key);
    const key = JSON.stringify([person, id]), last = this.reports.get(key);
    if (last !== undefined && now - last < 10_000) return fail("profile_rate_limited");
    if (last === undefined && this.reports.size >= 1024) return fail("profile_rate_limited");
    const result = this.deps.profiles.record(id, input); if (!result.ok) return fail(result.error);
    this.reports.set(key, now); return { ok: true };
  }
}
