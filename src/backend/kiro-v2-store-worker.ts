import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { KiroV2StoreInput, KiroV2StoreReply, KiroV2StoreRequest } from "./kiro-v2-store.js";

const CACHE_LIMIT = 4096;
const CACHE_BYTES = 4 * 1024 * 1024;
let cacheBytes = 0;
function drop(path: string): void {
  const old = cache.get(path);
  if (old) cacheBytes -= old.bytes;
  cache.delete(path);
}
type Meta = { cwd: string | null; subagent: boolean; id: string; updatedAt: number; createdAt: number | null };
const cache = new Map<string, { signature: string; meta: Meta | null; bytes: number }>();
const signature = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

// Do not retain a sliced string backed by the entire parsed history buffer.
const ownString = (value: string): string => Buffer.from(value, "utf16le").toString("utf16le");
function fileSignature(path: string): string | null {
  try { return signature(statSync(path)); } catch { return null; }
}

function scan({ keys, sessionsDir }: KiroV2StoreInput, deadlineAt: number): KiroV2StoreReply {
  let names: string[];
  try { names = readdirSync(sessionsDir); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "ok", sessions: [], diagnostics: { reads: 0, hits: 0 } }
      : { kind: "unreadable", detail: `cannot list ${sessionsDir}: ${(err as Error).message}` };
  }
  let reads = 0, hits = 0;
  const directories = new Set(keys), sessions: Extract<KiroV2StoreReply, { kind: "ok" }>["sessions"] = [];
  for (const name of names) {
    if (performance.now() >= deadlineAt) return { kind: "unreadable", detail: "v2 session discovery timed out" };
    if (!name.endsWith(".json")) continue;
    const path = join(sessionsDir, name);
    try {
      const before = fileSignature(path);
      let entry = before === null ? undefined : cache.get(path);
      if (!entry || entry.signature !== before) {
        let meta: Meta | null = null;
        try {
          // Full JSON validation preserves malformed-tail, duplicate-key and
          // arbitrary property order semantics. Never parse a prefix as proof.
          reads++;
          const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
          const created = Date.parse(String(value.created_at ?? ""));
          meta = { cwd: typeof value.cwd === "string" ? ownString(value.cwd) : null, subagent: value.session_created_reason === "subagent",
            id: typeof value.session_id === "string" ? ownString(value.session_id) : name.slice(0, -5),
            updatedAt: Date.parse(String(value.updated_at ?? "")) || 0, createdAt: Number.isFinite(created) ? created : null };
        } catch { /* partly written, as before */ }
        entry = { signature: before ?? "", meta, bytes: 2 * (path.length + (before?.length ?? 0) + (meta?.cwd?.length ?? 0) + (meta?.id.length ?? 0)) + 128 };
        if (before !== null && fileSignature(path) === before) {
          drop(path);
          if (meta !== null && entry.bytes <= CACHE_BYTES) {
            cache.set(path, entry); cacheBytes += entry.bytes;
            while (cache.size > CACHE_LIMIT || cacheBytes > CACHE_BYTES) drop(cache.keys().next().value!);
          }
        }
      } else hits++;
      const meta = entry.meta;
      if (meta && typeof meta.cwd === "string" && directories.has(meta.cwd) && !meta.subagent) {
        sessions.push({ id: meta.id, updatedAt: meta.updatedAt, createdAt: meta.createdAt });
      }
    } catch { drop(path); /* unreadable file, as before */ }
  }
  return { kind: "ok", sessions, diagnostics: { reads, hits } };
}
parentPort?.on("message", ({ id, input, deadlineAt }: KiroV2StoreRequest) => {
  const reply = scan(input, deadlineAt);
  parentPort?.postMessage({ id, reply });
});
