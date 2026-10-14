/**
 * #1665: the web preferences that follow the person from device to device (theme, language, the sidebar's arrangement,
 * the HTML-preview opt-in), kept on the host — design: the comment on #1665.
 *
 * - The tour and the first-run card stay per device (the user's call on #1665): they are not keys here.
 * - One bucket per web identity. There is one today: every web session is the operator's (SessionRecord has no
 *   owner), so the file is keyed by identity and holds "operator" only; a per-owner key can come later unmigrated.
 * - A fixed registry of keys, each with its own validator. Anything else is refused — "__proto__" and "constructor"
 *   are just unknown keys: every lookup is a Map, never an object's prototype chain.
 * - The file (<home>/web-prefs.json, 0600) is replaced atomically. One that cannot be read or parsed is never
 *   overwritten: reads give the defaults, writes are refused, until a person looks at it.
 * - `rev` rises with every change; the status frame carries it, so another device re-reads at its next poll.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export const WEB_PREFS_FILE = "web-prefs.json";
export const OPERATOR = "operator";

type Invalid = { readonly invalid: string };
const bad = (invalid: string): Invalid => ({ invalid });
const isInvalid = (v: unknown): v is Invalid => !!v && typeof v === "object" && Object.hasOwn(v, "invalid") && Object.keys(v).length === 1;

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const shortText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const name = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
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
const PROFILE_KEYS: ReadonlySet<string> = new Set([PROFILE_NAME, PROFILE_PLATFORM_NAME]);

/** #1664: at most this many favorites. */
export const MAX_FAVORITES = 50;
const FAVORITES = "nav.favorites";

/** The status chips of the sidebar filter (src/ui/shared/instance-nav.js STATUS_FACETS). */
const STATUS_FACETS = new Set(["working", "needs", "idle", "stopped", "crashed"]);

/** Each key's validator: the value to store, or why it is refused. `null` (clear) never reaches one. */
const REGISTRY = new Map<string, (v: unknown) => unknown>([
  ["theme", (v) => (v === "light" || v === "dark" || v === "system" ? v : bad("theme: light, dark or system"))],
  ["lang", (v) => (v === "en" || v === "zh-TW" ? v : bad("lang: en or zh-TW"))],
  // The sidebar's drag order: the rows instance-nav.js keeps (group rows have no group_name).
  ["nav.order", (v) => {
    if (!Array.isArray(v) || v.length > 1000) return bad("nav.order: a list of at most 1000 rows");
    for (const row of v) {
      if (!plain(row) || !exactly(row, ["item_type", "item_name", "sort_index", "group_name"])) return bad("nav.order: rows of item_type, item_name, sort_index, group_name");
      const groupRow = row.item_type === "group";
      if (!groupRow && row.item_type !== "instance") return bad("nav.order: item_type group or instance");
      if (!name(row.item_name)) return bad("nav.order: item_name of 1–128 characters");
      if (!Number.isSafeInteger(row.sort_index) || (row.sort_index as number) < 0) return bad("nav.order: sort_index a whole number from 0");
      if (groupRow ? row.group_name !== null : !name(row.group_name)) return bad("nav.order: group_name null for a group, the group's name for an instance");
    }
    return v;
  }],
  ["nav.collapsed", (v) => uniqueStrings(v, 200, name, "nav.collapsed")],
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
  // #1722: which name leads where the web shows an instance — its nickname (display name) or its real instance name.
  ["names.primary", (v) => (v === "nickname" || v === "instance" ? v : bad("names.primary: nickname or instance"))],
  // #1827: a web person's own profile — the name they chose, and their account's display name at their last sign-in.
  // Kept here so it follows the person (their bucket), but never a /ui/prefs key: read and written only through
  // profile() / setProfileName() / setPlatformName(), and checked in full where it is used (web-profile.ts). The file's
  // own check is only its shape.
  [PROFILE_NAME, (v) => (typeof v === "string" && v.length >= 1 && v.length <= 256 ? v : bad("profile.name"))],
  [PROFILE_PLATFORM_NAME, (v) => (typeof v === "string" && v.length >= 1 && v.length <= 256 ? v : bad("profile.platformName"))],
]);
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
    const validate = PROFILE_KEYS.has(key) ? undefined : REGISTRY.get(key);
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

interface Bucket { values: Map<string, unknown>; updated: Map<string, number> }
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
          const validate = REGISTRY.get(key);
          if (!validate) continue;
          const value = validate(raw.values[key]);
          if (isInvalid(value)) continue;
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
    const state = this.load();
    if (state === "unreadable") return { ok: false, status: 503, error: "prefs_unreadable" };
    const prior = state.buckets.get(identity);
    const next: Bucket = { values: new Map(prior?.values), updated: new Map(prior?.updated) };
    const at = (this.opts.now ?? Date.now)();
    const changed: string[] = [];
    for (const [key, value] of patch) {
      if (opts.onlyIfUnset && next.values.has(key)) continue;
      if (value === null) {
        if (!next.values.has(key)) continue;
        next.values.delete(key); next.updated.delete(key);
      } else {
        if (next.values.has(key) && JSON.stringify(next.values.get(key)) === JSON.stringify(value)) continue;
        next.values.set(key, value); next.updated.set(key, at);
      }
      changed.push(key);
    }
    if (!changed.length) return { ok: true, view: this.viewOf(state, identity), changed };
    const buckets = new Map(state.buckets);
    buckets.set(identity, next);
    const candidate: State = { buckets, rev: state.rev + 1 };
    (this.opts.write ?? ((path, data) => atomicWriteFileSync(path, data, { mode: 0o600 })))(this.path, serialize(candidate));
    // Only once it is on disk: a failed write leaves memory as the file is.
    this.state = candidate;
    return { ok: true, view: this.viewOf(candidate, identity), changed };
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
  const identities: Record<string, unknown> = {};
  for (const [id, b] of state.buckets) {
    identities[id] = { values: Object.fromEntries(b.values), updated: Object.fromEntries(b.updated) };
  }
  // Object.fromEntries with a "__proto__" entry defines an own property, but no such key ever gets in: ids are ours, keys
  // are the registry's.
  return JSON.stringify({ version: 1, rev: state.rev, identities }, null, 2) + "\n";
}
