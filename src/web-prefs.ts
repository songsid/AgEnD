/**
 * #1665: the web preferences that follow the person from device to device (theme, language, the sidebar's arrangement,
 * the HTML-preview opt-in), kept on the host — design: the comment on #1665.
 *
 * - The tour and the first-run card stay per device (the user's call on #1665): they are not keys here.
 * - Existing visible preferences remain in the host operator bucket. Five new owner-effect keys have fixed personal
 *   scope: a platform-bound web identity, or explicit host operator for an ownerless signed-in session. No migration.
 *   Raw internal profile/CSS callers retain their existing bucket API; web reads/writes use the scoped projection.
 * - A fixed registry of keys, each with its own validator. Anything else is refused — "__proto__" and "constructor"
 *   are just unknown keys: every lookup is a Map, never an object's prototype chain.
 * - The file (<home>/web-prefs.json, 0600) is replaced atomically. One that cannot be read or parsed is never
 *   overwritten: reads give the defaults, writes are refused, until a person looks at it.
 * - `rev` rises with every change; the status frame carries it, so another device re-reads at its next poll.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalPlacements } from "./web-identity-palette.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { checkWidgetData, checkWidgetSpec } from "./web-widget.js";

export const WEB_PREFS_FILE = "web-prefs.json";
export const OPERATOR = "operator";
/** Fixed scope, never supplied by a request. Existing public keys remain host-wide. */
export const OWNER_EFFECT_KEYS = ["fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"] as const;
export type OwnerEffectKey = typeof OWNER_EFFECT_KEYS[number];
const OWNER_KEYS: ReadonlySet<string> = new Set(OWNER_EFFECT_KEYS);
export function isOwnerEffectKey(key: string): key is OwnerEffectKey { return OWNER_KEYS.has(key); }
/** Library holders are bounded even for the longest platform identity. They confer no runtime read authority. */
export function ownerEffectHolder(identity: string, key: OwnerEffectKey): string {
  return `prefs:${createHash("sha256").update(identity).digest("hex")}:${key}`;
}

type Invalid = { readonly invalid: string };
const bad = (invalid: string): Invalid => ({ invalid });
const isInvalid = (v: unknown): v is Invalid => !!v && typeof v === "object" && Object.hasOwn(v, "invalid") && Object.keys(v).length === 1;

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const shortText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const name = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
/**
 * #2172: a sidebar group's key — a tag's name, or a team's: the one control-character prefix instance-nav.js gives it
 * (TEAM_GROUP), so a tag named like a team stays its own group — followed by the team's name. Only that prefix; any other
 * control character is refused as before, and an instance's own name never takes it.
 */
export const TEAM_GROUP_PREFIX = "\u0001team:";
const groupName = (v: unknown): v is string => name(v) || (typeof v === "string" && v.startsWith(TEAM_GROUP_PREFIX) && name(v.slice(TEAM_GROUP_PREFIX.length)));
/** Only the listed fields, each present: an extra field is a value this version does not understand. */
function exactly(v: Record<string, unknown>, fields: string[]): boolean {
  const keys = Object.keys(v);
  return keys.length === fields.length && fields.every((f) => Object.hasOwn(v, f));
}
function uniqueStrings(v: unknown, max: number, each: (s: unknown) => boolean, what: string): string[] | Invalid {
  if (!Array.isArray(v) || v.length > max) return bad(`${what}: a list of at most ${max}`);
  if (!v.every(each)) return bad(`${what}: each a name of 1–128 characters`);
  if (new Set(v).size !== v.length) return bad(`${what}: no repeats`);
  return v as string[];
}

/** #1827: a web person's profile keys (internal: not settable through /ui/prefs, not in its view). */
const PROFILE_NAME = "profile.name";
const PROFILE_PLATFORM_NAME = "profile.platformName";
/** #1629 r4 §3: the person's active owner-CSS version (a sha), internal too: set only by the owner-CSS routes. */
const OWNER_CSS_ACTIVE = "css.active";
/** #1629 r4 §3: the version on trial (keep or revert), internal too — its changes are what other devices hear. */
const OWNER_CSS_TRIAL = "css.trial";
/** Keys kept in a person's bucket that /ui/prefs neither shows nor sets. */
const PROFILE_KEYS: ReadonlySet<string> = new Set([PROFILE_NAME, PROFILE_PLATFORM_NAME, OWNER_CSS_ACTIVE, OWNER_CSS_TRIAL]);

