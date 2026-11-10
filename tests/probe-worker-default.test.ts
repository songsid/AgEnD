import { MessageChannel, Worker, threadId } from "node:worker_threads";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeProbeWorker } from "./helpers/probe-worker.js";
import { drainProbeWorkers, useRealProbeWorkers } from "./support/probe-worker-default.js";
import { processGuard } from "./support/process-guard.js";
import { FleetManager } from "../src/fleet-manager.js";

const roots: string[] = [];
const inert = "require('node:worker_threads').parentPort.postMessage({real:true})";
const input = { mode: "env", backend: "codex", instanceDir: "/unused", config: {}, refreshVendorCatalog: false };
function compiledEntry() {
  const root = mkdtempSync(join(tmpdir(), "agend-default-probe-")); roots.push(root);
  mkdirSync(join(root, "backend"));
  const entry = join(root, "backend", "cli-env-probe-worker.js");
  writeFileSync(entry, inert);
  return pathToFileURL(entry);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("shared model-probe Worker default", () => {
  it.each(["compiled", "tsx"])("fakes %s probe workers without a suite-local mock", async shape => {
    const entry = compiledEntry();
    const worker = shape === "compiled" ? new Worker(entry, { execArgv: [], workerData: input })
      : new Worker(inert, { eval: true, execArgv: [], workerData: { ...input, entry: entry.href.replace(/\.js$/, ".ts") } });
    worker.on("error", () => {});
    try {
      expect(worker).toBeInstanceOf(FakeProbeWorker);
      expect(await new Promise(resolve => worker.once("message", resolve))).toEqual({ ok: true, result: null });
    } finally { await worker.terminate(); }
  });

  it("leaves unrelated Workers real", async () => {
    const worker = new Worker(inert, { eval: true, execArgv: [] });
    try {
      expect(worker).not.toBeInstanceOf(FakeProbeWorker);
      expect(await new Promise(resolve => worker.once("message", resolve))).toEqual({ real: true });
    } finally { await worker.terminate(); }
  });

  it("keeps the same TS bootstrap real when its entry is another Worker kind", async () => {
    const worker = new Worker(inert, { eval: true, execArgv: [], workerData: { entry: "file:///unused/backend/kiro-v2-store-worker.ts" } });
    try {
      expect(worker).not.toBeInstanceOf(FakeProbeWorker);
      expect(await new Promise(resolve => worker.once("message", resolve))).toEqual({ real: true });
    } finally { await worker.terminate(); }
    const native = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
    expect(MessageChannel).toBe(native.MessageChannel);
    expect(threadId).toBe(native.threadId);
  });

  it("opts in to real probe Workers for this test only", async () => {
    useRealProbeWorkers();
    const worker = new Worker(compiledEntry(), { execArgv: [], workerData: input });
    try {
      expect(worker).not.toBeInstanceOf(FakeProbeWorker);
      expect(await new Promise(resolve => worker.once("message", resolve))).toEqual({ real: true });
    } finally { await worker.terminate(); }
    // Deliberately leave the opt-in set: the following test proves the shared reset.
    FakeProbeWorker.answer = () => { throw new Error("must not carry to the next test"); };
    FakeProbeWorker.constructionError = new Error("must not carry");
  });

  it("resets opt-in, answers, errors and worker history before the next test", async () => {
    expect(FakeProbeWorker.workers).toEqual([]);
    expect(FakeProbeWorker.constructionError).toBeUndefined();
    const worker = new Worker(compiledEntry(), { execArgv: [], workerData: input });
    expect(worker).toBeInstanceOf(FakeProbeWorker);
    expect(await new Promise(resolve => worker.once("message", resolve))).toEqual({ ok: true, result: null });
    // Leave this fake owned: shared teardown must terminate it.
  });

  it("keeps the real process guard on after explicit probe opt-in", async () => {
    useRealProbeWorkers();
    const entry = compiledEntry();
    const cli = join(roots.at(-1)!, "codex"), marker = `${cli}.started`;
    writeFileSync(cli, `#!/bin/sh\nprintf started > '${marker}'\n`); chmodSync(cli, 0o700);
    writeFileSync(entry, `const {parentPort}=require('node:worker_threads'); try { require('node:child_process').execFileSync(${JSON.stringify(cli)}); } catch(e) { parentPort.postMessage(e.message); }`);
    const worker = new Worker(entry, { execArgv: [], env: { ...process.env, NODE_OPTIONS: "" }, workerData: input });
    try {
      expect(worker).not.toBeInstanceOf(FakeProbeWorker);
      expect(await new Promise(resolve => worker.once("message", resolve))).toContain("real backend CLI forbidden");
      expect(existsSync(marker)).toBe(false);
      expect(processGuard.takeViolations()).toEqual([expect.stringContaining("real backend CLI forbidden")]);
    } finally { await worker.terminate(); }
  });

  it("drains the acknowledged fake stop and fences late answer callbacks", async () => {
    let answer!: (value: unknown) => void, stopped!: () => void;
    FakeProbeWorker.answer = () => new Promise(resolve => { answer = resolve; });
    const worker = new Worker(compiledEntry(), { execArgv: [], workerData: input }) as unknown as FakeProbeWorker;
    const messages = vi.fn(); worker.on("message", messages);
    worker.terminate.mockImplementation(() => new Promise<number>(resolve => { stopped = () => resolve(0); }));
    let done = false;
    const drain = drainProbeWorkers().then(() => { done = true; });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(done).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
    stopped(); await drain;
    expect(done).toBe(true);
    messages.mockClear();
    worker.on("message", messages); // even a retained listener cannot observe the prior answer
    answer("late"); await Promise.resolve(); await Promise.resolve();
    expect(messages).not.toHaveBeenCalled();
  });

  it("settles real FleetManager save-triggered discovery without a local Worker mock", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-default-save-")); roots.push(root);
    const fm = new FleetManager(root) as any;
    const path = join(root, "fleet.yaml");
    writeFileSync(path, 'defaults:\n  backend: codex\ninstances:\n  dev:\n    backend: codex\n');
    fm.loadConfig(path);
    try {
      delete fm.fleetConfig.instances.dev; fm.saveFleetConfig();
      fm.fleetConfig.instances.dev = { backend: "codex" }; fm.saveFleetConfig();
      await Promise.all([...fm.pendingCliEnvProbes.values(), ...fm.webModelRefreshes.values()]);
      expect(FakeProbeWorker.workers.length).toBeGreaterThan(0);
      expect(FakeProbeWorker.workers.every(w => w.input.backend === "codex")).toBe(true);
      expect(fm.pendingCliEnvProbes.size).toBe(0);
      expect(fm.webModelRefreshes.size).toBe(0);
      expect(FakeProbeWorker.workers.every(w => w.terminate.mock.calls.length === 1)).toBe(true);
    } finally { fm.stopCliEnvProbes(); }
  });
});
