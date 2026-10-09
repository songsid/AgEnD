import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle } from "./helpers/mini-dom.js";
import type { AppPage } from "./helpers/app-harness.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { csrfTokenFor } from "../src/web-session.js";

/**
 * Web track C4 (C-1 + C-3) — the fleet's own prompts (hang, clean exit, interactive prompt) answerable from
 * the web dashboard as on Telegram: one nonce, one claim, whoever answers first wins; a dashboard click is
 * good only for a prompt offered there, about the instance the page named, with one of its own answers.
 * And a fleet with no chat platform at all gets its agents' replies in the web chat. Expectations by hand.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "c4-")); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

// ── the fleet ───────────────────────────────────────────────────────────────────────────────────────────────

async function fleet() {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(dir);
  const any = fm as unknown as Record<string, any>;
  const events: Array<{ event: string; data: any }> = [];
  vi.spyOn(fm, "emitSseEvent").mockImplementation((event: string, data: unknown) => { events.push({ event, data }); });
  const edits: Array<[string, string, string]> = [];
  let nextMessage = 100;
  const adapter = {
    id: "tg", type: "telegram",
    notifyAlert: async (chatId: string) => ({ chatId, messageId: String(nextMessage++), threadId: "7" }),
    editMessageRemoveButtons: async (chatId: string, messageId: string, text: string) => { edits.push([chatId, messageId, text]); },
    sendText: async () => ({ chatId: "-100", messageId: "999" }),
    editMessage: async () => {},
  };
  vi.spyOn(fm, "isFleetAdmin").mockImplementation((userId: string) => userId === "42");
  const post = (prefix: string, instanceName = "w", choices = [{ action: "restart", label: "Restart" }, { action: "wait", label: "Wait" }]) =>
    any.postNonceButtonPromptOrThrow({
      prefix, alertType: "hang", instanceName, adapter, adapterId: "tg", chatId: "-100", threadId: "7",
      message: `${instanceName} looks hung`, choices, expiredText: `${instanceName}: expired`,
    }) as Promise<string>;
  // A Telegram click on the prompt's own message.
  const tgClick = (nonce: string, action: string, messageId: string, userId = "42", extra: Record<string, unknown> = {}) =>
    any.dispatchAdapterCallback({ callbackData: `hang:${nonce}:${action}`, chatId: "-100", threadId: "7", messageId, userId, ack() {}, ...extra }, "tg", adapter);
  return { fm, any, events, edits, post, tgClick, adapter };
}

describe("a fleet prompt is offered on the dashboard too", () => {
  it("hang / exit-restart / interactive-assist: once posted, with its text and its answers — the nonce only in the event", async () => {
    const { fm, events, post } = await fleet();
    const before = Date.now();
    const nonce = await post("hang:");
    const shown = events.filter(e => e.event === "prompt");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.data).toEqual({
      instance: "w", nonce, text: "w looks hung",
      actions: [{ id: "restart", label: "Restart" }, { id: "wait", label: "Wait" }],
      expiresAt: expect.any(Number),
    });
    expect(shown[0]!.data.expiresAt - before).toBeGreaterThanOrEqual(15 * 60_000);
    expect(shown[0]!.data.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // Nothing about where it lives on the platform.
    expect(JSON.stringify(shown[0]!.data)).not.toMatch(/-100|telegram|"tg"/);
    await post("exit-restart:");
    await post("interactive-assist:");
    expect(fm.listWebPrompts().map(p => p.instance)).toEqual(["w", "w", "w"]);
    // The chat history never holds a prompt.
    expect(fm.webChatHistory.lastId).toBe(0);
  });

  it.each(["clear-confirm:", "login:", "login-confirm:", "classic-approve:", "tip-dismiss:", "tip-unlock:"])(
    "%s stays where it was asked", async (prefix) => {
      const { fm, events, post } = await fleet();
      await post(prefix);
      expect(events.filter(e => e.event === "prompt")).toEqual([]);
      expect(fm.listWebPrompts()).toEqual([]);
    });

  it("a prompt that could not be posted is never offered", async () => {
    const { fm, events, any, adapter } = await fleet();
    adapter.notifyAlert = async () => { throw new Error("Telegram down"); };
    await expect(any.postNonceButtonPromptOrThrow({
      prefix: "hang:", alertType: "hang", instanceName: "w", adapter, adapterId: "tg", chatId: "-100",
      message: "m", choices: [{ action: "wait", label: "Wait" }], expiredText: "x",
    })).rejects.toThrow("Telegram down");
    expect(events).toEqual([]);
    expect(fm.listWebPrompts()).toEqual([]);
  });
});

describe("FleetManager.clickWebPrompt", () => {
  it("answers it as the platform click would: claimed once, the platform's buttons collapse to the outcome, every page told", async () => {
    const { fm, events, edits, post } = await fleet();
    const nonce = await post("hang:");
    expect(await fm.clickWebPrompt("w", nonce, "wait")).toEqual({ status: 200 });
    expect(edits).toEqual([["-100", "100", expect.stringContaining("w")]]);
    const resolved = events.filter(e => e.event === "prompt_resolved").map(e => e.data);
    expect(resolved[0]).toEqual({ instance: "w", nonce });
    expect(resolved.at(-1)).toEqual({ instance: "w", nonce, outcome: edits[0]![2] });
    expect(fm.listWebPrompts()).toEqual([]);
    expect(await fm.clickWebPrompt("w", nonce, "wait"), "twice").toMatchObject({ status: 409 });
  });

  it("restart on the dashboard restarts that instance", async () => {
    const { fm, any, post } = await fleet();
    const restarted: string[] = [];
    any.restartSingleInstance = async (n: string) => { restarted.push(n); };
    const nonce = await post("hang:");
    const result = await fm.clickWebPrompt("w", nonce, "restart");
    expect(result.status).toBe(200);
    expect(restarted).toEqual(["w"]);
  });

  it("refuses — and leaves open — another instance's prompt, an answer it does not have, a malformed one", async () => {
    const { fm, post } = await fleet();
    const nonce = await post("hang:");
    expect(await fm.clickWebPrompt("other", nonce, "wait")).toEqual({ status: 403, error: "This prompt belongs to another instance" });
    expect(await fm.clickWebPrompt("w", nonce, "ignore")).toEqual({ status: 400, error: "Not one of this prompt's answers" });
    for (const [n, a] of [["../x", "wait"], [nonce.toUpperCase(), "wait"], [nonce + "0", "wait"], [nonce, "WAIT"], [nonce, "wait:restart"], [nonce, ""]]) {
      expect((await fm.clickWebPrompt("w", n!, a!)).status, `${n} ${a}`).toBe(400);
    }
    expect(fm.listWebPrompts()).toHaveLength(1);
    expect((await fm.clickWebPrompt("w", "f".repeat(32), "wait")).status, "unknown").toBe(409);
    expect((await fm.clickWebPrompt("w", nonce, "wait")).status, "still answerable").toBe(200);
  });

  it("a prompt that was not offered on the dashboard cannot be answered from it, even by its nonce", async () => {
    const { fm, any, post } = await fleet();
    const nonce = await post("clear-confirm:", "w", [{ action: "confirm", label: "Clear" }]);
    expect(await fm.clickWebPrompt("w", nonce, "confirm")).toMatchObject({ status: 409 });
    // And underneath the route's own check: a dashboard click reaching the handler still is not good for it.
    const data = { callbackData: `clear-confirm:${nonce}:confirm`, chatId: "-100", threadId: "7", messageId: "100", userId: "web-user", ack() {} };
    any.webPromptClicks.add(data);
    const claimed = any.consumeNonceCallback("clear-confirm:", /^clear-confirm:([0-9a-f]+):(confirm|cancel)$/, data, "tg");
    expect(claimed).toBe("consumed");
    expect(any.pendingNonceButtons.has(nonce), "still open for the platform's admin").toBe(true);
  });

  it("whoever answers first wins: Telegram first, then the dashboard is told it is gone — and the other way round", async () => {
    const a = await fleet();
    const n1 = await a.post("hang:");
    await a.tgClick(n1, "wait", "100");
    expect(a.events.some(e => e.event === "prompt_resolved" && e.data.nonce === n1), "the page is told").toBe(true);
    expect(await a.fm.clickWebPrompt("w", n1, "wait")).toMatchObject({ status: 409 });

    const b = await fleet();
    const n2 = await b.post("hang:");
    expect((await b.fm.clickWebPrompt("w", n2, "wait")).status).toBe(200);
    const restarted: string[] = [];
    b.any.restartSingleInstance = async (n: string) => { restarted.push(n); };
    await b.tgClick(n2, "restart", "100");
    expect(restarted, "the late Telegram click does nothing").toEqual([]);
  });

  it("two dashboard clicks at once: exactly one is answered", async () => {
    const { fm, post } = await fleet();
    const nonce = await post("hang:");
    const results = await Promise.all([fm.clickWebPrompt("w", nonce, "wait"), fm.clickWebPrompt("w", nonce, "wait"), fm.clickWebPrompt("w", nonce, "restart")]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409, 409]);
  });

  it("nothing an adapter sends can pass for a dashboard click", async () => {
    const { fm, post, tgClick } = await fleet();
    const nonce = await post("hang:");
    // A non-admin on Telegram, with whatever the payload says about itself.
    await tgClick(nonce, "wait", "100", "7", { web: true, webSession: true, fromWeb: true, source: "web" });
    await tgClick(nonce, "wait", "100", "web-user");
    expect(fm.listWebPrompts(), "still open").toHaveLength(1);
    // The admin's click works as before.
    await tgClick(nonce, "wait", "100", "42");
    expect(fm.listWebPrompts()).toEqual([]);
  });

  it("an expired prompt, or one whose instance stopped, leaves every page with its closing line", async () => {
    vi.useFakeTimers();
    const { fm, any, events, post } = await fleet();
    const n1 = await post("hang:");
    vi.advanceTimersByTime(15 * 60_000);
    expect(events.find(e => e.event === "prompt_resolved" && e.data.nonce === n1)!.data).toEqual({ instance: "w", nonce: n1, outcome: "w: expired" });
    const n2 = await post("exit-restart:", "v");
    fm.clearNoncePromptsForInstance("v");
    expect(events.find(e => e.event === "prompt_resolved" && e.data.nonce === n2)!.data).toEqual({ instance: "v", nonce: n2, outcome: "v: expired" });
    const n3 = await post("hang:", "u");
    await any.retirePendingNoncePrompts(10);
    expect(events.find(e => e.event === "prompt_resolved" && e.data.nonce === n3)!.data.outcome).toBe("u: expired");
    expect(fm.listWebPrompts()).toEqual([]);
  });
});

// ── C-3: a fleet with no chat platform ─────────────────────────────────────────────────────────────────────

describe("instance-health prompts on a web-only fleet (#1307 item 6)", () => {
  // No chat platform: the dashboard is the only place to ask. Same nonce, same claim, same handlers.
  async function webOnlyFleet(instances: Record<string, unknown> = { w: { working_directory: "/tmp" } }) {
    const f = await fleet();
    f.any.fleetConfig = { instances };
    f.any.setTopicIcon = () => {};
    f.any.notifyInstanceTopic = () => {};
    return f;
  }
  const offered = (events: Array<{ event: string; data: any }>) => events.filter(e => e.event === "prompt").map(e => e.data);

  it("a hang is asked on the dashboard, and Keep waiting / Force restart answer it there", async () => {
    const { fm, any, events } = await webOnlyFleet();
    const restarted: string[] = [];
    any.restartSingleInstance = async (n: string) => { restarted.push(n); };
    await fm.sendHangNotification("w", 20 * 60_000);
    const [p] = offered(events);
    expect(p).toMatchObject({ instance: "w", actions: [{ id: "restart" }, { id: "wait" }] });
    expect(p.text).toContain("w");
    expect(fm.listWebPrompts()).toHaveLength(1);
    expect(await fm.clickWebPrompt("w", p.nonce, "restart")).toEqual({ status: 200 });
    expect(restarted).toEqual(["w"]);
    expect(events.filter(e => e.event === "prompt_resolved").at(-1)!.data).toMatchObject({ instance: "w", nonce: p.nonce, outcome: expect.any(String) });
    expect(fm.listWebPrompts()).toEqual([]);
  });

  it("a clean exit offers Restart / Ignore there, with no General needed", async () => {
    const { fm, any, events } = await webOnlyFleet();
    const restarted: string[] = [];
    any.restartSingleInstance = async (n: string) => { restarted.push(n); };
    await fm.notifyNormalExit("w");
    const [p] = offered(events);
    expect(p.actions.map((a: { id: string }) => a.id)).toEqual(["restart", "ignore"]);
    expect(await fm.clickWebPrompt("w", p.nonce, "restart")).toEqual({ status: 200 });
    expect(restarted).toEqual(["w"]);
  });

  it("an interactive prompt is offered when there is a General to help; Confirm asks it", async () => {
    const { fm, any, events } = await webOnlyFleet({ w: { working_directory: "/tmp" }, g: { working_directory: "/tmp", general_topic: true } });
    any.daemons.set("g", {});
    const delivered: Array<[string, any]> = [];
    any.deliverToInstance = async (n: string, m: unknown) => { delivered.push([n, m]); return true; };
    await fm.notifyInteractivePrompt("w", "permission");
    const [p] = offered(events);
    expect(p.actions.map((a: { id: string }) => a.id)).toEqual(["confirm", "cancel"]);
    expect(await fm.clickWebPrompt("w", p.nonce, "confirm")).toEqual({ status: 200 });
    expect(delivered.map(d => d[0])).toEqual(["g"]);
    expect(delivered[0]![1].meta).toMatchObject({ chat_id: "web", adapter_id: "web", source: "web" });
  });

  it("an interactive prompt with no General to help is not offered (nobody could act on Confirm)", async () => {
    const { fm, events } = await webOnlyFleet();
    await fm.notifyInteractivePrompt("w", "permission");
    expect(offered(events)).toEqual([]);
  });

  it("a fleet that has a chat platform configured is untouched: no adapter for it, no prompt anywhere", async () => {
    const { fm, any, events } = await fleet();
    any.fleetConfig = { channel: { type: "telegram", bot_token_env: "X", group_id: 1 }, instances: { w: { working_directory: "/tmp" } } };
    any.setTopicIcon = () => {}; any.notifyInstanceTopic = () => {};
    await fm.sendHangNotification("w");
    await fm.notifyNormalExit("w");
    expect(offered(events)).toEqual([]);
  });
});

describe("replies on a web-only fleet", () => {
  async function outbound(fleetConfig: unknown, msg: Record<string, unknown>) {
    const { fm, any, events } = await fleet();
    any.fleetConfig = fleetConfig;
    const sent: any[] = [];
    any.instanceIpcClients.set("w", { send: (m: unknown) => { sent.push(m); return true; } });
    any.getInstanceIdle = () => true; any.clearCancelButton = () => {}; any.reactDone = () => {};
    await any.handleOutboundFromInstance("w", { requestId: 1, ...msg });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    return { reply: sent[0], events, fm };
  }
  const webOnly = { instances: { w: { working_directory: "/tmp" } } };

  it("a reply goes to the web chat and the agent is told it was sent", async () => {
    const { reply, events } = await outbound(webOnly, { tool: "reply", args: { text: "done" } });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ chatId: "web", messageId: expect.stringMatching(/^web-[0-9a-z]+-[0-9a-f]{8}$/) });
    expect(events.filter(e => e.event === "message").map(e => [e.data.instance, e.data.text])).toEqual([["w", "done"]]);
  });

  it("the reply tool's own file rules still apply", async () => {
    const { reply, events } = await outbound(webOnly, { tool: "reply", args: { text: "x", files: Array.from({ length: 21 }, (_, i) => `/tmp/${i}`) } });
    expect(reply.error).toMatch(/too many files/);
    expect(events.filter(e => e.event === "message")).toEqual([]);
  });

  it("a daemon status line shows there too, without the reply bookkeeping", async () => {
    const { reply, events } = await outbound(webOnly, { tool: "reply", statusOnly: true, args: { text: "still on it" } });
    expect(reply.error).toBeUndefined();
    expect(events.filter(e => e.event === "message").map(e => e.data.text)).toEqual(["still on it"]);
  });

  it.each([
    ["a configured channel whose adapter is still starting", { channel: { type: "telegram", bot_token_env: "X" }, instances: {} }, "reply"],
    ["a configured channels list", { channels: [{ type: "discord", bot_token_env: "X" }], instances: {} }, "reply"],
    ["no config yet", null, "reply"],
    ["another channel tool", webOnly, "react"],
  ])("unchanged for %s: retry shortly", async (_n, config, tool) => {
    const { reply, events } = await outbound(config, { tool, args: { text: "x" } });
    expect(reply.error).toBe("Channel adapters are not ready — retry shortly");
    expect(events.filter(e => e.event === "message")).toEqual([]);
  });
});

// ── the routes ─────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = "u".repeat(48);
function call(method: string, url: string, c: WebApiContext, body?: string) {
  const req = Object.assign(new EventEmitter(), { method, url, headers: { "x-agend-token": TOKEN }, destroy() {}, resume() {} });
  const res = Object.assign(new EventEmitter(), {
    status: 0, body: "",
    setHeader() {}, writeHead(s: number) { res.status = s; return res; }, write() { return true; },
    end(chunk?: unknown) { if (chunk) res.body = String(chunk); return res; },
  });
  handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(url, "http://localhost"), c);
  setImmediate(() => { if (body !== undefined) req.emit("data", Buffer.from(body)); req.emit("end"); });
  return vi.waitFor(() => { expect(res.status).not.toBe(0); return { status: res.status, body: res.body ? JSON.parse(res.body) : {} }; });
}
function ctx(over: Record<string, unknown> = {}) {
  const clicks: unknown[][] = [];
  const c = {
    webToken: TOKEN, dataDir: dir, sseClients: new Set(), fleetConfig: { instances: {} }, instanceIpcClients: new Map(), daemons: new Map(),
    adapter: null, logger: { info() {}, debug() {}, error() {} }, eventLog: null, lastInboundUser: new Map(),
    emitSseEvent() {}, getUiStatus: () => ({}),
    listWebPrompts: () => [{ instance: "w", nonce: "a".repeat(32), text: "t", actions: [], expiresAt: 1 }],
    clickWebPrompt: async (...a: unknown[]) => { clicks.push(a); return a[2] === "wait" ? { status: 200 } : { status: 409, error: "gone" }; },
    ...over,
  } as unknown as WebApiContext;
  return { c, clicks };
}

describe("GET /ui/prompts and POST /ui/prompt", () => {
  it("lists the open prompts", async () => {
    const { c } = ctx();
    expect(await call("GET", "/ui/prompts", c)).toEqual({ status: 200, body: { prompts: [{ instance: "w", nonce: "a".repeat(32), text: "t", actions: [], expiresAt: 1 }] } });
    expect(await call("GET", "/ui/prompts", ctx({ listWebPrompts: undefined }).c)).toEqual({ status: 200, body: { prompts: [] } });
  });

  it("GET /ui/poll carries the open prompts too", async () => {
    const { c } = ctx();
    expect((await call("GET", "/ui/poll?after=", c)).body.prompts).toEqual([{ instance: "w", nonce: "a".repeat(32), text: "t", actions: [], expiresAt: 1 }]);
    expect((await call("GET", "/ui/poll?after=", ctx({ listWebPrompts: undefined }).c)).body.prompts).toEqual([]);
  });

  it("passes the answer through, from the body; a gone prompt says so", async () => {
    const { c, clicks } = ctx();
    expect(await call("POST", "/ui/prompt", c, JSON.stringify({ instance: "w", nonce: "b".repeat(32), action: "wait" }))).toEqual({ status: 200, body: { answered: true } });
    expect(await call("POST", "/ui/prompt", c, JSON.stringify({ instance: "w", nonce: "b".repeat(32), action: "restart" }))).toEqual({ status: 409, body: { error: "gone", gone: true } });
    expect(clicks).toEqual([["w", "b".repeat(32), "wait"], ["w", "b".repeat(32), "restart"]]);
  });

  it("anything else is 400 and answers nothing", async () => {
    const { c, clicks } = ctx();
    for (const body of ["not json", "null", "[]", "5", JSON.stringify({ instance: "w", nonce: 5, action: "wait" }), JSON.stringify({ nonce: "b".repeat(32), action: "wait" })]) {
      expect((await call("POST", "/ui/prompt", c, body)).status, body).toBe(400);
    }
    expect(clicks).toEqual([]);
    expect((await call("POST", "/ui/prompt", ctx({ clickWebPrompt: undefined }).c, "{}")).status).toBe(404);
  });

  it("refusals other than gone carry no `gone`", async () => {
    const { c } = ctx({ clickWebPrompt: async () => ({ status: 403, error: "This prompt belongs to another instance" }) });
    expect(await call("POST", "/ui/prompt", c, JSON.stringify({ instance: "x", nonce: "b".repeat(32), action: "wait" })))
      .toEqual({ status: 403, body: { error: "This prompt belongs to another instance" } });
  });
});

interface Res { status: number; body: string; setCookie: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = "";
      res.on("data", (ch: Buffer) => { text += ch.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, setCookie: String(res.headers["set-cookie"] ?? "") }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe("POST /ui/prompt through the real gate", () => {
  it("a session alone is not enough: same origin and the session's CSRF token, or nothing is answered", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir);
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    const click = vi.spyOn(fm, "clickWebPrompt").mockImplementation(async () => ({ status: 200 }));
    (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
    (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
    const server = (fm as unknown as { healthServer: Server }).healthServer;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    const port = address.port, origin = `http://127.0.0.1:${port}`;
    try {
      const login = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin }, JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
      const cookie = login.setCookie.split(";")[0]!, csrf = csrfTokenFor(cookie.split("=")[1]!);
      const body = JSON.stringify({ instance: "w", nonce: "c".repeat(32), action: "wait" });
      const json = { "content-type": "application/json" };
      expect((await raw(port, "POST", "/ui/prompt", { ...json, origin }, body)).status, "no session").toBe(401);
      expect((await raw(port, "POST", "/ui/prompt", { ...json, origin, cookie }, body)).status, "no CSRF token").toBe(403);
      expect((await raw(port, "POST", "/ui/prompt", { ...json, origin: "http://evil.example", cookie, "x-agend-csrf": csrf }, body)).status, "cross-origin").toBe(403);
      expect((await raw(port, "GET", "/ui/prompts", {})).status, "listing needs a session too").toBe(401);
      expect(click).not.toHaveBeenCalled();
      expect((await raw(port, "POST", "/ui/prompt", { ...json, origin, cookie, "x-agend-csrf": csrf }, body)).status).toBe(200);
      expect(click).toHaveBeenCalledWith("w", "c".repeat(32), "wait");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      (fm as unknown as { healthServer: Server | null }).healthServer = null;
    }
  }, 30_000);
});

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────

/** The app's stream as the chat hears it: `emit` is one frame, already parsed (app-stream.js parses before it emits). */
function fakeStream() {
  const subs = new Map<string, Array<(d: any, extra?: unknown) => void>>();
  return {
    on(name: string, fn: (d: any, extra?: unknown) => void) { subs.set(name, [...(subs.get(name) ?? []), fn]); return () => {}; },
    emit(name: string, d: any, extra?: unknown) { for (const fn of subs.get(name) ?? []) fn(d, extra); },
  };
}
/** The page's fetch: every call recorded; `respond` answers it (assign a new one to change the answer). */
function fetchMock() {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const mock = {
    calls,
    respond: (_path: string, _body?: any): unknown => ({}),
    fn: async (path: string, o: { method?: string; body?: string } = {}) => {
      const body = o.body ? JSON.parse(o.body) : undefined;
      calls.push({ path, method: o.method ?? "GET", body });
      const value = await mock.respond(path, body);
      return { ok: true, status: 200, json: async () => value };
    },
  };
  return mock;
}
const load = (path: string): Promise<any> => import(path);
const inst = (name: string, over: Record<string, unknown> = {}) => ({ name, status: "running", state: "idle", backend: "claude-code", ...over });
const frame = (...instances: Array<Record<string, unknown>>) => ({ uptime: 1, instances });

