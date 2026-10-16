/** #1629: bounded reported host observations. This store grants no effect or admission authority. */
import { constants, openSync, fstatSync, readSync, closeSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.js";

export const EFFECT_PROFILE_LIMIT = 20;
export const EFFECT_PROFILE_IDS = 512;
export const EFFECT_PROFILE_FILE_BYTES = 8 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;
const writes = new Set<string>();
const device = z.enum(["standard", "constrained"]);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fps = z.number().finite().min(0).max(1000);
const task = z.number().finite().min(0).max(256000).nullable();
const shape = {
  v: z.literal(1), device,
  verdict: z.enum(["ok", "degraded", "paused", "off"]),
  reason: z.enum(["host_budget", "clock_unavailable", "gates_unknown", "hidden", "reduced_motion", "save_data", "viewer_off"]).nullable(),
  samples: z.number().int().min(1).max(120),
  fps_p50: fps, fps_p10: fps, fps_floor: fps.positive(),
  long_task_p95: task, long_task_samples: z.number().int().min(0).max(120),
  attributed_long_task_p95: task, attributed_samples: z.number().int().min(0).max(120),
  attribution: z.enum(["unknown", "observed"]), load_ms: z.number().finite().min(0).max(600000).nullable(),
};
function coherent(p: z.infer<z.ZodObject<typeof shape>>): boolean {
  return p.fps_p10 <= p.fps_p50 && p.long_task_samples <= p.samples && p.attributed_samples <= p.long_task_samples
    && (p.long_task_samples === 0) === (p.long_task_p95 === null)
    && (p.attributed_samples === 0) === (p.attributed_long_task_p95 === null)
    && (p.attributed_samples === 0 ? p.attribution === "unknown" : p.attribution === "observed");
}
const inputSchema = z.object(shape).strict().refine(coherent);
const storedSchema = z.object({ ...shape, at: integer, source: z.literal("reported_host") }).strict().refine(coherent);
export type EffectProfileInput = z.infer<typeof inputSchema>;
export type StoredEffectProfile = z.infer<typeof storedSchema>;
export interface EffectProfileSummary { status: "unmeasured" | "reported"; records: StoredEffectProfile[] }
export function checkEffectProfile(input: unknown): { ok: true; profile: EffectProfileInput } | { ok: false; error: "profile_args" } {
  try { if (!plain(input)) return { ok: false, error: "profile_args" }; const p = inputSchema.safeParse(input); return p.success ? { ok: true, profile: p.data } : { ok: false, error: "profile_args" }; }
  catch { return { ok: false, error: "profile_args" }; }
}
type Buckets = { standard: StoredEffectProfile[]; constrained: StoredEffectProfile[] };
type State = { rev: number; entries: Map<string, Buckets> };
type Failure = { ok: false; error: "profile_args" | "profiles_unreadable" | "profiles_write_failed" | "profiles_bound" | "profile_clock" | "profiles_busy" };
const fail = (error: Failure["error"]): Failure => ({ ok: false, error });
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;

/** One regular fd, bounded before allocation and again after read; no path supplied by a web request. */
function readIndex(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > EFFECT_PROFILE_FILE_BYTES) throw Error("profile file bound");
    const bytes = Buffer.alloc(stat.size + 1); let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, null); if (!n) break; at += n; }
    if (at !== stat.size || fstatSync(fd).size !== stat.size) throw Error("profile file changed");
    return bytes.subarray(0, at);
  } finally { closeSync(fd); }
}

