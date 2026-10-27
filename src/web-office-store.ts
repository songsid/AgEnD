/**
 * Fleet → Org chart → Office: the offices people made, kept on the host (the page's own "whole fleet" office is never
 * stored: it is built from the teams each time).
 *
 *   <dataDir>/web-offices.json   { version: 1, rev, offices: Office[] }   (0600, atomic)
 *
 * The same shape as web-themes.json (web-theme-store.ts): one file for every viewer (an office is the fleet's, everyone
 * sees the same one), in the AgEnD home beside fleet.yaml — never fleet.yaml itself, so a change reconciles and restarts
 * nothing. An unreadable file means no offices and every write refused (503), never overwritten. Memory changes only
 * once a write is on disk. A write is checked strictly (checkOffices: unknown keys, sizes, counts, ranges); what is read
 * back is checked again, one office at a time (an office a tightened rule refuses is dropped, the rest stay).
 *
 * #2513: an office on a zones skin may keep `overrides` (the Office view's Edit layout: seats, furniture, the door and
 * the walkable graph moved on the pack, which itself never changes) — their shape checked by the page's own module
 * (fleet-office-pack.js checkLayoutOverrides), and, for a pack the host keeps, put on it (applyOverrides: a seat inside
 * its area, as many seats as the pack's, furniture the pack has) before a write is accepted.
 *
 * #2665: an item's night place (`overrides.furnitureNight`) is what the page reads and sends, but on disk it is kept
 * beside the offices, never inside them —
 *
 *   { version: 1, rev, offices: [ … overrides without furnitureNight … ], furnitureNight: { "<office id>": { "<item>": [x, y] } } }
 *
 * — so a rollback stays readable: an older host checks each office's overrides strictly (an unknown key drops that
 * office), but reads the file's other keys past version/rev/offices without looking. There every office keeps its name,
 * members and the rest of its layout, and only the night places are left out (an older host's save drops them). Read
 * back here, an office's night places are put on its overrides and checked with them; ones that no longer check (a
 * pack that dropped the item: on a write) are left out, the office kept.
 *
 * #2691: a seat's reservation (`overrides.seatFor`) is kept the same way, for the same reason (a host with #2665 but
 * not #2691 refuses it inside the overrides as well) —
 *
 *   { version: 1, rev, offices: [ … ], furnitureNight: { … }, seatFor: { "<office id>": { "<area>": { "<slot>": { for, lend } } } } }
 *
 * — each read back on its own: reservations that no longer check leave the night places (and the office) in.
 *
 * #2736: the mail drop (`overrides.mailDrop`) likewise, under `mailDrop` by office id: a 2.3.2 beta before it refuses
 * the key inside the overrides (and would show the office without its layout).
 *
 * #2706: the rest of an office's overrides are kept beside it too, by office id, never in its entry — 2.3.1 refuses an
 * entry with an `overrides` key, drops that office on read, and its next save deletes it. So 2.3.1 (and a host before
 * #2513) keeps every office, only without its layout —
 *
 *   { version: 1, rev, offices: [ { id, name, skin, members } … ], overrides: { "<office id>": { pack, seats, … } }, furnitureNight: { … }, seatFor: { … } }
 *
 * — and a 2.3.2 beta before #2706 reads every office the same way (it looks for overrides in the entry only). Read
 * here, an office's overrides come from beside it, else (a file a beta before #2706 wrote) from its entry, and the next
 * write moves them beside it. Overrides that do not check leave the office in, without them (and so without its night
 * places and reservations, which go on them).
 *
 * #2716: the whole-fleet office (the page's own, never stored as an office) has its style kept here too, for every
 * viewer and device and the share links alike — `autoSkin` beside the list (a skin id: a built-in style's or a pack's;
 * none: the page's default). An older host reads past it; its save drops it (the style falls back to the default).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { applyOverrides, checkLayoutOverrides, type CheckedPack, type LayoutOverrides } from "./ui/fleet-office-pack.js";

export const OFFICE_LIMITS = {
  offices: 20, members: 500, seats: 500, waypoints: 2000, edges: 8000,
  coord: 20000, name: 60, member: 200, pointId: 64, fileBytes: 256 * 1024,
} as const;
/** The page's own office (fleet-office-model.js AUTO_ID): never a stored one's id. */
export const AUTO_OFFICE_ID = "auto";

