/**
 * #4351 review (M-2133): the persistent-pane and native helper paths. A launch's ceiling stays the member tool names;
 * the provider sees and may call the composites that fold members in that ceiling (and the legacy member names), never
 * a tool outside it. Scratch files and in-memory doubles only: no CLI, provider, account or pane.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { facingToolNames, COMPOSITE_ACTIONS } from "../src/composite-tools.js";
import { COMPOSITE_TOOLS } from "../src/channel/mcp-tools.js";
import { nativeMcpRpc, type NativeMcpRequest } from "../src/windows-native-mcp.js";
import type { NativeMcpConnection } from "../src/windows-cli-providers.js";
import { PaneMcpAuthorityLease, type PaneMcpAuthority } from "../src/runtime-pane-mcp.js";
import type { PaneMcpBody } from "../src/runtime-pane-mcp-protocol.js";
import { prepareNativePaneConfig } from "../src/runtime-pane-config.js";
import { persistentNativeArguments, type NativePaneOwner } from "../src/runtime-pane-native.js";
import type { RuntimePaneLaunch } from "../src/runtime-pane-protocol.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const CEILING = ["reply", "set_web_theme", "list_stickers"];

describe("the facing names", () => {
  it("are the ceiling plus each composite with a member in it; one module, one map", () => {
    expect(facingToolNames(CEILING)).toEqual(["reply", "set_web_theme", "list_stickers", "web_appearance", "emoji_sticker"]);
    expect(facingToolNames(["reply"])).toEqual(["reply"]);
    expect(facingToolNames(["reply", "web_appearance"])).toEqual(["reply", "web_appearance"]);   // never twice
    for (const c of COMPOSITE_TOOLS) expect(c.actions).toBe(COMPOSITE_ACTIONS[c.name]);
  });
});

describe("the native MCP helper (connection.tools = member ceiling)", () => {
  const connection: NativeMcpConnection = { endpoint: "http://127.0.0.1:19280/agent", token: "a".repeat(64), tools: CEILING };
  const rpc = (method: string, params: Record<string, unknown> = {}, id: string | number = 1) => ({ jsonrpc: "2.0", id, method, params });
  it("lists the composites the server folded, and still filters what is outside the ceiling", async () => {
    const transport = vi.fn(async () => ({ tools: [{ name: "reply" }, { name: "web_appearance" }, { name: "emoji_sticker" }, { name: "create_instance" }] }));
    const listed: any = await nativeMcpRpc(rpc("tools/list"), connection, transport);
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(["reply", "web_appearance", "emoji_sticker"]);
  });
  it("passes a composite call and a legacy member call to the server; refuses a composite with no member in the ceiling", async () => {
    const calls: NativeMcpRequest[] = [];
    const transport = vi.fn(async (body: NativeMcpRequest) => { calls.push(body); return { content: [{ type: "text", text: "ok" }] }; });
    expect(await nativeMcpRpc(rpc("tools/call", { name: "web_appearance", arguments: { action: "set_theme", args: { set: { accent: "#123456" } } } }), connection, transport)).toMatchObject({ result: { content: [{ text: "ok" }] } });
    expect(await nativeMcpRpc(rpc("tools/call", { name: "set_web_theme", arguments: { set: { accent: "#654321" } } }, 2), connection, transport)).toMatchObject({ result: {} });
    expect(calls.map(c => (c.params as { name?: unknown }).name)).toEqual(["web_appearance", "set_web_theme"]);
    const narrow = { ...connection, tools: ["reply"] };
    expect(await nativeMcpRpc(rpc("tools/call", { name: "web_appearance", arguments: { action: "get" } }, 3), narrow, transport)).toMatchObject({ error: { code: -32602 } });
    expect(await nativeMcpRpc(rpc("tools/call", { name: "create_instance", arguments: {} }, 4), connection, transport)).toMatchObject({ error: { code: -32602 } });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("the persistent-pane coordinator (toolCeiling = member names)", () => {
  function rig(ceiling = CEILING) {
    const root = mkdtempSync(join(tmpdir(), "agend-m2133-pane-")); roots.push(root);
    const owner = { hostBootId: randomUUID(), paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), instance: "agent" }, machineId = randomUUID();
    const invoke = vi.fn(async (_input: any, _current: () => boolean) => ({ result: { ok: true } }));
    const authority: PaneMcpAuthority = { machineId, owner, toolCeiling: ceiling, current: () => true,
      menu: () => [{ name: "reply" }, { name: "set_web_theme" }, { name: "set_web_widget" }, { name: "list_stickers" }], allowed: () => true, invoke, responseWritten: vi.fn() };
    const lease = new PaneMcpAuthorityLease(join(root, "calls.json"), authority);
    let n = 0;
    const call = (name: string, args: Record<string, unknown>) => lease.handle(machineId, { op: "pane-mcp", method: "tools/call", owner, helperId: randomUUID(),
      callId: String(++n).padStart(64, "0"), params: { name, arguments: args } } as Extract<PaneMcpBody, { method: "tools/call" }>, () => true);
    return { lease, owner, machineId, invoke, call };
  }
  it("lists the composite with only the ceiling's actions; a member outside the ceiling is never offered", async () => {
    const f = rig();
    const listed: any = await f.lease.handle(f.machineId, { op: "pane-mcp", method: "tools/list", owner: f.owner, helperId: randomUUID(), params: {} } as PaneMcpBody, () => true);
    const tools = listed.result.tools as Array<{ name: string; inputSchema?: { properties: { action: { enum: string[] } } } }>;
    expect(tools.map(t => t.name)).toEqual(["reply", "web_appearance", "emoji_sticker"]);
    expect(tools.find(t => t.name === "web_appearance")!.inputSchema!.properties.action.enum).toEqual(["set_theme"]);
  });
  it("dispatches an allowed action as its member; refuses an action whose member is outside the ceiling; keeps the legacy name", async () => {
    const f = rig();
    await f.call("web_appearance", { action: "set_theme", args: { set: { accent: "#123456" } } });
    expect(f.invoke.mock.calls[0][0]).toMatchObject({ tool: "set_web_theme", args: { set: { accent: "#123456" } } });
    await expect(f.call("web_appearance", { action: "set_widget", args: { slot: "chat_header", widget: { kind: "facts" } } })).rejects.toThrow("Pane tool access was revoked");
    await f.call("set_web_theme", { set: { accent: "#654321" } });
    expect(f.invoke.mock.calls.map(c => c[0].tool)).toEqual(["set_web_theme", "set_web_theme"]);
    expect(await f.call("web_appearance", { action: "paint" })).toMatchObject({ result: { isError: true } });
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("the Claude CLI allowlist of a persistent pane", () => {
  it("--allowedTools names the composites beside the ceiling's members", () => {
    const root = mkdtempSync(join(tmpdir(), "agend-m2133-args-")); roots.push(root);
    const cwd = join(root, "workspace"); mkdirSync(cwd);
    const launch: RuntimePaneLaunch = { paneId: randomUUID(), agentId: randomUUID(), instance: "agent", cli: "claude-code", cwd, sandbox: "read-only", columns: 80, rows: 24, mcpTools: CEILING };
    const owner: NativePaneOwner = { directory: root, launchId: randomUUID() };
    owner.mcp = { endpoint: "http://127.0.0.1:12345/agent", token: "a".repeat(64), tools: CEILING, owner: { hostBootId: randomUUID(), paneId: launch.paneId, agentId: launch.agentId, instance: launch.instance, launchId: owner.launchId } };
    const config = prepareNativePaneConfig(launch, owner, "C:\\Node\\node.exe", "C:\\Program Files\\AgEnD\\windows-pane-mcp.js");
    try {
      const args = persistentNativeArguments(launch, config);
      const allowed = args[args.indexOf("--allowedTools") + 1].split(",").map(name => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ""));
      expect(allowed).toEqual(["reply", "set_web_theme", "list_stickers", "web_appearance", "emoji_sticker"]);
      expect(config.mcp!.tools).toEqual(CEILING);   // the issued ceiling itself is unchanged
    } finally { config.cleanup(); }
  });
});
