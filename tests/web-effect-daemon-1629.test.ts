import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
const hook = vi.hoisted(() => ({ afterRead: null as null | (() => Promise<void>) }));
vi.mock("../src/web-effect-upload.js", async original => {
  const real = await original<typeof import("../src/web-effect-upload.js")>();
  return { ...real, readAgentEffect: async (...args: Parameters<typeof real.readAgentEffect>) => {
    const result = await real.readAgentEffect(...args); if (hook.afterRead) await hook.afterRead(); return result;
  } };
});
import { EffectUploads } from "../src/web-effect-upload.js";
const roots: string[] = [];
afterEach(() => { hook.afterRead = null; vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function deferred() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function fixture(code = "agend.ready()", classic = false) {
  const parent = join(process.cwd(), ".artifacts"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "effect-daemon-")); roots.push(root);
  const state = join(root, "state"), workspace = classic ? join(state, "workspaces/own") : join(root, "workspace"), dir = join(workspace, "effect");
  mkdirSync(dir, { recursive: true }); mkdirSync(state, { recursive: true }); vi.stubEnv("AGEND_HOME", state);
  writeFileSync(join(dir, "effect.json"), JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["chat"], layer: "behind", wants: [] }));
  writeFileSync(join(dir, "worker.js"), code);
  const { Daemon } = await import("../src/daemon.js");
  const daemon = new Daemon("own", { working_directory: workspace, log_level: "error", restart_policy: { max_retries: 1, backoff: "exponential", reset_after: 300 }, context_guardian: { max_age_hours: 4, grace_period_ms: 600000 } } as never, join(state, "own"), true, undefined, undefined, pino({ level: "silent" }) as never) as any;
  // No lifecycle/spawn handler is invoked; transport and files are the only real boundaries in this fixture.
  vi.spyOn(daemon, "start").mockRejectedValue(Error("test must not start a daemon"));
  const send = vi.fn((_socket: unknown, _msg: unknown) => true), chunks: Array<Record<string, any>> = [], uploads = new EffectUploads();
  const broadcast = vi.fn((msg: Record<string, any>) => {
    chunks.push(msg);
    const result = uploads.accept("own", msg.payload, files => ({ id: "a".repeat(32), files: [...files.keys()] }));
    daemon.routeFleetResponse({ type: "fleet_web_theme_response", fleetRequestId: msg.fleetRequestId, result });
  });
  daemon.ipcServer = { send, broadcast };
  const call = (args: unknown = { dir: "effect" }) => daemon.handleToolCall({ tool: "upload_web_effect", args, requestId: 17 }, {} as never);
  return { root, dir, daemon, send, broadcast, chunks, call };
}
describe("#1629 daemon's owned effect upload", () => {
  it("reads and validates in the agent workspace, sends normalized bytes without paths and answers once", async () => {
    const f = await fixture("x".repeat(700000)); f.call();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.chunks.length).toBeGreaterThan(1);
    expect(f.chunks.every(m => m.type === "fleet_upload_web_effect" && m.meta.instance_name === "own" && !Object.hasOwn(m.payload, "dir") && !Object.hasOwn(m.payload, "instance"))).toBe(true);
    expect(f.send.mock.calls[0]![1]).toMatchObject({ requestId: 17, result: { id: "a".repeat(32), files: expect.arrayContaining(["effect.json", "worker.js"]) } });
    expect(f.daemon.pendingIpcRequests.size).toBe(0);
    expect(f.daemon.start).not.toHaveBeenCalled();
  });
  it.each([false, true])("#2025: owned state workspace effect, absolute=%s", async absolute => {
    const f = await fixture("agend.ready()", true); f.call({ dir: absolute ? f.dir : "effect", instance: "other" });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.send.mock.calls[0]![1]).toMatchObject({ result: { id: "a".repeat(32) } });
    expect(f.broadcast).toHaveBeenCalledOnce(); expect(f.chunks[0]!.meta.instance_name).toBe("own");
  });
  it.each(["launchFenceEpoch", "spawnGeneration", "bootId", "ipcServer", "deliveryWritesStopping", "startupAborted"])("revokes %s during the real directory read before any upload part", async field => {
    const f = await fixture(), held = deferred(), entered = deferred();
    hook.afterRead = async () => { entered.release(); await held.promise; };
    f.call(); await entered.promise;
    if (field === "ipcServer") f.daemon.ipcServer = { send: f.send, broadcast: f.broadcast };
    else if (field === "bootId") f.daemon.bootId = "replacement";
    else if (field === "deliveryWritesStopping" || field === "startupAborted") f.daemon[field] = true;
    else f.daemon[field]++;
    held.release();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.send.mock.calls[0]![1]).toMatchObject({ requestId: 17, error: "upload_web_effect: launch no longer current" });
    expect(f.broadcast).not.toHaveBeenCalled(); expect(f.daemon.start).not.toHaveBeenCalled();
  });
  it("rechecks the owner between acknowledged parts and never uploads the remainder into a replacement launch", async () => {
    const f = await fixture("x".repeat(700000));
    const original = f.broadcast.getMockImplementation()!;
    f.broadcast.mockImplementation(msg => { original(msg); f.daemon.launchFenceEpoch++; });
    f.call(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.broadcast).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]![1]).toMatchObject({ error: "upload_web_effect: launch no longer current" });
    expect(f.daemon.pendingIpcRequests.size).toBe(0);
  });
  it("refuses an already stopped owner before reading or broadcasting", async () => {
    const f = await fixture(); f.daemon.deliveryWritesStopping = true; f.call();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.send.mock.calls[0]![1]).toMatchObject({ error: "upload_web_effect: launch no longer current" });
  });
  it.each([{}, { dir: "/outside/workspace" }, { dir: { toString: null } }])("rejects bad directory %s without a fleet call", async args => {
    const f = await fixture(); f.call(args);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce()); expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.send.mock.calls[0]![1]).toMatchObject({ requestId: 17, error: expect.stringContaining("upload_web_effect:") });
  });
});
