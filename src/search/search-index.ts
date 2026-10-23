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
 * - Retention: when retention_days is a positive integer, docs older than that many days go; unset and 0 mean no
 *   age limit. The oldest past ROW_CAP are pruned either way, after the backfill and daily.
 */
import { Worker } from "node:worker_threads";
import type { SearchDoc, SearchFilters, SearchHit, SearchResult } from "./search-store.js";

export const BATCH_MS = 250;
export const BATCH_MAX = 200;
export const QUEUE_MAX = 5_000;
export const QUERY_BUDGET_MS = 3_000;
export const PENDING_MAX = 16;
/** A query the worker still holds this long after it was asked: the worker is stuck, and is restarted. */
export const STALL_MS = 30_000;
/** How long close() waits for the worker to write what it was sent and exit. */
export const CLOSE_WAIT_MS = 3_000;
export const PRUNE_EVERY_MS = 24 * 3600_000;
export const BACKFILL_CHUNK = 200;
/**
 * web.search.retention_days when unset. 0 = no age-based prune (the daily prune still enforces ROW_CAP).
 * An explicit 0 in fleet.yaml means the same.
 */
export const SEARCH_RETENTION_DAYS = 0;

/**
 * Epoch-ms cutoff for age prune and backfill. Unset, 0, and any non-finite or non-positive days mean no age
 * limit (cutoff 0): naive `now - 0 * day` would be `now` and would wipe the index.
 */
