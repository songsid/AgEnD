// S-30 (real Windows acceptance of 2.3.5-alpha): every web-chat turn to a local Windows agent was refused with "Web authorization expired
// before the Windows task started". /ui/send fenced delivery with `!res.destroyed`, the native runtime passed that same
// fence to the bridge, and the bridge rechecks it only after its (asynchronous) transport lookup — when /ui/send has
// already answered and Node has marked the finished response destroyed. These run the real /ui/send handler, the real
// FleetWindowsRuntime, WindowsAgents and WindowsCliBridge, with a launcher held open until the response is gone.
import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/child-process.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/child-process.js")>()), spawn: vi.fn() }));
import { spawn } from "../src/child-process.js";
import { FleetWindowsRuntime } from "../src/fleet-windows-runtime.js";
import { WindowsAgents } from "../src/windows-agents.js";
import { WindowsCliBridge, type WindowsTransport } from "../src/windows-cli.js";
import { nativeInstanceName } from "../src/native-instance-registry.js";
import { nativeProvider } from "../src/windows-cli-providers.js";
import { WebChatHistory } from "../src/web-chat-history.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import type { FleetConfig } from "../src/types.js";

const token = "w".repeat(48), dirs: string[] = [];
/** A response the way Node leaves one: once ended, it is destroyed. */
class NodeLikeRes extends ServerResponse {
  status = 0; body = "";
  override writeHead(status: number): this { this.status = status; return this; }
  override end(value?: unknown): this { this.body += String(value ?? ""); this.destroy(); this.emit("capture:end"); return this; }
}
async function send(ctx: WebApiContext, body: unknown) {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method = "POST"; req.url = "/ui/send"; req.headers = { host: "localhost", "x-agend-token": token };
  const res = new NodeLikeRes(req), ended = new Promise<void>(done => res.once("capture:end", () => done()));
  expect(handleWebRequest(req, res, new URL("/ui/send", "http://localhost"), ctx)).toBe(true); await ended;
  expect(res.destroyed).toBe(true);
  return { status: res.status, body: JSON.parse(res.body) };
}
class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kill = vi.fn();
  emitLine(value: unknown) { this.stdout.write(JSON.stringify(value) + "\n"); }
}
let child: FakeChild;
beforeEach(() => { vi.stubEnv("AGEND_WINDOWS_CLI", "1"); vi.clearAllMocks(); child = new FakeChild(); vi.mocked(spawn).mockReturnValue(child as never); });
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) { if (!resolve(dir).startsWith(resolve(tmpdir()))) throw Error("unsafe"); rmSync(dir, { recursive: true, force: true }); } });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-s30-chat-")); dirs.push(dir);
  const inventory = join(dir, "windows-cli-inventory.json");
  writeFileSync(inventory, JSON.stringify({ home: "C:\\Users\\Test", probedAt: 1, clis: [{ id: "codex", path: "C:\\codex.exe", version: "1.0",
    authenticated: true, runnable: true, readOnlySupport: true, supports: nativeProvider("codex").supports, models: [] }] }));
  let release!: () => void;
  const launched = new Promise<void>(done => { release = done; });
  const launcher = vi.fn(async (): Promise<WindowsTransport> => { await launched; return { executable: "/native/node.exe", args: ["C:\\AgEnD\\worker.js"] }; });
  const bridge = new WindowsCliBridge(launcher, inventory);
  const store = new WindowsAgents(dir, bridge), profile = await store.create({ name: "Acceptance", cwd: "C:\\Users\\Test\\scratch", cli: "codex", sandbox: "read-only" });
  const fleet: FleetConfig = { defaults: {}, instances: {} };
  const history = new WebChatHistory();
  const host = { owner: { dataDir: dir }, fleet: () => fleet, save: vi.fn(), emit: (event: string, data: any) => { if (event === "message") history.record(data); }, stopping: () => false, history };
  const runtime = new FleetWindowsRuntime(host, { store, bridge }); runtime.register();
  const name = nativeInstanceName(profile.id);
  expect(fleet.instances[name]?.runtime).toBe("windows");
  const ctx = { webToken: token, dataDir: dir, fleetConfig: fleet, instanceIpcClients: new Map(), daemons: new Map(), sseClients: new Set(), adapter: null, eventLog: null,
    logger: { info() {}, debug() {}, warn() {}, error() {} }, lastInboundUser: new Map(), webChatHistory: history,
    getUiStatus: () => ({ instances: [] }), emitSseEvent: () => {}, getInstanceDir: () => dir, getInstanceStatus: () => runtime.status(name),
    nativeInstanceRuntime: () => runtime,
    // The fleet's facade, as FleetManager.deliverToInstance forwards a Windows instance's delivery.
    deliverToInstance: async (n: string, payload: Record<string, unknown>, options: any) => runtime.deliver(n, payload,
      { stillCurrent: options?.stillCurrent, ...(options?.authorityCurrent ? { authorityCurrent: options.authorityCurrent } : {}) }),
    lifecycle: { handleCreate: vi.fn() }, saveFleetConfig: vi.fn() } as unknown as WebApiContext;
  const turn = () => store.get(profile.id).turns.at(-1);
  return { ctx, fleet, name, release, launcher, bridge, store, profile, history, turn };
}

describe("S-30: a web-chat turn to a local Windows agent starts after /ui/send has answered", () => {
  it("the turn runs once the transport lookup finishes, after the response is gone, and its reply reaches the chat", async () => {
    const f = await fixture();
    const sent = await send(f.ctx, { instance: f.name, message: "List the files here", clientId: "acceptance-client-01" });
    expect(sent).toMatchObject({ status: 200, body: { sent: true } });
    expect(spawn).not.toHaveBeenCalled();                                   // still looking up the transport
    f.release();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(f.turn()?.error).toBeUndefined();
    child.emitLine({ type: "started" });
    child.emitLine({ type: "stdout", text: JSON.stringify({ type: "thread.started", thread_id: f.profile.id }) + "\n"
      + JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "two files" } }) + "\n" + JSON.stringify({ type: "turn.completed" }) + "\n" });
    child.emitLine({ type: "finished", code: 0 }); child.emit("close", 0);
    await vi.waitFor(() => expect(f.turn()).toMatchObject({ status: "completed", output: "two files\n" }));
    expect(f.history.list(f.name, 10).map(m => m.text)).toContain("two files\n");          // the agent's reply in the chat
  });

  it("a revoke between the journal and the spawn still stops it: nothing starts, the turn says why", async () => {
    const f = await fixture();
    expect((await send(f.ctx, { instance: f.name, message: "Do not run me", clientId: "acceptance-client-02" })).body.sent).toBe(true);
    (f.ctx as { webToken: string }).webToken = "r".repeat(48);              // the admin's access is revoked / rotated
    f.release();
    await vi.waitFor(() => expect(f.turn()).toMatchObject({ status: "failed", error: "Web authorization expired before the Windows task started" }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("an instance removed (no longer a Windows instance) before the spawn does not start either", async () => {
    const f = await fixture();
    expect((await send(f.ctx, { instance: f.name, message: "Removed meanwhile", clientId: "acceptance-client-03" })).body.sent).toBe(true);
    delete f.fleet.instances[f.name];
    f.release();
    await vi.waitFor(() => expect(f.turn()?.status).toBe("failed"));
    expect(spawn).not.toHaveBeenCalled();
  });
});
