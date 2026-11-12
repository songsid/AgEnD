/**
 * AGEND-197 (the owner's ruling on #3648), server side. The chat's activity block is:
 *   - for an admin session on the local dashboard ONLY — refused by the route (403), not hidden by the page;
 *   - gated by each agent's own `tool_progress` (off: nothing, and nothing is read; standard: a summary; verbose: the
 *     command, arguments and output) — not by `web.log_tab`;
 *   - with thinking behind its own switch (`web.log_thinking`), OFF by default; while it is off AgEnD never writes
 *     `showThinkingSummaries` into Claude's settings.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { bindGuestRequest } from "../src/web-guest-access.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { LogService, thinkingOn, type LogServiceDeps } from "../src/log-service.js";
import { chatStep, type LogStep } from "../src/log-steps.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { createBackend } from "../src/backend/factory.js";
import type { InstanceConfig } from "../src/types.js";
import type { Logger } from "../src/logger.js";

vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-197-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TOKEN = "a".repeat(48), origin = "https://fixture.example";
/** GET /ui/steps through the real route as an admin, a read-only session, a guest, or the public link. */
function ask(opts: { tier?: "admin" | "read" | "guest"; gateway?: boolean; query?: string } = {}): Promise<{ status: number; body: any; q: any }> {
  const { tier = "admin", gateway = false, query = "instance=w&chat=1" } = opts;
  const sessions = new WebSessionStore();
  const sid = sessions.create({ tier, surface: gateway ? "gateway" : "local", label: "t", tokenEpoch: tokenEpoch(TOKEN), ...(gateway ? { exposureId: "e1" } : {}), ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "1" } } : {}) }).sessionId as string;
  const req = Object.assign(new EventEmitter(), { method: "GET", url: `/ui/steps?${query}`, headers: { host: gateway ? "fixture.example" : "127.0.0.1:19280", cookie: `${gateway ? "__Host-agend_session" : "agend_session"}=${sid}` } });
  if (gateway) bindGatewayRequest(req as never, { surface: "gateway", exposureId: "e1", expectedOrigin: origin, isCurrent: () => true });
  if (tier === "guest") bindGuestRequest(req as never, { owner: { adapterId: "discord", userId: "1" }, scope: () => new Set(["w"]), current: () => true } as never);
  return new Promise((resolve) => {
    let q: unknown, status = 0, body = "";
    const res = { destroyed: false, setHeader() {}, writeHead(n: number) { status = n; return res; }, end(b?: string) { body = b ?? ""; resolve({ status, body: body ? JSON.parse(body) : null, q }); } };
    const ctx = { webToken: TOKEN, webSessions: sessions, fleetConfig: { instances: {} }, logger: { info() {}, warn() {}, error() {}, debug() {} },
      logSteps: async (_n: string, query: unknown) => { q = query; return { enabled: true, steps: [] }; } };
    handleWebRequest(req as never, res as never, new URL(req.url, "http://127.0.0.1:19280"), ctx as never);
  });
}

describe("the whole block is for an admin session on the local dashboard — refused on the server for everyone else", () => {
  it("admin, local: the service is told it is the chat's block", async () => {
    const r = await ask();
    expect(r.status).toBe(200);
    expect(r.q).toMatchObject({ chat: true });
  });
  it.each([
    ["a guest", { tier: "guest" as const }],
    ["the public link", { gateway: true }],
    ["a read-only session", { tier: "read" as const }],
  ])("%s asking for it gets 403 admin_only, and the service is never reached", async (_n, opts) => {
    const r = await ask(opts);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "admin_only" });
    expect(r.q).toBeUndefined();
  });
  it.each([
    ["a guest", { tier: "guest" as const }],
    ["the public link", { gateway: true }],
  ])("%s, with the chat flag AND with thinking asked, still gets nothing of either", async (_n, opts) => {
    const r = await ask({ ...opts, query: "instance=w&chat=1&thinking=1" });
    expect(r.status).toBe(403);
    expect(r.q).toBeUndefined();
  });
  it("the Log tab's own read (no chat flag) is as it was: not turned into the chat's by anything the page sends", async () => {
    const r = await ask({ gateway: true, query: "instance=w" });
    expect(r.status).toBe(200);
    expect(r.q).not.toHaveProperty("chat");
  });
});

