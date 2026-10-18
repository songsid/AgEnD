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
 * already counted, and counting them twice would be worse than missing a rewrite. The inode is checked on the
 * descriptor actually read, not only on the listing. Two instances whose transcripts land in the same place (the same
 * working directory: one Claude project, one Codex cwd) cannot be told apart: neither is analysed, both say so.
 */
import { mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { scanJsonl } from "./cache-scan.js";
import { addTurn, claudeLine, codexLine, emptyLedger, KEEP_DAYS, pruneLedger, reviveLedger, type FileCursor, type Ledger, type TranscriptKind } from "./cache-ledger.js";
import { analyzeLedger, type InstanceAnalysis } from "./cache-analysis.js";
import { PRICES_CHECKED, PRICE_SOURCES } from "./cache-prices.js";
import { addCoverage, foldHours, pruneDays, readDays, writeDays, type UsageDays } from "./usage-rollup.js";

/** An instance to analyse: a fleet.yaml instance, or a ClassicBot room (its workspace under the AgEnD home). */
export interface CacheInstance {
  name: string; backend: string; workingDirectory: string; ledgerPath: string;
  /** #1699: this instance's claude config dir (its credential profile's); absent = claudeProjectsDir()'s parent. */
  claudeConfigDir?: string;
  /**
   * #2122: the profile the hours read now are tagged with — the claude profile whose config dir is read ("default"
   * without one); "unrecorded" for codex (a rollout does not say which login wrote it).
   */
  profile?: string;
}

export interface CacheServiceOptions {
  instances(): CacheInstance[];
  claudeProjectsDir(): string;
  claudeKey(workingDirectory: string): string;
  codexSessionsDir(): string;
  /** Rollout files with their mtimes (the shared rollout index). */
  listRollouts(root: string): Array<{ path: string; mtimeMs: number }>;
  /** #2122: how much the last listing of `root` could not read (rollout-index.ts `unreadable`); absent: 0. */
  rolloutsUnreadable?(root: string): number;
  /** Where the rollout → working-directory map is kept (one session_meta read per rollout, ever). */
  metaPath: string;
  now?: () => number;
  passBytes?: number;
  pauseMs?: number;
  intervalMs?: number;
  log?: (level: "info" | "warn" | "debug", msg: string, extra?: Record<string, unknown>) => void;
  /** Monotonic milliseconds for the published report's age (tests); default performance.now. */
  monotonic?: () => number;
  /** #2122: the zone days are folded in (defaults.scheduler.default_timezone, else the host's). */
  zone?: () => string;
}

export type CacheWindow = "24h" | "7d" | "30d";
export const WINDOWS: Record<CacheWindow, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
/** A window name as asked (a query string, a tool argument); anything unknown is the default, 7 days. */
export const cacheWindow = (w: string): CacheWindow => (Object.prototype.hasOwnProperty.call(WINDOWS, w) ? w as CacheWindow : "7d");

export interface InstanceReport {
  name: string;
  backend: string;
  /**
   * "ok" with `analysis`; "no_data": nothing read yet (or no transcript); "credit_billed": kiro; "unsupported";
   * "shared": its transcripts cannot be told apart from another instance's (the same working directory) — `with`.
   */
  status: "ok" | "no_data" | "credit_billed" | "unsupported" | "shared";
  with?: string[];
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
  /** `switchTo1h` (#2010): instances whose 5-minute cache measurably expires in 5–60 minute gaps — set prompt_cache_ttl: "1h". */
  fleet: { expiryCost: number; saving: number; recommended: number; analysed: number; priced: boolean; switchTo1h: number };
  instances: InstanceReport[];
}

const DAY = 86_400_000;
const META_MAX_BYTES = 256 * 1024;   // session_meta carries the instructions (~22 KB in real rollouts)
const kindOf = (backend: string): TranscriptKind | null => (backend === "claude-code" ? "claude" : backend === "codex" ? "codex" : null);
const sleep = (ms: number): Promise<void> => new Promise((r) => { const h = setTimeout(r, ms); h.unref?.(); });
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
/** An error that means the path is not there (never was, or went): a real absence, not a failure to read it. */
const gone = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

export class CacheService {
  private readonly ledgers = new Map<string, Ledger>();
  /** #2122: each instance's daily rollup (usage-rollup.ts), beside its ledger. */
  private readonly rollups = new Map<string, UsageDays>();
  private readonly dirty = new Set<string>();
  /** Rollout path → the inode its session_meta was read from, and the cwd it names (null: not a session_meta). */
  private meta: Record<string, { ino: number; cwd: string | null }> | null = null;
  private metaDirty = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Set by stop() to fence new scan admission while the current pass drains. */
  private closing = false;
  private pending = { bytes: 0, files: 0 };
  private caughtUp = false;
  /**
   * #2122 §5.5: instances whose transcripts could not all be listed or read during this catch-up (EACCES, EIO… — a source
   * that is simply not there is not one). The catch-up then proves nothing about them: no coverage is recorded.
   */
  private readonly unread = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly o: CacheServiceOptions) { this.now = o.now ?? Date.now; }

  /** Catch up now (joins a catch-up already running). */
  kick(): Promise<void> {
    if (this.stopped || this.closing) return Promise.resolve();
    return this.running ??= this.catchUp().catch((err) => { this.o.log?.("warn", "cache analysis: a pass failed", { err: String(err) }); })
      .finally(() => { this.running = null; });
  }

  /** Keep up on a timer from now on (the first report starts it). */
  start(): void {
    if (this.timer || this.stopped || this.closing) return;
    this.timer = setInterval(() => { void this.kick(); }, this.o.intervalMs ?? 10 * 60_000);
    this.timer.unref?.();
  }

  /** Stop the timer, fence new scan admission, drain the current pass, then
   * do one bounded save. Returns a promise callers MUST await for durability.
   *
   * Sequence:
   *  1. Cancel timer and set closing=true so kick()/start() refuse new work.
   *  2. Join this.running (if any) — the current catchUp() loop will exit at
   *     its next iteration boundary because closing=true, writing its own dirty
   *     data before returning.
   *  3. Do one final save() of anything that is still dirty.
   *  4. Set stopped=true.
   *
   * This bounds shutdown to one physical pass rather than scanning the entire
   * backlog.
   */
  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Set closing now so: (a) the current catchUp() loop exits after its next
    // physical pass instead of rescanning the full backlog, and (b) no new
    // kicks or timers can restart work once we start draining.
    this.closing = true;
    const inFlight = this.running ?? Promise.resolve();
    return inFlight
      .catch(() => {}) // a failed pass must not prevent the flush
      .then(async () => {
        // One bounded save for anything dirtied by the just-completed pass
        // (or already dirty). Use save() directly, not kick(), to avoid
        // re-entering the full scan loop.
        if (this.dirty.size > 0 || this.metaDirty) {
          const insts = this.o.instances();
          await this.save(insts).catch(() => {});
        }
      })
      .finally(() => { this.stopped = true; });
  }

  scanning(): CacheReport["scanning"] {
    return { active: this.running !== null, caughtUp: this.caughtUp, pendingBytes: this.pending.bytes, pendingFiles: this.pending.files };
  }

  private async catchUp(): Promise<void> {
    this.unread.clear();
    for (;;) {
      const left = await this.pass();
      if (left === 0) { this.caughtUp = true; await this.recordCoverage(); }
      // Stop looping when: all caught up, explicitly stopped, or closing (stop()
      // fenced new admission — let the current physical pass write its dirty data,
      // then exit rather than scanning the full backlog during shutdown).
      if (this.stopped || this.closing || left === 0) return;
      await sleep(this.o.pauseMs ?? 25);
    }
  }

  private zone(): string { return this.o.zone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  private daysPath(inst: CacheInstance): string { return join(dirname(inst.ledgerPath), "usage-days.json"); }
  /** #2122: an instance's rollup, read once. */
  async rollupFor(inst: CacheInstance): Promise<UsageDays> {
    let d = this.rollups.get(inst.name);
    if (d) return d;
    d = await readDays(this.daysPath(inst));
    const again = this.rollups.get(inst.name);
    if (again) return again;
    this.rollups.set(inst.name, d);
    return d;
  }
  /**
   * #2122 §5.2: fold the hours about to leave the ledger into the rollup — on a copy, kept only once it is on disk — and
   * return the checkpoint that is durable now (the ledger is pruned through it, never past it).
   */
  private async foldBeforePrune(inst: CacheInstance, ledger: Ledger, cutoff: number): Promise<number> {
    const current = await this.rollupFor(inst);
    const next: UsageDays = structuredClone(current);
    const folded = foldHours(next, ledger, cutoff, this.zone());
    const pruned = pruneDays(next, this.now(), this.zone());
    if (!folded && !pruned) return current.checkpoint;
    if (!(await writeDays(this.daysPath(inst), next))) {
      this.o.log?.("warn", "usage rollup: could not be saved; the ledger keeps those hours until it can", { instance: inst.name });
      return current.checkpoint;
    }
    this.rollups.set(inst.name, next);
    return next.checkpoint;
  }
  /**
   * #2122 §5.5: a catch-up finished — for each instance whose sources were all listed and read, every one changed in the
   * read window has been read up to now (an empty source included: a real zero). One that failed proves nothing.
   */
  private async recordCoverage(): Promise<void> {
    const now = this.now();
    const insts = this.o.instances();
    const shared = await this.shared(insts);
    for (const inst of insts) {
      if (!kindOf(inst.backend) || shared.has(inst.name) || this.unread.has(inst.name)) continue;
      const next: UsageDays = structuredClone(await this.rollupFor(inst));
      addCoverage(next, now - KEEP_DAYS * DAY, now);
      if (await writeDays(this.daysPath(inst), next)) this.rollups.set(inst.name, next);
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

  /**
   * The instances whose transcripts land where another's do — the same Claude project (working directory), the
   * same Codex cwd — mapped to the others. They are not read: nothing in a transcript says which one wrote it.
   */
  private async shared(insts: CacheInstance[]): Promise<Map<string, string[]>> {
    const groups = new Map<string, string[]>();
    for (const i of insts) {
      const kind = kindOf(i.backend);
      if (!kind) continue;
      const keys = kind === "claude" ? [`claude|${this.o.claudeKey(i.workingDirectory)}`] : (await cwdKeys(i.workingDirectory)).map((k) => `codex|${k}`);
      for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), i.name]);
    }
    const out = new Map<string, string[]>();
    for (const names of groups.values()) {
      const unique = [...new Set(names)];
      if (unique.length < 2) continue;
      for (const n of unique) out.set(n, [...new Set([...(out.get(n) ?? []), ...unique.filter((m) => m !== n)])]);
    }
    return out;
  }

  private passing: Promise<unknown> = Promise.resolve();
  /**
   * One bounded pass over every instance's files. Returns the bytes still behind afterwards. Passes never overlap
   * (two reading one file from the same cursor would count it twice): a pass asked for during another runs after it.
   */
  pass(): Promise<number> {
    const run = this.passing.then(() => this.passOnce());
    this.passing = run.catch(() => {});
    return run;
  }

  private async passOnce(): Promise<number> {
    const cutoff = this.now() - KEEP_DAYS * DAY;
    let budget = this.o.passBytes ?? 16 * 1024 * 1024;
    let behindBytes = 0, behindFiles = 0;
    const insts = this.o.instances();
    const shared = await this.shared(insts);
    const codex = await this.codexFilesByInstance(insts.filter((i) => !shared.has(i.name)), cutoff);
    for (const inst of insts) {
      if (this.stopped) break;
      const kind = kindOf(inst.backend);
      if (!kind || shared.has(inst.name)) { await this.keepHistory(inst, cutoff); continue; }
      const ledger = await this.ledgerFor(inst);
      const files = kind === "claude" ? await this.claudeFiles(inst, cutoff) : codex.get(inst.name) ?? [];
      const listed = new Set(files.map((f) => f.path));
      for (const path of Object.keys(ledger.files)) if (!listed.has(path)) { delete ledger.files[path]; this.dirty.add(inst.name); }
      for (const f of files) {
        let cur = ledger.files[f.path];
        if (!cur) { cur = ledger.files[f.path] = { kind, ino: f.ino, offset: 0 }; this.dirty.add(inst.name); }
        else if (cur.ino !== f.ino || f.size < cur.offset) { cur = this.followFromEnd(ledger, f.path, cur, f.ino, f.size); this.dirty.add(inst.name); }
        if (cur.offset >= f.size) continue;
        // Only an unfinished line was left, and the file has not grown since: nothing new to read.
        if (cur.stalled === f.size) continue;
        if (budget <= 0) { behindBytes += f.size - cur.offset; behindFiles++; continue; }
        const done = await this.read(ledger, cur, f.path, budget, cutoff, inst.profile);
        if (done.failed) this.unread.add(inst.name);
        this.dirty.add(inst.name);
        budget -= done.read;
        if (done.behind > 0) { behindBytes += done.behind; behindFiles++; }
      }
      // #2122: fold, then prune — the ledger never drops an hour the rollup does not durably hold.
      pruneLedger(ledger, cutoff, await this.foldBeforePrune(inst, ledger, cutoff));
    }
    this.pending = { bytes: behindBytes, files: behindFiles };
    // A ledger read something new (or lost a file): a published report is out of date (Fable #2030 P2 — a pass that
    // read nothing, such as the one every report starts, leaves it as it is).
    if (this.dirty.size) this.changes++;
    await this.save(insts);
    return behindBytes;
  }

  /**
   * #2122: an instance not read now (a backend AgEnD cannot measure, or a working directory it shares) keeps what it
   * measured before: its ledger's old hours are still folded into the rollup before they leave, as anyone's.
   */
  private async keepHistory(inst: CacheInstance, cutoff: number): Promise<void> {
    const ledger = await this.ledgerFor(inst);
    const before = Object.keys(ledger.hours).length;
    if (!before) return;
    pruneLedger(ledger, cutoff, await this.foldBeforePrune(inst, ledger, cutoff));
    if (Object.keys(ledger.hours).length !== before) this.dirty.add(inst.name);
  }

  /** A file that is not the one the cursor read (another inode, or shorter): keep the session's end, start at its end. */
  private followFromEnd(ledger: Ledger, path: string, cur: FileCursor, ino: number, size: number): FileCursor {
    const next: FileCursor = { kind: cur.kind, ino, offset: size };
    if (cur.last) { next.last = cur.last; next.first = cur.first; }
    if (cur.ttl !== undefined) next.ttl = cur.ttl;
    return ledger.files[path] = next;
  }

  private async read(ledger: Ledger, cur: FileCursor, path: string, budget: number, cutoff: number, profile?: string): Promise<{ read: number; behind: number; failed?: true }> {
    try {
      const res = await scanJsonl(path, cur.offset, { maxBytes: budget, ino: cur.ino }, (line) => {
        const turn = cur.kind === "claude" ? claudeLine(line, cur) : codexLine(line, cur);
        if (turn) addTurn(ledger, cur, turn, cutoff, profile);
      });
      if (res.replaced) { this.followFromEnd(ledger, path, cur, res.ino, res.size); return { read: 0, behind: 0 }; }
      cur.offset = res.offset;
      // Read to the end with an unfinished line left: the CLI is still writing it. Not behind, and not read again
      // until the file grows.
      if (res.done && res.offset < res.size) cur.stalled = res.size; else delete cur.stalled;
      return { read: Math.max(res.read, 1), behind: res.done ? 0 : res.size - res.offset };
    } catch (err) {
      this.o.log?.("debug", "cache analysis: could not read a transcript", { path, err: String(err) });
      // Gone since the listing: nothing left to read. Anything else: not read (the cursor stays; a later pass retries).
      return gone(err) ? { read: 1, behind: 0 } : { read: 1, behind: 0, failed: true };
    }
  }

  private async claudeFiles(inst: CacheInstance, cutoff: number): Promise<Array<{ path: string; ino: number; size: number }>> {
    const projects = inst.claudeConfigDir ? join(inst.claudeConfigDir, "projects") : this.o.claudeProjectsDir();
    const dir = join(projects, this.o.claudeKey(inst.workingDirectory));
    let names: string[];
    // No project directory: this instance has written nothing there (a real zero). Unreadable: not listed at all.
    try { names = await readdir(dir); } catch (err) { if (!gone(err)) this.unread.add(inst.name); return []; }
    const out: Array<{ path: string; ino: number; size: number }> = [];
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const path = join(dir, n);
      try { const st = await stat(path); if (st.isFile() && st.mtimeMs >= cutoff) out.push({ path, ino: st.ino, size: st.size }); }
      catch (err) { if (!gone(err)) this.unread.add(inst.name); }
    }
    return out;
  }

  /** Codex rollouts of the last KEEP_DAYS, by the instance whose working directory their session_meta names. */
  private async codexFilesByInstance(insts: CacheInstance[], cutoff: number): Promise<Map<string, Array<{ path: string; ino: number; size: number }>>> {
    const out = new Map<string, Array<{ path: string; ino: number; size: number }>>();
    const codexInsts = insts.filter((i) => kindOf(i.backend) === "codex");
    if (!codexInsts.length) return out;
    const byCwd = new Map<string, string>();
    for (const i of codexInsts) for (const k of await cwdKeys(i.workingDirectory)) byCwd.set(k, i.name);
    if (!this.meta) {
      this.meta = dict();
      try {
        for (const [p, v] of Object.entries(JSON.parse(await readFile(this.o.metaPath, "utf8")) as Record<string, unknown>)) {
          const e = v as { ino?: unknown; cwd?: unknown } | null;
          if (e && typeof e.ino === "number" && (typeof e.cwd === "string" || e.cwd === null)) this.meta[p] = { ino: e.ino, cwd: e.cwd };
        }
      } catch { /* none yet */ }
    }
    let rollouts: Array<{ path: string; mtimeMs: number }> = [];
    // A listing that could not read part of the tree may miss any codex instance's rollouts: none of them is covered.
    const unlisted = (): void => { for (const i of codexInsts) this.unread.add(i.name); };
    try {
      const root = this.o.codexSessionsDir();
      rollouts = this.o.listRollouts(root).filter((r) => r.mtimeMs >= cutoff);
      if ((this.o.rolloutsUnreadable?.(root) ?? 0) > 0) unlisted();
    } catch (err) { if (!gone(err)) unlisted(); /* else no sessions yet */ }
    const live = new Set<string>();
    for (const r of rollouts) {
      live.add(r.path);
      let st;
      try { st = await stat(r.path); } catch (err) { if (!gone(err)) unlisted(); continue; }
      let m = this.meta![r.path];
      // Read once per physical file; a first line still being written is read again next pass.
      if (!m || m.ino !== st.ino) {
        const read = await rolloutMeta(r.path);
        // Unreadable (not gone, not just unfinished): whose it is cannot be known, so no codex instance is covered.
        if (read === "unreadable") { unlisted(); delete this.meta![r.path]; continue; }
        if (read) { m = this.meta![r.path] = read; this.metaDirty = true; } else { delete this.meta![r.path]; continue; }
      }
      const name = m.cwd ? byCwd.get(resolve(m.cwd)) : undefined;
      // The meta belongs to the inode it was read from; a file replaced since is read again next pass.
      if (!name || m.ino !== st.ino) continue;
      const list = out.get(name) ?? [];
      list.push({ path: r.path, ino: st.ino, size: st.size });
      out.set(name, list);
    }
    for (const p of Object.keys(this.meta!)) if (!live.has(p)) { delete this.meta![p]; this.metaDirty = true; }
    return out;
  }

  /** Write what changed; whatever fails to write stays dirty and is written by a later pass. */
  private async save(insts: CacheInstance[]): Promise<void> {
    const byName = new Map(insts.map((i) => [i.name, i]));
    for (const name of [...this.dirty]) {
      const inst = byName.get(name), l = this.ledgers.get(name);
      if (!inst || !l) { this.dirty.delete(name); continue; }
      if (await writeAtomic(inst.ledgerPath, JSON.stringify(l))) this.dirty.delete(name);
    }
    if (this.metaDirty && this.meta && await writeAtomic(this.o.metaPath, JSON.stringify(this.meta))) this.metaDirty = false;
  }

  /** Ledger changes so far: a catch-up pass that read new lines (or dropped a file). */
  private changes = 0;
  private readonly memo = new Map<CacheWindow, { at: number; changes: number; report: Promise<CacheReport> }>();
  /**
   * #2001: the report as last worked out, for get_cache_report — the same as report(), reused for up to a minute and
   * until a catch-up reads something new, so agents asking in turn do not each redo it (or start another catch-up).
   * Never reads a transcript itself.
   */
  published(window: CacheWindow, maxAgeMs = 60_000): Promise<CacheReport> {
    const m = this.memo.get(window), now = (this.o.monotonic ?? (() => performance.now()))();
    if (m && m.changes === this.changes && now - m.at < maxAgeMs) return m.report;
    const report = this.report(window);
    this.memo.set(window, { at: now, changes: this.changes, report });
    report.catch(() => this.memo.delete(window));
    return report;
  }

  /**
   * #2122: what the usage report reads — each instance's ledger and rollup as they are now, or why it has none. Never
   * reads a transcript (a catch-up is started, not waited for).
   */
  async usageData(): Promise<{ scanning: CacheReport["scanning"]; instances: Array<{ inst: CacheInstance; status: InstanceReport["status"]; with?: string[]; ledger: Ledger; days: UsageDays }> }> {
    this.start();
    void this.kick();
    const insts = this.o.instances();
    const shared = await this.shared(insts);
    const out: Array<{ inst: CacheInstance; status: InstanceReport["status"]; with?: string[]; ledger: Ledger; days: UsageDays }> = [];
    for (const inst of insts) {
      await this.ledgerFor(inst);
      await this.rollupFor(inst);
      // One instance's ledger and rollup copied together, with no await between: a pass folds an hour into a new rollup
      // and prunes it from the ledger later, so both copies hold it (the report counts it once, by the checkpoint) or
      // one does — never neither. Copies, so a pass that runs while the next instance is loaded changes nothing here.
      const live = this.ledgers.get(inst.name)!;
      const ledger: Ledger = { ...emptyLedger(), hours: structuredClone(live.hours), ...(live.writesSeen ? { writesSeen: true } : {}) };   // what the report reads
      const days = structuredClone(this.rollups.get(inst.name)!);
      // `status` is about collecting now; what it measured before (another backend, a directory it did not share yet)
      // is in `ledger` and `days` either way.
      const kind = kindOf(inst.backend), others = shared.get(inst.name);
      if (!kind) out.push({ inst, status: inst.backend.startsWith("kiro") ? "credit_billed" : "unsupported", ledger, days });
      else if (others) out.push({ inst, status: "shared", with: others, ledger, days });
      else out.push({ inst, status: "ok", ledger, days });
    }
    return { scanning: this.scanning(), instances: out };
  }

  /** The analysis for a window, from the ledgers as they are now (a catch-up is started, not waited for). */
  async report(window: CacheWindow): Promise<CacheReport> {
    this.start();
    void this.kick();
    const to = this.now(), from = to - WINDOWS[window];
    const instances: InstanceReport[] = [];
    const fleet = { expiryCost: 0, saving: 0, recommended: 0, analysed: 0, priced: true, switchTo1h: 0 };
    const insts = this.o.instances();
    const shared = await this.shared(insts);
    for (const inst of insts) {
      const kind = kindOf(inst.backend);
      if (!kind) { instances.push({ name: inst.name, backend: inst.backend, status: inst.backend.startsWith("kiro") ? "credit_billed" : "unsupported" }); continue; }
      const others = shared.get(inst.name);
      if (others) { instances.push({ name: inst.name, backend: inst.backend, status: "shared", with: others }); continue; }
      const ledger = await this.ledgerFor(inst);
      const analysis = analyzeLedger(ledger, { backend: kind, from, to });
      if (!analysis.requests && !analysis.sim.tailPings) { instances.push({ name: inst.name, backend: inst.backend, status: "no_data" }); continue; }
      instances.push({ name: inst.name, backend: inst.backend, status: "ok", analysis });
      fleet.analysed++;
      if (analysis.recommendation.reason === "switch_to_1h") fleet.switchTo1h++;
      if (!analysis.priced) { fleet.priced = false; continue; }
      fleet.expiryCost += analysis.sim.expiryCost;
      if (analysis.recommendation.on) { fleet.recommended++; fleet.saving += analysis.sim.net; }
    }
    return { window, from, to, pricesChecked: PRICES_CHECKED, priceSources: PRICE_SOURCES, scanning: this.scanning(), fleet, instances };
  }
}

