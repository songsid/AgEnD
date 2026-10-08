import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import type { KiroDbCursor } from "./kiro-db-reader.js";
import type { TranscriptEvents } from "./transcript-sources.js";

export const KIRO_TRANSCRIPT_BUDGET_MS = 15_000;
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

/** One physical isolate, one queued/in-flight request per source, warm RO handles.
 * Queue time counts toward the total budget. Termination does not release the
 * physical slot until exit: a stalled native read never creates a worker herd.
 */
export class KiroTranscriptLane implements KiroDbLane {
  private worker: Isolate | null = null;
  private exiting: Promise<void> | null = null;
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
    if (!this.pending.size) this.worker?.unref();
  }
  private recycle(): void {
    const worker = this.worker;
    if (!worker || this.exiting) return;
    for (const id of this.pending.keys()) this.settle(id, null);
    // The exit listener owns release; a rejected termination keeps the slot.
    this.exiting = new Promise<void>(resolve => worker.on("exit", resolve));
    try { void worker.terminate().catch(() => {}); } catch { /* retain physical reservation */ }
  }
  private ensureWorker(): Isolate {
    if (this.worker) return this.worker;
    const worker = this.factory();
    this.worker = worker;
    worker.on("message", (message: { id: number; reply: KiroDbReply | null }) => {
      if (this.worker !== worker || this.exiting) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      if (this.now() >= request.deadlineAt) { this.settle(message.id, null); this.recycle(); }
      else this.settle(message.id, message.reply);
    });
    worker.on("error", () => { if (this.worker === worker) this.recycle(); });
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.exiting = null;
      for (const [id, request] of this.pending) if (request.worker === worker) this.settle(id, null);
    });
    worker.unref();
    return worker;
  }
  private read(owner: number, input: KiroDbInput): Promise<KiroDbReply | null> {
    if (!this.owners.has(owner)) return Promise.resolve(null);
    const existing = [...this.pending.values()].find(request => request.owner === owner);
    if (existing) return existing.promise;
    const id = ++this.nextId, deadlineAt = this.now() + KIRO_TRANSCRIPT_BUDGET_MS;
    let resolve!: Pending["resolve"];
    const promise = new Promise<KiroDbReply | null>(done => { resolve = done; });
    const request: Pending = { owner, deadlineAt, promise, resolve, timer: setTimeout(() => {
      this.settle(id, null); this.recycle();
    }, KIRO_TRANSCRIPT_BUDGET_MS) };
    this.pending.set(id, request);
    void (async () => {
      if (this.exiting) await this.exiting;
      if (!this.pending.has(id) || !this.owners.has(owner)) return;
      if (this.now() >= deadlineAt) { this.settle(id, null); return; }
      try { const worker = this.ensureWorker(); request.worker = worker; worker.ref(); worker.postMessage({ id, owner, deadlineAt, input } satisfies KiroWorkerRequest); }
      catch { this.settle(id, null); this.recycle(); }
    })();
    return promise;
  }
}
export const sharedKiroTranscriptLane = new KiroTranscriptLane();
