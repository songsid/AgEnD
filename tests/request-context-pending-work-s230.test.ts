import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContextPendingWork } from "../src/request-context-pending-work.js";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { Daemon } from "../src/daemon.js";

const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
it("a timed-out caller cannot settle its actual work or another agent's work", async () => {
  const jobs = new RequestContextPendingWork(), held = deferred<number>();
  const actual = jobs.run("worker", () => held.promise), finishOther = jobs.begin("other");
  await Promise.race([actual, Promise.resolve("caller stopped waiting")]);
  expect(jobs.count("worker")).toBe(1); expect(jobs.count("other")).toBe(1);
  const revision = jobs.revision; finishOther(); finishOther();
  expect(jobs.revision).toBe(revision + 1); expect(jobs.count("worker")).toBe(1);
  held.resolve(7); expect(await actual).toBe(7); expect(jobs.count("worker")).toBe(0);
});
it("synchronous returns/throws stay synchronous, and rejected handlers release their registrations", async () => {
  const jobs = new RequestContextPendingWork();
  expect(jobs.run("worker", () => 3)).toBe(3);
  expect(() => jobs.run("worker", () => { throw Error("sync failure"); })).toThrow("sync failure");
  expect(jobs.count("worker")).toBe(0);
  const held = deferred<never>(), result = jobs.run("worker", () => held.promise);
  const assertion = expect(result).rejects.toThrow("async failure");
  held.reject(Error("async failure")); await assertion; expect(jobs.count("worker")).toBe(0);
});
it("the actual agent endpoint retains legacy/native work after its caller stops waiting", async () => {
  const jobs = new RequestContextPendingWork(), held = deferred<unknown>();
  const ctx: any = { requestContextPendingWork: jobs,
    fleetConfig: { defaults: {}, instances: { worker: { tool_set: "worker" } } },
    logger: { warn() {} }, handleTaskCrudHttp: vi.fn(() => held.promise) };
  const operation = dispatchAgentOperation(ctx, "worker", "task", { action: "list" });
  await Promise.race([operation, Promise.resolve("transport closed")]);
  expect(ctx.handleTaskCrudHttp).toHaveBeenCalledTimes(1); expect(jobs.count("worker")).toBe(1);
  held.resolve({ tasks: [] }); expect(await operation).toEqual({ tasks: [] });
  expect(jobs.count("worker")).toBe(0);
});
it("a local job outliving its daemon response still blocks replacement until the handler settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "pending-work-")); homes.push(root);
  const logger: any = { info() {}, error() {}, warn() {}, debug() {}, child() { return logger; } };
  const daemon = new Daemon("worker", { working_directory: root, backend: "claude-code", log_level: "silent" } as any, root, true, undefined, undefined, logger) as any;
  const held = deferred<void>(), send = vi.fn(() => true);
  daemon.handleCheckoutRepo = vi.fn((_args, respond) => { respond({ ok: true }); return held.promise; });
  daemon.handleToolCall({ tool: "checkout_repo", requestId: 1 }, undefined, { current: () => true, send });
  expect(send).toHaveBeenCalledTimes(1); expect(daemon.requestContextPendingWork.count("worker")).toBe(1);
  held.resolve(); await held.promise; await Promise.resolve();
  expect(daemon.requestContextPendingWork.count("worker")).toBe(0);
});
