import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/child-process.js", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
import { spawn } from "../src/child-process.js";
import { WindowsCliBridge } from "../src/windows-cli.js";

class Child extends EventEmitter { stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kill = vi.fn(); }
beforeEach(() => vi.clearAllMocks());
describe("standalone runtime shutdown owns discovery workers", () => {
  it("cancels an in-flight discovery child and rejects the waiting request", async () => {
    const child = new Child(); vi.mocked(spawn).mockReturnValue(child as never);
    const bridge = new WindowsCliBridge(async () => ({ executable: "/fixture/node", args: ["fixture-worker.js"] }));
    const pending = bridge.probe({force:true}), rejected = expect(pending).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce()); bridge.close(); await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it("does not start discovery after shutdown races with transport resolution", async () => {
    let ready!: (value: { executable: string; args: string[] }) => void;
    const bridge = new WindowsCliBridge(() => new Promise(resolve => { ready = resolve; }));
    const pending = bridge.probe({force:true}), rejected = expect(pending).rejects.toThrow(/cancelled/);
    bridge.close(); ready({ executable: "/fixture/node", args: ["fixture-worker.js"] }); await rejected;
    expect(spawn).not.toHaveBeenCalled();
  });
});