describe("the service: gated by tool_progress, not web.log_tab", () => {
  const rec = (o: unknown) => JSON.stringify(o) + "\n";
  const transcript = () => {
    const f = join(temp(), "t.jsonl");
    writeFileSync(f, rec({ type: "user", promptId: "p1", message: { role: "user", content: "the person's own words" } })
      + rec({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test -- --token=abcdef123456 tests/a.test.ts" } }] } })
      + rec({ type: "user", promptId: "p1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ALL 12 TESTS PASSED output-line" }] } })
      + rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "needle-pattern", path: "src" } }, { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/work/proj/src/a.ts" } }] } }));
    return f;
  };
  const svc = (over: Partial<LogServiceDeps> = {}, path = transcript()) => new LogService({
    enabled: () => false, toolProgress: () => "standard", thinking: () => false, cwd: () => "/work/proj", known: () => true,
    source: () => ({ backend: "claude-code", path, format: "claude" }), events: () => [], emit() {}, ...over,
  });
  const tools = (a: any) => a.steps.filter((s: any) => s.kind === "tool");

  it("log_tab OFF, tool_progress standard: the chat's block still has its steps; the Log tab's own read says disabled", async () => {
    const s = svc();
    const chat: any = await s.steps("w", { chat: true });
    expect(chat).toMatchObject({ enabled: true, level: "standard" });
    expect(tools(chat).length).toBe(3);
    expect(await s.steps("w", {})).toEqual({ enabled: false });
  });
  it("tool_progress off: no steps, nothing is read (the transcript need not exist), no events, no thinking — whatever is asked", async () => {
    const s = svc({ toolProgress: () => "off", source: () => ({ backend: "claude-code", path: "/nonexistent/never-read.jsonl", format: "claude" }) });
    const a: any = await s.steps("w", { chat: true, thinking: true, watch: true });
    expect(a).toMatchObject({ enabled: true, level: "off", steps: [], events: [], thinking: false });
    expect(a).not.toHaveProperty("key");
    expect(s.watched()).toBe(0);
  });
  it("no toolProgress dependency at all: off (the block is never offered by default)", async () => {
    const a: any = await svc({ toolProgress: undefined }).steps("w", { chat: true });
    expect(a.level).toBe("off");
    expect(a.steps).toEqual([]);
  });
  it("standard: a summary — the tool, its status and what it names (a path, the program), never the arguments, the output or a search's pattern", async () => {
    const a: any = await svc().steps("w", { chat: true });
    const [bash, grep, read] = tools(a);
    expect(bash).toMatchObject({ tool: "Bash", cat: "run", subject: "npm", status: "done" });
    expect(bash).not.toHaveProperty("input");
    expect(bash).not.toHaveProperty("body");
    expect(grep).toMatchObject({ tool: "Grep", cat: "search" });
    expect(grep).not.toHaveProperty("subject");
    expect(read).toMatchObject({ cat: "read", subject: "/work/proj/src/a.ts" });
    const wire = JSON.stringify(a);
    for (const leaked of ["--token", "abcdef123456", "tests/a.test.ts", "ALL 12 TESTS PASSED", "needle-pattern"]) expect(wire, leaked).not.toContain(leaked);
  });
  it("verbose: the same steps with the command, the arguments and the output (still masked, as the Log masks)", async () => {
    const a: any = await svc({ toolProgress: () => "verbose" }).steps("w", { chat: true });
    const bash = tools(a)[0];
    expect(bash.subject).toContain("npm test");
    expect(bash.subject).toContain("tests/a.test.ts");
    expect(bash.input).toContain("npm test");
    expect(bash.body).toContain("ALL 12 TESTS PASSED");
    expect(JSON.stringify(a)).not.toContain("abcdef123456");        // the secret shape is masked at every level
    expect(a.level).toBe("verbose");
  });
  it("a person's own words are never sent in the chat's answer (the chat already shows them): the user step only anchors the turn", async () => {
    for (const level of ["standard", "verbose"] as const) {
      const a: any = await svc({ toolProgress: () => level }).steps("w", { chat: true });
      expect(a.steps.some((s: any) => s.kind === "user")).toBe(true);
      expect(JSON.stringify(a)).not.toContain("the person's own words");
    }
    // The Log tab (not the chat) keeps showing the prompt as it always did.
    const log: any = await svc({ enabled: () => true }).steps("w", {});
    expect(JSON.stringify(log)).toContain("the person's own words");
  });
  it("the chat's answer carries cwd/home for path display (an admin only reaches it); the Log's answer without thinking still does not", async () => {
    const chat: any = await svc().steps("w", { chat: true });
    expect(chat.cwd).toBe("/work/proj");
    expect(typeof chat.home).toBe("string");
    const log: any = await svc({ enabled: () => true }).steps("w", {});
    expect(log).not.toHaveProperty("cwd");
    expect(log).not.toHaveProperty("home");
  });
  it("thinking is its own switch, off by default: not for the chat's block either, until web.log_thinking is on", async () => {
    const off: any = await svc().steps("w", { chat: true, thinking: true });
    expect(JSON.stringify(off)).not.toContain("private reasoning");
    expect(off.thinking).toBe(false);
    const none: any = await svc({ thinking: undefined }).steps("w", { chat: true, thinking: true });
    expect(JSON.stringify(none)).not.toContain("private reasoning");
    const on: any = await svc({ thinking: () => true }).steps("w", { chat: true, thinking: true });
    expect(on.steps.some((s: any) => s.kind === "thinking")).toBe(true);
    const notAsked: any = await svc({ thinking: () => true }).steps("w", { chat: true });
    expect(notAsked.steps.some((s: any) => s.kind === "thinking")).toBe(false);
  });
  it("chatStep on its own: a lone shell program, a plan or a web address keeps no subject at standard; verbose returns the step itself", () => {
    const step = (over: Partial<LogStep>): LogStep => ({ id: "x", turn: "t", ts: 1, kind: "tool", tool: "Bash", cat: "run", status: "done", ...over });
    const shell = chatStep(step({ subject: "/usr/bin/env FOO=1 ./run.sh --flag", input: "{}", body: "out" }), "standard");
    expect(shell).toMatchObject({ cat: "run", subject: "env" });
    expect(shell).not.toHaveProperty("input");
    expect(shell).not.toHaveProperty("body");
    expect(chatStep(step({ cat: "web", tool: "WebFetch", subject: "https://example.com/secret?x=1" }), "standard")).not.toHaveProperty("subject");
    expect(chatStep(step({ cat: "plan", tool: "TodoWrite", subject: "3" }), "standard")).not.toHaveProperty("subject");
    expect(chatStep(step({ cat: "agent", tool: "Task", subject: "a long task text" }), "standard")).not.toHaveProperty("subject");
    expect(chatStep(step({ cat: "mcp", tool: "mcp__x__y", subject: "x:y" }), "standard")).toMatchObject({ subject: "x:y" });
    const v = step({ subject: "ls -la", input: "{}", body: "out" });
    expect(chatStep(v, "verbose")).toBe(v);
  });
});