/** #1629 r4.1 Q3 (a): at most this many per-instance card sizes. */
export const MAX_CARD_SIZES = 200;
/** #1664: at most this many favorites. */
export const MAX_FAVORITES = 50;
const FAVORITES = "nav.favorites";

/** The status chips of the sidebar filter (src/ui/shared/instance-nav.js STATUS_FACETS). */
const STATUS_FACETS = new Set(["working", "needs", "idle", "stopped", "crashed"]);

/** Each key's validator: the value to store, or why it is refused. `null` (clear) never reaches one. */
const VALIDATORS = new Map<string, (v: unknown) => unknown>([
  ["theme", (v) => (v === "light" || v === "dark" || v === "system" ? v : bad("theme: light, dark or system"))],
  ["lang", (v) => (v === "en" || v === "zh-TW" ? v : bad("lang: en or zh-TW"))],
  // The sidebar's drag order: the rows instance-nav.js keeps (group rows have no group_name).
  ["nav.order", (v) => {
    if (!Array.isArray(v) || v.length > 1000) return bad("nav.order: a list of at most 1000 rows");
    for (const row of v) {
      if (!plain(row) || !exactly(row, ["item_type", "item_name", "sort_index", "group_name"])) return bad("nav.order: rows of item_type, item_name, sort_index, group_name");
      const groupRow = row.item_type === "group";
      if (!groupRow && row.item_type !== "instance") return bad("nav.order: item_type group or instance");
      if (!(groupRow ? groupName(row.item_name) : name(row.item_name))) return bad("nav.order: item_name of 1–128 characters");
      if (!Number.isSafeInteger(row.sort_index) || (row.sort_index as number) < 0) return bad("nav.order: sort_index a whole number from 0");
      if (groupRow ? row.group_name !== null : !groupName(row.group_name)) return bad("nav.order: group_name null for a group, the group's name for an instance");
    }
    return v;
  }],
  ["nav.collapsed", (v) => uniqueStrings(v, 200, groupName, "nav.collapsed")],
  // #2179: how the sidebar sorts — the person's own order (custom, the default), or the last reply first (recent); in
  // recent, the favorites keep their order (fixed) or are sorted the same way (recent).
  ["nav.sort", (v) => (plain(v) && exactly(v, ["mode", "favs"]) && (v.mode === "custom" || v.mode === "recent") && (v.favs === "fixed" || v.favs === "recent")
    ? { mode: v.mode, favs: v.favs } : bad("nav.sort: { mode: custom or recent, favs: fixed or recent }"))],
  ["nav.filter", (v) => {
    if (!plain(v) || !exactly(v, ["q", "status", "cli"])) return bad("nav.filter: { q, status, cli }");
    if (!shortText(v.q, 200)) return bad("nav.filter: q at most 200 characters");
    const status = uniqueStrings(v.status, STATUS_FACETS.size, (s) => typeof s === "string" && STATUS_FACETS.has(s), "nav.filter.status");
    if (isInvalid(status)) return status;
    const cli = uniqueStrings(v.cli, 32, (s) => typeof s === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(s), "nav.filter.cli");
    if (isInvalid(cli)) return cli;
    return { q: v.q, status, cli };
  }],
  // #1664: the starred instances, in the order they were starred (or moved). Whether each one exists is checked where
  // the fleet is known (parseWebPrefsPatch's `exists`); a deleted one is dropped on read and when it is removed.
  [FAVORITES, (v) => uniqueStrings(v, MAX_FAVORITES, name, FAVORITES)],
  // HTML previews allowed. Who may write it at all is the route's business (a signed-in session, never the public link).
  ["preview.optIn", (v) => (typeof v === "boolean" ? v : bad("preview.optIn: true or false"))],
  // #1629 r2 (d): whether this person's screens show agents' themes and effects (default true; synced like the rest).
  ["fx.show", (v) => (typeof v === "boolean" ? v : bad("fx.show: true or false"))],
  // #1629 r4.1 Q3 (a): how large this person's screens draw identity cards — the default for every card, and the cards
  // set apart from it (at most 200; the page drops the oldest). A display size only: no agent reads or sets it.
  ["card.size", (v) => (v === "s" || v === "m" || v === "l" ? v : bad("card.size: s, m or l"))],
  // #1958: where identity colours show for an instance nobody chose for (a list of name / bar / ring; [] is nowhere;
  // unset: name, bar and ring, #2056), and whether this host shows them at all (true: off everywhere; every pick is kept).
  ["color.show", (v) => canonicalPlacements(v) ?? bad("color.show: a list of name, bar, ring (each once; [] for nowhere)")],
  ["color.off", (v) => (v === true ? v : bad("color.off: true (clear it to turn colours back on)"))],
  ["card.sizeByInstance", (v) => {
    if (!plain(v)) return bad("card.sizeByInstance: { <instance>: s | m | l }");
    const keys = Object.keys(v);
    if (keys.length > MAX_CARD_SIZES) return bad(`card.sizeByInstance: at most ${MAX_CARD_SIZES} instances`);
    for (const k of keys) if (!name(k) || !["s", "m", "l"].includes(v[k] as string)) return bad("card.sizeByInstance: { <instance>: s | m | l }");
    return v;
  }],
  // #2196: a person's choice, per instance, of where its theme's colours go — the whole page ("page") or only its chat
  // ("chat"); an instance not listed follows its agent's (theme.page.on). Host-wide, like the identity colour.
  ["theme.pageByInstance", (v) => {
    if (!plain(v)) return bad("theme.pageByInstance: { <instance>: page | chat }");
    const keys = Object.keys(v);
    if (keys.length > MAX_CARD_SIZES) return bad(`theme.pageByInstance: at most ${MAX_CARD_SIZES} instances`);
    for (const k of keys) if (!name(k) || (v[k] !== "page" && v[k] !== "chat")) return bad("theme.pageByInstance: { <instance>: page | chat }");
    return Object.fromEntries(keys.map((k) => [k, v[k]]));
  }],
  // #1629 r4-4: the person's own sidebar widget — a declarative spec and its values (web-widget.ts), checked as an
  // agent's is, with the fleet's counts as the only binds. Never an agent's: no tool or agent path writes a person's keys.
  ["widget.sidebar", (v) => {
    if (!plain(v) || !exactly(v, ["spec", "data"])) return bad("widget.sidebar: { spec, data }");
    const spec = checkWidgetSpec(v.spec, "sidebar");
    if (!spec.ok) return bad(`widget.sidebar: ${spec.errors[0]!.path} — ${spec.errors[0]!.problem}`);
    const data = checkWidgetData(v.data, spec.value);
    if (!data.ok) return bad(`widget.sidebar: ${data.errors[0]!.path} — ${data.errors[0]!.problem}`);
    return { spec: spec.value, data: { ...data.value } };
  }],
  // #1722: which name leads where the web shows an instance — its nickname (display name) or its real instance name.
  ["names.primary", (v) => (v === "nickname" || v === "instance" ? v : bad("names.primary: nickname or instance"))],
  // #1827: a web person's own profile — the name they chose, and their account's display name at their last sign-in.
  // Kept here so it follows the person (their bucket), but never a /ui/prefs key: read and written only through
  // profile() / setProfileName() / setPlatformName(), and checked in full where it is used (web-profile.ts). The file's
  // own check is only its shape.
  [PROFILE_NAME, (v) => (typeof v === "string" && v.length >= 1 && v.length <= 256 ? v : bad("profile.name"))],
  [PROFILE_PLATFORM_NAME, (v) => (typeof v === "string" && v.length >= 1 && v.length <= 256 ? v : bad("profile.platformName"))],
  [OWNER_CSS_ACTIVE, (v) => (typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : bad("css.active"))],
  [OWNER_CSS_TRIAL, (v) => (typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : bad("css.trial"))],
]);
for (const key of OWNER_EFFECT_KEYS) VALIDATORS.set(key, v => typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : bad(`${key}: an effect id`));
const REGISTRY = new Map([...VALIDATORS].map(([key, validate]) => [key, { validate, scope: (OWNER_KEYS.has(key) ? "person" : PROFILE_KEYS.has(key) ? "internal" : "host") as "person" | "host" | "internal" }]));
export function webPrefScope(key: string): "person" | "host" | "internal" | null { return REGISTRY.get(key)?.scope ?? null; }
export const WEB_PREF_KEYS: readonly string[] = [...REGISTRY.keys()].filter((k) => !PROFILE_KEYS.has(k));
export function isWebPrefKey(key: string): boolean { return REGISTRY.has(key) && !PROFILE_KEYS.has(key); }