describe("the chat panel's prompts (the real page modules)", () => {
  const pages: AppPage[] = [];
  afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } });

  /** A page with the app's modules: the store booted on a stream (fake, or the real one over poll or SSE), <ChatPanel>
   *  mounted into <main id="main"> as the shell does. vi.resetModules() first: boot runs once per module instance. */
  async function chatPage(kind: "fake" | "poll" | "events" = "fake") {
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    const p = harness.page();
    pages.push(p);
    const app = await load("/assets/app-store.js");
    const panel = await load("/ui/js/panel-chat.js");
    const fx = fetchMock();
    const toasts: Array<[string, boolean]> = [];
    const timers: Array<() => void> = [];        // the store's 60-second clocks: recorded, never run here
    const sources: any[] = [];                   // the EventSource(s) the real stream opened
    const clock = (f: () => void) => { timers.push(f); return timers.length; };
    const env = {
      fetch: fx.fn, setTimeout: clock, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      EventSource: class { listeners = new Map<string, (e: { data: string; lastEventId?: string }) => void>(); constructor() { sources.push(this); } addEventListener(n: string, f: any) { this.listeners.set(n, f); } close() {} },
    };
    const stream: any = kind === "fake" ? fakeStream() : (await load("/assets/app-stream.js")).createStream({ mode: "full", transport: kind === "poll" ? "poll" : undefined, env });
    stream.on("status", app.applyStatus);        // app.js wires these two before the chat boots
    stream.on("activity", app.applyActivity);
    panel.boot({ stream, boot: null, deps: { fetch: fx.fn, toast: (m: string, ok = true) => { toasts.push([m, ok]); }, setTimeout: clock } });
    const mount = (name: string) => p.mount(harness.h("main", { id: "main" }, harness.h(panel.ChatPanel, { route: { panel: "chat", instance: name }, navKey: `chat|${name}` })));
    return { p, fx, toasts, timers, stream, sources, app, panel, mount, store: () => panel.store as any };
  }

  const NONCE = "d".repeat(32);
  const posts = (c: { fx: { calls: Array<{ method: string }> } }) => c.fx.calls.filter(x => x.method === "POST");
  /** The offered prompt: two answers, as the platform would show them. */
  const offer = (c: { stream: any }, instance = "w", text = "w looks hung") =>
    c.stream.emit("prompt", { instance, nonce: NONCE, text, actions: [{ id: "restart", label: "Restart" }, { id: "wait", label: "Wait" }], expiresAt: 1 });
  const cards = (c: { p: AppPage }) => c.p.root.querySelectorAll(".prompts > .prompt");
  const buttons = (card: any) => card.querySelectorAll(".acts button");
  const txt = (card: any) => card.querySelector(".txt").textContent;

  it("shows the prompt in its instance's chat: its text and one button per answer, as text", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    offer(c, "w", "<img src=x onerror=alert(1)> looks hung");
    await settle();
    expect(cards(c)).toHaveLength(1);
    const card = cards(c)[0];
    expect([card.getAttribute("role"), card.getAttribute("aria-label")]).toEqual(["group", "<img src=x onerror=alert(1)> looks hung"]);
    expect(txt(card)).toBe("<img src=x onerror=alert(1)> looks hung");
    expect(buttons(card).map((b: any) => [b.textContent, b.type])).toEqual([["Restart", "button"], ["Wait", "button"]]);
    expect(card.querySelector("img"), "the text is text, never markup").toBeNull();
  });

  it("another instance's prompt is announced, not shown here — not even when this chat re-renders", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w"), inst("other")));
    await c.mount("w");
    offer(c, "other", "other looks hung");
    await settle();
    expect(cards(c)).toHaveLength(0);
    expect(c.toasts).toEqual([["other: other looks hung", false]]);
    c.stream.emit("prompt", { instance: "w", nonce: "f".repeat(32), text: "w exited", actions: [{ id: "restart", label: "Restart" }], expiresAt: 1 });
    await settle();
    expect(cards(c).map((k: any) => txt(k))).toEqual(["w exited"]);
  });

  it("the answer names the prompt's own instance, whatever chat is open by the time it is clicked", async () => {
    const c = await chatPage();
    c.fx.respond = () => ({ answered: true });
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    offer(c);
    await settle();
    c.store().setCurrent("v");
    fire(buttons(cards(c)[0])[1], "click");
    await settle();
    expect(posts(c)).toEqual([{ method: "POST", path: "/ui/prompt", body: { instance: "w", nonce: NONCE, action: "wait" } }]);
  });

  it("a click posts the answer for that prompt, then waits for the outcome; the outcome replaces the buttons", async () => {
    const c = await chatPage();
    c.fx.respond = () => ({ answered: true });
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    offer(c);
    await settle();
    fire(buttons(cards(c)[0])[1], "click");
    await settle();
    expect(posts(c)).toEqual([{ method: "POST", path: "/ui/prompt", body: { instance: "w", nonce: NONCE, action: "wait" } }]);
    expect(buttons(cards(c)[0]).every((b: any) => b.disabled)).toBe(true);
    expect(cards(c)[0].querySelector(".acts .wait").textContent).toBe("Answering…");
    c.stream.emit("prompt_resolved", { instance: "w", nonce: NONCE });
    await settle();
    c.stream.emit("prompt_resolved", { instance: "w", nonce: NONCE, outcome: "Waiting for w" });
    await settle();
    expect(cards(c)[0].className).toBe("prompt done");
    expect(cards(c)[0].children.map((k: any) => k.textContent)).toEqual(["Waiting for w"]);
    // A resolved prompt cannot be answered again.
    await c.store().answerPrompt(c.store().state.prompts[NONCE], "wait");
    expect(posts(c)).toHaveLength(1);
  });

  it("answered elsewhere first: the buttons go and the page says why; any other refusal keeps them", async () => {
    const c = await chatPage();
    c.fx.respond = () => ({ error: "This prompt belongs to another instance" });
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    offer(c);
    await settle();
    fire(buttons(cards(c)[0])[0], "click");
    await settle();
    expect(buttons(cards(c)[0]).map((b: any) => b.disabled)).toEqual([false, false]);
    expect(c.toasts.at(-1)).toEqual(["This prompt belongs to another instance", false]);
    c.fx.respond = () => ({ error: "already answered on Telegram", gone: true });
    fire(buttons(cards(c)[0])[0], "click");
    await settle();
    expect(cards(c)[0].className).toBe("prompt done");
    expect(txt(cards(c)[0])).toBe("This prompt is no longer open");
  });

  it("the open prompts (sent on each stream connect, and with each poll): new ones appear, ones no longer open lose their buttons", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    offer(c);
    await settle();
    c.stream.emit("prompts", [{ instance: "w", nonce: "e".repeat(32), text: "w exited", actions: [{ id: "restart", label: "Restart" }], expiresAt: 1 }]);
    await settle();
    expect(cards(c).map((k: any) => [k.className, txt(k)])).toEqual([["prompt done", "This prompt is no longer open"], ["prompt", "w exited"]]);
  });

  it("a snapshot arriving while an answer is on its way keeps that prompt answering — its buttons stay off", async () => {
    const c = await chatPage();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    c.fx.respond = async () => { await gate; return { answered: true }; };
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    offer(c);
    await settle();
    fire(buttons(cards(c)[0])[0], "click");
    await settle();
    expect(buttons(cards(c)[0]).map((b: any) => b.disabled)).toEqual([true, true]);
    c.stream.emit("prompts", [{ instance: "w", nonce: NONCE, text: "w looks hung", actions: [{ id: "restart", label: "Restart" }, { id: "wait", label: "Wait" }], expiresAt: 1 }]);
    await settle();
    expect(buttons(cards(c)[0]).map((b: any) => b.disabled), "still answering").toEqual([true, true]);
    release();
    await settle();
    expect(buttons(cards(c)[0]).map((b: any) => b.disabled), "answered: it waits for the outcome, buttons stay off").toEqual([true, true]);
  });

  it.each<[string, () => unknown, string]>([
    ["the request fails (network)", () => Promise.reject(new Error("Failed to fetch")), "buttons back"],
    ["it is refused", () => ({ error: "This prompt belongs to another instance" }), "buttons back"],
    ["it was answered elsewhere first", () => ({ error: "gone", gone: true }), "resolved"],
  ])("a snapshot arrives while an answer is on its way, then %s: the prompt on screen is settled (#1282 review)", async (_why, reply, outcome) => {
    const c = await chatPage();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    c.fx.respond = async () => { await gate; return reply(); };
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    offer(c);
    await settle();
    fire(buttons(cards(c)[0])[0], "click");
    await settle();
    // The poll / a reconnect still lists the prompt while the answer is in flight.
    c.stream.emit("prompts", [{ instance: "w", nonce: NONCE, text: "w looks hung", actions: [{ id: "restart", label: "Restart" }, { id: "wait", label: "Wait" }], expiresAt: 1 }]);
    await settle();
    release();
    await settle();
    if (outcome === "buttons back") {
      expect(cards(c)[0].className).toBe("prompt");
      expect(buttons(cards(c)[0]).map((b: any) => b.disabled), "the buttons can be pressed again").toEqual([false, false]);
      // …and a retry goes out.
      c.fx.respond = () => ({ answered: true });
      fire(buttons(cards(c)[0])[1], "click");
      await settle();
      expect(buttons(cards(c)[0]).map((b: any) => b.disabled)).toEqual([true, true]);
    } else {
      expect(cards(c)[0].className).toBe("prompt done");
      // A later snapshot that still lists it (stale) never reopens it.
      c.stream.emit("prompts", [{ instance: "w", nonce: NONCE, text: "w looks hung", actions: [{ id: "wait", label: "Wait" }], expiresAt: 1 }]);
      await settle();
      expect(cards(c)[0].className).toBe("prompt done");
    }
  });

  it("each layer on its own: a snapshot keeps the very object an answer holds; a response settles whatever object holds the nonce now", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    offer(c);
    await settle();
    const held = c.store().state.prompts[NONCE];
    c.stream.emit("prompts", [{ instance: "w", nonce: NONCE, text: "w looks hung (2)", actions: [{ id: "wait", label: "Wait" }], expiresAt: 2 }]);
    await settle();
    expect(c.store().state.prompts[NONCE], "updated in place, not replaced").toBe(held);
    expect(c.store().state.prompts[NONCE].text).toBe("w looks hung (2)");
    // The response side alone: the object is swapped under an in-flight answer (as an older page did) — still settled.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    c.fx.respond = async () => { await gate; return { error: "Failed" }; };
    fire(buttons(cards(c)[0])[0], "click");
    await settle();
    c.store().state.prompts[NONCE] = { ...c.store().state.prompts[NONCE] };
    release();
    await settle();
    expect(c.store().state.prompts[NONCE].busy).toBe(false);
    expect(buttons(cards(c)[0]).map((b: any) => b.disabled)).toEqual([false]);
  });

  it("a resolved prompt is never reopened by a snapshot that still lists it", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    offer(c);
    await settle();
    c.stream.emit("prompt_resolved", { instance: "w", nonce: NONCE, outcome: "Restarted" });
    await settle();
    c.stream.emit("prompts", [{ instance: "w", nonce: NONCE, text: "w looks hung", actions: [{ id: "wait", label: "Wait" }], expiresAt: 1 }]);
    await settle();
    expect(cards(c)[0].className).toBe("prompt done");
    expect(txt(cards(c)[0])).toBe("Restarted");
  });

  it("polling carries the open prompts: the poll alone catches one up — the page never re-reads /ui/prompts on a timer (#1253 rule)", async () => {
    const c = await chatPage("poll");
    let pollFrame: Record<string, unknown> = { status: frame(inst("w")), messages: [], deliveries: [] };
    c.fx.respond = (path: string) => (path.startsWith("/ui/poll") ? pollFrame : { messages: [] });
    c.stream.start();                                       // the first poll lists the instance (no cursor yet)
    await settle();
    await c.mount("w");
    c.fx.calls.length = 0;                                  // the first visit's own history read is not part of this
    pollFrame = { status: frame(inst("w")), messages: [], cursor: "b-1", deliveries: [], prompts: [{ instance: "w", nonce: NONCE, text: "w looks hung", actions: [{ id: "wait", label: "Wait" }], expiresAt: 1 }] };
    await c.stream._pollOnce();
    await settle();
    expect(c.fx.calls.map((x: { path: string }) => x.path), "one passive poll, nothing else").toEqual(["/ui/poll?after="]);
    expect(cards(c).map((k: any) => txt(k))).toEqual(["w looks hung"]);
  });

  it("a prompt posted while the stream was down is caught up on reconnect — through the real /ui/events handler, with no poll", async () => {
    const c = await chatPage("events");
    const open = [{ instance: "w", nonce: NONCE, text: "w looks hung", actions: [{ id: "wait", label: "Wait" }], expiresAt: 1 }];
    const { c: server } = ctx({ listWebPrompts: () => open, getUiStatus: () => ({ uptime: 1, instances: [inst("w")] }) });
    const writes: string[] = [];
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/events", headers: { "x-agend-token": TOKEN, "last-event-id": "b1-1" }, socket: null });
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead() { return res; }, write(x: string) { writes.push(x); return true; }, end() { return res; } });
    handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL("http://localhost/ui/events"), server);
    res.emit("close");
    const frames = writes.join("").split("\n\n").filter(Boolean).map(f => ({ event: f.match(/^event: (.*)$/m)![1]!, data: f.match(/^data: (.*)$/m)![1]! }));
    expect(frames.map(f => f.event)).toEqual(["status", "prompts"]);
    c.stream.start();
    for (const f of frames) c.sources[0].listeners.get(f.event)?.({ data: f.data });
    await c.mount("w");
    await settle();
    expect(cards(c).map((k: any) => txt(k))).toEqual(["w looks hung"]);
    expect(c.fx.calls.filter((x: { path: string }) => x.path.startsWith("/ui/poll")), "no poll: the stream alone caught it up").toEqual([]);
  });
});
