/** The actual native process factory must freeze proof before it starts even the owned helper. */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
const calls = vi.hoisted(() => ({ prepare: vi.fn(), spawn: vi.fn() }));
vi.mock("../src/runtime-pane-quota-history.js", () => ({ prepareNativePaneQuotaHistory: calls.prepare }));
vi.mock("../src/child-process.js", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), spawn: calls.spawn }));
import { spawnNativePane } from "../src/runtime-pane-process.js";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); calls.prepare.mockReset(); calls.spawn.mockReset(); });
it("holds physical launch until its pre-resume proof settles, then retains that same frozen proof", async () => {
  vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
  const proof = { messages: ["You've hit your usage limit. Old."], current: () => true };
  let release!: (value: typeof proof) => void; calls.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const stdout = new EventEmitter(), stderr = { resume() {} };
  const stdin = Object.assign(new EventEmitter(), { writable: true, writableLength: 0, write: vi.fn(() => { queueMicrotask(() => stdout.emit("data", Buffer.from('{"type":"ready","pid":12345}\n'))); }) });
  calls.spawn.mockReturnValue(Object.assign(new EventEmitter(), { pid: 12345, stdin, stdout, stderr, kill: vi.fn() }));
  const launch = { paneId: randomUUID(), agentId: randomUUID(), instance: "fixture", launchId: randomUUID(), sessionId: randomUUID(), cli: "codex" as const, cwd: "C:\\scratch", sandbox: "read-only" as const, columns: 80, rows: 24 };
  const pending = spawnNativePane(launch, { directory: "C:\\private-fixture", launchId: launch.launchId });
  expect(calls.prepare).toHaveBeenCalledExactlyOnceWith(launch); expect(calls.spawn).not.toHaveBeenCalled();
  release(proof); const child = await pending; expect(calls.spawn).toHaveBeenCalledOnce(); expect(child.quotaReplay).toBe(proof);
});