/** Lazy, single-fleet-owner store. No constructor I/O, HTTP ingress, profile writer tool or frame mount. */
export class WebEffectProfiles {
  readonly path: string;
  private readonly dataDir: string;
  constructor(dataDir: string, private readonly opts: { now?: () => number } = {}) { this.dataDir = resolve(dataDir); this.path = join(this.dataDir, "web-effect-profiles.json"); }
  private load(): State | Failure {
    let bytes: Buffer;
    try { bytes = readIndex(this.path); }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { rev: 0, entries: new Map() } : fail("profiles_unreadable"); }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), doc: unknown = JSON.parse(text);
      if (!plain(doc) || Object.keys(doc).sort().join(",") !== "entries,rev,version" || doc.version !== 1 || !Number.isSafeInteger(doc.rev) || (doc.rev as number) < 0 || !plain(doc.entries)) return fail("profiles_unreadable");
      const entries = new Map<string, Buckets>();
      for (const [id, value] of Object.entries(doc.entries)) {
        if (!ID.test(id) || entries.size >= EFFECT_PROFILE_IDS || !plain(value) || Object.keys(value).sort().join(",") !== "constrained,standard") return fail("profiles_unreadable");
        const buckets: Buckets = { standard: [], constrained: [] };
        for (const cls of ["standard", "constrained"] as const) {
          if (!Array.isArray(value[cls]) || value[cls].length > EFFECT_PROFILE_LIMIT) return fail("profiles_unreadable");
          let previous = -1;
          for (const item of value[cls]) {
            const p = storedSchema.safeParse(item);
            if (!p.success || p.data.device !== cls || p.data.at < previous) return fail("profiles_unreadable");
            previous = p.data.at; buckets[cls].push(p.data);
          }
        }
        entries.set(id, buckets);
      }
      return { rev: doc.rev as number, entries };
    } catch { return fail("profiles_unreadable"); }
  }
  read(id: string): { ok: true; status: "unmeasured" | "reported"; records: StoredEffectProfile[] } | Failure {
    if (typeof id !== "string" || !ID.test(id)) return fail("profile_args");
    const state = this.load(); if ("ok" in state) return state;
    const entry = state.entries.get(id), records = entry ? [...entry.standard, ...entry.constrained].sort((a, b) => a.at - b.at) : [];
    return { ok: true, status: records.length ? "reported" : "unmeasured", records };
  }
  /** One bounded parse for a library listing; callers still project only their authorized ids. */
  readSummaries(): { ok: true; summaries: Record<string, EffectProfileSummary> } | Failure {
    const state = this.load(); if ("ok" in state) return state;
    return { ok: true, summaries: Object.fromEntries([...state.entries].map(([id, buckets]) => {
      const records = [buckets.standard.at(-1), buckets.constrained.at(-1)].filter((p): p is StoredEffectProfile => p !== undefined);
      return [id, { status: records.length ? "reported" : "unmeasured", records }];
    })) };
  }
  record(id: string, input: unknown): { ok: true; profile: StoredEffectProfile } | Failure {
    if (writes.has(this.path)) return fail("profiles_busy");
    writes.add(this.path);
    try {
      if (typeof id !== "string" || !ID.test(id)) return fail("profile_args");
      const checked = checkEffectProfile(input); if (!checked.ok) return checked;
      const state = this.load(); if ("ok" in state) return state;
      let now: number; try { now = (this.opts.now ?? Date.now)(); } catch { return fail("profile_clock"); }
      if (!Number.isSafeInteger(now) || now < 0) return fail("profile_clock");
      if (state.rev === Number.MAX_SAFE_INTEGER || !state.entries.has(id) && state.entries.size >= EFFECT_PROFILE_IDS) return fail("profiles_bound");
      const buckets = state.entries.get(id) ?? { standard: [], constrained: [] }, cls = checked.profile.device;
      const at = Math.max(now, buckets[cls].at(-1)?.at ?? 0), profile: StoredEffectProfile = { ...checked.profile, source: "reported_host", at };
      buckets[cls] = [...buckets[cls], profile].slice(-EFFECT_PROFILE_LIMIT); state.entries.set(id, buckets);
      const text = JSON.stringify({ version: 1, rev: state.rev + 1, entries: Object.fromEntries(state.entries) });
      if (Buffer.byteLength(text, "utf8") > EFFECT_PROFILE_FILE_BYTES) return fail("profiles_bound");
      try { mkdirSync(this.dataDir, { recursive: true }); atomicWriteFileSync(this.path, text, { mode: 0o600 }); }
      catch { return fail("profiles_write_failed"); }
      return { ok: true, profile: JSON.parse(JSON.stringify(profile)) as StoredEffectProfile };
    } finally { writes.delete(this.path); }
  }
}
