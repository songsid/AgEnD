import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("the dashboard (the real page script)", () => {
  const RENDER = readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8");
  const PAGE = readFileSync(join(process.cwd(), "src", "ui", "dashboard.html"), "utf8").match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  function el(tag = "div") {
    const node: any = {
      tag, className: "", title: "", type: "", id: "", disabled: false, dataset: {}, children: [] as any[], attrs: {} as Record<string, string>, style: {},
      append(...kids: any[]) { node.children.push(...kids); }, setAttribute(k: string, v: string) { node.attrs[k] = v; }, remove() {},
    };
    let text = "";
    Object.defineProperty(node, "textContent", { get: () => text, set: (v: string) => { text = v; if (v === "") node.children = []; } });
    return node;
  }
  function page() {
    const nodes: Record<string, any> = { prompts: el(), workBar: el(), messages: { innerHTML: "", scrollHeight: 0 }, uptime: { textContent: "" } };
    const sse: Record<string, (e: { data: string }) => void> = {};
    const toasts: Array<[string, boolean]> = [];
    const c = vm.createContext({
      localStorage: { getItem: () => null }, navigator: { language: "en" },
      document: { getElementById: (n: string) => nodes[n] ?? null, createElement: (t: string) => el(t), body: { appendChild() {} } },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      EventSource: class { addEventListener(k: string, f: (e: { data: string }) => void) { sse[k] = f; } },
    });
    vm.runInContext(RENDER, c);
    vm.runInContext(PAGE, c);
    (c as any).captureToast = (m: string, ok: boolean) => toasts.push([m, ok]);
    vm.runInContext('toast=(m,ok=true)=>captureToast(m,ok);renderList=()=>{};renderActions=()=>{};mode="instance";cur="w";curTab="chat";', c);
    return { c, nodes, sse, toasts, read: (s: string) => vm.runInContext(s, c) };
  }
  const NONCE = "d".repeat(32);
  const offer = (p: ReturnType<typeof page>, instance = "w", text = "w looks hung") =>
    p.sse.prompt!({ data: JSON.stringify({ instance, nonce: NONCE, text, actions: [{ id: "restart", label: "Restart" }, { id: "wait", label: "Wait" }], expiresAt: 1 }) });
  const cards = (p: ReturnType<typeof page>) => p.nodes.prompts.children;
  const buttons = (p: ReturnType<typeof page>) => cards(p)[0].children[1]?.children.filter((k: any) => k.tag === "button") ?? [];

  it("shows the prompt in its instance's chat: its text and one button per answer, as text", () => {
    const p = page();
    offer(p, "w", "<img src=x onerror=alert(1)> looks hung");
    expect(cards(p)).toHaveLength(1);
    expect(cards(p)[0].attrs).toEqual({ role: "group", "aria-label": "<img src=x onerror=alert(1)> looks hung" });
    expect(cards(p)[0].children[0].textContent).toBe("<img src=x onerror=alert(1)> looks hung");
    expect(buttons(p).map((b: any) => [b.textContent, b.type])).toEqual([["Restart", "button"], ["Wait", "button"]]);
    expect(cards(p)[0].innerHTML).toBeUndefined();
  });

  it("another instance's prompt is announced, not shown here — not even when this chat re-renders", () => {
    const p = page();
    offer(p, "other", "other looks hung");
    expect(cards(p)).toEqual([]);
    expect(p.toasts).toEqual([["other: other looks hung", false]]);
    p.sse.prompt!({ data: JSON.stringify({ instance: "w", nonce: "f".repeat(32), text: "w exited", actions: [{ id: "restart", label: "Restart" }], expiresAt: 1 }) });
    expect(cards(p).map((k: any) => k.children[0].textContent)).toEqual(["w exited"]);
  });

  it("the answer names the prompt's own instance, whatever chat is open by the time it is clicked", async () => {
    const p = page();
    const calls: unknown[] = [];
    (p.c as any).recordCall = (x: unknown) => calls.push(x);
    p.read('api = async (m, path, body) => { recordCall(body); return { answered: true }; }');
    offer(p);
    const wait = buttons(p)[1];
    p.read('cur = "v"');
    await wait.onclick();
    expect(calls).toEqual([{ instance: "w", nonce: NONCE, action: "wait" }]);
  });

  it("a click posts the answer for that prompt, then waits for the outcome; the outcome replaces the buttons", async () => {
    const p = page();
    const calls: unknown[] = [];
    (p.c as any).recordCall = (x: unknown) => calls.push(x);
    p.read('api = async (m, path, body) => { recordCall([m, path, body]); return { answered: true }; }');
    offer(p);
    await buttons(p)[1].onclick();
    expect(calls).toEqual([["POST", "/ui/prompt", { instance: "w", nonce: NONCE, action: "wait" }]]);
    expect(buttons(p).every((b: any) => b.disabled)).toBe(true);
    expect(cards(p)[0].children[1].children.at(-1).textContent).toBe("Answering…");
    p.sse.prompt_resolved!({ data: JSON.stringify({ instance: "w", nonce: NONCE }) });
    p.sse.prompt_resolved!({ data: JSON.stringify({ instance: "w", nonce: NONCE, outcome: "Waiting for w" }) });
    expect(cards(p)[0].className).toBe("prompt done");
    expect(cards(p)[0].children.map((k: any) => k.textContent)).toEqual(["Waiting for w"]);
    // A resolved prompt cannot be answered again.
    await p.read(`answerPrompt(prompts["${NONCE}"], "wait")`);
    expect(calls).toHaveLength(1);
  });

  it("answered elsewhere first: the buttons go and the page says why; any other refusal keeps them", async () => {
    const p = page();
    p.read('api = async () => ({ error: "This prompt belongs to another instance" })');
    offer(p);
    await buttons(p)[0].onclick();
    expect(buttons(p).map((b: any) => b.disabled)).toEqual([false, false]);
    expect(p.toasts.at(-1)).toEqual(["This prompt belongs to another instance", false]);
    p.read('api = async () => ({ error: "already answered on Telegram", gone: true })');
    await buttons(p)[0].onclick();
    expect(cards(p)[0].className).toBe("prompt done");
    expect(cards(p)[0].children[0].textContent).toBe("This prompt is no longer open");
  });

  it("loading the open prompts: new ones appear, ones no longer open lose their buttons", async () => {
    const p = page();
    offer(p);
    p.read(`api = async () => ({ prompts: [{ instance: "w", nonce: "${"e".repeat(32)}", text: "w exited", actions: [{ id: "restart", label: "Restart" }], expiresAt: 1 }] })`);
    await p.read("loadPrompts()");
    expect(cards(p).map((k: any) => [k.className, k.children[0].textContent])).toEqual([["prompt done", "This prompt is no longer open"], ["prompt", "w exited"]]);
  });
});
