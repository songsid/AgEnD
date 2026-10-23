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
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export const OFFICE_LIMITS = {
  offices: 20, members: 500, seats: 500, waypoints: 2000, edges: 8000,
  coord: 20000, name: 60, member: 200, pointId: 64, fileBytes: 256 * 1024,
} as const;
/** The page's own office (fleet-office-model.js AUTO_ID): never a stored one's id. */
export const AUTO_OFFICE_ID = "auto";

export interface OfficePoint { id: string; x: number; y: number }
export interface OfficeSeat extends OfficePoint { instance?: string }
export interface OfficeLayout { seats: OfficeSeat[]; waypoints: OfficePoint[]; edges: Array<[string, string]> }
/** `members`: instance names, or `team:<name>` for a team's members; none means everyone. */
export interface Office { id: string; name: string; skin: string; members: string[]; layout?: OfficeLayout }
export type OfficeCheck = { ok: true; offices: Office[] } | { ok: false; status: 400 | 413; error: string; detail?: string };
export type OfficeWrite = { ok: true; rev: number; offices: Office[] } | { ok: false; status: 400 | 409 | 413 | 503; error: string; detail?: string };

const ID = /^[A-Za-z0-9_-]{1,40}$/;
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
function office(v: unknown, at: string): Office {
  if (!isObj(v)) throw new Refused(at, "an object");
  keysIn(v, ["id", "name", "skin", "members", "layout"], at);
  if (typeof v.id !== "string" || !ID.test(v.id)) throw new Refused(`${at}.id`, "1–40 letters, digits, _ or -");
  if (v.id === AUTO_OFFICE_ID) throw new Refused(`${at}.id`, `"${AUTO_OFFICE_ID}" is the page's own office`);
  const skin = v.skin === undefined ? "pixel" : typeof v.skin === "string" && ID.test(v.skin) ? v.skin : null;
  if (skin === null) throw new Refused(`${at}.skin`, "1–40 letters, digits, _ or -");
  const members = list(v.members ?? [], OFFICE_LIMITS.members, `${at}.members`).map((m, i) => text(m, OFFICE_LIMITS.member, `${at}.members[${i}]`));
  if (new Set(members).size !== members.length) throw new Refused(`${at}.members`, "a name twice");
  return { id: v.id, name: text(v.name, OFFICE_LIMITS.name, `${at}.name`), skin, members, ...(v.layout === undefined ? {} : { layout: layout(v.layout, `${at}.layout`) }) };
}

/** A whole list of offices, as a person sends it: every rule, or a refusal naming where it broke. */
export function checkOffices(raw: unknown): OfficeCheck {
  try {
    const ids = new Set<string>();
    const offices = list(raw, OFFICE_LIMITS.offices, "offices").map((o, i) => {
      const checked = office(o, `offices[${i}]`);
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

type State = { rev: number; offices: Office[] } | "unreadable";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class OfficeStore {
  private state: State | null = null;
  readonly path: string;
  constructor(dataDir: string) { this.path = join(dataDir, "web-offices.json"); }

  private load(): State {
    if (this.state) return this.state;
    let body: string;
    try { body = readFileSync(this.path, "utf8"); }
    catch (err) { return (this.state = (err as NodeJS.ErrnoException).code === "ENOENT" ? { rev: 0, offices: [] } : "unreadable"); }
    try {
      const doc = JSON.parse(body) as { version?: unknown; rev?: unknown; offices?: unknown };
      if (doc.version !== 1 || !Number.isSafeInteger(doc.rev) || !Array.isArray(doc.offices)) return (this.state = "unreadable");
      const offices: Office[] = [], ids = new Set<string>();
      for (const raw of doc.offices.slice(0, OFFICE_LIMITS.offices)) {
        try { const o = office(raw, "office"); if (!ids.has(o.id)) { ids.add(o.id); offices.push(o); } }
        catch (err) { if (!(err instanceof Refused)) throw err; }
      }
      return (this.state = { rev: doc.rev as number, offices });
    } catch { return (this.state = "unreadable"); }
  }

  readable(): boolean { return this.load() !== "unreadable"; }
  rev(): number { const s = this.load(); return s === "unreadable" ? 0 : s.rev; }
  /** What the page reads (GET /ui/offices): a copy; none when the file is unreadable. */
  list(): { rev: number; offices: Office[]; readable: boolean } {
    const s = this.load();
    return s === "unreadable" ? { rev: 0, offices: [], readable: false } : { rev: s.rev, offices: clone(s.offices), readable: true };
  }
  /**
   * Replace every stored office (PUT /ui/offices). `expectedRev`: the rev the page last read — another change since is a
   * 409, so two editors never overwrite each other unseen. On disk first, then in memory.
   */
  replace(raw: unknown, expectedRev?: number): OfficeWrite {
    const s = this.load();
    if (s === "unreadable") return { ok: false, status: 503, error: "offices_unreadable" };
    if (expectedRev !== undefined && expectedRev !== s.rev) return { ok: false, status: 409, error: "offices_changed", detail: `now at rev ${s.rev}` };
    const checked = checkOffices(raw);
    if (!checked.ok) return checked;
    const rev = s.rev + 1;
    try { atomicWriteFileSync(this.path, JSON.stringify({ version: 1, rev, offices: checked.offices }, null, 2) + "\n", { mode: 0o600 }); }
    catch (err) { return { ok: false, status: 503, error: "offices_write_failed", detail: (err as Error).message }; }
    this.state = { rev, offices: checked.offices };
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
