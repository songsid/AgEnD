/** Real stdio stub and owned IPC only. No CLI, Fleet, account or pane. */
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { CLASSIC_RESTRICTED_TOOLS } from "../src/contact-auth-types.js";
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0).reverse()) await f(); });
async function world(ceiling?: string) {
  const root = mkdtempSync(join(tmpdir(), "classic-mcp-")), dir = join(root, "instances", "sample-room"); mkdirSync(dir, { recursive: true });
  const socket = join(dir, "channel.sock"), server = new IpcServer(socket); await server.listen();
  const calls: string[] = [];
  server.on("message", (m: any, peer: any) => { if (m.type === "tool_call") { calls.push(m.tool); server.send(peer, { requestId: m.requestId, result: { sent: true } }); } });
  const client = new Client({ name: "classic-guard-fixture", version: "1" });
  clean.push(async () => { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", resolve("src/channel/mcp-server.ts")],
    env: { PATH: process.env.PATH!, AGEND_HOME: root, AGEND_SOCKET_PATH: socket, AGEND_INSTANCE_NAME: "sample-room", AGEND_TOOL_SET: "full",
      ...(ceiling === undefined ? {} : { AGEND_CLASSIC_ALLOWED_TOOLS: ceiling }) }, stderr: "pipe" }));
  return { client, calls };
}
it("lists only the room ceiling and refuses guessed admin/Hub tools before IPC", async () => {
  const w = await world(JSON.stringify(CLASSIC_RESTRICTED_TOOLS));
  expect((await w.client.listTools()).tools.map(t => t.name).sort()).toEqual([...CLASSIC_RESTRICTED_TOOLS].sort());
  for (const name of ["create_instance", "task", "hub_room_post", "set_web_settings"]) {
    const result: any = await w.client.callTool({ name, arguments: {} });
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain("Restricted room");
  }
  expect(w.calls).toEqual([]);
  const result: any = await w.client.callTool({ name: "reply", arguments: { text: "fixture" } });
  expect(result.isError).not.toBe(true); expect(w.calls).toEqual(["reply"]);
});
it("fails closed on a malformed ceiling while preserving ordinary admin behavior", async () => {
  for (const value of ["invalid json", '["create_instance"]']) {
    const w = await world(value); expect((await w.client.listTools()).tools).toEqual([]);
    expect((await w.client.callTool({ name: "reply", arguments: {} })).isError).toBe(true);
    expect(w.calls).toEqual([]);
  }
  const admin = await world(); expect((await admin.client.listTools()).tools.some(t => t.name === "create_instance")).toBe(true);
  expect((await admin.client.callTool({ name: "create_instance", arguments: {} })).isError).not.toBe(true);
  expect(admin.calls).toEqual(["create_instance"]);
});
