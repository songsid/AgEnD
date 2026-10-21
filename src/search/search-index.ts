/**
 * #2293: the fleet's side of global search. The fleet loop only builds small docs (search-docs.ts) and posts them; the
 * worker (search-worker.ts) owns search.db — every write, query, prune and the SQLite part of the backfill run there.
 *
 * - Writes are batched: posted every BATCH_MS or at BATCH_MAX docs. While the worker is starting (or restarting) they
 *   wait in a bounded queue (QUEUE_MAX; the oldest go first — the backfill finds what is still kept).
 * - A query has QUERY_BUDGET_MS; past it the page is told so and the worker carries on (a query is bounded: LIMIT, or
 *   the newest SHORT_SCAN_ROWS rows). At most PENDING_MAX at a time.
 * - A new or rebuilt index (`ready` with built=false: a first start, a schema change, a corrupt file moved aside) is
 *   backfilled: the chat histories the fleet holds, in chunks between turns of the loop, then the worker's read of the
 *   outbox and the Task Board; then marked built. Search answers meanwhile and says it is still building.
 * - A worker that exits is started again after a backoff (1 s doubling to a minute); one that cannot open the file at
 *   all ("failed") leaves search unavailable until the next fleet start. The fleet runs on either way.
 * - Retention: docs older than retention_days, and the oldest past ROW_CAP, are pruned after the backfill and daily.
 */
import { Worker } from "node:worker_threads";
import type { SearchDoc, SearchFilters, SearchHit, SearchResult } from "./search-store.js";

export const BATCH_MS = 250;
export const BATCH_MAX = 200;
export const QUEUE_MAX = 5_000;
export const QUERY_BUDGET_MS = 3_000;
export const PENDING_MAX = 16;
export const PRUNE_EVERY_MS = 24 * 3600_000;
export const BACKFILL_CHUNK = 200;
/** web.search.retention_days when unset. */
export const SEARCH_RETENTION_DAYS = 90;
const RESTART_MIN_MS = 1_000, RESTART_MAX_MS = 60_000;

export type SearchState = "starting" | "building" | "ready" | "unavailable";
export type SearchAnswer<T> = { ok: true; value: T; building: boolean } | { ok: false; reason: "unavailable" | "timeout" | "busy" };
export interface SearchContext { doc: SearchHit & { text: string }; before: Array<SearchHit & { text: string }>; after: Array<SearchHit & { text: string }> }