export interface WebPrefsView {
  /** Every key that is set, and its value (a key not set has its default: the page's own). */
  readonly values: Record<string, unknown>;
  readonly rev: number;
  /** The file could not be read: these are the defaults, and writes are refused until it is fixed. */
  readonly unreadable?: true;
}
export type WebPrefsWrite =
  | { ok: true; view: WebPrefsView; changed: string[] }
  | { ok: false; status: 400 | 503; error: string };

/**
 * A request's `set`: own keys only, each known, each valid — or the first reason it is not. All or nothing.
 * `exists`: whether an instance of that name is in the fleet now (#1664: a favorite must be one).
 */
export function parseWebPrefsPatch(set: unknown, exists?: (name: string) => boolean): { ok: true; patch: Map<string, unknown> } | { ok: false; error: string } {
  if (!plain(set)) return { ok: false, error: "set: an object of preference keys" };
  const patch = new Map<string, unknown>();
  const keys = Object.keys(set);
  if (!keys.length) return { ok: false, error: "set: at least one preference" };
  for (const key of keys) {
    const validate = PROFILE_KEYS.has(key) ? undefined : REGISTRY.get(key)?.validate;
    if (!validate) return { ok: false, error: `unknown_pref: ${key.slice(0, 64)}` };
    const raw = set[key];
    if (raw === null) { patch.set(key, null); continue; }
    const value = validate(raw);
    if (isInvalid(value)) return { ok: false, error: value.invalid };
    if (key === FAVORITES) {
      const unknown = (value as string[]).find((n) => !exists || !exists(n));
      if (unknown !== undefined) return { ok: false, error: `unknown_instance: ${unknown.slice(0, 64)}` };
    }
    patch.set(key, value);
  }
  return { ok: true, patch };
}

