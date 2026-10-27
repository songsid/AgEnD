/**
 * #2714 / #2738: the links classic kiro's /compact leaves in `conversations_v2`, worked out in one pass — run on the
 * kiro store worker lane (kiro-v2-store.ts), never on the fleet loop.
 *
 * A compaction writes a new row whose transcript starts with the whole earlier one; nothing else points from one to
 * the other. Proving that means reading every transcript — on a long-lived instance tens of MB each, a GB per store
 * key (#2738: 38 rows, 1 GB, and a pairwise SQL join that parsed them again for every pair blocked the loop for
 * minutes and the systemd watchdog killed the fleet). Here each transcript is extracted once, rows in creation order,
 * and kept only as a running hash: a row continues an earlier one when its hash at the earlier one's length minus
 * its closing "]" equals the earlier one's, and a "," stands where that "]" stood. One transcript in memory at a time.
 *
 * Bounded: the rows' total size is checked first (no value read), and the clock between rows. Over either budget the
 * answer is "over-budget" — unproven, the same as an ambiguous compaction: the caller stays on the recorded id.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

/** The most a store key's rows may hold (value bytes) for its links to be worked out at all. */
export const KIRO_CLASSIC_LINKS_MAX_BYTES = 2 * 1024 ** 3;

export interface KiroClassicLinksInput { dbPath: string; keys: string[]; maxBytes?: number }
export type KiroClassicLinks =
  | {
    kind: "ok";
    /** Each conversation's first-hop continuations: same key, summarized, created no earlier than it was last written. */
    successors: Record<string, string[]>;
    /** Whether a conversation carries a compaction summary (it continues an earlier one). */
    summarized: Record<string, boolean>;
  }
  | { kind: "over-budget"; detail: string }
  | { kind: "unreadable"; detail: string };

/** A launch that did not work its links out first: unproven, so it stays on the recorded conversation. */
export const KIRO_CLASSIC_LINKS_NOT_PREPARED: KiroClassicLinks = { kind: "unreadable", detail: "classic compaction links were not prepared for this launch" };

interface Row { key: string; id: string; created: number; at: number; bytes: number }
interface Seen { id: string; at: number; length: number; digest: string; order: number }

