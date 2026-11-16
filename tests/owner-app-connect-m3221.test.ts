/** Owned stdio/Unix sockets and inert service ports. No live Fleet, account, CLI or browser. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OwnerAppControl, requestOwnerApp } from "../src/connect/control.js";
import { dispatchOwnerApp, type OwnerAppService } from "../src/connect/protocol.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function service() {
  return { current: (): boolean => true, listAgents: vi.fn(() => [{ name: "helper", status: "running" }]),
    send: vi.fn(async () => ({ accepted: true })), readAnswers: vi.fn(() => ({ messages: [] })),
    readBoard: vi.fn(() => ({ cards: [] })) } satisfies OwnerAppService;
}
async function world(server = true) {
  const home = mkdtempSync(join(tmpdir(), "ac4a-"));
  cleanup.push(async () => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "instances/test"), { recursive: true });
  const port = service(), control = new OwnerAppControl(home, port);
  if (server) { await control.listen(); cleanup.push(() => control.close()); }
  const client = new Client({ name: "owner-app-control", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ["--import", "tsx", resolve(process.env.M3221_ENTRY || "src/connect/stdio-entry.ts")],
    env: { ...process.env as Record<string, string>, AGEND_HOME: home, AGEND_SOCKET_PATH: join(home, "instances/test/channel.sock"),
      AGEND_INSTANCE_NAME: "test", AGEND_TOOL_SET: "full" }, stderr: "pipe" }));
  return { client, home, port, control };
}
describe.skipIf(process.platform === "win32")("local owner's four-operation connector", () => {
  it("lists only the fixed person surface immediately without any Fleet socket", async () => {
    const w = await world(false), start = performance.now();
    const tools = await w.client.listTools({}, { timeout: 900 });
    expect(tools.tools.map(t => t.name)).toEqual(["list_agents", "send_message", "read_answer", "task_board"]);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it("keeps the catalog responsive while a separate send is waiting", async () => {
    const w = await world(); let release!: () => void;
    const held = new Promise<void>(yes => { release = yes; });
    w.port.send.mockImplementation(async () => { await held; return { accepted: true }; });
    const pending = w.client.callTool({ name: "send_message", arguments: { agent: "helper", text: "Owned question" } });
    try {
      await vi.waitFor(() => expect(w.port.send).toHaveBeenCalledOnce());
      expect((await w.client.listTools({}, { timeout: 900 })).tools).toHaveLength(4);
    } finally { release(); }
    expect((await pending).isError).not.toBe(true);
  });
  it("refuses administrative and caller-name arguments without dispatching them", async () => {
    const w = await world();
    for (const call of [{ name: "create_instance", arguments: { name: "forged" } },
      { name: "send_message", arguments: { agent: "helper", text: "Hello", caller: "general" } },
      { name: "task_board", arguments: { action: "create", title: "forged" } },
      { name: "send_message", arguments: { agent: "helper", text: "/raw forged" } }]) {
      expect((await w.client.callTool(call)).isError).toBe(true);
    }
    expect(w.port.send).not.toHaveBeenCalled(); expect(w.port.readBoard).not.toHaveBeenCalled();
    await expect(dispatchOwnerApp(w.port, "create_instance", {}, () => true)).rejects.toThrow();
  });
  it("enforces the same strict scope on the owner socket and private permissions", async () => {
    const w = await world();
    expect(statSync(join(w.home, "operator")).mode & 0o777).toBe(0o700);
    expect(statSync(join(w.home, "operator/connect.sock")).mode & 0o777).toBe(0o600);
    await expect(requestOwnerApp(w.home, "send_message", { agent: "helper", text: "Hello", owner: "somebody" })).rejects.toThrow();
    expect(w.port.send).not.toHaveBeenCalled();
    expect(await requestOwnerApp(w.home, "list_agents", {})).toEqual([{ name: "helper", status: "running" }]);
  });
  it("does not replace an ordinary file and refuses calls after shutdown", async () => {
    const w = await world(false); mkdirSync(join(w.home, "operator"));
    writeFileSync(join(w.home, "operator/connect.sock"), "retained owner file");
    await expect(w.control.listen()).rejects.toThrow();
    const port = service(); port.current = () => false;
    await expect(dispatchOwnerApp(port, "list_agents", {}, () => true)).rejects.toThrow();
    expect(port.listAgents).not.toHaveBeenCalled();
  });
});
