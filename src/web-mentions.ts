/**
 * #1682: the names the web chat shows for Discord mentions (`<@id>`, `<@&id>`, `<#id>`) — design: the comment on #1682.
 *
 * Asked by id, a few at a time (GET /ui/mentions?u=…&r=…&c=…: the ids a page found in what it rendered), answered
 * without any Discord request: the fleet's own bots (their instance's label — fleet.yaml and the View profiles in
 * profiles.db), the people seen on inbound messages (a bounded LRU), and what the Discord adapters already hold in
 * their caches. A page never gets a directory: only the names of the ids it asked for. M-3827: the people seen are kept
 * on disk (web-seen-users.json), so a restart does not turn every mention back into @user until each person speaks.
 */
import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";

export type MentionKind = "u" | "r" | "c";
export interface MentionQuery { u: string[]; r: string[]; c: string[] }
export type MentionNames = { u: Record<string, string>; r: Record<string, string>; c: Record<string, string> };

/** At most this many ids in one request (all kinds together). */
export const MAX_MENTION_IDS = 100;
/** People remembered from inbound messages. */
export const MAX_SEEN_USERS = 1000;
const SNOWFLAKE = /^\d{15,25}$/;

/** `?u=1,2&r=3&c=4` → the ids, or why not: digits only (a Discord id), at most MAX_MENTION_IDS, no other parameter. */
export function parseMentionQuery(params: URLSearchParams): { ok: true; query: MentionQuery } | { ok: false; error: string } {
  const query: MentionQuery = { u: [], r: [], c: [] };
  let total = 0;
  for (const key of params.keys()) if (key !== "u" && key !== "r" && key !== "c") return { ok: false, error: `unknown parameter: ${key.slice(0, 16)}` };
  for (const kind of ["u", "r", "c"] as const) {
    for (const raw of params.getAll(kind)) {
      for (const id of raw.split(",")) {
        if (!id) continue;
        if (!SNOWFLAKE.test(id)) return { ok: false, error: "ids are Discord ids (digits)" };
        if (!query[kind].includes(id)) { query[kind].push(id); total++; }
      }
    }
  }
  if (total > MAX_MENTION_IDS) return { ok: false, error: `at most ${MAX_MENTION_IDS} ids` };
  return { ok: true, query };
}

/** M-3827: where the fleet keeps the people it has seen (<home>/web-seen-users.json), so a restart keeps their names. */
export const SEEN_USERS_FILE = "web-seen-users.json";
/** A change reaches the disk at most this long after it happened (one write for a busy stretch, not one per message). */
export const SEEN_USERS_WRITE_DELAY_MS = 10_000;

export interface SeenUsersFile {
  path: string;
  /** Injected for tests; default: an atomic write (temp + fsync + rename), owner-only. */
  write?: (path: string, data: string) => void;
  read?: (path: string) => string;
  delayMs?: number;
  onWarn?: (message: string) => void;
}

/** The entries of a saved file, oldest first: only well-formed ones; anything unreadable is none (never an error). */
export function parseSeenUsersFile(raw: string, max = MAX_SEEN_USERS): Array<[string, string]> {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return []; }
  if (!doc || typeof doc !== "object" || (doc as { version?: unknown }).version !== 1 || !Array.isArray((doc as { users?: unknown }).users)) return [];
  const out: Array<[string, string]> = [];
  for (const entry of (doc as { users: unknown[] }).users) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [id, name] = entry as [unknown, unknown];
    if (typeof id !== "string" || !SNOWFLAKE.test(id) || typeof name !== "string" || !name.trim()) continue;
    out.push([id, name.trim().slice(0, 100)]);
  }
  return out.slice(-max);
}

/** The people seen on inbound messages: id → the name they wrote under, most recent last; the oldest go first. */
export class SeenUsers {
  private readonly names = new Map<string, string>();
  private file: SeenUsersFile | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private warned = false;
  private newest: string | undefined;
  constructor(private readonly max = MAX_SEEN_USERS) {}
  record(id: string, name: string): void {
    if (!SNOWFLAKE.test(id) || typeof name !== "string" || !name.trim()) return;
    const clean = name.trim().slice(0, 100);
    // Already the newest, under the same name: nothing changed, nothing to write.
    if (this.newest === id && this.names.get(id) === clean) return;
    this.names.delete(id);
    this.names.set(id, clean);
    this.newest = id;
    while (this.names.size > this.max) this.names.delete(this.names.keys().next().value as string);
    this.changed();
  }
  get(id: string): string | undefined { return this.names.get(id); }
  get size(): number { return this.names.size; }

