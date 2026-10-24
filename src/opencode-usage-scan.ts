/**
 * #2122 §10 step 5: OpenCode's usage — each assistant message's `tokens` in `opencode.db` (real counts, per message), by
 * the working directory its session records (`session.directory`). OpenCode keeps messages in two tables, `message`
 * (older) and `session_message` (newer, `type = 'assistant'`); a message copied from one to the other keeps its id, so
 * each id is counted once. Only a finished message (`time.completed`) is counted: its tokens are final.
 *
 * Units: `tokens.input` is uncached, `tokens.cache.read`/`.write` are the cache, and `tokens.reasoning` is apart from
 * `tokens.output` (it is often larger) — so the ledger's output is output + reasoning, reasoning its part (§10.3).
 * `cost` is what the provider charged (0 on a subscription such as github-copilot): the amount only where the price
 * table lacks the model. The field mapping follows tokscale (sessions/opencode_schema.rs at 669fdaee, MIT; see
 * THIRD_PARTY_NOTICES.md). Read-only, synchronous: it runs on a worker thread (kiro-usage-run.ts).
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import type { Turn } from "./cache-ledger.js";

/** Where reading stopped: the last update time read, and the ids counted at or after the read window. */
export interface OpencodeCursor { after: number; ids: string[] }
export interface OpencodeScanInput {
  dbPath: string;
  cutoff: number;
  instances: Array<{ name: string; cwds: string[]; cursor: OpencodeCursor | null }>;
}
export interface OpencodeScanOutput {
  instances: Array<{ name: string; turns: Turn[]; cursor: OpencodeCursor; failed: boolean }>;
}
/** Ids kept per instance: enough for a month of a busy agent; the oldest go first. */
export const OPENCODE_IDS_MAX = 20_000;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const ms = (v: unknown): number | null => { const n = num(v); return n ? (n <= 1e12 ? n * 1000 : n) : null; };

/** The turn one assistant message records, or null (not an assistant's, not finished, or no tokens). */
export function opencodeTurn(data: unknown): Turn | null {
  const d = data as { role?: unknown; modelID?: unknown; model?: { id?: unknown }; tokens?: Record<string, unknown>; cost?: unknown; time?: { created?: unknown; completed?: unknown } } | null;
  if (!d || typeof d !== "object" || !d.tokens || typeof d.tokens !== "object") return null;
  if (d.role !== undefined && d.role !== "assistant") return null;
  const t = ms(d.time?.created);
  if (t === null || ms(d.time?.completed) === null) return null;
  const tk = d.tokens, cache = (tk.cache ?? {}) as Record<string, unknown>;
  const input = num(tk.input), read = num(cache.read), write = num(cache.write), output = num(tk.output), reasoning = num(tk.reasoning);
  if (!input && !read && !write && !output && !reasoning) return null;
  const model = typeof d.modelID === "string" && d.modelID ? d.modelID : typeof d.model?.id === "string" && d.model.id ? d.model.id : "unknown";
  const cost = num(d.cost);
  return { t, model, prompt: input + read + write, uncached: input, read, write5m: 0, write1h: 0, write, output: output + reasoning, reasoning, ...(cost ? { cost } : {}) };
}

export function scanOpencodeUsage(input: OpencodeScanInput): OpencodeScanOutput {
  const fail = () => ({ instances: input.instances.map(i => ({ name: i.name, turns: [], cursor: i.cursor ?? { after: input.cutoff, ids: [] }, failed: true })) });
  if (!existsSync(input.dbPath)) return { instances: input.instances.map(i => ({ name: i.name, turns: [], cursor: i.cursor ?? { after: input.cutoff, ids: [] }, failed: false })) };
  let db: Database.Database;
  try { db = new Database(input.dbPath, { readonly: true, fileMustExist: true }); db.pragma("query_only = ON"); } catch { return fail(); }
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name));
    const from = Math.min(...input.instances.map(i => Math.max(i.cursor?.after ?? input.cutoff, input.cutoff)));
    const rows: Array<{ id: string; u: number; data: string; dir: string | null }> = [];
    if (tables.has("message") && tables.has("session"))
      rows.push(...db.prepare("SELECT m.id AS id, m.time_updated AS u, m.data AS data, s.directory AS dir FROM message m LEFT JOIN session s ON s.id = m.session_id WHERE m.time_updated >= ?").all(from) as typeof rows);
    if (tables.has("session_message") && tables.has("session_v2"))
      rows.push(...db.prepare("SELECT sm.id AS id, sm.time_updated AS u, sm.data AS data, s.directory AS dir FROM session_message sm LEFT JOIN session_v2 s ON s.id = sm.session_id WHERE sm.type = 'assistant' AND sm.time_updated >= ?").all(from) as typeof rows);
    rows.sort((a, b) => a.u - b.u || a.id.localeCompare(b.id));
    return {
      instances: input.instances.map((inst) => {
        const cwds = new Set(inst.cwds), after = Math.max(inst.cursor?.after ?? input.cutoff, input.cutoff);
        const seen = new Set(inst.cursor?.ids ?? []), ids = [...(inst.cursor?.ids ?? [])], turns: Turn[] = [];
        let last = after;
        for (const r of rows) {
          if (r.u < after || r.dir === null || !cwds.has(r.dir) || seen.has(r.id)) continue;
          let data: unknown;
          try { data = JSON.parse(r.data); } catch { continue; }
          const turn = opencodeTurn(data);
          if (!turn) continue;                                   // not finished yet: read again once it is updated
          seen.add(r.id); ids.push(r.id); turns.push(turn); last = Math.max(last, r.u);
        }
        return { name: inst.name, turns, cursor: { after: last, ids: ids.slice(-OPENCODE_IDS_MAX) }, failed: false };
      }),
    };
  } catch { return fail(); }
  finally { db.close(); }
}