/** `late()` is asked before each row's transcript is read: true ends the pass as over budget. */
export function computeKiroClassicLinks(input: KiroClassicLinksInput, late: () => boolean): KiroClassicLinks {
  try { statSync(input.dbPath); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "ok", successors: {}, summarized: {} } // no store: nothing compacted
      : { kind: "unreadable", detail: `cannot stat ${input.dbPath}: ${(err as Error).message}` };
  }
  let db: Database.Database;
  try {
    db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { kind: "unreadable", detail: `cannot open ${input.dbPath}: ${(err as Error).message}` };
  }
  try {
    const [a, b = a, c = b] = input.keys;
    // octet_length reads the record header only: sizing the rows reads no value.
    const rows = (db.prepare(`SELECT key, conversation_id AS id, created_at AS created, updated_at AS at, octet_length(value) AS bytes
      FROM conversations_v2 WHERE key IN (?, ?, ?)`).all(a, b, c) as Array<Record<string, unknown>>)
      .filter(r => typeof r.key === "string" && typeof r.id === "string")
      .map(r => ({ key: r.key as string, id: r.id as string, created: Number(r.created) || 0, at: Number(r.at) || 0, bytes: Number(r.bytes) || 0 }));
    const total = rows.reduce((sum, r) => sum + r.bytes, 0);
    const max = input.maxBytes ?? KIRO_CLASSIC_LINKS_MAX_BYTES;
    if (total > max) return { kind: "over-budget", detail: `${rows.length} conversations, ${total} bytes (more than ${max})` };
    // A continuation is created no earlier than its predecessor was last written, so creation order meets nearly every
    // predecessor first; one whose four timestamps all equal its continuation's may come after it (checked below).
    rows.sort((x, y) => x.created - y.created || x.at - y.at || x.bytes - y.bytes || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const one = db.prepare(`SELECT json_type(value, '$.latest_summary') AS summary, json_type(value, '$.transcript') AS type,
      json_extract(value, '$.transcript') AS t FROM conversations_v2 WHERE key = ? AND conversation_id = ? AND json_valid(value)`);
    const read = (row: Row): { isSummary: boolean; t: string | null } => {
      const r = one.get(row.key, row.id) as { summary: unknown; type: unknown; t: unknown } | undefined;
      return { isSummary: typeof r?.summary === "string" && r.summary !== "null", t: r?.type === "array" && typeof r.t === "string" ? r.t : null };
    };
    const summarized: Record<string, boolean> = Object.create(null);
    const continues = new Map<string, Map<string, Set<string>>>(); // key → successor → the conversations it continues
    const seen = new Map<string, Seen[]>(); // key → rows read so far, with their transcript hash
    /**
     * Which of `candidates` (shorter, written before `row` was created) `t` continues; returns t's own digest. Hashed as
     * UTF-16 code units: a cut may fall inside a surrogate pair, and only the code units themselves hash the same on
     * both sides of it (#2739 review).
     */
    const link = (row: Row, t: string, candidates: Seen[]): string => {
      const hash = createHash("sha256");
      let at = 0;
      for (const p of [...candidates].sort((x, y) => x.length - y.length)) {
        const cut = p.length - 1; // where p's closing "]" stands
        hash.update(t.slice(at, cut), "utf16le"); at = cut;
        if (t[cut] === "," && hash.copy().digest("hex") === p.digest) {
          const byKey = continues.get(row.key) ?? new Map<string, Set<string>>();
          continues.set(row.key, byKey);
          (byKey.get(row.id) ?? byKey.set(row.id, new Set()).get(row.id)!).add(p.id);
        }
      }
      hash.update(t.slice(at, t.length - 1), "utf16le");
      return hash.digest("hex");
    };
    const overTime = () => ({ kind: "over-budget" as const, detail: `not done in time (${rows.length} conversations, ${total} bytes)` });
    const continuations: Array<{ row: Row; length: number; order: number }> = [];
    for (const [order, row] of rows.entries()) {
      if (late()) return overTime();
      const { isSummary, t } = read(row);
      summarized[row.id] = summarized[row.id] === true || isSummary;
      if (t === null) continue;
      const earlier = seen.get(row.key) ?? [];
      // Only a summarized row continues another; any row may be continued.
      const digest = link(row, t, isSummary ? earlier.filter(p => p.at <= row.created && p.length < t.length) : []);
      earlier.push({ id: row.id, at: row.at, length: t.length, digest, order });
      seen.set(row.key, earlier);
      if (isSummary) continuations.push({ row, length: t.length, order });
    }
    // A tie (#2739 review): a predecessor read after its continuation — every timestamp equal, the sort fell back to
    // value size. Such a continuation is read again for exactly those, never declared to continue nothing.
    for (const c of continuations) {
      const missed = (seen.get(c.row.key) ?? []).filter(p => p.order > c.order && p.at <= c.row.created && p.length < c.length);
      if (missed.length === 0) continue;
      if (late()) return overTime();
      const { t } = read(c.row);
      if (t === null || t.length !== c.length) return { kind: "unreadable", detail: `${c.row.id} changed while it was read` };
      link(c.row, t, missed);
    }
    // First hop only: a continuation that continues another continuation of `id` is that one's successor, not `id`'s.
    const successors: Record<string, Set<string>> = Object.create(null);
    for (const byKey of continues.values()) {
      for (const [s, of] of byKey) {
        for (const id of of) {
          const through = [...byKey].some(([m, mOf]) => m !== s && mOf.has(id) && of.has(m));
          if (!through) (successors[id] ??= new Set()).add(s);
        }
      }
    }
    return { kind: "ok", summarized, successors: Object.fromEntries(Object.entries(successors).map(([id, s]) => [id, [...s].sort()])) };
  } catch (err) {
    return { kind: "unreadable", detail: `cannot read ${input.dbPath}: ${(err as Error).message}` };
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}
