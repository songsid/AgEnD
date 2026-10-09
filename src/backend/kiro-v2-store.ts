import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

export const KIRO_V2_STORE_BUDGET_MS = 15_000;
export const KIRO_V2_STORE_QUEUE_LIMIT = 64;
export interface KiroV2StoreInput { keys: string[]; sessionsDir: string; }
export type KiroV2StoreReply = { kind: "ok"; sessions: Array<{ id: string; updatedAt: number; createdAt: number | null }>; diagnostics: { reads: number; hits: number } }
  | { kind: "unreadable"; detail: string };
export interface KiroV2StoreRequest { id: number; deadlineAt: number; input: KiroV2StoreInput; }
interface Isolate {
  on(event: "message" | "error" | "exit", listener: (...args: any[]) => void): unknown;
  postMessage(value: unknown): void; terminate(): Promise<number>; ref(): unknown; unref(): unknown;
}
const unreadable = (detail: string): KiroV2StoreReply => ({ kind: "unreadable", detail });
function createIsolate(): Isolate {
  return import.meta.url.endsWith(".ts")
    ? new Worker(`const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
      { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 }, workerData: { entry: new URL("./kiro-v2-store-worker.ts", import.meta.url).href } })
    : new Worker(new URL("./kiro-v2-store-worker.js", import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
}

/** One warm physical worker. Total budgets include queue/retirement; never
 * replace a retired worker until exit proves that its physical slot is free.
 * Only metadata crosses back to the fleet; JSON bodies stay in the worker.
 */
export class KiroV2StoreLane {
  private worker: Isolate | null = null;
  private retiring = false;
  private nextId = 0;
  private pending = new Map<number, { deadlineAt: number; input: KiroV2StoreInput; sent: boolean;
    timer: ReturnType<typeof setTimeout>; resolve(reply: KiroV2StoreReply): void }>();
  constructor(private factory = createIsolate, private now = () => performance.now()) {}

  read(input: KiroV2StoreInput): Promise<KiroV2StoreReply> {
    if (this.pending.size >= KIRO_V2_STORE_QUEUE_LIMIT) return Promise.resolve(unreadable("v2 session discovery queue full"));
    const id = ++this.nextId, deadlineAt = this.now() + KIRO_V2_STORE_BUDGET_MS;
    const promise = new Promise<KiroV2StoreReply>(resolve => {
      this.pending.set(id, { input, deadlineAt, sent: false, resolve, timer: setTimeout(() => {
        this.settle(id, unreadable("v2 session discovery timed out")); this.retire();
      }, KIRO_V2_STORE_BUDGET_MS) });
    });
    this.pump();
    return promise;
  }
  close(): void {
    for (const id of this.pending.keys()) this.settle(id, unreadable("v2 session discovery closed"));
    this.retire();
  }
  private settle(id: number, reply: KiroV2StoreReply): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id); clearTimeout(request.timer); request.resolve(reply);
    if (!this.pending.size) this.worker?.unref();
  }
  private retire(): void {
    if (!this.worker || this.retiring) return;
    this.retiring = true;
    for (const [id, request] of this.pending) if (request.sent) this.settle(id, unreadable("v2 session discovery worker retired"));
    try { void this.worker.terminate().catch(() => {}); } catch { /* retain physical slot until exit */ }
  }
  private pump(): void {
    if (this.retiring || !this.pending.size) return;
    for (const [id, request] of this.pending) {
      if (this.now() >= request.deadlineAt) this.settle(id, unreadable("v2 session discovery timed out"));
    }
    if (!this.pending.size) return;
    if (!this.worker) {
      try {
        const worker = this.factory(); this.worker = worker;
        worker.on("message", (message: { id: number; reply: KiroV2StoreReply }) => {
          if (this.worker !== worker || this.retiring) return;
          const request = this.pending.get(message.id);
          if (!request) return;
          if (this.now() >= request.deadlineAt) {
            this.settle(message.id, unreadable("v2 session discovery timed out")); this.retire();
          } else this.settle(message.id, message.reply);
        });
        worker.on("error", () => { if (this.worker === worker) this.retire(); });
        worker.on("exit", () => {
          if (this.worker !== worker) return;
          this.worker = null; this.retiring = false;
          for (const [id, request] of this.pending) if (request.sent) this.settle(id, unreadable("v2 session discovery worker exited"));
          this.pump();
        });
      } catch {
        for (const id of this.pending.keys()) this.settle(id, unreadable("cannot start v2 session discovery worker"));
        return;
      }
    }
    for (const [id, request] of this.pending) {
      if (request.sent) continue;
      if (this.now() >= request.deadlineAt) { this.settle(id, unreadable("v2 session discovery timed out")); continue; }
      try {
        request.sent = true; this.worker!.ref();
        this.worker!.postMessage({ id, deadlineAt: request.deadlineAt, input: request.input } satisfies KiroV2StoreRequest);
      } catch { this.retire(); break; }
    }
  }
}
export const sharedKiroV2StoreLane = new KiroV2StoreLane();
