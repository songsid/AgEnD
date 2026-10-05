import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: mocks.execFile }));
import { runMemoryCommand } from "../src/darwin-memory.js";
afterEach(() => mocks.execFile.mockReset());
describe("native metric command boundary", () => {
  it("uses async argv-only fixed commands, C locale and bounded output/time", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }); let callback!: Function;
    mocks.execFile.mockImplementation((_file, _args, _options, cb) => { callback = cb; return child; });
    const command = runMemoryCommand("/usr/sbin/sysctl", ["vm.swapusage"]);
    // Assert outside the production catch: a mutant must fail this assertion,
    // rather than swallowing the mock's assertion as a constructor failure.
    const [file, args, options] = mocks.execFile.mock.calls[0];
    expect(file).toBe("/usr/sbin/sysctl"); expect(args).toEqual(["vm.swapusage"]);
    expect(options).toMatchObject({ encoding: "utf8", timeout: 1500, killSignal: "SIGKILL", maxBuffer: 32768, env: expect.objectContaining({ LC_ALL: "C", LANG: "C" }) });
    expect(options.shell).toBeUndefined();
    const closed = vi.fn(); void command.stopped.then(closed);
    callback(null, "snapshot"); expect(await command.result).toBe("snapshot");
    command.kill(); expect(child.kill).toHaveBeenCalledWith("SIGKILL"); expect(closed).not.toHaveBeenCalled();
    child.emit("close"); await command.stopped; expect(closed).toHaveBeenCalledOnce();
  });
  it("failed callback or kill does not falsely report child close", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => { throw new Error("kill failed"); }) }); let callback!: Function;
    mocks.execFile.mockImplementation((_file, _args, _options, cb) => { callback = cb; return child; });
    const command = runMemoryCommand("/usr/bin/vm_stat", []); const closed = vi.fn(); void command.stopped.then(closed);
    callback(new Error("timeout"), "partial"); expect(await command.result).toBeNull();
    expect(() => command.kill()).not.toThrow(); expect(closed).not.toHaveBeenCalled();
    child.emit("error", new Error("spawn/exit error")); expect(closed).not.toHaveBeenCalled();
    child.emit("close"); await command.stopped; expect(closed).toHaveBeenCalledOnce();
  });
  it("synchronous constructor failure is a settled unknown with no live reservation", async () => {
    mocks.execFile.mockImplementation(() => { throw new Error("ENOENT"); });
    const command = runMemoryCommand("/usr/bin/vm_stat", []);
    expect(await command.result).toBeNull(); await command.stopped;
    expect(() => command.kill()).not.toThrow();
  });
});