describe("the watch: a chat's block keeps its live ticks without log_tab, and stops when tool_progress goes off", () => {
  const path = () => { const f = join(temp(), "t.jsonl"); writeFileSync(f, JSON.stringify({ type: "user", promptId: "p", message: { role: "user", content: "x" } }) + "\n"); return f; };
  function rig(level: { v: "off" | "standard" | "verbose" }, logOn = { v: false }) {
    const f = path();
    let now = 0;
    const timers: Array<() => void> = [];
    const emits: string[] = [];
    const s = new LogService({
      enabled: () => logOn.v, toolProgress: () => level.v, known: () => true, source: () => ({ backend: "claude-code", path: f, format: "claude" }), events: () => [],
      emit: (e) => { emits.push(e); }, now: () => now, setInterval: (fn: () => void) => { timers.push(fn); return timers.length; }, clearInterval: () => { timers.length = 0; },
    } as LogServiceDeps);
    return { s, f, emits, timers, tick: async () => { for (const t of [...timers]) t(); await new Promise((r) => setTimeout(r, 10)); } };
  }
  it("tick on growth with the Log off", async () => {
    const r = rig({ v: "standard" });
    await r.s.steps("w", { chat: true, watch: true });
    expect(r.s.watched()).toBe(1);
    writeFileSync(r.f, readFileSync(r.f, "utf8") + JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "more" }] } }) + "\n");
    await r.tick();
    expect(r.emits).toContain("steps_tick");
  });
  it("the Log tab being turned off does not end a chat's watch; tool_progress going off does", async () => {
    const level = { v: "standard" as "off" | "standard" | "verbose" };
    const r = rig(level, { v: true });
    await r.s.steps("w", { watch: true });                 // the Log's own watch
    await r.s.steps("w", { chat: true, watch: true });     // and a chat's, on the same transcript
    expect(r.s.watched()).toBe(1);
    r.s.unwatchAll(false);                                  // the Log was switched off
    expect(r.s.watched()).toBe(1);
    level.v = "off";
    await r.tick();
    expect(r.s.watched()).toBe(0);
  });
  it("AGEND-210: the chat reading tool_progress off lets go of its own hold only — the Log tab's watch stays live", async () => {
    const level = { v: "standard" as "off" | "standard" | "verbose" };
    const r = rig(level, { v: true });
    await r.s.steps("w", { watch: true });                 // the Log tab is watching
    await r.s.steps("w", { chat: true, watch: true });     // a chat too, on the same transcript
    level.v = "off";
    const off = await r.s.steps("w", { chat: true, watch: true });
    expect(off).toMatchObject({ enabled: true, level: "off", steps: [] });
    expect(r.s.watched()).toBe(1);                         // before the fix: 0 — the Log's watch was torn down with it
    writeFileSync(r.f, readFileSync(r.f, "utf8") + JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "more" }] } }) + "\n");
    await r.tick();
    expect(r.emits).toContain("steps_tick");               // and it still ticks for the Log
    r.s.unwatchAll(false);                                  // the Log tab lets go: now nobody holds it
    expect(r.s.watched()).toBe(0);
  });
  it("AGEND-210 (the counter-proof): a chat alone reading off ends the watch; the Log's watch is not kept by a chat that left", async () => {
    const level = { v: "standard" as "off" | "standard" | "verbose" };
    const r = rig(level, { v: true });
    await r.s.steps("w", { chat: true, watch: true });
    expect(r.s.watched()).toBe(1);
    level.v = "off";
    await r.s.steps("w", { chat: true, watch: true });
    expect(r.s.watched()).toBe(0);                         // nobody else held it
    // Log + chat: the chat leaves, then the Log is switched off — the chat's gone flag does not keep the watch alive.
    level.v = "standard";
    const r2 = rig(level, { v: true });
    await r2.s.steps("w", { watch: true });
    await r2.s.steps("w", { chat: true, watch: true });
    level.v = "off";
    await r2.s.steps("w", { chat: true, watch: true });
    r2.s.unwatchAll(false);
    expect(r2.s.watched()).toBe(0);
  });
});