export function searchAgeCutoff(now: number, retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  return now - retentionDays * 24 * 3600_000;
}
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
  /**
   * Queries the worker holds: PENDING_MAX counts these. Past QUERY_BUDGET_MS the caller is answered ("timeout"), but the
   * entry stays until the worker replies or exits — the worker still runs or queues it. One still held at STALL_MS: the
   * worker is retired (terminated) and started again.
   */
  private queries = new Map<number, { answered: boolean; timer: ReturnType<typeof setTimeout>; stall?: ReturnType<typeof setTimeout>; resolve(v: { ok: boolean; value?: unknown; reason?: string }): void }>();
  /** The index's own requests (backfill, prune): no budget; settled on the reply or when the worker goes. */
  private requests = new Map<number, (v: { ok: boolean; value?: unknown }) => void>();
  /**
   * Batches posted and not yet committed (the worker acks each after its write). A worker that goes, or reopens a fresh
   * file, gets them again (an upsert by key: twice is harmless). Flushing waits while they hold QUEUE_MAX docs.
   */
  private inflight = new Map<number, SearchDoc[]>();
  private inflightDocs = 0;
  private nextBatch = 0;
  /**
   * Instance removals not yet known to be done, with the last batch posted before each: sent again before anything else
   * to a worker that (re)starts. Done when the worker acks it, or acks a later batch (it works in order).
   */
  private removals = new Map<string, { gen: number; before: number }>();
  private removalGen = 0;
  /** A backfill waiting for room under QUEUE_MAX uncommitted docs: woken by a commit, the worker going, or close. */
  private roomWaiters: Array<() => void> = [];
  /** Instances removed while a backfill runs: the rest of it leaves their chat out (it read the history before). */
  private removedDuringBackfill: Set<string> | null = null;
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
    worker.on("message", (m: { op: string; id?: number; ok?: boolean; value?: unknown; error?: string; built?: boolean; reason?: string; batch?: number; instance?: string; gen?: number }) => {
      if (this.worker !== worker) return;          // an old worker's late reply or ack changes nothing
      if (m.op === "reply" && m.id !== undefined) { this.replied(m.id, m.ok ? { ok: true, value: m.value } : { ok: false, reason: "unavailable" }); return; }
      if (m.op === "added" && m.batch !== undefined) { this.committed(m.batch); return; }
      // A removal's ack confirms that removal only: a later one of the same name (re-created, removed again) stays.
      if (m.op === "removed" && typeof m.instance === "string") { if (this.removals.get(m.instance)?.gen === m.gen) this.removals.delete(m.instance); return; }
      if (m.op === "failed") { this.opts.log?.("warn", `search: the index cannot be opened (${m.reason ?? "unknown"}); search is unavailable`); this.state = "unavailable"; this.closed = true; return; }
      if (m.op !== "ready") return;
      this.restartDelay = RESTART_MIN_MS;
      // Whatever this worker's file may be missing: removals first, then the batches no worker committed.
      for (const [instance, { gen }] of this.removals) this.post({ op: "removeInstance", instance, gen });
      for (const [batch, docs] of this.inflight) this.post({ op: "add", batch, docs });
      if (m.built) { this.state = "ready"; this.flush(); this.startPruning(); }
      else void this.backfill(epoch);
    });
    worker.on("error", (err: unknown) => { if (this.worker === worker) this.opts.log?.("warn", `search: index worker error: ${String((err as Error)?.message ?? err)}`); });
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.dropWorkerWork();
      this.wakeRoom();
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

  /**
   * An instance removed from the fleet: its chat leaves the index — queued and uncommitted docs, what the worker has, and
   * the rest of a backfill running now (see SearchStore.removeInstance). Its later chat, under the same name, is a new
   * instance's and is indexed as usual.
   */
  removeInstance(instance: string): void {
    const gone = (d: SearchDoc) => d.source === "chat" && d.instance === instance;
    this.queue = this.queue.filter(d => !gone(d));
    for (const [batch, docs] of this.inflight) {
      const kept = docs.filter(d => !gone(d));
      this.inflightDocs -= docs.length - kept.length;
      this.inflight.set(batch, kept);
    }
    this.removedDuringBackfill?.add(instance);
    const gen = ++this.removalGen;
    this.removals.set(instance, { gen, before: this.nextBatch });
    this.post({ op: "removeInstance", instance, gen });
  }

  query(filters: SearchFilters): Promise<SearchAnswer<SearchResult>> { return this.ask("query", { filters }) as Promise<SearchAnswer<SearchResult>>; }
  context(key: string): Promise<SearchAnswer<SearchContext | null>> { return this.ask("context", { key }) as Promise<SearchAnswer<SearchContext | null>>; }

  /**
   * Stop: everything queued goes to the worker first (bounded: the queue is at most QUEUE_MAX), then "close" — the worker
   * writes in order and then closes the file. Resolves when the worker has exited, or after CLOSE_WAIT_MS.
   */
  close(): Promise<void> {
    if (this.closed && !this.worker) return Promise.resolve();
    this.closed = true;
    this.epoch++;
    for (const t of [this.flushTimer, this.restartTimer]) if (t) clearTimeout(t);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flushTimer = this.restartTimer = this.pruneTimer = null;
    while (this.queue.length && this.worker) if (!this.postBatch(this.queue.splice(0, BATCH_MAX))) break;
    this.dropWorkerWork();
    this.wakeRoom();
    const worker = this.worker;
    this.post({ op: "close" });
    this.state = "unavailable";
    if (!worker) return Promise.resolve();
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, CLOSE_WAIT_MS);
      timer.unref?.();
      worker.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private ask(op: "query" | "context", body: Record<string, unknown>): Promise<SearchAnswer<unknown>> {
    if (!this.worker || (this.state !== "ready" && this.state !== "building")) return Promise.resolve({ ok: false, reason: "unavailable" });
    if (this.queries.size >= PENDING_MAX) return Promise.resolve({ ok: false, reason: "busy" });
    const id = ++this.nextId, building = this.state === "building", worker = this.worker;
    return new Promise(resolve => {
      const entry = {
        answered: false,
        resolve: (r: { ok: boolean; value?: unknown; reason?: string }) => resolve(r.ok ? { ok: true, value: r.value, building } : { ok: false, reason: (r.reason as "unavailable" | "timeout" | "busy") ?? "unavailable" }),
        timer: setTimeout(() => {
          this.answer(id, { ok: false, reason: "timeout" });
          // Still held long after: the worker is stuck — retire it (its exit ends the hold, and it is started again).
          const held = this.queries.get(id);
          if (held) held.stall = setTimeout(() => { if (this.queries.has(id) && this.worker === worker) this.retire(); }, STALL_MS - QUERY_BUDGET_MS);
        }, QUERY_BUDGET_MS),
      } as { answered: boolean; timer: ReturnType<typeof setTimeout>; stall?: ReturnType<typeof setTimeout>; resolve(v: { ok: boolean; value?: unknown; reason?: string }): void };
      this.queries.set(id, entry);
      if (!this.post({ op, id, ...body })) this.replied(id, { ok: false, reason: "unavailable" });
    });
  }
  /** The caller's answer (once); the worker may still hold the query. */
  private answer(id: number, r: { ok: boolean; value?: unknown; reason?: string }): void {
    const q = this.queries.get(id);
    if (!q || q.answered) return;
    q.answered = true; clearTimeout(q.timer); q.resolve(r);
  }
  /** The worker is done with `id`: a query's hold ends (answered now if it was not), or a request settles. */
  private replied(id: number, r: { ok: boolean; value?: unknown; reason?: string }): void {
    if (this.queries.has(id)) {
      this.answer(id, r);
      const q = this.queries.get(id)!;
      if (q.stall) clearTimeout(q.stall);
      this.queries.delete(id);
      return;
    }
    const request = this.requests.get(id);
    if (request) { this.requests.delete(id); request({ ok: r.ok, value: r.value }); }
  }
  /** The worker went (or the index closes): nothing it held will be answered. Uncommitted batches are kept. */
  private dropWorkerWork(): void {
    for (const id of [...this.queries.keys()]) this.replied(id, { ok: false, reason: "unavailable" });
    for (const id of [...this.requests.keys()]) this.replied(id, { ok: false });
  }
  private retire(): void {
    const w = this.worker;
    if (!w) return;
    this.opts.log?.("warn", "search: a query held the index worker too long; restarting it");
    try { void w.terminate().catch(() => {}); } catch { /* its exit (or none) decides */ }
  }
  private committed(batch: number): void {
    const docs = this.inflight.get(batch);
    if (docs) { this.inflight.delete(batch); this.inflightDocs -= docs.length; }
    // The worker works in order: a removal posted before this batch is done too.
    for (const [instance, { before }] of this.removals) if (before < batch) this.removals.delete(instance);
    this.wakeRoom();
    if (this.queue.length && (this.state === "ready" || this.state === "building")) this.flushTimer ??= setTimeout(() => this.flush(), BATCH_MS);
  }
  private wakeRoom(): void { const waiters = this.roomWaiters; this.roomWaiters = []; for (const w of waiters) w(); }
  /**
   * A backfill's chunk, admitted under the same QUEUE_MAX as the queue's batches: while that many wait for a commit, it
   * waits for one. False when this backfill is over (the worker went — the next one backfills again — or close).
   */
  private async admitChunk(docs: SearchDoc[], epoch: number, kept: (d: SearchDoc) => boolean): Promise<number | null> {
    while (this.inflightDocs > 0 && this.inflightDocs + docs.length > QUEUE_MAX) {
      if (epoch !== this.epoch || !this.worker || this.closed) return null;
      await new Promise<void>(resolve => this.roomWaiters.push(resolve));
    }
    if (epoch !== this.epoch || !this.worker || this.closed) return null;
    const admitted = docs.filter(kept);                    // an instance removed while it waited, too
    return this.postBatch(admitted) ? admitted.length : null;
  }
  private post(message: Record<string, unknown>): boolean {
    if (!this.worker) return false;
    try { this.worker.postMessage(message); return true; } catch { return false; }
  }
  /** A batch to the worker, kept until it is committed. False when there is no worker to take it. */
  private postBatch(docs: SearchDoc[]): boolean {
    if (!docs.length) return true;
    const batch = ++this.nextBatch;
    this.inflight.set(batch, docs); this.inflightDocs += docs.length;
    if (this.post({ op: "add", batch, docs })) return true;
    this.inflight.delete(batch); this.inflightDocs -= docs.length;
    return false;
  }
  private flush(force = false): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.queue.length || (!force && this.state !== "ready" && this.state !== "building")) return;
    // Bounded: while QUEUE_MAX docs wait for their commit, new ones wait in the (capped) queue.
    if (!force && this.inflightDocs >= QUEUE_MAX) return;
    const docs = this.queue.splice(0, BATCH_MAX);
    if (!this.postBatch(docs)) { this.queue = docs.concat(this.queue).slice(-QUEUE_MAX); return; }
    if (this.queue.length) this.flushTimer = setTimeout(() => this.flush(), 0);
  }
  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(RESTART_MAX_MS, this.restartDelay * 2);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.start(); }, delay);
    this.restartTimer.unref?.();
  }
  private cutoff(): number { return searchAgeCutoff(this.now(), this.opts.retentionDays); }
  private async backfill(epoch: number): Promise<void> {
    this.state = "building";
    this.flush();
    const started = this.now();
    const removed = this.removedDuringBackfill = new Set<string>();
    const kept = (d: SearchDoc) => !(d.source === "chat" && removed.has(d.instance));
    let chats = 0;
    try {
      const cutoff = this.cutoff();
      let chunk: SearchDoc[] = [];
      for (const doc of this.opts.chatDocs()) {
        if (doc.ts < cutoff || !kept(doc)) continue;
        chunk.push(doc);
        if (chunk.length < BACKFILL_CHUNK) continue;
        const sent = await this.admitChunk(chunk, epoch, kept);
        if (sent === null) return;
        chats += sent; chunk = [];
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (epoch !== this.epoch) return;
      const sent = await this.admitChunk(chunk, epoch, kept);
      if (sent === null) return;
      chats += sent;
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
    } finally {
      if (this.removedDuringBackfill === removed) this.removedDuringBackfill = null;
    }
  }
  /** A worker request without the query budget (the backfill and prune run as long as they need). */
  private request(op: string, body: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown }> {
    const id = ++this.nextId;
    return new Promise(resolve => {
      this.requests.set(id, resolve);
      if (!this.post({ op, id, ...body })) this.replied(id, { ok: false });
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
