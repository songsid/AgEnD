/**
 * #2122 §10 step 6: Antigravity's usage — each generation's usage in its conversation databases
 * (`<GEMINI_CLI_HOME or ~/.gemini>/antigravity-cli/conversations/<id>.db`), by the workspace the conversation records.
 * Real counts, per generation, read from a protobuf stored in SQLite. There is no schema: the field numbers below are
 * tokscale's reverse engineering (sessions/antigravity_cli.rs at 669fdaee, MIT; see THIRD_PARTY_NOTICES.md), checked
 * here against the host's 41 databases written by agy 1.4.6:
 *
 * - `gen_metadata.data` #1 chatModel: #4 usage { #1 fixed system-prompt tokens, #2 new input, #5 cache read, #9 output
 *   text, #10 thinking, #11 responseId }; #19 the model (`gemini-default` is a routing label, not a model), #21 its
 *   display label; #9.#4 a Timestamp (agy ≤ 1.1.17).
 * - `steps.metadata` (step_type 15): #1 a Timestamp, #9.#11 the responseId, #20.#3 the generation index — the time of a
 *   generation that carries none.
 * - `trajectory_metadata_blob.data`: #1.#1 the workspace URI, #2 the conversation's created-at.
 *
 * Input is #1 + #2 (tokscale counts the fixed system prompt as input); output is #9 + #10, reasoning (#10) its part
 * (#9 + #10 is the total output). No cache write is recorded. Each generation is counted once (its responseId, and the
 * cursor's last index). Read-only and synchronous: it runs on a worker thread (kiro-usage-run.ts).
 */
import Database from "better-sqlite3";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Turn } from "./cache-ledger.js";

// ── The protobuf wire format, just enough to pull fields out (no schema).
type Field = { n: number; wire: number; v: number | Uint8Array };
function fields(buf: Uint8Array): Field[] | null {
  const out: Field[] = [];
  let i = 0;
  const varint = (): number | null => {
    let r = 0, mul = 1;
    for (let k = 0; k < 10 && i < buf.length; k++) {
      const b = buf[i++]!;
      r += (b & 0x7f) * mul; mul *= 128;
      if (b < 0x80) return r;
    }
    return null;
  };
  while (i < buf.length) {
    const key = varint();
    if (key === null) return null;
    const n = Math.floor(key / 8), wire = key % 8;
    if (wire === 0) { const v = varint(); if (v === null) return null; out.push({ n, wire, v }); }
    else if (wire === 1) { if (i + 8 > buf.length) return null; out.push({ n, wire, v: buf.subarray(i, i + 8) }); i += 8; }
    else if (wire === 2) { const len = varint(); if (len === null || i + len > buf.length) return null; out.push({ n, wire, v: buf.subarray(i, i + len) }); i += len; }
    else if (wire === 5) { if (i + 4 > buf.length) return null; out.push({ n, wire, v: buf.subarray(i, i + 4) }); i += 4; }
    else return null;
  }
  return out;
}
const message = (buf: Uint8Array | null | undefined, n: number): Uint8Array | null => {
  if (!buf) return null;
  const f = fields(buf)?.find((x) => x.n === n && x.wire === 2);
  return f ? f.v as Uint8Array : null;
};
/** A varint field's value, or null when the field is absent (0 is a value: Prism #2609). */
const varintField = (buf: Uint8Array | null | undefined, n: number): number | null => {
  if (!buf) return null;
  const f = fields(buf)?.find((x) => x.n === n && x.wire === 0);
  return f && Number.isSafeInteger(f.v) ? f.v as number : null;
};
const varint = (buf: Uint8Array | null | undefined, n: number): number => varintField(buf, n) ?? 0;
const text = (buf: Uint8Array | null | undefined, n: number): string | null => {
  const m = message(buf, n);
  if (!m) return null;
  const s = Buffer.from(m).toString("utf8").trim();
  return s || null;
};
const timestamp = (buf: Uint8Array | null): number | null => {
  if (!buf) return null;
  const s = varint(buf, 1), ns = varint(buf, 2);
  return s > 0 && ns <= 999_999_999 ? s * 1000 + Math.floor(ns / 1e6) : null;
};

/**
 * The agy versions this reader's field map is checked on (design §10.4: kept behind a version check). The map is
 * reverse-engineered, so another version is not read until it is checked: its instances are "not measured".
 */
export const ANTIGRAVITY_USAGE_VERIFIED = /^1\.4\.\d+$/;
/** Whether agy at this version (as AgEnD's cached CLI probe recorded it; null: not known yet) is read. */
export function antigravityUsageSupported(version: string | null | undefined): boolean {
  const v = typeof version === "string" ? /\d+\.\d+\.\d+/.exec(version)?.[0] : undefined;
  return !!v && ANTIGRAVITY_USAGE_VERIFIED.test(v);
}

/** The workspace a conversation records (a file:// URI made a path), and when it was created. */
export function antigravityConversation(blob: Uint8Array | null): { workspace: string | null; created: number | null } {
  const uri = text(message(blob, 1), 1);
  let workspace: string | null = null;
  if (uri?.startsWith("file://")) { try { workspace = fileURLToPath(uri); } catch { /* not a file URI */ } }
  return { workspace, created: timestamp(message(blob, 2)) };
}