interface Isolate {
  on(event: "message" | "error" | "exit", listener: (...args: any[]) => void): unknown;
  postMessage(value: unknown): void; terminate(): Promise<number>; unref(): unknown;
}
function createIsolate(path: string): Isolate {
  return import.meta.url.endsWith(".ts")
    ? new Worker(`const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
      { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 }, workerData: { path, entry: new URL("./search-worker.ts", import.meta.url).href } })
    : new Worker(new URL("./search-worker.js", import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 }, workerData: { path } });
}

export interface SearchIndexOptions {
  /** search.db's path. */
  path: string;
  retentionDays: number;
  /** The SQLite sources the worker backfills from, read-only. */
  outboxPath?: string;
  schedulerPath?: string;
  /** The chat docs the fleet holds now, for the backfill (iterated a chunk per turn of the loop). */
  chatDocs: () => Iterable<SearchDoc>;
  log?: (level: "info" | "warn", msg: string) => void;
  /** Tests: the worker, the clock (wall clock: doc times are wall-clock epoch ms). */
  factory?: (path: string) => Isolate;
  now?: () => number;
}

export class SearchIndex {
  private worker: Isolate | null = null;
  private state: SearchState = "starting";
  private queue: SearchDoc[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private restartDelay = RESTART_MIN_MS;
  private nextId = 0;
  private pending = new Map<number, { timer?: ReturnType<typeof setTimeout>; resolve(v: { ok: boolean; value?: unknown; reason?: string }): void }>();
  /** Bumped on every (re)start and on close: a backfill of an older worker stops. */
  private epoch = 0;
  private closed = false;
  private readonly factory: (path: string) => Isolate;
  private readonly now: () => number;

  constructor(private readonly opts: SearchIndexOptions) {
    this.factory = opts.factory ?? createIsolate;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.closed || this.worker) return;
    const epoch = ++this.epoch;
    let worker: Isolate;
    try { worker = this.factory(this.opts.path); }
    catch (err) { this.opts.log?.("warn", `search: cannot start the index worker: ${String((err as Error)?.message ?? err)}`); this.scheduleRestart(); return; }
    this.worker = worker;
    this.state = "starting";
    worker.unref();
    worker.on("message", (m: { op: string; id?: number; ok?: boolean; value?: unknown; error?: string; built?: boolean; reason?: string }) => {
      if (this.worker !== worker) return;
      if (m.op === "reply" && m.id !== undefined) { this.settle(m.id, m.ok ? { ok: true, value: m.value } : { ok: false, reason: "unavailable" }); return; }
      if (m.op === "failed") { this.opts.log?.("warn", `search: the index cannot be opened (${m.reason ?? "unknown"}); search is unavailable`); this.state = "unavailable"; this.closed = true; return; }
      if (m.op !== "ready") return;
      this.restartDelay = RESTART_MIN_MS;
      if (m.built) { this.state = "ready"; this.flush(); this.startPruning(); }
      else void this.backfill(epoch);
    });
    worker.on("error", (err: unknown) => { if (this.worker === worker) this.opts.log?.("warn", `search: index worker error: ${String((err as Error)?.message ?? err)}`); });
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, reason: "unavailable" });
      if (this.closed) { if (this.state !== "unavailable") this.state = "unavailable"; return; }
      this.state = "starting";
      this.scheduleRestart();
    });
  }

  /** What a page shows: whether search answers, and whether the index is still being built. */
  status(): SearchState { return this.state; }

  /** A doc to index (null: nothing to index). */
  record(doc: SearchDoc | null): void {
    if (!doc || this.closed) return;
    this.queue.push(doc);
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX);
    if (this.state !== "ready" && this.state !== "building") return;
    if (this.queue.length >= BATCH_MAX) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  /** An instance removed from the fleet: its chat leaves the index (queued rows too; see SearchStore.removeInstance). */
  removeInstance(instance: string): void {
    this.queue = this.queue.filter(d => d.source !== "chat" || d.instance !== instance);
    this.post({ op: "removeInstance", instance });
  }

  query(filters: SearchFilters): Promise<SearchAnswer<SearchResult>> { return this.ask("query", { filters }) as Promise<SearchAnswer<SearchResult>>; }
  context(key: string): Promise<SearchAnswer<SearchContext | null>> { return this.ask("context", { key }) as Promise<SearchAnswer<SearchContext | null>>; }

  close(): void {
    if (this.closed && !this.worker) return;
    this.closed = true;
    this.epoch++;
    for (const t of [this.flushTimer, this.restartTimer]) if (t) clearTimeout(t);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flushTimer = this.restartTimer = this.pruneTimer = null;
    this.flush(true);
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, reason: "unavailable" });
    this.post({ op: "close" });
    this.state = "unavailable";
  }

  private ask(op: "query" | "context", body: Record<string, unknown>): Promise<SearchAnswer<unknown>> {
    if (!this.worker || (this.state !== "ready" && this.state !== "building")) return Promise.resolve({ ok: false, reason: "unavailable" });
    if (this.pending.size >= PENDING_MAX) return Promise.resolve({ ok: false, reason: "busy" });
    const id = ++this.nextId, building = this.state === "building";
    return new Promise(resolve => {
      this.pending.set(id, {
        timer: setTimeout(() => this.settle(id, { ok: false, reason: "timeout" }), QUERY_BUDGET_MS),
        resolve: r => resolve(r.ok ? { ok: true, value: r.value, building } : { ok: false, reason: (r.reason as "unavailable" | "timeout" | "busy") ?? "unavailable" }),
      });
      if (!this.post({ op, id, ...body })) this.settle(id, { ok: false, reason: "unavailable" });
    });
  }
  private settle(id: number, r: { ok: boolean; value?: unknown; reason?: string }): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id); clearTimeout(p.timer); p.resolve(r);
  }
  private post(message: Record<string, unknown>): boolean {
    if (!this.worker) return false;
    try { this.worker.postMessage(message); return true; } catch { return false; }
  }
  private flush(force = false): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.queue.length || (!force && this.state !== "ready" && this.state !== "building")) return;
    const docs = this.queue; this.queue = [];
    if (!this.post({ op: "add", docs })) this.queue = docs.concat(this.queue).slice(-QUEUE_MAX);
  }
  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(RESTART_MAX_MS, this.restartDelay * 2);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.start(); }, delay);
    this.restartTimer.unref?.();
  }
  private cutoff(): number { return this.now() - this.opts.retentionDays * 24 * 3600_000; }
  private async backfill(epoch: number): Promise<void> {
    this.state = "building";
    this.flush();
    const started = this.now();
    let chats = 0;
    try {
      const cutoff = this.cutoff();
      let chunk: SearchDoc[] = [];
      for (const doc of this.opts.chatDocs()) {
        if (doc.ts < cutoff) continue;
        chunk.push(doc);
        if (chunk.length < BACKFILL_CHUNK) continue;
        if (epoch !== this.epoch || !this.post({ op: "add", docs: chunk })) return;
        chats += chunk.length; chunk = [];
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (epoch !== this.epoch) return;
      if (chunk.length && !this.post({ op: "add", docs: chunk })) return;
      chats += chunk.length;
      const sql = await this.request("backfill", { outboxPath: this.opts.outboxPath, schedulerPath: this.opts.schedulerPath, cutoff });
      if (epoch !== this.epoch || !sql.ok) return;
      this.post({ op: "markBuilt", now: this.now() });
      const { xmsg = 0, tasks = 0 } = (sql.value ?? {}) as { xmsg?: number; tasks?: number };
      this.opts.log?.("info", `search: index built (${chats} chat, ${xmsg} cross-instance, ${tasks} task docs in ${this.now() - started} ms)`);
      this.state = "ready";
      this.flush();
      this.startPruning();
    } catch (err) {
      this.opts.log?.("warn", `search: backfill failed: ${String((err as Error)?.message ?? err)}`);
    }
  }
  /** A worker request without the query budget (the backfill and prune run as long as they need). */
  private request(op: string, body: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown }> {
    const id = ++this.nextId;
    return new Promise(resolve => {
      this.pending.set(id, { resolve });
      if (!this.post({ op, id, ...body })) this.settle(id, { ok: false });
    });
  }
  private startPruning(): void {
    void this.prune();
    if (this.pruneTimer || this.closed) return;
    this.pruneTimer = setInterval(() => void this.prune(), PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
  }
  private async prune(): Promise<void> {
    for (let rounds = 0; rounds < 1_000; rounds++) {
      const r = await this.request("prune", { cutoff: this.cutoff() });
      if (!r.ok || !(r.value as { more?: boolean } | undefined)?.more) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}