export interface OfficePoint { id: string; x: number; y: number }
export interface OfficeSeat extends OfficePoint { instance?: string }
export interface OfficeLayout { seats: OfficeSeat[]; waypoints: OfficePoint[]; edges: Array<[string, string]> }
/**
 * #2752: the one member of an office kept for nobody (its style's NPCs only): a team with no name, which no team has, so
 * an older version finds nobody in it too. As fleet-office-model.js NOBODY.
 */
export const OFFICE_NOBODY = "team:";
/** `members`: instance names, or `team:<name>` for a team's members; none means everyone, [OFFICE_NOBODY] nobody. */
export interface Office { id: string; name: string; skin: string; members: string[]; layout?: OfficeLayout; overrides?: LayoutOverrides }
/** The checked pack an office's overrides are put on (a pack the host keeps), or null (a built-in style: shape only). */
export type OverridePack = (id: string) => CheckedPack | null;
export type OfficeCheck = { ok: true; offices: Office[] } | { ok: false; status: 400 | 413; error: string; detail?: string };
export type OfficeWrite = { ok: true; rev: number; offices: Office[] } | { ok: false; status: 400 | 409 | 413 | 503; error: string; detail?: string };

const ID = /^[A-Za-z0-9_-]{1,40}$/;
/** #2708 review: ids an object already has a meaning for — never an office's (its overrides are kept in maps by office id). */
const INHERITED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const POINT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

class Refused extends Error { constructor(readonly at: string, readonly why: string) { super(`${at}: ${why}`); } }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function keysIn(v: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Refused(at, `unknown key "${k}"`);
}
function text(v: unknown, max: number, at: string): string {
  if (typeof v !== "string") throw new Refused(at, "a string");
  const s = v.trim();
  if (!s || s.length > max || CONTROL.test(s)) throw new Refused(at, `1–${max} characters, no control characters`);
  return s;
}
function list(v: unknown, max: number, at: string): unknown[] {
  if (!Array.isArray(v)) throw new Refused(at, "a list");
  if (v.length > max) throw new Refused(at, `at most ${max}`);
  return v;
}
function coord(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > OFFICE_LIMITS.coord) throw new Refused(at, `a number from 0 to ${OFFICE_LIMITS.coord}`);
  return v;
}
function points<T extends OfficePoint>(v: unknown, max: number, at: string, extra: (p: Record<string, unknown>, at: string) => Partial<T> = () => ({})): T[] {
  const ids = new Set<string>();
  return list(v, max, at).map((p, i) => {
    const here = `${at}[${i}]`;
    if (!isObj(p)) throw new Refused(here, "an object");
    if (typeof p.id !== "string" || !POINT_ID.test(p.id)) throw new Refused(`${here}.id`, "1–64 letters, digits, _ . : or -");
    if (ids.has(p.id)) throw new Refused(`${here}.id`, "used twice");
    ids.add(p.id);
    return { id: p.id, x: coord(p.x, `${here}.x`), y: coord(p.y, `${here}.y`), ...extra(p, here) } as T;
  });
}
function layout(v: unknown, at: string): OfficeLayout {
  if (!isObj(v)) throw new Refused(at, "an object");
  keysIn(v, ["seats", "waypoints", "edges"], at);
  const seats = points<OfficeSeat>(v.seats, OFFICE_LIMITS.seats, `${at}.seats`, (p, here) => {
    keysIn(p, ["id", "x", "y", "instance"], here);
    return p.instance === undefined ? {} : { instance: text(p.instance, OFFICE_LIMITS.member, `${here}.instance`) };
  });
  if (!seats.length) throw new Refused(`${at}.seats`, "at least one seat");
  const waypoints = points<OfficePoint>(v.waypoints ?? [], OFFICE_LIMITS.waypoints, `${at}.waypoints`, (p, here) => { keysIn(p, ["id", "x", "y"], here); return {}; });
  const known = new Set(waypoints.map(w => w.id));
  const edges = list(v.edges ?? [], OFFICE_LIMITS.edges, `${at}.edges`).map((e, i): [string, string] => {
    const here = `${at}.edges[${i}]`;
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || typeof e[1] !== "string") throw new Refused(here, "a pair of waypoint ids");
    if (!known.has(e[0]) || !known.has(e[1])) throw new Refused(here, "names a waypoint the layout does not have");
    if (e[0] === e[1]) throw new Refused(here, "joins a waypoint to itself");
    return [e[0], e[1]];
  });
  return { seats, waypoints, edges };
}
/** A refusal from fleet-office-pack.js ("overrides.<where>: <why>"), placed under `at`. */
function placed(at: string, error: string): Refused {
  const k = error.indexOf(": ");
  const where = k < 0 ? "" : error.slice(0, k).replace(/^overrides/, "");
  return new Refused(`${at}${where}`, k < 0 ? error : error.slice(k + 2));
}
function overrides(v: unknown, at: string, packOf?: OverridePack): LayoutOverrides {
  const c = checkLayoutOverrides(v);
  if (!c.ok) throw placed(at, c.error);
  const pack = packOf?.(c.overrides.pack);
  if (pack) { const a = applyOverrides(pack, c.overrides); if (!a.ok) throw placed(at, a.error); }
  return c.overrides;
}
function office(v: unknown, at: string, packOf?: OverridePack): Office {
  if (!isObj(v)) throw new Refused(at, "an object");
  keysIn(v, ["id", "name", "skin", "members", "layout", "overrides"], at);
  if (typeof v.id !== "string" || !ID.test(v.id)) throw new Refused(`${at}.id`, "1–40 letters, digits, _ or -");
  if (v.id === AUTO_OFFICE_ID) throw new Refused(`${at}.id`, `"${AUTO_OFFICE_ID}" is the page's own office`);
  if (INHERITED_IDS.has(v.id)) throw new Refused(`${at}.id`, "not __proto__, constructor or prototype");
  const skin = v.skin === undefined ? "pixel" : typeof v.skin === "string" && ID.test(v.skin) ? v.skin : null;
  if (skin === null) throw new Refused(`${at}.skin`, "1–40 letters, digits, _ or -");
  const members = list(v.members ?? [], OFFICE_LIMITS.members, `${at}.members`).map((m, i) => text(m, OFFICE_LIMITS.member, `${at}.members[${i}]`));
  if (new Set(members).size !== members.length) throw new Refused(`${at}.members`, "a name twice");
  return { id: v.id, name: text(v.name, OFFICE_LIMITS.name, `${at}.name`), skin, members, ...(v.layout === undefined ? {} : { layout: layout(v.layout, `${at}.layout`) }),
    ...(v.overrides === undefined ? {} : { overrides: overrides(v.overrides, `${at}.overrides`, packOf) }) };
}

