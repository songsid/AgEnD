import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import type { KiroDbCursor } from "./kiro-db-reader.js";
import type { TranscriptEvents } from "./transcript-sources.js";

export const KIRO_TRANSCRIPT_BUDGET_MS = 15_000;
/** One replacement can read while one retired native call is still held. */
export const KIRO_TRANSCRIPT_MAX_WORKERS = 2;
export interface KiroDbInput {
  dbPath: string;
  workingDirectory: string;
  createdAt: number;
  baseline: boolean;
  cursor?: KiroDbCursor;
}
export interface KiroDbReply { events: TranscriptEvents | null; cursor: KiroDbCursor; }
export interface KiroDbLease { read(input: KiroDbInput): Promise<KiroDbReply | null>; close(): void; }
export interface KiroDbLane { acquire(): KiroDbLease; }
export interface KiroWorkerRequest { id: number; owner: number; deadlineAt: number; input: KiroDbInput; }
interface Isolate {
  on(event: "message" | "error" | "exit", listener: (...args: any[]) => void): unknown;
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  ref(): unknown;
  unref(): unknown;
}
interface Pending {
  owner: number;
  input: KiroDbInput;
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: KiroDbReply | null): void;
  promise: Promise<KiroDbReply | null>;
  worker?: Isolate;
}

function createIsolate(): Isolate {
  return import.meta.url.endsWith(".ts")
    ? new Worker(`const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
      { eval: true, execArgv: [], workerData: { entry: new URL("./kiro-transcript-worker.ts", import.meta.url).href } })
    : new Worker(new URL("./kiro-transcript-worker.js", import.meta.url), { execArgv: [] });
}

/** One active isolate, one queued/in-flight request per source, warm RO handles.
 * A retired isolate stops owning reads immediately, but keeps its physical slot
 * until exit. One spare slot allows recovery from a stuck native call without a
 * worker herd. If both slots are stuck, requests keep their original deadlines.
 */
export class KiroTranscriptLane implements KiroDbLane {
  private worker: Isolate | null = null;
  private physical = new Set<Isolate>();
  private owners = new Set<number>();
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private nextOwner = 0;
  constructor(private factory: () => Isolate = createIsolate, private now = () => performance.now()) {}

  acquire(): KiroDbLease {
    const owner = ++this.nextOwner;
    this.owners.add(owner);
    return {
      read: input => this.read(owner, input),
      close: () => {
        if (!this.owners.delete(owner)) return;
        for (const [id, request] of this.pending) if (request.owner === owner) this.settle(id, null);
        try { this.worker?.postMessage({ close: owner }); } catch { this.recycle(); }
        if (!this.owners.size) this.recycle();
      },
    };
  }
  private settle(id: number, reply: KiroDbReply | null): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    request.resolve(reply);
    if (request.worker && ![...this.pending.values()].some(other => other.worker === request.worker)) request.worker.unref();
  }
  private recycle(worker = this.worker): void {
    if (!worker || this.worker !== worker) return;
    // Detach before settling promises: no continuation or old event may use it.
    this.worker = null;
    for (const [id, request] of this.pending) if (request.worker === worker) this.settle(id, null);
    // Only the exact exit listener releases its physical reservation. Neither
    // a resolved nor a rejected termination promise proves the native call left.
    try { void worker.terminate().catch(() => {}); } catch { /* retain physical reservation */ }
    // Native Worker.terminate() calls ref(); undo it after the attempt so a
    // stuck retiree cannot keep daemon shutdown alive by itself.
    worker.unref();
    this.dispatch();
  }
  private ensureWorker(): Isolate | null {
    if (this.worker) return this.worker;
    if (this.physical.size >= KIRO_TRANSCRIPT_MAX_WORKERS) return null;
    const worker = this.factory();
    this.physical.add(worker);
    this.worker = worker;
    worker.on("message", (message: { id: number; reply: KiroDbReply | null }) => {
      if (this.worker !== worker) return;
      const request = this.pending.get(message.id);
      if (!request || request.worker !== worker) return;
      if (this.now() >= request.deadlineAt) { this.settle(message.id, null); this.recycle(worker); }
      else this.settle(message.id, message.reply);
    });
    worker.on("error", () => this.recycle(worker));
    worker.on("exit", () => {
      if (!this.physical.delete(worker)) return; // late/duplicate exit owns only itself
      if (this.worker === worker) this.worker = null;
      for (const [id, request] of this.pending) if (request.worker === worker) this.settle(id, null);
      this.dispatch();
    });
    worker.unref();
    return worker;
  }
  private dispatch(): void {
    for (const [id, request] of this.pending) {
      if (request.worker) continue;
      if (!this.owners.has(request.owner) || this.now() >= request.deadlineAt) { this.settle(id, null); continue; }
      try {
        const worker = this.ensureWorker();
        if (!worker) return; // physical cap; exit will wake the original queue
        if (this.now() >= request.deadlineAt) { this.settle(id, null); continue; }
        request.worker = worker;
        worker.ref();
        worker.postMessage({ id, owner: request.owner, deadlineAt: request.deadlineAt, input: request.input } satisfies KiroWorkerRequest);
      } catch {
        this.settle(id, null);
        this.recycle();
      }
    }
  }
  private read(owner: number, input: KiroDbInput): Promise<KiroDbReply | null> {
    if (!this.owners.has(owner)) return Promise.resolve(null);
    const existing = [...this.pending.values()].find(request => request.owner === owner);
    if (existing) return existing.promise;
    const id = ++this.nextId, deadlineAt = this.now() + KIRO_TRANSCRIPT_BUDGET_MS;
    let resolve!: Pending["resolve"];
    const promise = new Promise<KiroDbReply | null>(done => { resolve = done; });
    const request: Pending = { owner, deadlineAt, promise, resolve, input, timer: setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.settle(id, null);
      if (request.worker) this.recycle(request.worker);
    }, KIRO_TRANSCRIPT_BUDGET_MS) };
    this.pending.set(id, request);
    this.dispatch();
    return promise;
  }
}
export const sharedKiroTranscriptLane = new KiroTranscriptLane();
