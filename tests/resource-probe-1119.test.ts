import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), execFile: mocks.execFile }));
import { probeDiskUsage } from "../src/resource-report.js";
afterEach(() => mocks.execFile.mockReset());
describe("bounded disk subprocess", () => {
  it("passes the literal path as argv with an async deadline, kill signal and buffer bound", async () => {
    const path = "/tmp/$(literal); workspace";
    mocks.execFile.mockImplementation((file, args, options, callback) => {
      expect(file).toBe("du"); expect(args).toEqual(["-sk", "-x", path]);
      expect(options).toEqual(expect.objectContaining({ timeout: 123, killSignal: "SIGKILL", maxBuffer: 65536, encoding: "utf8" }));
      expect(options.shell).toBeUndefined(); callback(null, "128\t" + path + "\n");
    });
    expect(await probeDiskUsage(path, 123.5)).toBe(128 * 1024);
  });
  it("rejects a partial total on any process error, including timeout", async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error("timeout"), "128\tpartial\n"));
    expect(await probeDiskUsage("/tmp/workspace", 123)).toBeNull();
  });
  it("distinguishes malformed output from a successful zero-byte measurement", async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, "not a size"));
    expect(await probeDiskUsage("/tmp/workspace", 123)).toBeNull();
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, "0\tempty\n"));
    expect(await probeDiskUsage("/tmp/workspace", 123)).toBe(0);
  });
});