/** A whole list of offices, as a person sends it: every rule, or a refusal naming where it broke. */
export function checkOffices(raw: unknown, packOf?: OverridePack): OfficeCheck {
  try {
    const ids = new Set<string>();
    const offices = list(raw, OFFICE_LIMITS.offices, "offices").map((o, i) => {
      const checked = office(o, `offices[${i}]`, packOf);
      if (ids.has(checked.id)) throw new Refused(`offices[${i}].id`, "used twice");
      ids.add(checked.id);
      return checked;
    });
    if (Buffer.byteLength(JSON.stringify(offices)) > OFFICE_LIMITS.fileBytes) return { ok: false, status: 413, error: "offices_too_large", detail: `at most ${OFFICE_LIMITS.fileBytes / 1024} KiB` };
    return { ok: true, offices };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, status: 400, error: "offices_invalid", detail: err.message };
    throw err;
  }
}

type State = { rev: number; offices: Office[]; autoSkin: string | null } | "unreadable";
/** The overrides parts kept beside the offices on disk, apart from the rest (#2665 night places, #2691 seat reservations, #2736 the mail drop). */
const BESIDE = ["furnitureNight", "seatFor", "mailDrop"] as const;
type Beside = (typeof BESIDE)[number];
type OnDisk = { offices: Office[]; overrides?: Record<string, LayoutOverrides> } & { [K in Beside]?: Record<string, NonNullable<LayoutOverrides[K]>> };
/**
 * #2665/#2706: what goes on disk — the offices without their overrides; beside them, by office id, each office's
 * overrides without those parts, and each part on its own (none: no key). The maps have no prototype (#2708 review), so
 * an id is always an own key; exported for tests.
 */
