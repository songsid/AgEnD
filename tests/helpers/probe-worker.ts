import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { BackendProbeInput, BackendProbeResult } from "../../src/backend/cli-env-probe.js";

/** No isolate, CLI, backend construction or lifecycle effects in parent tests. */
export class FakeProbeWorker extends EventEmitter {
  static workers: FakeProbeWorker[] = [];
  static answer: ((input: BackendProbeInput) => unknown) | undefined;
  static constructionError: Error | undefined;
  private disposed = false;
  readonly exited: Promise<void>;
  readonly input: BackendProbeInput;
  terminate = vi.fn<() => Promise<number>>().mockResolvedValue(0);

  constructor(_entry: unknown, readonly options: { workerData: BackendProbeInput }) {
    super();
    if (FakeProbeWorker.constructionError) throw FakeProbeWorker.constructionError;
    this.exited = new Promise(resolve => this.once("exit", () => resolve()));
    this.input = options.workerData;
    FakeProbeWorker.workers.push(this);
    if (FakeProbeWorker.answer) {
      try {
        const answer = FakeProbeWorker.answer(this.input);
        void Promise.resolve(answer).then(
          result => this.send({ ok: true, result }),
          error => this.send({ ok: false, error: String(error) }),
        );
      } catch (error) {
        queueMicrotask(() => this.send({ ok: false, error: String(error) }));
      }
    }
  }

  private send(message: unknown): void { if (!this.disposed) this.emit("message", message); }
  reply(result: BackendProbeResult | null): void { this.send({ ok: true, result }); }
  /** Shared teardown fences callbacks whose fake answer promise outlives the test. */
  dispose(): void { this.disposed = true; this.removeAllListeners(); }
  static reset(): void {
    this.workers = [];
    this.answer = undefined;
    this.constructionError = undefined;
  }
}

export function fakeProbeLogger() {
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
  logger.child = () => logger;
  return logger;
}