/** A working directory as configured and as the filesystem resolves it (a rollout records either). */
async function cwdKeys(dir: string): Promise<string[]> {
  const keys = [resolve(dir)];
  try { const real = await realpath(dir); if (real !== keys[0]) keys.push(real); } catch { /* missing: as configured */ }
  return keys;
}

/**
 * A rollout's session_meta, read with one bounded read through the descriptor whose inode it records. Null while the
 * first line is not complete yet, or the file is gone (the next pass reads it again); `cwd: null` for a complete first
 * line that is not a session_meta; "unreadable" when it is there and could not be read (EACCES, EIO… — #2122: not a
 * real absence).
 */
export async function rolloutMeta(path: string): Promise<{ ino: number; cwd: string | null } | null | "unreadable"> {
  let fh;
  try {
    fh = await open(path, "r");
    const ino = (await fh.stat()).ino;
    const buf = Buffer.alloc(META_MAX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, META_MAX_BYTES, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(10);
    if (nl === -1) return bytesRead >= META_MAX_BYTES ? { ino, cwd: null } : null;
    try {
      const d = JSON.parse(buf.toString("utf8", 0, nl)) as { type?: unknown; payload?: { cwd?: unknown } };
      return { ino, cwd: d.type === "session_meta" && typeof d.payload?.cwd === "string" ? d.payload.cwd : null };
    } catch { return { ino, cwd: null }; }
  } catch (err) {
    return gone(err) ? null : "unreadable";
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function writeAtomic(path: string, text: string): Promise<boolean> {
  const tmp = `${path}.${process.pid}.tmp`;
  try { await mkdir(dirname(path), { recursive: true }); await writeFile(tmp, text); await rename(tmp, path); return true; } catch { return false; }
}