  /**
   * M-3827: keep the list in `file` — what it holds is loaded now (older than anyone already seen since the start),
   * and changes are written there from now on (debounced, atomic). A missing or unreadable file is an empty list.
   */
  persistTo(file: SeenUsersFile): void {
    if (this.file) return;
    this.file = file;
    let raw: string | null = null;
    try { raw = (file.read ?? ((p: string) => readFileSync(p, "utf8")))(file.path); } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") file.onWarn?.(`web mention names: could not read ${SEEN_USERS_FILE} (${(err as Error)?.message ?? err}); starting empty`);
    }
    const since = [...this.names];
    this.names.clear();
    if (raw !== null) for (const [id, name] of parseSeenUsersFile(raw, this.max)) this.names.set(id, name);
    for (const [id, name] of since) { this.names.delete(id); this.names.set(id, name); }
    while (this.names.size > this.max) this.names.delete(this.names.keys().next().value as string);
    this.newest = [...this.names.keys()].at(-1);
    if (since.length) this.changed();
  }

  /** Write what is still owed now (the fleet's stop). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.file || !this.dirty) return;
    const file = this.file;
    try {
      (file.write ?? ((p: string, d: string) => atomicWriteFileSync(p, d, { mode: 0o600 })))(file.path, JSON.stringify({ version: 1, users: [...this.names] }));
      this.dirty = false;
    } catch (err) {
      // Kept owed: the next change (or the stop) tries again. Said once, not per message.
      if (!this.warned) { this.warned = true; file.onWarn?.(`web mention names: could not write ${SEEN_USERS_FILE} (${(err as Error)?.message ?? err})`); }
    }
  }

  private changed(): void {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.file.delayMs ?? SEEN_USERS_WRITE_DELAY_MS);
    this.timer.unref?.();
  }
}

/** One source of names: what it knows for the asked ids (leaving out what it does not). */
export type MentionSource = (query: MentionQuery) => Partial<MentionNames>;

/** The names for a query from the sources, in order: the first that knows an id names it. Own keys only. */
export function resolveMentions(query: MentionQuery, sources: MentionSource[]): MentionNames {
  const out: MentionNames = { u: Object.create(null), r: Object.create(null), c: Object.create(null) };
  for (const source of sources) {
    let found: Partial<MentionNames>;
    try { found = source(query); } catch { continue; }
    for (const kind of ["u", "r", "c"] as const) {
      const got = found[kind];
      if (!got) continue;
      for (const id of query[kind]) {
        if (Object.hasOwn(out[kind], id) || !Object.hasOwn(got, id)) continue;
        const name = got[id];
        if (typeof name === "string" && name.trim()) out[kind][id] = name.trim().slice(0, 100);
      }
    }
  }
  return { u: { ...out.u }, r: { ...out.r }, c: { ...out.c } };
}

/** Labels for one already-visible message, never an arbitrary guest query. Reads the existing memory-only sources. */
export function messageMentionNames(text: string, source: MentionSource): MentionNames | undefined {
  const ids = new Map<string, { kind: MentionKind; id: string }>();
  for (const m of text.replace(/\u0000/g, "").matchAll(/<(@!?|@&|#)(\d{15,25})>/g)) {
    const kind: MentionKind = m[1] === "#" ? "c" : m[1] === "@&" ? "r" : "u";
    ids.set(`${kind}:${m[2]}`, { kind, id: m[2]! });
  }
  if (!ids.size) return undefined;
  const out: MentionNames = { u: {}, r: {}, c: {} }, entries = [...ids.values()];
  for (let i = 0; i < entries.length; i += MAX_MENTION_IDS) {
    const query: MentionQuery = { u: [], r: [], c: [] };
    for (const { kind, id } of entries.slice(i, i + MAX_MENTION_IDS)) query[kind].push(id);
    const names = resolveMentions(query, [source]);
    for (const kind of ["u", "r", "c"] as const) Object.assign(out[kind], names[kind]);
  }
  return Object.values(out).some(names => Object.keys(names).length) ? out : undefined;
}
