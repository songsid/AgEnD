/**
 * #1682: the names the web chat shows for Discord mentions (`<@id>`, `<@&id>`, `<#id>`) — design: the comment on #1682.
 *
 * Asked by id, a few at a time (GET /ui/mentions?u=…&r=…&c=…: the ids a page found in what it rendered), answered
 * without any Discord request: the fleet's own bots (their instance's label — fleet.yaml and the View profiles in
 * profiles.db), the people seen on inbound messages (a bounded LRU), and what the Discord adapters already hold in
 * their caches. A page never gets a directory: only the names of the ids it asked for.
 */
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

/** The people seen on inbound messages: id → the name they wrote under, most recent last; the oldest go first. */
export class SeenUsers {
  private readonly names = new Map<string, string>();
  constructor(private readonly max = MAX_SEEN_USERS) {}
  record(id: string, name: string): void {
    if (!SNOWFLAKE.test(id) || typeof name !== "string" || !name.trim()) return;
    this.names.delete(id);
    this.names.set(id, name.trim().slice(0, 100));
    while (this.names.size > this.max) this.names.delete(this.names.keys().next().value as string);
  }
  get(id: string): string | undefined { return this.names.get(id); }
  get size(): number { return this.names.size; }
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