describe("an instance's effective tool_progress: its own, else the fleet default, else off", () => {
  const level = (config: Record<string, unknown>, name = "w") => {
    const fm = new FleetManager(temp());
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, ...config };
    return (fm as unknown as { chatToolProgress(n: string): string }).chatToolProgress(name);
  };
  it.each([
    ["its own wins over the default", { instances: { w: { working_directory: "/w", tool_progress: "verbose" } }, defaults: { tool_progress: "standard" } }, "verbose"],
    ["the fleet default", { instances: { w: { working_directory: "/w" } }, defaults: { tool_progress: "standard" } }, "standard"],
    ["its own off is off, whatever the default", { instances: { w: { working_directory: "/w", tool_progress: "off" } }, defaults: { tool_progress: "verbose" } }, "off"],
    ["nothing set: off", { instances: { w: { working_directory: "/w" } } }, "off"],
    ["junk is off", { instances: { w: { working_directory: "/w", tool_progress: "loud" } } }, "off"],
    ["an instance that is not there: off (the default does not make one)", { instances: {}, defaults: {} }, "off"],
  ])("%s", (_n, config, want) => { expect(level(config as never)).toBe(want); });
});

describe("thinking is off by default, and while it is off Claude's settings are left alone", () => {
  it("only an exact true is on", () => {
    expect(thinkingOn(undefined)).toBe(false);
    expect(thinkingOn(null)).toBe(false);
    expect(thinkingOn({})).toBe(false);
    expect(thinkingOn({ log_thinking: false })).toBe(false);
    expect(thinkingOn({ log_thinking: "yes" })).toBe(false);
    expect(thinkingOn({ log_thinking: true })).toBe(true);
  });
  const config = (): InstanceConfig => ({
    working_directory: "/tmp/test", restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 }, log_level: "info", backend: "claude-code",
  } as InstanceConfig);
  /** The launch settings file the daemon's own backend config produces. */
  function launched(setter?: () => boolean): Record<string, unknown> {
    const dir = temp();
    const daemon = new Daemon("w", config(), dir, false, createBackend("claude-code", dir), undefined, pino({ level: "silent" }) as Logger);
    if (setter) daemon.setThinkingSummaries(setter);
    const built = (daemon as unknown as { buildBackendConfig(): Record<string, unknown> }).buildBackendConfig();
    new ClaudeCodeBackend(dir).writeConfig({ ...built, workingDirectory: dir, instanceDir: dir, instanceName: "w", mcpServers: {} } as never);
    return JSON.parse(readFileSync(join(dir, "claude-settings.json"), "utf8"));
  }
  it("never set up, or set up off (the default): showThinkingSummaries is not written at all", () => {
    expect(launched()).not.toHaveProperty("showThinkingSummaries");
    expect(launched(() => thinkingOn({}))).not.toHaveProperty("showThinkingSummaries");
    expect(launched(() => thinkingOn({ log_thinking: false }))).not.toHaveProperty("showThinkingSummaries");
  });
  it("switched on: written (from the next launch)", () => {
    expect(launched(() => thinkingOn({ log_thinking: true })).showThinkingSummaries).toBe(true);
  });
  it("the keys the daemon writes are the same with it off as with no switch at all (nothing else changes)", () => {
    expect(Object.keys(launched(() => false)).sort()).toEqual(Object.keys(launched()).sort());
  });
});
