/** Optional, bounded filesystem lane. Its physical capacity is held through all reads AND close. */
import { constants } from "node:fs";
import { open, realpath, lstat, opendir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { projectSubagents, subagentLaunches, type SubagentArtifact, type SubagentRun } from "./subagent-records.js";
export interface SubagentSource { backend: "claude-code" | "codex"; sessionId: string; cwd: string; path: string; root: string; owner: string }
export interface SubagentAnswer { subagents: 1; owner: string | null; status: "ok" | "unavailable" | "busy"; runs: SubagentRun[] }
export const SUBAGENT_READ_BYTES = 2 * 1024 * 1024;
let physicalReads = 0;
const MAX_PHYSICAL = 2;
const stamp = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
const inside = (root: string, path: string) => { const p = relative(root, path); return p !== "" && !p.startsWith(".." + sep) && p !== ".." && !p.startsWith(sep); };
export async function readSubagentFile(root: string, file: string, max = SUBAGENT_READ_BYTES): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const base = await realpath(root), path = resolve(file), expected = resolve(base, relative(resolve(root), path));
    if (!inside(resolve(root), path) || !inside(base, expected) || await realpath(path) !== expected) return null;
    const before = await lstat(path);
    if (!before.isFile() || before.size > max) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const admitted = await handle.stat();
    if (stamp(before) !== stamp(admitted) || await realpath(path) !== expected) return null;
    const buffer = Buffer.alloc(Math.min(max + 1, before.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max || bytesRead !== before.size || stamp(await handle.stat()) !== stamp(before)
      || stamp(await lstat(path)) !== stamp(before) || await realpath(path) !== expected) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return null; }
  finally { if (handle) await handle.close(); }
}
function jsonl(text: string | null): unknown[] | null {
  if (text === null || (text.length > 0 && !text.endsWith("\n"))) return null;
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > 20000 || lines.some(s => s.length > 128000)) return null;
  try { return lines.map(s => JSON.parse(s)); } catch { return null; }
}
const identity = (s: SubagentSource) => JSON.stringify([s.owner, s.backend, s.sessionId, s.cwd, s.path, s.root]);
const token = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const empty = (status: SubagentAnswer["status"] = "unavailable"): SubagentAnswer => ({ subagents: 1, owner: null, status, runs: [] });
export class SubagentService {
  private pending = new Map<string, Promise<SubagentAnswer>>();
  private cache = new Map<string, { at: number; answer: SubagentAnswer }>();
  constructor(private source: (name: string) => SubagentSource | null,
    private readFile = readSubagentFile, private now = Date.now) {}
  private async withDeadline(flight: Promise<SubagentAnswer>, id: string): Promise<SubagentAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Retire only the optional HTTP observation. The physical reservation remains in run().finally.
      return await Promise.race([flight, new Promise<SubagentAnswer>(resolve => {
        timer = setTimeout(() => resolve({ subagents: 1, owner: token(id), status: "unavailable", runs: [] }), 1000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async read(name: string): Promise<SubagentAnswer> {
    const source = this.source(name);
    if (!source) return empty();
    const id = identity(source), old = this.cache.get(id);
    if (old && this.now() - old.at < 2000) return old.answer;
    const existing = this.pending.get(id);
    if (existing) return this.withDeadline(existing, id);
    if (physicalReads >= MAX_PHYSICAL) return empty("busy");
    physicalReads++;
    const current = () => { const s = this.source(name); return s !== null && identity(s) === id; };
    const run = async (): Promise<SubagentAnswer> => {
      try {
        const parent = jsonl(await this.readFile(source.root, source.path));
        if (!current()) return empty();
        if (!parent) return { subagents: 1, owner: token(id), status: "unavailable", runs: [] };
        const input = { backend: source.backend, sessionId: source.sessionId, cwd: source.cwd, parent };
        const specs = subagentLaunches(input), children = new Map<string, SubagentArtifact>();
        if (source.backend === "claude-code") {
          for (const spec of specs) {
            const base = join(dirname(source.path), source.sessionId, "subagents", "agent-" + spec.id);
            const records = jsonl(await this.readFile(source.root, base + ".jsonl", 512 * 1024));
            const meta = await this.readFile(source.root, base + ".meta.json", 32 * 1024);
            if (!current()) return empty();
            try { if (records && meta !== null) children.set(spec.id, { records, meta: JSON.parse(meta) }); } catch { /* partial sidecar: unknown */ }
          }
        } else if (specs.length) {
          const days = [dirname(source.path)];
          const ymd = relative(source.root, dirname(source.path)).split(sep);
          if (ymd.length === 3 && /^\d{4}$/.test(ymd[0]) && /^\d{2}$/.test(ymd[1]) && /^\d{2}$/.test(ymd[2])) {
            const next = new Date(ymd.join("-") + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
            if (Number.isFinite(next.getTime())) days.push(join(source.root, ...next.toISOString().slice(0, 10).split("-")));
          }
          const wanted = new Set(specs.map(s => s.id)), seen = new Set<string>(), ambiguous = new Set<string>();
          for (const dir of days) {
            // opendir iteration bounds discovery; readdir would allocate an unbounded whole directory first.
            try {
              const canonicalRoot = await realpath(source.root), expected = resolve(canonicalRoot, relative(resolve(source.root), resolve(dir)));
              if (await realpath(dir) !== expected || !inside(canonicalRoot, expected)) continue;
              let scanned = 0;
              for await (const file of await opendir(dir)) {
                if (++scanned > 256) { children.clear(); for (const id of wanted) ambiguous.add(id); break; }
                if (!current()) break;
                if (!file.isFile()) continue;
                const m = /^rollout-[\dT:-]+-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/i.exec(file.name);
                if (!m || !wanted.has(m[1]) || ambiguous.has(m[1])) continue;
                if (seen.has(m[1])) { children.delete(m[1]); ambiguous.add(m[1]); continue; }
                seen.add(m[1]);
                const records = jsonl(await this.readFile(source.root, join(dir, file.name), 512 * 1024));
                if (records) children.set(m[1], { records });
              }
            } catch { /* absent next day or unreadable store: its proved launches remain unknown */ }
          }
        }
        if (!current()) return empty();
        const answer: SubagentAnswer = { subagents: 1, owner: token(id), status: "ok", runs: projectSubagents({ ...input, children, now: this.now(), live: true }) };
        // Do not retain other instances/launches forever. No full transcripts enter the cache.
        this.cache.set(id, { at: this.now(), answer });
        while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
        return answer;
      } finally { physicalReads--; this.pending.delete(id); }
    };
    const flight = run(); this.pending.set(id, flight); return this.withDeadline(flight, id);
  }
}
