/**
 * #1468: keeps each instance's cache ledger (cache-ledger.ts) up to date from its transcripts, off the fleet loop's
 * critical path, and answers the analysis (cache-analysis.ts) from the ledgers alone.
 *
 * - Which files: a Claude Code instance's `<claude config>/projects/<project key of its working directory>/*.jsonl`
 *   (the main conversation; subagents write elsewhere); a Codex instance's rollouts under the shared sessions
 *   directory whose `session_meta` names its working directory. Only files touched in the last KEEP_DAYS.
 * - How: passes of at most `passBytes` (scan-jsonl awaits every chunk), with a pause between passes, until every
 *   file is caught up; then again every `intervalMs` and when the panel asks. Where each file stopped is persisted
 *   with the ledger (`<instance dir>/cache-ledger.json`), so a restart resumes instead of re-reading.
 * - Never: a vendor API call, a child process, a synchronous read of a transcript.
 * A file that shrank or was replaced (another inode) is followed from its current end: its earlier turns are
 * already counted, and counting them twice would be worse than missing a rewrite.
 */
import { mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { scanJsonl } from "./cache-scan.js";
import { addTurn, claudeLine, codexLine, emptyLedger, KEEP_DAYS, pruneLedger, reviveLedger, type FileCursor, type Ledger, type TranscriptKind } from "./cache-ledger.js";
import { analyzeLedger, type InstanceAnalysis } from "./cache-analysis.js";
import { PRICES_CHECKED, PRICE_SOURCES } from "./cache-prices.js";

export interface CacheInstance { name: string; backend: string; workingDirectory: string; ledgerPath: string }

export interface CacheServiceOptions {
  instances(): CacheInstance[];
  claudeProjectsDir(): string;
  claudeKey(workingDirectory: string): string;
  codexSessionsDir(): string;
  /** Rollout files with their mtimes (the shared rollout index). */
  listRollouts(root: string): Array<{ path: string; mtimeMs: number }>;
  /** Where the rollout → working-directory map is kept (one session_meta read per rollout, ever). */
  metaPath: string;
  now?: () => number;
  passBytes?: number;
  pauseMs?: number;
  intervalMs?: number;
  log?: (level: "info" | "warn" | "debug", msg: string, extra?: Record<string, unknown>) => void;
}

export type CacheWindow = "24h" | "7d" | "30d";
export const WINDOWS: Record<CacheWindow, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

export interface InstanceReport {
  name: string;
  backend: string;
  /** "ok" with `analysis`; "no_data": nothing read yet (or no transcript); "credit_billed": kiro; "unsupported". */
  status: "ok" | "no_data" | "credit_billed" | "unsupported";
  analysis?: InstanceAnalysis;
}

export interface CacheReport {
  window: CacheWindow;
  from: number;
  to: number;
  pricesChecked: string;
  priceSources: readonly string[];
  /** `caughtUp`: a catch-up has finished since the fleet started (before that, what is shown may be partial). */
  scanning: { active: boolean; caughtUp: boolean; pendingBytes: number; pendingFiles: number };
  fleet: { expiryCost: number; saving: number; recommended: number; analysed: number; priced: boolean };
  instances: InstanceReport[];
}

const DAY = 86_400_000;
const META_MAX_BYTES = 256 * 1024;   // session_meta carries the instructions (~22 KB in real rollouts)
const kindOf = (backend: string): TranscriptKind | null => (backend === "claude-code" ? "claude" : backend === "codex" ? "codex" : null);
const sleep = (ms: number): Promise<void> => new Promise((r) => { const h = setTimeout(r, ms); h.unref?.(); });
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export class CacheService {
  private readonly ledgers = new Map<string, Ledger>();
  private readonly dirty = new Set<string>();
  private meta: Record<string, string | null> | null = null;
  private metaDirty = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private pending = { bytes: 0, files: 0 };
  private caughtUp = false;
  private readonly now: () => number;

  constructor(private readonly o: CacheServiceOptions) { this.now = o.now ?? Date.now; }

  /** Catch up now (joins a catch-up already running). */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.running ??= this.catchUp().catch((err) => { this.o.log?.("warn", "cache analysis: a pass failed", { err: String(err) }); })
      .finally(() => { this.running = null; });
  }

  /** Keep up on a timer from now on (the first report starts it). */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.kick(); }, this.o.intervalMs ?? 10 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scanning(): CacheReport["scanning"] {
    return { active: this.running !== null, caughtUp: this.caughtUp, pendingBytes: this.pending.bytes, pendingFiles: this.pending.files };
  }

  private async catchUp(): Promise<void> {
    for (;;) {
      const left = await this.pass();
      if (left === 0) this.caughtUp = true;
      if (this.stopped || left === 0) return;
      await sleep(this.o.pauseMs ?? 25);
    }
  }

  private async ledgerFor(inst: CacheInstance): Promise<Ledger> {
    let l = this.ledgers.get(inst.name);
    if (l) return l;
    try { l = reviveLedger(JSON.parse(await readFile(inst.ledgerPath, "utf8"))); } catch { l = emptyLedger(); }
    // Another pass may have loaded it meanwhile.
    const again = this.ledgers.get(inst.name);
    if (again) return again;
    this.ledgers.set(inst.name, l);
    return l;
  }

  /** One bounded pass over every instance's files. Returns the bytes still behind afterwards. */
  async pass(): Promise<number> {
    const cutoff = this.now() - KEEP_DAYS * DAY;
    let budget = this.o.passBytes ?? 16 * 1024 * 1024;
    let behindBytes = 0, behindFiles = 0;
    const codex = await this.codexFilesByInstance(cutoff);
    for (const inst of this.o.instances()) {
      if (this.stopped) break;
      const kind = kindOf(inst.backend);
      if (!kind) continue;
      const ledger = await this.ledgerFor(inst);
      const files = kind === "claude" ? await this.claudeFiles(inst, cutoff) : codex.get(inst.name) ?? [];
      const listed = new Set(files.map((f) => f.path));
      for (const path of Object.keys(ledger.files)) if (!listed.has(path)) { delete ledger.files[path]; this.dirty.add(inst.name); }
      for (const f of files) {
        let cur = ledger.files[f.path];
        if (!cur) { cur = ledger.files[f.path] = { kind, ino: f.ino, offset: 0 }; this.dirty.add(inst.name); }
        else if (cur.ino !== f.ino || f.size < cur.offset) {
          ledger.files[f.path] = cur = { kind, ino: f.ino, offset: f.size, ...(cur.last ? { last: cur.last, first: cur.first } : {}) };
          this.dirty.add(inst.name);
        }
        if (cur.offset >= f.size) continue;
        if (budget <= 0) { behindBytes += f.size - cur.offset; behindFiles++; continue; }
        const done = await this.read(ledger, cur, f.path, budget, cutoff);
        this.dirty.add(inst.name);
        budget -= done.bytes;
        if (done.offset < done.size) { behindBytes += done.size - done.offset; behindFiles++; }
      }
      pruneLedger(ledger, cutoff);
    }
    this.pending = { bytes: behindBytes, files: behindFiles };
    await this.save();
    return behindBytes;
  }

  private async read(ledger: Ledger, cur: FileCursor, path: string, budget: number, cutoff: number): Promise<{ bytes: number; offset: number; size: number }> {
    try {
      const res = await scanJsonl(path, cur.offset, { maxBytes: budget }, (line) => {
        const turn = cur.kind === "claude" ? claudeLine(line, cur) : codexLine(line, cur);
        if (turn) addTurn(ledger, cur, turn, cutoff);
      });
      cur.offset = res.offset;
      // An unfinished last line is not "behind": the CLI is still writing it.
      return { bytes: Math.max(res.bytes, 1), offset: res.done ? res.size : res.offset, size: res.size };
    } catch (err) {
      this.o.log?.("debug", "cache analysis: could not read a transcript", { path, err: String(err) });
      return { bytes: 1, offset: cur.offset, size: cur.offset };
    }
  }

  private async claudeFiles(inst: CacheInstance, cutoff: number): Promise<Array<{ path: string; ino: number; size: number }>> {
    const dir = join(this.o.claudeProjectsDir(), this.o.claudeKey(inst.workingDirectory));
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const out: Array<{ path: string; ino: number; size: number }> = [];
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const path = join(dir, n);
      try { const st = await stat(path); if (st.isFile() && st.mtimeMs >= cutoff) out.push({ path, ino: st.ino, size: st.size }); } catch { /* gone */ }
    }
    return out;
  }

  /** Codex rollouts of the last KEEP_DAYS, by the instance whose working directory their session_meta names. */
  private async codexFilesByInstance(cutoff: number): Promise<Map<string, Array<{ path: string; ino: number; size: number }>>> {
    const out = new Map<string, Array<{ path: string; ino: number; size: number }>>();
    const insts = this.o.instances().filter((i) => kindOf(i.backend) === "codex");
    if (!insts.length) return out;
    const byCwd = new Map<string, string>();
    for (const i of insts) {
      byCwd.set(resolve(i.workingDirectory), i.name);
      try { byCwd.set(await realpath(i.workingDirectory), i.name); } catch { /* missing: as configured */ }
    }
    if (!this.meta) {
      try { this.meta = Object.assign(dict<string | null>(), JSON.parse(await readFile(this.o.metaPath, "utf8"))); } catch { this.meta = dict(); }
    }
    let rollouts: Array<{ path: string; mtimeMs: number }> = [];
    try { rollouts = this.o.listRollouts(this.o.codexSessionsDir()).filter((r) => r.mtimeMs >= cutoff); } catch { /* no sessions yet */ }
    const live = new Set<string>();
    for (const r of rollouts) {
      live.add(r.path);
      if (!(r.path in this.meta!)) { this.meta![r.path] = await rolloutCwd(r.path); this.metaDirty = true; }
      const cwd = this.meta![r.path];
      const name = cwd ? byCwd.get(resolve(cwd)) : undefined;
      if (!name) continue;
      try {
        const st = await stat(r.path);
        const list = out.get(name) ?? [];
        list.push({ path: r.path, ino: st.ino, size: st.size });
        out.set(name, list);
      } catch { /* gone */ }
    }
    for (const p of Object.keys(this.meta!)) if (!live.has(p)) { delete this.meta![p]; this.metaDirty = true; }
    return out;
  }

  private async save(): Promise<void> {
    const insts = new Map(this.o.instances().map((i) => [i.name, i]));
    for (const name of [...this.dirty]) {
      const inst = insts.get(name), l = this.ledgers.get(name);
      this.dirty.delete(name);
      if (inst && l) await writeAtomic(inst.ledgerPath, JSON.stringify(l));
    }
    if (this.metaDirty && this.meta) { this.metaDirty = false; await writeAtomic(this.o.metaPath, JSON.stringify(this.meta)); }
  }

  /** The analysis for a window, from the ledgers as they are now (a catch-up is started, not waited for). */
  async report(window: CacheWindow): Promise<CacheReport> {
    this.start();
    void this.kick();
    const to = this.now(), from = to - WINDOWS[window];
    const instances: InstanceReport[] = [];
    const fleet = { expiryCost: 0, saving: 0, recommended: 0, analysed: 0, priced: true };
    for (const inst of this.o.instances()) {
      const kind = kindOf(inst.backend);
      if (!kind) { instances.push({ name: inst.name, backend: inst.backend, status: inst.backend.startsWith("kiro") ? "credit_billed" : "unsupported" }); continue; }
      const ledger = await this.ledgerFor(inst);
      const analysis = analyzeLedger(ledger, { backend: kind, from, to });
      if (!analysis.requests && !analysis.sim.tailPings) { instances.push({ name: inst.name, backend: inst.backend, status: "no_data" }); continue; }
      instances.push({ name: inst.name, backend: inst.backend, status: "ok", analysis });
      fleet.analysed++;
      if (!analysis.priced) { fleet.priced = false; continue; }
      fleet.expiryCost += analysis.sim.expiryCost;
      if (analysis.recommendation.on) { fleet.recommended++; fleet.saving += analysis.sim.net; }
    }
    return { window, from, to, pricesChecked: PRICES_CHECKED, priceSources: PRICE_SOURCES, scanning: this.scanning(), fleet, instances };
  }
}

/** The cwd a rollout's first line (session_meta) names, read with a bounded read; null if it is not one. */
export async function rolloutCwd(path: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(META_MAX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, META_MAX_BYTES, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(10);
    if (nl === -1) return null;
    const d = JSON.parse(buf.toString("utf8", 0, nl)) as { type?: unknown; payload?: { cwd?: unknown } };
    return d.type === "session_meta" && typeof d.payload?.cwd === "string" ? d.payload.cwd : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try { await mkdir(dirname(path), { recursive: true }); await writeFile(tmp, text); await rename(tmp, path); } catch { /* the next pass writes again */ }
}