interface Bucket { values: Map<string, unknown>; updated: Map<string, number>; ownerCssUnknown?: true }
type State = { buckets: Map<string, Bucket>; rev: number };

export class WebPrefsStore {
  private state: State | "unreadable" | null = null;
  /**
   * `exists` (#1664): whether an instance of that name is in the fleet now — a favorite that is not is never served,
   * and is never accepted.
   */
  constructor(private readonly dir: string, private readonly opts: { now?: () => number; write?: (path: string, data: string) => void; exists?: (name: string) => boolean } = {}) {}

  /** parseWebPrefsPatch against this fleet. */
  parsePatch(set: unknown): ReturnType<typeof parseWebPrefsPatch> { return parseWebPrefsPatch(set, this.opts.exists); }

  get path(): string { return join(this.dir, WEB_PREFS_FILE); }

  private load(): State | "unreadable" {
    // A store that could not read its file tries again next time (a permission put back, a disk that recovered); one
    // that did keeps what it read.
    if (this.state && this.state !== "unreadable") return this.state;
    const empty: State = { buckets: new Map(), rev: 0 };
    // Only a file that is definitely not there (ENOENT) is a new, empty store. Anything else — a read refused (EACCES),
    // an I/O error, no place for the file at all, content of another shape — is "unreadable": the defaults are served
    // and nothing is written, so the file is never replaced and a page or status frame never fails because of it.
    try {
      let raw: string;
      try { raw = readFileSync(this.path, "utf8"); } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return (this.state = empty);
        return (this.state = "unreadable");
      }
      const doc = JSON.parse(raw) as unknown;
      if (!plain(doc) || doc.version !== 1 || !plain(doc.identities) || !Number.isSafeInteger(doc.rev)) return (this.state = "unreadable");
      const buckets = new Map<string, Bucket>();
      for (const id of Object.keys(doc.identities)) {
        const raw = doc.identities[id];
        if (!plain(raw) || !plain(raw.values) || !plain(raw.updated)) return (this.state = "unreadable");
        const bucket: Bucket = { values: new Map(), updated: new Map() };
        // A key this version no longer knows, or a value it would refuse now, is left out (never served).
        for (const key of Object.keys(raw.values)) {
          const validate = REGISTRY.get(key)?.validate;
          if (!validate) continue;
          const value = validate(raw.values[key]);
          if (isInvalid(value)) { if (OWNER_KEYS.has(key)) return (this.state = "unreadable"); if (key === OWNER_CSS_ACTIVE || key === OWNER_CSS_TRIAL) bucket.ownerCssUnknown = true; continue; }
          bucket.values.set(key, value);
          const at = raw.updated[key];
          bucket.updated.set(key, typeof at === "number" && Number.isFinite(at) ? at : 0);
        }
        buckets.set(id, bucket);
      }
      return (this.state = { buckets, rev: doc.rev as number });
    } catch {
      return (this.state = "unreadable");
    }
  }

  read(identity: string = OPERATOR): WebPrefsView {
    const state = this.load();
    if (state === "unreadable") return { values: {}, rev: 0, unreadable: true };
    return this.viewOf(state, identity);
  }

  /** null is explicitly host-only, including when OPERATOR physically holds personal choices. */
  readForViewer(person: string | null): WebPrefsView {
    const state = this.load();
    return state === "unreadable" ? { values: {}, rev: 0, unreadable: true } : this.scopedView(state, person);
  }
  private scopedView(state: State, person: string | null): WebPrefsView {
    const host = this.viewOf(state, OPERATOR), values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(host.values)) if (REGISTRY.get(key)?.scope === "host") values[key] = value;
    if (person !== null) for (const [key, value] of state.buckets.get(person)?.values ?? []) if (REGISTRY.get(key)?.scope === "person") values[key] = value;
    return { values, rev: state.rev };
  }
  /** All identities retain their stored references after sharing is withdrawn; unknown state refuses collection. */
  ownerEffectReferences(): Array<{ id: string; holder: string }> {
    const state = this.load(); if (state === "unreadable") throw Error("prefs_unreadable");
    const refs: Array<{ id: string; holder: string }> = [];
    for (const [identity, bucket] of state.buckets) for (const key of OWNER_EFFECT_KEYS) {
      const id = bucket.values.get(key); if (id === undefined) continue;
      if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw Error("prefs_unreadable");
      refs.push({ id, holder: ownerEffectHolder(identity, key) });
    }
    return refs;
  }

  rev(): number { const s = this.load(); return s === "unreadable" ? 0 : s.rev; }

  /** #1664: an instance was removed — drop it from every favorites list (a write, and a new rev, only if one had it). */
  forgetInstance(name: string): void {
    const state = this.load();
    if (state === "unreadable") return;
    for (const [identity, bucket] of state.buckets) {
      const list = bucket.values.get(FAVORITES) as string[] | undefined;
      if (list && list.includes(name)) this.write(identity, new Map([[FAVORITES, list.filter((n) => n !== name)]]));
    }
  }

  private viewOf(state: State, identity: string): WebPrefsView {
    const values: Record<string, unknown> = Object.create(null);
    const bucket = state.buckets.get(identity);
    if (bucket) for (const [k, v] of bucket.values) if (!PROFILE_KEYS.has(k)) values[k] = v;
    // #1664: a favorite whose instance was deleted is dropped (paused or stopped ones are still instances: kept).
    if (Object.hasOwn(values, FAVORITES)) {
      const exists = this.opts.exists;
      values[FAVORITES] = (values[FAVORITES] as string[]).filter((n) => !!exists && exists(n));
    }
    return { values: { ...values }, rev: state.rev };
  }

  /**
   * Set (or, with null, clear) the patch's keys. `onlyIfUnset`: a device's first upload of what it had locally — only
   * the keys the host does not have yet are taken, so the first device to arrive wins and the host wins from then on.
   */
  write(identity: string, patch: Map<string, unknown>, opts: { onlyIfUnset?: boolean } = {}): WebPrefsWrite {
    const result = this.writeBuckets([{ identity, patch }], opts);
    return result.ok ? { ok: true, view: this.viewOf(result.state, identity), changed: result.changed } : result;
  }

  /** One candidate/index write/revision for mixed host+person patches. No migration or cross-bucket shadowing. */
  writeForViewer(person: string | null, patch: Map<string, unknown>, opts: {
    onlyIfUnset?: boolean;
    validateEffect?: (person: string, key: OwnerEffectKey, id: string) => string | null;
  } = {}): WebPrefsWrite {
    const parsed = this.parsePatch(Object.fromEntries(patch)); if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const host = new Map<string, unknown>(), own = new Map<string, unknown>();
    for (const [key, value] of parsed.patch) {
      if (REGISTRY.get(key)?.scope !== "person") { host.set(key, value); continue; }
      if (person === null) return { ok: false, status: 400, error: "prefs_need_a_signed_in_person" };
      if (value !== null) {
        const error = opts.validateEffect ? opts.validateEffect(person, key as OwnerEffectKey, value as string) : "effects_unavailable";
        if (error) return { ok: false, status: 400, error };
      }
      own.set(key, value);
    }
    const targets = person === OPERATOR ? [{ identity: OPERATOR, patch: new Map([...host, ...own]) }]
      : [{ identity: OPERATOR, patch: host }, ...(person === null ? [] : [{ identity: person, patch: own }])];
    const result = this.writeBuckets(targets, opts);
    return result.ok ? { ok: true, view: this.scopedView(result.state, person), changed: result.changed } : result;
  }

  private writeBuckets(targets: Array<{ identity: string; patch: Map<string, unknown> }>, opts: { onlyIfUnset?: boolean }):
    { ok: true; state: State; changed: string[] } | { ok: false; status: 503; error: string } {
    const state = this.load();
    if (state === "unreadable") return { ok: false, status: 503, error: "prefs_unreadable" };
    const buckets = new Map(state.buckets), changed: string[] = [], at = (this.opts.now ?? Date.now)();
    for (const { identity, patch } of targets) {
      const prior = buckets.get(identity), next: Bucket = { values: new Map(prior?.values), updated: new Map(prior?.updated) };
      let touched = false;
      for (const [key, value] of patch) {
        if (opts.onlyIfUnset && next.values.has(key)) continue;
        if (value === null) { if (!next.values.has(key)) continue; next.values.delete(key); next.updated.delete(key); }
        else { if (next.values.has(key) && JSON.stringify(next.values.get(key)) === JSON.stringify(value)) continue; next.values.set(key, value); next.updated.set(key, at); }
        changed.push(key); touched = true;
      }
      if (touched) buckets.set(identity, next);
    }
    if (!changed.length) return { ok: true, state, changed };
    // A successful full rewrite drops previously filtered invalid CSS values too. Publish that proof only after write.
    for (const [id, bucket] of buckets) if (bucket.ownerCssUnknown) buckets.set(id, { values: bucket.values, updated: bucket.updated });
    const candidate: State = { buckets, rev: state.rev + 1 };
    (this.opts.write ?? ((path, data) => atomicWriteFileSync(path, data, { mode: 0o600 })))(this.path, serialize(candidate));
    this.state = candidate;
    return { ok: true, state: candidate, changed };
  }

  /**
   * #2056: the people whose preferences are kept here — the host operator first, then everyone who has signed in (their
   * bucket), each with the web name they go by. For a tool naming whose own settings it changes.
   */
  people(): Array<{ person: string; name: string | null }> {
    const state = this.load();
    const ids = state === "unreadable" ? [] : [...state.buckets.keys()].filter((k) => k !== OPERATOR).sort();
    return [OPERATOR, ...ids].map((person) => { const p = this.profile(person); return { person, name: p?.name ?? p?.platformName ?? null }; });
  }

  /** #1827: a web person's profile as kept (checked again where it is used); null while the file cannot be read. */
  profile(identity: string): WebProfile | null {
    const state = this.load();
    if (state === "unreadable") return null;
    const values = state.buckets.get(identity)?.values;
    const name = values?.get(PROFILE_NAME) as string | undefined;
    const platformName = values?.get(PROFILE_PLATFORM_NAME) as string | undefined;
    return { ...(name !== undefined ? { name } : {}), ...(platformName !== undefined ? { platformName } : {}) };
  }

  /** #1827: set (or, with null, clear) a person's own name — already validated by the caller (web-profile.ts). */
  setProfileName(identity: string, name: string | null): { ok: true } | { ok: false; status: 400 | 503; error: string } {
    const w = this.write(identity, new Map([[PROFILE_NAME, name]]));
    return w.ok ? { ok: true } : w;
  }

  /** B2: unlike the legacy nullable accessor, absence is proven only from a readable, valid CSS bucket. */
  ownerCssSelection(identity: string): { known: true; active: string | null } | { known: false } {
    const state = this.load(); if (state === "unreadable") return { known: false };
    const bucket = state.buckets.get(identity); if (bucket?.ownerCssUnknown) return { known: false };
    const value = bucket?.values.get(OWNER_CSS_ACTIVE);
    return value === undefined ? { known: true, active: null }
      : typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? { known: true, active: value } : { known: false };
  }
  /** #1629 r4 §3: the person's active owner-CSS version, or null (none, or the file cannot be read). */
  ownerCssActive(identity: string): string | null {
    const state = this.load();
    if (state === "unreadable") return null;
    const v = state.buckets.get(identity)?.values.get(OWNER_CSS_ACTIVE);
    return typeof v === "string" ? v : null;
  }
  /** #1629 r4-5: the person's owner-CSS trial id, or null (none, or the file cannot be read). */
  ownerCssTrial(identity: string): string | null {
    const state = this.load();
    if (state === "unreadable") return null;
    const v = state.buckets.get(identity)?.values.get(OWNER_CSS_TRIAL);
    return typeof v === "string" ? v : null;
  }
  /**
   * #1629 r4 §3: move the person's owner-CSS pointers in one write — `active` (null: none in force) and `trial` (null:
   * none on trial). A change is a new rev, so their other devices follow.
   */
  setOwnerCss(identity: string, change: { active?: string | null; trial?: string | null }): { ok: true } | { ok: false; status: 400 | 503; error: string } {
    const patch = new Map<string, unknown>();
    for (const [key, v] of [[OWNER_CSS_ACTIVE, change.active], [OWNER_CSS_TRIAL, change.trial]] as const) {
      if (v === undefined) continue;
      if (v !== null && !/^[0-9a-f]{32}$/.test(v)) return { ok: false, status: 400, error: key };
      patch.set(key, v);
    }
    if (!patch.size) return { ok: true };
    const w = this.write(identity, patch);
    return w.ok ? { ok: true } : w;
  }

  /** #1827: their account's display name at a sign-in (a change is a write and a new rev; the same, nothing). */
  setPlatformName(identity: string, name: string): void {
    const value = name.slice(0, 256);
    if (value) this.write(identity, new Map([[PROFILE_PLATFORM_NAME, value]]));
  }
}

export interface WebProfile {
  /** The name they chose (as stored); absent: not set — their platform name is used. */
  readonly name?: string;
  /** Their account's display name at their last sign-in with a code. */
  readonly platformName?: string;
}

function serialize(state: State): string {
  const identities: Record<string, unknown> = Object.create(null);
  for (const [id, b] of state.buckets) {
    identities[id] = { values: Object.fromEntries(b.values), updated: Object.fromEntries(b.updated) };
  }
  // A raw identity named "__proto__" remains data in the null-prototype container.
  // Bucket values use Object.fromEntries, which also defines own data properties.
  return JSON.stringify({ version: 1, rev: state.rev, identities }, null, 2) + "\n";
}
