import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "../src/child-process.js";
import { CLAUDE_ASSISTANT_MIN_VERSION, createClaudeAssistantHost } from "../src/hub/assistant/claude-host.js";
import type { RoomAssistantAsk, RoomAssistantSession } from "../src/hub/assistant/types.js";

const request = (roomId = "room-a"): RoomAssistantAsk => ({ roomId, roomName: "Weekly meeting", messageId: "m-1", asker: { name: "Han" }, text: "Summarise", context: [{ author: "Jo", text: "Done", at: 1 }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  writes: string[] = [];
  kill = vi.fn((_signal?: string) => true);
  constructor(readonly args: string[], readonly options: any) {
    super();
    this.stdin.on("data", chunk => this.writes.push(chunk.toString()));
    queueMicrotask(() => this.emit("spawn"));
  }
  get sessionId() { return this.args[this.args.indexOf("--session-id") + 1]; }
  frame(value: unknown) { this.stdout.write(JSON.stringify(value) + "\n"); }
  init(extra = {}) { this.frame({ type: "system", subtype: "init", session_id: this.sessionId, tools: [], mcp_servers: [], ...extra }); }
  result(text: string, extra = {}) { this.frame({ type: "result", subtype: "success", is_error: false, session_id: this.sessionId, result: text, ...extra }); }
  close() { this.emit("close", 0, null); }
}
const roots: string[] = [], children: FakeChild[] = [], sessions: RoomAssistantSession[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.close();
  await Promise.allSettled(sessions.splice(0).map(session => session.stop()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});
async function world() {
  const root = await mkdtemp(join(tmpdir(), "hub-assistant-claude-")); roots.push(root);
  const binary = join(root, "inert-claude"), home = join(root, "operator"), fleetHome = join(root, "fleet"), instanceHome = join(root, "chosen-instance-root");
  await writeFile(binary, "This inert fixture must never be executed.\n"); await mkdir(home);
  let next = deferred<FakeChild>();
  const launch = vi.fn((binary: string, args: string[], options: any) => {
    const child = new FakeChild(args, options); children.push(child); next.resolve(child); next = deferred<FakeChild>(); return child;
  });
  const version = vi.fn(async () => CLAUDE_ASSISTANT_MIN_VERSION as string | null);
  const environment = { HOME: home, PATH: "/inert", AGEND_INSTANCE_NAME: "operator", AGEND_AGENT_TOKEN: "not-for-assistant",
    NODE_OPTIONS: "--require=/must-not-load", BASH_ENV: "/must-not-source", ANTHROPIC_API_KEY: "fake-owner-key", CLAUDE_CODE_OAUTH_TOKEN: "fake-owner-token" };
  const host = createClaudeAssistantHost({ fleetHome, instanceHome, binary, environment, version, spawn: launch as unknown as typeof spawn });
  const start = async (roomId = "room-a", account: string | null = null) => {
    const controller = new AbortController();
    const session = await host.start({ roomId, roomName: "Weekly meeting", account, backend: "claude-code", signal: controller.signal });
    sessions.push(session);
    return { session, child: children.at(-1)!, controller };
  };
  return { host, root, home, fleetHome, instanceHome, binary, launch, version, environment, start, nextChild: () => next.promise };
}

describe("Hub host Fleet tools-off Claude adapter (inert process only)", () => {
  it("launches an empty per-room cwd under a configurable root with every tool surface disabled", async () => {
    const w = await world(), a = await w.start(), b = await w.start("room-b");
    const args = a.child.args, value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--tools")).toBe(""); expect(value("--disallowedTools")).toBe("mcp__*");
    expect(args).toContain("--restricted"); expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--safe-mode"); expect(args).toContain("--disable-slash-commands"); expect(args).not.toContain("--bare");
    expect(JSON.parse(value("--mcp-config"))).toEqual({ mcpServers: {} });
    expect(value("--setting-sources")).toBe(""); expect(args).toContain("--no-chrome");
    expect(JSON.parse(value("--settings"))).toEqual({ disableAllHooks: true, disableClaudeAiConnectors: true, disableBundledSkills: true, permissions: { defaultMode: "dontAsk" } });
    expect(value("--permission-mode")).toBe("dontAsk"); expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--no-session-persistence"); expect(value("--input-format")).toBe("stream-json");
    expect(value("--output-format")).toBe("stream-json"); expect(value("--max-turns")).toBe("1");
    expect(a.child.options.cwd).toMatch(new RegExp(`^${w.instanceHome}/`));
    expect(b.child.options.cwd).not.toBe(a.child.options.cwd);
    expect(await readdir(a.child.options.cwd)).toEqual([]);
    expect(a.child.options.env).not.toHaveProperty("AGEND_AGENT_TOKEN"); expect(a.child.options.env).not.toHaveProperty("AGEND_INSTANCE_NAME");
    expect(a.child.options.env).not.toHaveProperty("NODE_OPTIONS"); expect(a.child.options.env).not.toHaveProperty("BASH_ENV");
    expect(a.child.options.env.HOME).toBe(w.home);
  });

  it.each(["2.1.315", "2.0.999", null, "unknown"])("refuses unproven tools-off version %s before spawning", async version => {
    const w = await world(); w.version.mockResolvedValue(version);
    await expect(w.start()).rejects.toThrow("supported tools-off");
    expect(w.launch).not.toHaveBeenCalled();
  });

  it("refuses a binary replaced during the version check", async () => {
    const w = await world(); w.version.mockImplementation(async () => { await writeFile(w.binary, "Changed binary fixture, still inert"); return CLAUDE_ASSISTANT_MIN_VERSION; });
    await expect(w.start()).rejects.toThrow("supported tools-off");
    expect(w.launch).not.toHaveBeenCalled();
  });

  it("uses the named profile without copying credentials or inheriting shared account overrides", async () => {
    const w = await world(), profile = join(w.fleetHome, "credential-profiles", "claude-code", "hub-owner");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "inert-owner" } }));
    const before = await readFile(join(profile, ".claude.json"), "utf8");
    const a = await w.start("a", "hub-owner");
    expect(a.child.options.env.CLAUDE_CONFIG_DIR).toBe(profile);
    expect(a.child.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(a.child.options.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(await readdir(profile)).toEqual([".claude.json"]);
    expect(await readFile(join(profile, ".claude.json"), "utf8")).toBe(before);
    await expect(w.start("b", "missing-account")).rejects.toThrow();
    expect(w.launch).toHaveBeenCalledTimes(1);
  });

  it("uses a new one-shot worker for each turn, without retaining or duplicating prior conversation", async () => {
    const w = await world(), a = await w.start();
    const first = a.session.ask(request(), a.controller.signal); await flush();
    a.child.init(); a.child.result("**Summary**"); a.child.close();
    expect(await first).toEqual({ text: "**Summary**" });
    expect(a.child.stdin.writableEnded).toBe(true);
    const spawned = w.nextChild();
    const second = a.session.ask({ ...request(), messageId: "m-2", text: "Follow up" }, a.controller.signal);
    const secondChild = await spawned; await flush();
    expect(secondChild.sessionId).not.toBe(a.child.sessionId);
    expect(secondChild.options.cwd).not.toBe(a.child.options.cwd);
    secondChild.init(); secondChild.result("Follow-up"); secondChild.close();
    expect(await second).toEqual({ text: "Follow-up" });
    expect(w.launch).toHaveBeenCalledTimes(2);
    const sent = [...a.child.writes, ...secondChild.writes].map(line => JSON.parse(line));
    expect(sent.map(frame => JSON.parse(frame.message.content))).toEqual([
      { room: { id: "room-a", name: "Weekly meeting" }, messageId: "m-1", asker: "Han", recentMessages: request().context, request: "Summarise" },
      { room: { id: "room-a", name: "Weekly meeting" }, messageId: "m-2", asker: "Han", recentMessages: request().context, request: "Follow up" },
    ]);
    await expect(a.session.ask(request("room-b"), a.controller.signal)).rejects.toThrow("unavailable");
    expect(a.child.writes).toHaveLength(1); expect(secondChild.writes).toHaveLength(1);
    expect(w.launch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [] },
    { type: "system", subtype: "init", tools: [], mcp_servers: [{ name: "foreign" }] },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
    { type: "control_request", request: { subtype: "can_use_tool" } },
  ])("refuses a native or MCP tool surface: %j", async frame => {
    const w = await world(), a = await w.start();
    const result = a.session.ask(request(), a.controller.signal);
    const rejected = expect(result).rejects.toThrow();
    await flush();
    a.child.frame({ session_id: a.child.sessionId, ...frame });
    a.child.close();
    await rejected;
    expect(a.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each(["no-init", "foreign-session", "vendor-error", "malformed-json", "null"])("rejects unowned or incomplete result: %s", async kind => {
    const w = await world(), a = await w.start();
    const result = a.session.ask(request(), a.controller.signal), rejected = expect(result).rejects.toThrow();
    await flush();
    if (kind !== "no-init") a.child.init();
    if (kind === "foreign-session") a.child.result("wrong", { session_id: "another-room" });
    else if (kind === "vendor-error") a.child.result("private vendor detail must not escape", { is_error: true });
    else if (kind === "malformed-json") a.child.stdout.write("not json\n");
    else if (kind === "null") a.child.frame(null);
    else a.child.result("not proven");
    a.child.close();
    await rejected;
    expect(a.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("holds stop until process close, then removes only its owned scratch directory", async () => {
    const w = await world(), a = await w.start(), result = a.session.ask(request(), a.controller.signal);
    const rejected = expect(result).rejects.toThrow("stopped");
    await flush();
    const stop = a.session.stop(), done = vi.fn(); void stop.then(done);
    await rejected; await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    expect(await readdir(a.child.options.cwd)).toEqual([]);
    a.child.close(); await stop;
    await expect(readdir(a.child.options.cwd)).rejects.toThrow();
    expect(await readFile(w.binary, "utf8")).toContain("inert fixture");
  });

  it("returns an answer only after the one-shot worker closes, preserving an older replied-to anchor", async () => {
    const w = await world(), a = await w.start(), ask = request();
    ask.context = Array.from({ length: 35 }, (_, at) => ({ author: "Han", text: `Row ${at}`, at, ...(at === 1 ? { repliedTo: true as const } : {}) }));
    const result = a.session.ask(ask, a.controller.signal), settled = vi.fn(); void result.then(settled);
    await flush();
    const sent = JSON.parse(JSON.parse(a.child.writes[0]).message.content);
    expect(sent.recentMessages.map((row: any) => row.at)).toEqual([1, ...Array.from({ length: 30 }, (_, i) => i + 5)]);
    expect(sent.recentMessages[0].repliedTo).toBe(true);
    a.child.init(); a.child.result("Bounded answer"); await flush();
    expect(settled).not.toHaveBeenCalled();
    a.child.close(); expect(await result).toEqual({ text: "Bounded answer" });
  });

  it("aborts a pending turn and never returns its later text", async () => {
    const w = await world(), a = await w.start(), result = a.session.ask(request(), a.controller.signal);
    const rejected = expect(result).rejects.toThrow("cancelled");
    await flush();
    a.controller.abort(); a.child.init(); a.child.result("too late");
    a.child.close();
    await rejected;
    expect(a.child.kill).toHaveBeenCalledTimes(1);
    await expect(a.session.ask(request(), new AbortController().signal)).rejects.toThrow("unavailable");
  });
});
