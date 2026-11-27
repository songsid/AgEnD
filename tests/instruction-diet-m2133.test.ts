/**
 * M-2133 / M-3526 (inventory recs 1 and 2): the appearance tools are off unless switched on and listed as one
 * `web_appearance`; the emoji and sticker tools are one `emoji_sticker`; the task, reply and report_result schemas lost
 * words, not fields. The real stdio MCP child with an owned IPC socket: no Fleet, CLI, adapter, Hub, account or pane.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { COMPOSITE_TOOLS, TOOLS, expandCompositeCall, withComposites } from "../src/channel/mcp-tools.js";
import { TOOL_PROFILES } from "../src/tool-permissions.js";
import { DASHBOARD_FEATURE_TOOLS, TASK_CARD_REF_HINT, dashboardFeaturesOff, withoutFeatures } from "../src/dashboard-permissions.js";

const APPEARANCE = DASHBOARD_FEATURE_TOOLS.appearance;
const EMOJI = ["list_emojis", "preview_emojis", "list_stickers", "preview_stickers", "set_persona_emoji"];
const menu = (profile: keyof typeof TOOL_PROFILES, access: Record<string, boolean> = {}) =>
  withComposites(withoutFeatures(TOOLS.filter(t => TOOL_PROFILES[profile].includes(t.name)), dashboardFeaturesOff(access)));

describe("the menus", () => {
  it("default: no appearance tool at all; emoji and stickers are one emoji_sticker; no member is listed", () => {
    for (const profile of ["worker", "coordinator", "general", "standard", "full"] as const) {
      const names = menu(profile).map(t => t.name);
      expect(names, profile).not.toContain("web_appearance");
      expect(names, profile).toContain("emoji_sticker");
      for (const member of [...APPEARANCE, ...EMOJI]) expect(names, `${profile} ${member}`).not.toContain(member);
      expect(new Set(names).size, profile).toBe(names.length);
    }
  });
  it("switched on (dashboard.appearance: true): one web_appearance with all ten actions, each naming its tool", () => {
    const tool = menu("worker", { appearance: true }).find(t => t.name === "web_appearance")!;
    const actions = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum!;
    expect(actions).toHaveLength(10);
    const composite = COMPOSITE_TOOLS.find(c => c.name === "web_appearance")!;
    expect(actions.map(a => composite.actions[a]).sort()).toEqual([...APPEARANCE].sort());
    expect(tool.inputSchema.required).toEqual(["action"]);
  });
  it("a composite offers only the actions whose tools the profile has (minimal: no set_persona_emoji)", () => {
    const tool = menu("minimal").find(t => t.name === "emoji_sticker")!;
    expect((tool.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum)
      .toEqual(["list_emojis", "preview_emojis", "list_stickers", "preview_stickers"]);
  });
  it("a menu with none of a composite's tools has no composite", () => {
    const names = withComposites(TOOLS.filter(t => t.name === "reply")).map(t => t.name);
    expect(names).toEqual(["reply"]);
  });
});

describe("a composite call is its action's tool", () => {
  it("maps action + args, and refuses what is not a call", () => {
    expect(expandCompositeCall("web_appearance", { action: "set_theme", args: { set: { accent: "#123456" } } })).toEqual({ name: "set_web_theme", args: { set: { accent: "#123456" } } });
    expect(expandCompositeCall("web_appearance", { action: "get" })).toEqual({ name: "get_web_appearance", args: {} });
    expect(expandCompositeCall("emoji_sticker", { action: "set_persona_emoji", args: { emoji: "🦊" } })).toEqual({ name: "set_persona_emoji", args: { emoji: "🦊" } });
    expect(expandCompositeCall("web_appearance", { action: "constructor" })).toEqual({ error: expect.stringMatching(/action must be one of get, get_theme/) });
    expect(expandCompositeCall("web_appearance", { action: "get", accent: "x" })).toEqual({ error: "web_appearance: put accent inside args" });
    expect(expandCompositeCall("emoji_sticker", { action: "list_emojis", args: ["x"] })).toEqual({ error: "emoji_sticker: args must be an object" });
    expect(expandCompositeCall("reply", { text: "hi" })).toEqual({ name: "reply", args: { text: "hi" } });
  });
});

describe("M-3526: shorter words, the same schemas", () => {
  it("every shortened or folded tool keeps each field, type, enum, bound and required list (dev 63a41c9c)", () => {
    const strip = (n: unknown): unknown => Array.isArray(n) ? n.map(strip) : n && typeof n === "object"
      ? Object.fromEntries(Object.entries(n).filter(([k]) => k !== "description").map(([k, v]) => [k, strip(v)])) : n;
    const pinned = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/tool-schema-shapes-m3526.json"), "utf8")) as Record<string, unknown>;
    for (const [name, shape] of Object.entries(pinned)) {
      if (name.startsWith("_")) continue;
      expect(strip(TOOLS.find(t => t.name === name)!.inputSchema), name).toEqual(shape);
    }
  });
  it("the default worker menu stays inside its budget (13.9k o200k before; about 9.9k after)", () => {
    expect(Buffer.byteLength(JSON.stringify(menu("worker")))).toBeLessThan(46_000);   // 43.4 KB now; 59.9 KB before
    // 80.9 KB before; M-3693 adds 0.8 KB (contact_state and a propose_contact_change description General can use — Lumen's admin audit);
    // M-3694 adds the origin-clear kind (about 30 bytes, its description already trimmed elsewhere).
    expect(Buffer.byteLength(JSON.stringify(menu("general")))).toBeLessThan(67_050);
  });
  it("the task tool tells an agent how to point at a card (#M-3, not a URL) in one sentence — what it costs: tests/task-card-ref-hint.test.ts", () => {
    const description = TOOLS.find(t => t.name === "task")!.description!;
    expect(description).toContain(TASK_CARD_REF_HINT);
    expect(Buffer.byteLength(description), "the sentence is the only growth: 930 bytes now").toBeLessThan(1000);
  });
  it("the task tool points to its skill, which keeps the rules the description no longer spells out", () => {
    expect(TOOLS.find(t => t.name === "task")!.description).toContain("task-board skill");
    const skill = readFileSync(join(process.cwd(), "src/general-knowledge/skills/task-board/SKILL.md"), "utf8");
    for (const words of ["start here after a reset", "finishing it from review with `done`", "only the legacy detail/verbose lists cap", "A blocked card you handed out comes", "changing or archiving a project is a person's"])
      expect(skill.toLowerCase(), words).toContain(words.toLowerCase());
  });
});

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0).reverse()) await f(); });
async function world(dashboardOff: string) {
  const home = mkdtempSync(join(tmpdir(), "agend-m2133-")), dir = join(home, "instances/agent"); mkdirSync(dir, { recursive: true });
  const server = new IpcServer(join(dir, "channel.sock")); await server.listen();
  const calls: Array<{ tool: string; args: unknown }> = []; let ready = false;
  server.on("message", (m: any, peer: any) => {
    if (m.type === "mcp_ready") { ready = true; return; }
    if (m.type !== "tool_call") return;
    calls.push({ tool: m.tool, args: m.args });
    server.send(peer, { requestId: m.requestId, result: { ok: m.tool } });
  });
  const client = new Client({ name: "m2133-control", version: "1" });
  clean.push(async () => { await client.close(); await server.close(); rmSync(home, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", resolve("src/channel/mcp-server.ts")],
    env: { ...process.env as Record<string, string>, AGEND_HOME: home, AGEND_SOCKET_PATH: join(dir, "channel.sock"), AGEND_INSTANCE_NAME: "agent", AGEND_TOOL_SET: "worker", AGEND_DASHBOARD_OFF: dashboardOff }, stderr: "pipe" }));
  await vi.waitFor(() => expect(ready).toBe(true));
  return { client, calls };
}

describe("the real MCP child", () => {
  it("lists the composites and sends each call to the daemon as its tool, with its args", async () => {
    const w = await world("office,office_packs");   // appearance switched on
    const names = (await w.client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(["web_appearance", "emoji_sticker", "reply", "task"]));
    for (const member of [...APPEARANCE, ...EMOJI]) expect(names).not.toContain(member);
    await w.client.callTool({ name: "web_appearance", arguments: { action: "set_theme", args: { set: { accent: "#123456" } } } });
    await w.client.callTool({ name: "emoji_sticker", arguments: { action: "list_stickers", args: { name: "cat" } } });
    await w.client.callTool({ name: "set_web_theme", arguments: { set: { accent: "#654321" } } });   // a resumed session's old name
    expect(w.calls).toEqual([
      { tool: "set_web_theme", args: { set: { accent: "#123456" } } },
      { tool: "list_stickers", args: { name: "cat" } },
      { tool: "set_web_theme", args: { set: { accent: "#654321" } } },
    ]);
    const bad: any = await w.client.callTool({ name: "web_appearance", arguments: { action: "paint" } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/web_appearance: action must be one of/);
    expect(w.calls).toHaveLength(3);
  }, 30_000);
  it("default (appearance off): no web_appearance in the list", async () => {
    const w = await world("appearance,office,office_packs");
    const names = (await w.client.listTools()).tools.map(t => t.name);
    expect(names).not.toContain("web_appearance");
    expect(names).toContain("emoji_sticker");
  }, 30_000);
});
