/** Exercise the real MCP registration with inert SDK/IPC boundaries: no CLI, socket or fleet is started. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_WORKER_EXPERIMENTAL_MESSAGE } from "../src/web-experimental.js";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (request: any) => Promise<any>>(),
  options: null as any,
  notifications: vi.fn(async () => {}),
  sent: [] as Array<Record<string, unknown>>,
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
  constructor(_info: unknown, options: unknown) { state.options = options; }
  setRequestHandler(schema: any, fn: (request: any) => Promise<any>) { state.handlers.set(schema.shape.method.value, fn); }
  async connect() {}
  sendToolListChanged() { return state.notifications(); }
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../src/channel/ipc-bridge.js", async () => {
  const { EventEmitter } = await import("node:events");
  return { IpcClient: class extends EventEmitter {
    async connect() {}
    async close() {}
    send(message: Record<string, unknown>) {
      state.sent.push(message);
      if (message.type === "tool_call") queueMicrotask(() => this.emit("message", { requestId: message.requestId, result: { ok: true, tool: message.tool } }));
      return true;
    }
  } };
});

let home: string | undefined;
const ownedListeners: Array<[NodeJS.EventEmitter, string | symbol, (...args: any[]) => void]> = [];
afterEach(() => {
  for (const [emitter, event, listener] of ownedListeners.splice(0)) emitter.removeListener(event, listener);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
});

it("live MCP menus and guessed calls use the owning socket's current setting, and notify both toggle directions", async () => {
  home = mkdtempSync(join(tmpdir(), "agend-cw-mcp-"));
  const ownHome = join(home, "own"), inheritedHome = join(home, "inherited"), instance = join(ownHome, "instances", "worker");
  mkdirSync(instance, { recursive: true });
  mkdirSync(inheritedHome);
  writeFileSync(join(inheritedHome, "fleet.yaml"), "web:\n  experimental:\n    canvas_worker: true\n");
  const setting = (enabled: boolean) => writeFileSync(join(ownHome, "fleet.yaml"), `web:\n  experimental:\n    canvas_worker: ${enabled}\n`);
  setting(false);
  vi.stubEnv("AGEND_HOME", inheritedHome);
  vi.stubEnv("AGEND_FLEET_DATA_DIR", inheritedHome);
  vi.stubEnv("AGEND_FLEET_CONFIG_PATH", join(inheritedHome, "fleet.yaml"));
  vi.stubEnv("AGEND_SOCKET_PATH", join(instance, "channel.sock"));
  vi.stubEnv("AGEND_TOOL_SET", "full");
  vi.stubEnv("AGEND_INSTANCE_NAME", "worker");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const watched: Array<[NodeJS.EventEmitter, string[]]> = [[process, ["unhandledRejection", "uncaughtException", "exit"]], [process.stdin, ["end", "close", "error"]]];
  const before = watched.map(([emitter, events]) => events.map(event => new Set(emitter.listeners(event))));
  try {
    await import("../src/channel/mcp-server.js");
    await Promise.resolve();
    await Promise.resolve();
    expect(state.options.capabilities.tools.listChanged).toBe(true);
    const list = () => state.handlers.get("tools/list")!({});
    const call = (name: string) => state.handlers.get("tools/call")!({ params: { name, arguments: {} } });
    const off = (await list()).tools;
    expect(off.map((t: any) => t.name)).not.toContain("upload_web_effect");
    expect(off.map((t: any) => t.name)).not.toContain("export_web_mod");
    expect(off.map((t: any) => t.name)).toContain("set_web_ambient");
    expect(JSON.stringify(off)).not.toContain("Canvas Worker");
    for (const name of ["upload_web_effect", "propose_web_mod"]) {
      expect(await call(name)).toEqual({ content: [{ type: "text", text: CANVAS_WORKER_EXPERIMENTAL_MESSAGE }], isError: true });
    }
    expect(state.sent.filter(m => m.type === "tool_call")).toEqual([]);
    // The actual config need not be dataDir/fleet.yaml; the explicit owner pair selects it.
    const custom = join(home, "custom-fleet.yaml");
    writeFileSync(custom, "web:\n  experimental:\n    canvas_worker: true\n");
    vi.stubEnv("AGEND_FLEET_DATA_DIR", ownHome);
    vi.stubEnv("AGEND_FLEET_CONFIG_PATH", custom);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.notifications).toHaveBeenCalledTimes(1);
    expect((await list()).tools.map((t: any) => t.name)).toContain("upload_web_effect");
    expect(await call("upload_web_effect")).not.toHaveProperty("isError");
    setting(true); // A true default file must not override the selected custom file.
    writeFileSync(custom, "web:\n  experimental:\n    canvas_worker: false\n");
    // Calls and lists are fenced immediately, before the periodic notification fires.
    expect((await list()).tools.map((t: any) => t.name)).not.toContain("upload_web_effect");
    expect((await call("upload_web_effect")).isError).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.notifications).toHaveBeenCalledTimes(2);
    expect(await call("set_web_ambient")).not.toHaveProperty("isError");
    expect(state.sent.filter(m => m.type === "tool_call").map(m => m.tool)).toEqual(["upload_web_effect", "set_web_ambient"]);
  } finally {
    for (const [i, [emitter, events]] of watched.entries()) for (const [j, event] of events.entries()) {
      for (const listener of emitter.listeners(event)) if (!before[i][j].has(listener)) ownedListeners.push([emitter, event, listener as (...args: any[]) => void]);
    }
  }
});
