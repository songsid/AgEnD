import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFleetProcessHandlers } from "../src/fleet-process-handlers.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-fatal-test-"));
  directories.push(dataDir);
  const events = new Map<string, (...args: any[]) => any>();
  const runtime = { on: (event: string, handler: (...args: any[]) => any) => events.set(event, handler), exit: vi.fn() };
  const manager = { stopAll: vi.fn(async () => {}), notifyFleetError: vi.fn(), noteRequestedShutdown: vi.fn() };
  const output = { log: vi.fn(), error: vi.fn() };
  const state = installFleetProcessHandlers({ dataDir, runtime: runtime as any, manager, console: output, describeSignal: () => "test SIGTERM" });
  return { dataDir, events, runtime, manager, output, state };
}

describe("fleet process errors (#2191)", () => {
  it("persists the fatal reason and stack before stopping, then exits 1", async () => {
    const h = harness();
    const failure = new Error("Opening handshake has timed out");
    let beforeStop: unknown;
    h.manager.stopAll.mockImplementation(async () => {
      beforeStop = JSON.parse(readFileSync(join(h.dataDir, "fleet-fatal.log"), "utf8"));
    });
    await h.events.get("uncaughtException")!(failure);
    expect(beforeStop).toMatchObject({ pid: process.pid, reason: "uncaughtException", error: String(failure), stack: failure.stack });
    expect(h.manager.stopAll).toHaveBeenCalledTimes(1);
    expect(h.runtime.exit).toHaveBeenCalledWith(1);
    expect(h.manager.noteRequestedShutdown).not.toHaveBeenCalled();
  });

  it("records a signal shutdown request only after a successful stop, never a failed stop", async () => {
    const h = harness(); let release!: () => void;
    h.manager.stopAll.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const stopping = h.events.get("SIGTERM")!();
    expect(h.manager.noteRequestedShutdown).not.toHaveBeenCalled();
    release(); await stopping; expect(h.manager.noteRequestedShutdown).toHaveBeenCalledOnce();
    const failed = harness(); failed.manager.stopAll.mockRejectedValue(new Error("inert stop failure"));
    await failed.events.get("SIGTERM")!();
    expect(failed.manager.noteRequestedShutdown).not.toHaveBeenCalled();
  });

  it("keeps rejected network work local and reports it without stopping the fleet", () => {
    const h = harness();
    h.events.get("unhandledRejection")!(new Error("connect ETIMEDOUT"));
    expect(h.manager.notifyFleetError).toHaveBeenCalledWith(expect.stringContaining("connect ETIMEDOUT"));
    expect(h.manager.stopAll).not.toHaveBeenCalled();
    expect(h.runtime.exit).not.toHaveBeenCalled();
    expect(h.state.stopping).toBe(false);
  });

  it("coalesces fatal and signal shutdowns while stopAll drains", async () => {
    const h = harness();
    let resolve!: () => void;
    h.manager.stopAll.mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    const fatal = h.events.get("uncaughtException")!(new Error("unknown state"));
    await h.events.get("SIGINT")!();
    await h.events.get("SIGTERM")!();
    expect(h.manager.stopAll).toHaveBeenCalledTimes(1);
    expect(h.state.stopping).toBe(true);
    resolve();
    await fatal;
    expect(h.runtime.exit).toHaveBeenCalledTimes(1);
    expect(h.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("installs the same policy before startAll in the fleet start callback", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const parsed = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true);
    const callbacks: ts.ArrowFunction[] = [];
    function walk(node: ts.Node) {
      if (ts.isArrowFunction(node) && node.getText(parsed).includes("installFleetProcessHandlers({")) callbacks.push(node);
      ts.forEachChild(node, walk);
    }
    walk(parsed);
    // #2356: `fleet start` is the only in-process start; the `fleet restart --reload` takeover is gone.
    expect(callbacks).toHaveLength(1);
    for (const callback of callbacks) {
      const body = callback.getText(parsed);
      expect(body.indexOf("installFleetProcessHandlers({")).toBeLessThan(body.indexOf("await fm.startAll("));
      expect(body).not.toContain('process.on("unhandledRejection"');
      expect(body).not.toContain('process.on("uncaughtException"');
    }
  });
});