export function officesOnDisk(offices: Office[]): OnDisk {
  const out: OnDisk = { offices: [] };
  out.offices = offices.map(o => {
    if (!o.overrides) return o;
    const { overrides, ...entry } = o, rest: LayoutOverrides = { ...overrides };
    for (const k of BESIDE) {
      if (rest[k] === undefined) continue;
      ((out[k] ??= Object.create(null)) as Record<string, unknown>)[o.id] = rest[k];
      delete rest[k];
    }
    (out.overrides ??= Object.create(null) as Record<string, LayoutOverrides>)[o.id] = rest;
    return entry;
  });
  return out;
}
const own = (side: unknown, id: string): boolean => isObj(side) && Object.prototype.hasOwnProperty.call(side, id);
/** #2665: a stored office with its `key` overrides (kept beside it on disk, in `side`) back on its overrides. */
function withBeside(raw: unknown, key: Beside, side: unknown): unknown {
  if (!isObj(raw) || typeof raw.id !== "string" || !own(side, raw.id) || !isObj(raw.overrides)) return raw;
  return { ...raw, overrides: { ...raw.overrides, [key]: (side as Record<string, unknown>)[raw.id] } };
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class OfficeStore {
  private state: State | null = null;
  readonly path: string;
  /** `packOf`: the packs the host keeps (web-office-skins.ts), for checking an office's overrides on a write. */
  constructor(dataDir: string, private readonly packOf?: OverridePack) { this.path = join(dataDir, "web-offices.json"); }

  private load(): State {
    if (this.state) return this.state;
    let body: string;
    try { body = readFileSync(this.path, "utf8"); }
    catch (err) { return (this.state = (err as NodeJS.ErrnoException).code === "ENOENT" ? { rev: 0, offices: [], autoSkin: null } : "unreadable"); }
    try {
      const doc = JSON.parse(body) as { version?: unknown; rev?: unknown; offices?: unknown; overrides?: unknown; autoSkin?: unknown } & { [K in Beside]?: unknown };
      if (doc.version !== 1 || !Number.isSafeInteger(doc.rev) || !Array.isArray(doc.offices)) return (this.state = "unreadable");
      const offices: Office[] = [], ids = new Set<string>();
      const read = (raw: unknown): Office | null => {
        try { return office(raw, "office"); } catch (err) { if (!(err instanceof Refused)) throw err; return null; }
      };
      for (const raw of doc.offices.slice(0, OFFICE_LIMITS.offices)) {
        // #2706: the office first, without overrides; then its overrides (beside it, else in its entry: a beta before
        // #2706 wrote them there), left out when they do not check, the office kept.
        if (!isObj(raw)) continue;
        const { overrides: inEntry, ...entry } = raw;
        let cur: unknown = entry, o = read(entry);
        const ov = typeof raw.id === "string" && own(doc.overrides, raw.id) ? (doc.overrides as Record<string, unknown>)[raw.id] : inEntry;
        if (o && ov !== undefined) { const next = { ...entry, overrides: ov }, r = read(next); if (r) { cur = next; o = r; } }
        // Each kept beside put back in turn: one that does not check is left out, the office and the rest kept.
        for (const k of BESIDE) {
          const next = o ? withBeside(cur, k, doc[k]) : cur;
          if (next === cur) continue;
          const r = read(next);
          if (r) { cur = next; o = r; }
        }
        if (o && !ids.has(o.id)) { ids.add(o.id); offices.push(o); }
      }
      // #2716: one that does not check is the default's (none), the offices kept.
      const autoSkin = typeof doc.autoSkin === "string" && ID.test(doc.autoSkin) ? doc.autoSkin : null;
      return (this.state = { rev: doc.rev as number, offices, autoSkin });
    } catch { return (this.state = "unreadable"); }
  }

  readable(): boolean { return this.load() !== "unreadable"; }
  rev(): number { const s = this.load(); return s === "unreadable" ? 0 : s.rev; }
  /** What the page reads (GET /ui/offices): a copy; none when the file is unreadable. #2716: `autoSkin` when one is kept. */
  list(): { rev: number; offices: Office[]; readable: boolean; autoSkin?: string } {
    const s = this.load();
    return s === "unreadable" ? { rev: 0, offices: [], readable: false }
      : { rev: s.rev, offices: clone(s.offices), readable: true, ...(s.autoSkin ? { autoSkin: s.autoSkin } : {}) };
  }
  /** #2716: the whole-fleet office's style kept for everyone, or null (the page's default). */
  autoSkin(): string | null { const s = this.load(); return s === "unreadable" ? null : s.autoSkin; }
  /**
   * #2716: set the whole-fleet office's style (PUT /ui/office-style): a skin id, or null for the default. One value, so
   * the last person's pick wins (no rev); the offices are written unchanged with it, and the rev moves (every page reads
   * again). On disk first, then in memory.
   */
  setAutoSkin(skin: unknown): { ok: true; rev: number; autoSkin: string | null } | { ok: false; status: 400 | 503; error: string; detail?: string } {
    const s = this.load();
    if (s === "unreadable") return { ok: false, status: 503, error: "offices_unreadable" };
    if (skin !== null && (typeof skin !== "string" || !ID.test(skin))) return { ok: false, status: 400, error: "office_style_invalid", detail: "skin: 1–40 letters, digits, _ or -, or null" };
    const autoSkin = skin as string | null, rev = s.rev + 1;
    try { this.write(rev, s.offices, autoSkin); }
    catch (err) { return { ok: false, status: 503, error: "offices_write_failed", detail: (err as Error).message }; }
    this.state = { rev, offices: s.offices, autoSkin };
    return { ok: true, rev, autoSkin };
  }
  private write(rev: number, offices: Office[], autoSkin: string | null): void {
    atomicWriteFileSync(this.path, JSON.stringify({ version: 1, rev, ...officesOnDisk(offices), ...(autoSkin ? { autoSkin } : {}) }, null, 2) + "\n", { mode: 0o600 });
  }
  /**
   * Replace every stored office (PUT /ui/offices). `expectedRev`: the rev the page last read — another change since is a
   * 409, so two editors never overwrite each other unseen. On disk first, then in memory. `packOf` (#2692): the packs to
   * check the overrides against in place of the kept ones (a pack about to replace one; or none, to put back as it was).
   */
  replace(raw: unknown, expectedRev?: number, opts: { packOf?: OverridePack } = {}): OfficeWrite {
    const s = this.load();
    if (s === "unreadable") return { ok: false, status: 503, error: "offices_unreadable" };
    if (expectedRev !== undefined && expectedRev !== s.rev) return { ok: false, status: 409, error: "offices_changed", detail: `now at rev ${s.rev}` };
    const checked = checkOffices(raw, opts.packOf ?? this.packOf);
    if (!checked.ok) return checked;
    const rev = s.rev + 1;
    try { this.write(rev, checked.offices, s.autoSkin); }
    catch (err) { return { ok: false, status: 503, error: "offices_write_failed", detail: (err as Error).message }; }
    this.state = { rev, offices: checked.offices, autoSkin: s.autoSkin };
    return { ok: true, rev, offices: clone(checked.offices) };
  }
}

/**
 * Office review (#2399 carry): how often one person may save the offices (PUT /ui/offices). An editor saves on an explicit
 * Save, so a person needs a few a minute at most; a page or a script looping on PUT is refused (429, with when to try
 * again) instead of rewriting web-offices.json and announcing it to every page each time. Only accepted saves count
 * (`record` after the write is on disk); the clock is monotonic; a fleet restart clears it.
 */
export const OFFICE_WRITES = { perWindow: 20, windowMs: 60_000 } as const;
export class OfficeWriteLimiter {
  private readonly saves = new Map<string, number[]>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly limits: { perWindow: number; windowMs: number } = OFFICE_WRITES) {}
  private recent(person: string, now: number): number[] {
    const kept = (this.saves.get(person) ?? []).filter(t => now - t < this.limits.windowMs);
    if (kept.length) this.saves.set(person, kept); else this.saves.delete(person);
    return kept;
  }
  /** Whether `person` may save now; else the seconds until one of its saves leaves the window. Changes nothing. */
  check(person: string): { ok: true } | { ok: false; retry_after_s: number } {
    const now = this.now(), kept = this.recent(person, now);
    return kept.length < this.limits.perWindow ? { ok: true } : { ok: false, retry_after_s: Math.max(1, Math.ceil((this.limits.windowMs - (now - kept[0]!)) / 1000)) };
  }
  /** Count an accepted save. */
  record(person: string): void { const now = this.now(); this.saves.set(person, [...this.recent(person, now), now]); }
}
