/** #1629: human-session effects and retained-placement runtime reads. No page is mounted here. */
import { WebEffectLibrary } from "./web-effect-library.js";
import { ThemeStore } from "./web-theme-store.js";
import { WEB_EFFECT_ID, resolveEffectParams } from "./web-effect.js";
import { effectRasterAssets } from "./web-effect-bundle.js";
import { decodeEffectFiles } from "./web-effect-upload.js";
import type { WebEffectProfiles } from "./web-effect-profiles.js";

type Answer = Record<string, unknown>;
const fail = (error: string): Answer => ({ error });
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
const fields = (x: unknown, allowed: string[]): x is Record<string, unknown> => plain(x) && Object.keys(x).every(k => allowed.includes(k));
export interface EffectServiceDeps {
  library: WebEffectLibrary;
  themes: ThemeStore;
  profiles: WebEffectProfiles;
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
    const result = this.deps.library.list(this.principal(person));
    return result.ok ? { effects: result.entries.map(e => ({ ...e, profiles: this.profileSummary(e.id) })) } : fail(result.error);
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
  /** A runtime resource is not an export grant. An exact currently retained placement is independently required. */
  private retained(id: string, instance: string) {
    if (!this.deps.known(instance) || !WEB_EFFECT_ID.test(id) || !this.deps.themes.readable()) return { ok: false as const, error: "not_found" };
    const placement = this.deps.themes.get(instance).placements.effects.find(p => p.id === id);
    if (!placement) return { ok: false as const, error: "not_found" };
    const r = this.deps.library.readReferenced(id, `instance:${instance}`); if (!r.ok) return r;
    const params = resolveEffectParams(r.entry.manifest, placement.params ?? {}); if (!params.ok) return { ok: false as const, error: "effect_params" };
    return { ...r, placement, params: params.values };
  }
  resource(person: string, id: string, instance?: string): Answer {
    if (!this.validPerson(person)) return fail("not_found");
    const binding = instance === undefined ? null : this.retained(id, instance);
    const r = binding ?? this.readable(person, id); if (!r.ok) return fail("not_found");
    const defaults = resolveEffectParams(r.entry.manifest); if (!defaults.ok) return fail("not_found");
    return { id, manifest: r.entry.manifest, params: binding?.ok ? binding.params : defaults.values, wants: r.entry.manifest.wants, code: new TextDecoder("utf-8", { fatal: true }).decode(r.entry.files.get("worker.js")!),
      assets: effectRasterAssets(r.entry).map(({ name, mime, bytes }) => ({ name, mime, data_b64: Buffer.from(bytes).toString("base64") })) };
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