export interface AntigravityGeneration extends Turn { idx: number; responseId: string | null; label: string | null }
/** One generation's usage (`gen_metadata.data`), or null: none recorded. `model` is #19 as written ("" when absent). */
export function antigravityGeneration(idx: number, blob: Uint8Array, at: { steps: Map<string, number>; byIdx: Map<number, number>; fallback: number }): AntigravityGeneration | null {
  const chat = message(blob, 1), usage = message(chat, 4);
  if (!usage) return null;
  const input = varint(usage, 1) + varint(usage, 2), read = varint(usage, 5), outputText = varint(usage, 9), thinking = varint(usage, 10);
  if (!input && !read && !outputText && !thinking) return null;
  const responseId = text(usage, 11);
  const t = timestamp(message(message(chat, 9), 4)) ?? (responseId ? at.steps.get(responseId) : undefined) ?? at.byIdx.get(idx) ?? at.fallback;
  const model = text(chat, 19);
  return { idx, responseId, label: text(chat, 21), t, model: model && model.toLowerCase() !== "gemini-default" ? model : "",
    prompt: input + read, uncached: input, read, write5m: 0, write1h: 0, write: null, output: outputText + thinking, reasoning: thinking };
}

export interface AntigravityCursor { sig: string; after: number }
export interface AntigravityScanInput {
  /** The conversations directory. */
  dir: string;
  cutoff: number;
  instances: Array<{ name: string; cwds: string[]; cursors: Record<string, AntigravityCursor> }>;
  /** Database → its signature and workspace, from earlier scans (a database is opened to learn it only when it changed). */
  index: Record<string, { sig: string; workspace: string | null }>;
}
export interface AntigravityScanOutput {
  instances: Array<{ name: string; updates: Array<{ key: string; sig: string; after: number; turns: Turn[] }>; live: string[]; failed: boolean }>;
  index: AntigravityScanInput["index"];
}

const gone = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

export function scanAntigravityUsage(input: AntigravityScanInput): AntigravityScanOutput {
  const index: AntigravityScanInput["index"] = Object.create(null);
  const out = input.instances.map((i) => ({ name: i.name, updates: [] as AntigravityScanOutput["instances"][number]["updates"], live: [] as string[], failed: false }));
  const owner = new Map<string, number>();
  input.instances.forEach((i, k) => { for (const c of i.cwds) owner.set(c, k); });
  const failAll = () => { for (const o of out) o.failed = true; };
  let names: string[] = [];
  try { names = readdirSync(input.dir).filter((n) => n.endsWith(".db")); } catch (err) { if (!gone(err)) failAll(); return { instances: out, index }; }
  for (const n of names) {
    const path = join(input.dir, n);
    let sig: string, mtime: number;
    try {
      const db = statSync(path);
      let wal = { size: 0, mtimeMs: 0, ino: 0 };
      try { wal = statSync(`${path}-wal`); } catch (err) { if (!gone(err)) throw err; }
      sig = `${db.ino}:${db.size}:${db.mtimeMs}|${wal.size}:${wal.mtimeMs}`; mtime = Math.max(db.mtimeMs, wal.mtimeMs);
    } catch (err) { if (!gone(err)) failAll(); continue; }
    if (mtime < input.cutoff) continue;
    const known = input.index[path];
    // Unchanged and not an instance's: nothing to open.
    if (known?.sig === sig && (known.workspace === null || !owner.has(known.workspace))) { index[path] = known; continue; }
    if (known?.sig === sig && known.workspace !== null) {
      const k = owner.get(known.workspace)!, key = `agy:${path}`;
      index[path] = known; out[k]!.live.push(key);
      if (input.instances[k]!.cursors[key]?.sig === sig) continue;
    }
    let db: Database.Database | null = null;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      const meta = db.prepare("SELECT data FROM trajectory_metadata_blob LIMIT 1").get() as { data?: Buffer } | undefined;
      const conv = antigravityConversation(meta?.data ?? null);
      index[path] = { sig, workspace: conv.workspace };
      const k = conv.workspace === null ? undefined : owner.get(conv.workspace);
      if (k === undefined) continue;
      const inst = input.instances[k]!, key = `agy:${path}`;
      if (!out[k]!.live.includes(key)) out[k]!.live.push(key);
      if (inst.cursors[key]?.sig === sig) continue;
      const steps = new Map<string, number>(), byIdx = new Map<number, number>();
      for (const r of db.prepare("SELECT metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL").all() as Array<{ metadata: Buffer }>) {
        const t = timestamp(message(r.metadata, 1));
        if (t === null) continue;
        const id = text(message(r.metadata, 9), 11);
        if (id) steps.set(id, t);
        const gi = varintField(message(r.metadata, 20), 3);
        if (gi !== null) byIdx.set(gi, t);
      }
      const after = inst.cursors[key]?.after ?? -1;
      const gens: AntigravityGeneration[] = [];
      const seen = new Set<string>();
      for (const r of db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").all() as Array<{ idx: number; data: Buffer }>) {
        const g = antigravityGeneration(r.idx, r.data, { steps, byIdx, fallback: conv.created ?? mtime });
        if (!g) continue;
        if (g.responseId) { if (seen.has(g.responseId)) continue; seen.add(g.responseId); }
        gens.push(g);
      }
      // A row without #19 takes the model other rows with its display label named — only when they all name the same
      // one: a label two models share is ambiguous, and the row stays unknown (Prism #2609; tokscale tests it too).
      const byLabel = new Map<string, string | null>();
      for (const g of gens) if (g.model && g.label) byLabel.set(g.label, byLabel.has(g.label) && byLabel.get(g.label) !== g.model ? null : g.model);
      const turns: Turn[] = [];
      let last = after;
      for (const g of gens) {
        last = Math.max(last, g.idx);
        if (g.idx <= after) continue;
        const { idx: _i, responseId: _r, label, ...turn } = g;
        turns.push({ ...turn, model: turn.model || (label ? byLabel.get(label) : undefined) || "unknown" });
      }
      out[k]!.updates.push({ key, sig, after: last, turns });
    } catch {
      // Being written or unreadable: whose it is may be unknown, so no instance's scan is complete.
      failAll();
    } finally { db?.close(); }
  }
  return { instances: out, index };
}
