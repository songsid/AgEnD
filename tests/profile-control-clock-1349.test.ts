import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
const fakes = vi.hoisted(() => ({ server: null as any, socket: null as any, accept: null as any, lstat: vi.fn(), chmod: vi.fn(), unlink: vi.fn() }));
vi.mock("node:net", async original => {
  const real = await original<typeof import("node:net")>();
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    destroyed = false; write = vi.fn(); end = vi.fn(() => this.destroy());
    destroy = vi.fn(() => { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; });
  }
  return { ...real, createServer: (accept: unknown) => {
    fakes.accept = accept;
    const server = Object.assign(new EventEmitter(), { listen: vi.fn(), close: vi.fn((callback?: () => void) => { callback?.(); }) });
    fakes.server = server; return server;
  }, createConnection: () => { fakes.socket = new Socket(); return fakes.socket; } };
});
vi.mock("node:fs/promises", () => ({ lstat: fakes.lstat, chmod: fakes.chmod, unlink: fakes.unlink,
  mkdir: vi.fn(async () => {}), open: vi.fn(async () => ({ stat: async () => ({ isDirectory: () => true, uid: process.getuid!() }), chmod: async () => {}, close: async () => {} })) }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
import { ProfileControlServer, requestCpuProfile } from "../src/profile-control.js";
import type { RuntimeCpuProfiler } from "../src/runtime-cpu-profile.js";
let clock = 0;
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
function socket() { return Object.assign(new EventEmitter(), { destroyed: false, write: vi.fn(), end: vi.fn(), destroy: vi.fn() }); }
beforeEach(() => {
  vi.useFakeTimers(); clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
  fakes.server = fakes.socket = fakes.accept = null; fakes.chmod.mockReset().mockResolvedValue(undefined); fakes.unlink.mockReset().mockResolvedValue(undefined); fakes.lstat.mockReset();
  fakes.lstat.mockImplementation(async (path: string) => ({ isDirectory: () => !path.endsWith(".sock"), isSymbolicLink: () => false, isSocket: () => path.endsWith(".sock"), uid: process.getuid!(), mode: 0o700, ino: 123 }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded local profile transport with fake IO/clock", () => {
  it("an expired native listen cannot publish a late listener", async () => {
    const start = vi.fn(); const control = new ProfileControlServer("/private", { start } as unknown as RuntimeCpuProfiler);
    const pending = control.listen(); const assertion = expect(pending).rejects.toThrow("timed out"); await flush();
    const late = fakes.server.listen.mock.calls[0][1];
    clock = 2000; await vi.advanceTimersByTimeAsync(2000); await assertion;
    expect(fakes.server.close).toHaveBeenCalledTimes(1); late(); await flush();
    expect(fakes.server.close).toHaveBeenCalledTimes(2); const peer = socket(); fakes.accept(peer); expect(peer.destroy).toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("input received past the budget cannot start a recording even before its timer fires", async () => {
    const start = vi.fn(); const control = new ProfileControlServer("/private", { start } as unknown as RuntimeCpuProfiler);
    const listening = control.listen(); await flush(); fakes.server.listen.mock.calls[0][1](); await listening;
    const peer = socket(); fakes.accept(peer); clock = 2000; peer.emit("data", Buffer.from('{"seconds":60}\n'));
    expect(peer.destroy).toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); await control.close();
  });
  it("client deadline is monotonic and ignores late connection/response", async () => {
    const a = requestCpuProfile("/private", 1, {}); const assertion = expect(a).rejects.toThrow("deadline"); await flush();
    clock = 21000; fakes.socket.emit("connect"); fakes.socket.emit("data", Buffer.from('{"status":"saved","path":"/private/late","bytes":1}\n')); await assertion; expect(fakes.socket.write).not.toHaveBeenCalled();
    clock = 0; const b = requestCpuProfile("/private", 1, {}); const second = expect(b).rejects.toThrow("deadline"); await flush(); fakes.socket.emit("connect");
    clock = 21000; fakes.socket.emit("data", Buffer.from('{"status":"saved","path":"/private/a","bytes":1}\n')); await second;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a never-answering fleet times out and destroys the client without a second request", async () => {
    const pending = requestCpuProfile("/private", 1, {}); const assertion = expect(pending).rejects.toThrow("timed out"); await flush();
    fakes.socket.emit("connect"); clock = 21000; await vi.advanceTimersByTimeAsync(21000); await assertion;
    expect(fakes.socket.destroy).toHaveBeenCalled(); expect(fakes.socket.write).toHaveBeenCalledTimes(1);
  });
});
