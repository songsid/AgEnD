/**
 * #1269 (3)+(4): an instance's chat commands from the web chat — the server side.
 * - runWebCommand: only the instance commands the topic accepts; the same command table (a scope refusal stands);
 *   the arguments the handlers expect; /clear asks first; the public link refuses /save.
 * - POST /ui/command: validated, signed in, told whether it is the public link; admitted on the public link (POST).
 * - /ui/send: `/raw ` (what the daemon would paste raw) is refused over the public link, allowed locally.
 * - FleetManager.webCommand's /clear: a token per question, used once, expiring, for the instance as it was asked
 *   about (the same fence the platform's Confirm button uses).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runWebCommand, WEB_COMMANDS, type WebCommandDeps } from "../src/web-commands.js";
import { handleWebRequest } from "../src/web-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { FleetManager } from "../src/fleet-manager.js";

function deps(over: Partial<WebCommandDeps> = {}): WebCommandDeps & Record<string, any> {
  const d: any = {
    scope: vi.fn(() => "fleet"),
    ctx: vi.fn(async () => "ctx text"),
    compact: vi.fn(async (_i: string, x?: string) => `compact ${x ?? "-"}`),
    applyModel: vi.fn(async (_i: string, m: string) => `model ${m}`),
    modelChoices: vi.fn(() => ({ current: "a", options: [{ id: "a", label: "✓ A" }, { id: "b", label: "B" }] })),
    applyEffort: vi.fn(async (_i: string, l: string) => `effort ${l}`),
    effortChoices: vi.fn(() => ({ current: "high", options: [{ id: "low", label: "low" }, { id: "high", label: "✓ high" }] })),
    cancel: vi.fn(() => true),
    steer: vi.fn((_i: string, x: string) => `steer ${x}`),
    btw: vi.fn((_i: string, x: string) => `btw ${x}`),
    pauseWake: vi.fn(async (_i: string, a: string) => `${a}d`),
    save: vi.fn(async (_i: string, f: string) => `saved ${f}`),
    clearAsk: vi.fn(() => ({ token: "t".repeat(32), message: "Clear w?" })),
    clearConfirm: vi.fn(async () => ({ status: 200, text: "cleared" })),
    t: (k: string, ...a: string[]) => [k, ...a].join("|"),
    ...over,
  };
  return d;
}
const run = (d: WebCommandDeps, command: string, args?: string, extra: Record<string, unknown> = {}, publicLink = false) =>
  runWebCommand(d, { instance: "w", command, args, ...extra }, { publicLink });

describe("runWebCommand", () => {
  it("only the instance commands: /raw and the fleet-level ones are not commands here", async () => {
    expect([...WEB_COMMANDS].sort()).toEqual(["btw", "cancel", "clear", "compact", "ctx", "effort", "model", "pause", "save", "steer", "wake"]);
    const d = deps();
    for (const c of ["raw", "/raw", "status", "restart", "update", "login", "collab", "tips", "__proto__", "constructor"]) {
      expect(await run(d, c, "x"), c).toEqual({ status: 400, body: { error: `web.command_unknown|/${c.replace(/^\//, "")}` } });
    }
  });

  it("an unknown instance: 404; the command table's refusal for the instance's scope stands", async () => {
    expect((await run(deps({ scope: () => null }), "ctx")).status).toBe(404);
    // A channel with no agent ("none"): every instance command is refused there by the table.
    const d = deps({ scope: () => "none" });
    expect(await run(d, "compact")).toEqual({ status: 403, body: { error: "classic.no_agent" } });
    expect(d.compact).not.toHaveBeenCalled();
  });

  it("each command reaches its handler with the arguments the topic would give it", async () => {
    const d = deps();
    expect((await run(d, "ctx")).body).toEqual({ text: "ctx text" });
    expect((await run(d, "/compact", "  keep the API notes ")).body).toEqual({ text: "compact keep the API notes" });
    expect((await run(d, "compact")).body).toEqual({ text: "compact -" });
    expect((await run(d, "model", "opus")).body).toEqual({ text: "model opus" });
    expect((await run(d, "effort", "low")).body).toEqual({ text: "effort low" });
    expect((await run(d, "cancel")).body).toEqual({ text: "cancel.sent|w" });
    expect((await run(deps({ cancel: () => false }), "cancel")).body).toEqual({ text: "cancel.not_running|w" });
    expect((await run(d, "steer", "look at main.ts")).body).toEqual({ text: "steer look at main.ts" });
    expect((await run(d, "btw", "what time is it?")).body).toEqual({ text: "btw what time is it?" });
    expect((await run(d, "pause")).body).toEqual({ text: "paused" });
    expect((await run(d, "wake")).body).toEqual({ text: "waked" });
    expect((await run(d, "save", "notes.md")).body).toEqual({ text: "saved notes.md" });
  });

  it("missing or bad arguments: the handler's own usage words, nothing run", async () => {
    const d = deps();
    expect(await run(d, "steer", "  ")).toEqual({ status: 400, body: { error: "steer.usage" } });
    expect(await run(d, "btw")).toEqual({ status: 400, body: { error: "btw.usage" } });
    expect(await run(d, "save")).toEqual({ status: 400, body: { error: "save.usage" } });
    for (const bad of ["../x", "a/b", "a b", "~x"]) expect(await run(d, "save", bad), bad).toEqual({ status: 400, body: { error: "filename.invalid" } });
    expect(d.steer).not.toHaveBeenCalled(); expect(d.btw).not.toHaveBeenCalled(); expect(d.save).not.toHaveBeenCalled();
  });

  it("/model and /effort with nothing after them: the same pick list; no list → say so", async () => {
    const d = deps();
    expect((await run(d, "model")).body.choices).toEqual({ current: "a", options: [{ id: "a", label: "✓ A" }, { id: "b", label: "B" }] });
    expect((await run(d, "effort")).body.choices!.current).toBe("high");
    expect((await run(deps({ modelChoices: () => null }), "model")).body).toEqual({ text: "model.list_unavailable|w" });
    expect(await run(deps({ effortChoices: () => null }), "effort")).toEqual({ status: 400, body: { error: "web.command_no_choices|/effort" } });
  });

  it("/clear asks first (a token), and only the second call — with that token — clears", async () => {
    const d = deps();
    expect(await run(d, "clear")).toEqual({ status: 200, body: { confirm: { token: "t".repeat(32), message: "Clear w?" } } });
    expect(d.clearConfirm).not.toHaveBeenCalled();
    expect(await run(d, "clear", undefined, { confirm: "t".repeat(32) })).toEqual({ status: 200, body: { text: "cleared" } });
    expect(d.clearConfirm).toHaveBeenCalledWith("w", "t".repeat(32));
    expect(await run(deps({ clearAsk: () => ({ refused: "clear.unsupported" }) }), "clear")).toEqual({ status: 409, body: { error: "clear.unsupported" } });
    expect(await run(deps({ clearConfirm: async () => ({ status: 409, text: "menu.click_stale" }) }), "clear", undefined, { confirm: "t".repeat(32) }))
      .toEqual({ status: 409, body: { error: "menu.click_stale" } });
  });

  it("the public link: /save is refused (a file the caller names, written by the CLI); everything else runs as locally", async () => {
    const d = deps();
    expect(await run(d, "save", "notes.md", {}, true)).toEqual({ status: 403, body: { error: "web.command_public_refused|/save" } });
    expect(d.save).not.toHaveBeenCalled();
    for (const c of ["ctx", "compact", "model", "effort", "cancel", "pause", "wake"]) expect((await run(d, c, undefined, {}, true)).status, c).toBe(200);
    expect((await run(d, "steer", "x", {}, true)).status).toBe(200);
    expect((await run(d, "clear", undefined, {}, true)).body.confirm).toBeTruthy();
  });
});

// ── The route ──
const token = "c".repeat(48), pub = "https://sample.trycloudflare.com", exposureId = "a".repeat(32);
/** A POST locally (the header token), or over the public link (a gateway session with its cookie, origin and CSRF). */
function post(path: string, body: unknown, over: Record<string, unknown> = {}, gateway = false) {
  const store = new WebSessionStore();
  let headers: Record<string, string> = { host: "127.0.0.1:19280", "x-agend-token": token, "content-type": "application/json" };
  if (gateway) {
    const s = store.create({ tier: "admin", surface: "gateway", exposureId, label: "phone", tokenEpoch: tokenEpoch(token) });
    headers = { host: "sample.trycloudflare.com", cookie: `__Host-agend_session=${s.sessionId}`, origin: pub, "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" };
  }
  const req = Object.assign(new EventEmitter(), { method: "POST", url: path, headers, destroy: vi.fn(), socket: { destroy: vi.fn() } });
  if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
  let status = 0, text = "";
  const done = new Promise<void>((resolve) => {
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { text = t; resolve(); }, write() { return true; } });
    const ctx = { webToken: token, webSessions: store, logger: { info() {}, debug() {}, error() {} }, sseClients: new Set(), instanceIpcClients: new Map([["w", {}]]), ...over } as any;
    handleWebRequest(req as never, res as never, new URL(path, gateway ? pub : "http://127.0.0.1:19280"), ctx);
    setImmediate(() => { req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body))); req.emit("end"); });
  });
  return done.then(() => ({ status, body: text ? JSON.parse(text) : null }));
}

describe("POST /ui/command", () => {
  it("passes a valid request through — publicLink false here — and answers what the command answered", async () => {
    const webCommand = vi.fn(async () => ({ status: 200, body: { text: "ok" } }));
    expect(await post("/ui/command", { instance: "w", command: "compact", args: "x" }, { webCommand })).toEqual({ status: 200, body: { text: "ok" } });
    expect(webCommand).toHaveBeenCalledWith({ instance: "w", command: "compact", args: "x", confirm: undefined }, { publicLink: false });
  });
  it("rejects what is not a request: names, oversized args, a malformed confirmation", async () => {
    const webCommand = vi.fn(async () => ({ status: 200, body: {} }));
    for (const [b, why] of [[{ instance: "../w", command: "ctx" }, "name"], [{ instance: "w" }, "command"], [{ instance: "w", command: "ctx", args: "x".repeat(4001) }, "args"],
      [{ instance: "w", command: "clear", confirm: "zz" }, "confirm"], [{ instance: "w", command: "ctx", args: 7 }, "args type"]] as const) {
      expect((await post("/ui/command", b, { webCommand })).status, why).toBe(400);
    }
    expect(webCommand).not.toHaveBeenCalled();
    expect((await post("/ui/command", { instance: "w", command: "ctx" })).status).toBe(404);
  });
  it("on the public link: admitted as a POST (not a GET), and told it is the public link", async () => {
    expect(isPublicWebRoute("POST", "/ui/command")).toBe(true);
    expect(isPublicWebRoute("GET", "/ui/command")).toBe(false);
    expect(isPassiveWebRead("POST", "/ui/command")).toBe(false);
    const webCommand = vi.fn(async (_input: unknown, _opts: unknown) => ({ status: 403, body: { error: "no" } }));
    await post("/ui/command", { instance: "w", command: "save", args: "a.md" }, { webCommand }, true);
    expect(webCommand.mock.calls[0]![1]).toEqual({ publicLink: true });
  });
});

describe("/raw over the public link (#1269 decision)", () => {
  const sendCtx = () => {
    const deliverToInstance = vi.fn(async () => true);
    return { deliverToInstance, ctx: { deliverToInstance, fleetConfig: { instances: { w: { working_directory: "/w" } } }, adapter: null,
      lastInboundUser: new Map(), emitSseEvent: vi.fn() } };
  };
  it("refused on the public link — nothing delivered, a clear message; allowed locally", async () => {
    const pub = sendCtx();
    const r = await post("/ui/send", { instance: "w", message: "/raw ls -la" }, pub.ctx, true);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("/raw");
    expect(pub.deliverToInstance).not.toHaveBeenCalled();
    const local = sendCtx();
    const lr = await post("/ui/send", { instance: "w", message: "/raw ls -la" }, local.ctx);
    expect(lr.status, JSON.stringify(lr.body)).toBe(200);
    expect(local.deliverToInstance).toHaveBeenCalledTimes(1);
  });
  it("only what the daemon would paste raw: '/raw' alone, ' /raw x' and '/rawx' are ordinary messages there", async () => {
    for (const m of ["/raw", " /raw x", "/rawx", "please /raw x"]) {
      const pub = sendCtx();
      expect((await post("/ui/send", { instance: "w", message: m }, pub.ctx, true)).status, JSON.stringify(m)).toBe(200);
    }
  });
});

// ── FleetManager.webCommand's /clear ──
describe("the web's /clear: the platform's fence, a token used once", () => {
  function fm(over: Record<string, unknown> = {}) {
    const f: any = Object.create(FleetManager.prototype);
    const owner = { bootId: "boot-1", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 1 };
    const daemon = { getInteractionSnapshot: () => ({ owner }) };
    Object.assign(f, {
      fleetConfig: { instances: { w: { working_directory: "/w" } } }, classicChannels: null,
      instanceIpcClients: new Map([["w", { connected: true }]]),
      lifecycle: { epochOf: () => 3, daemons: new Map([["w", daemon]]) }, getDeliveryEpoch: () => 5, isDeliveryEpochCurrent: () => true, shuttingDown: false,
      eventLog: { insert: vi.fn() }, webClearTokens: new Map(),
      topicCommands: { supportsClear: () => true, sendClear: vi.fn(async () => "clear sent") },
      ...over,
    });
    return f;
  }
  const ask = (f: any) => f.webCommand({ instance: "w", command: "clear" }, { publicLink: false });
  const confirm = (f: any, tok: string, instance = "w") => f.webCommand({ instance, command: "clear", confirm: tok }, { publicLink: false });

  it("ask → token; confirm → cleared, once; the token cannot be used again", async () => {
    const f = fm();
    const a = await ask(f);
    expect(a.status).toBe(200);
    const tok = a.body.confirm.token;
    expect(tok).toMatch(/^[0-9a-f]{32}$/);
    expect(await confirm(f, tok)).toEqual({ status: 200, body: { text: "clear sent" } });
    expect(f.topicCommands.sendClear).toHaveBeenCalledTimes(1);
    expect((await confirm(f, tok)).status).toBe(409);
    expect(f.topicCommands.sendClear).toHaveBeenCalledTimes(1);
  });

  it("a replaced daemon, another owner, or a moved lifecycle between the question and the yes: stale, nothing cleared", async () => {
    for (const change of ["daemon", "owner", "lifecycle", "delivery"] as const) {
      const f = fm();
      const tok = (await ask(f)).body.confirm.token;
      if (change === "daemon") f.daemons.set("w", { getInteractionSnapshot: () => ({ owner: { bootId: "boot-1", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 1 } }) });
      if (change === "owner") f.daemons.get("w").getInteractionSnapshot = () => ({ owner: { bootId: "boot-2", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 1 } });
      if (change === "lifecycle") f.lifecycle.epochOf = () => 4;
      if (change === "delivery") f.isDeliveryEpochCurrent = () => false;
      const r = await confirm(f, tok);
      expect(r.status, change).toBe(409);
      expect(f.topicCommands.sendClear, change).not.toHaveBeenCalled();
    }
  });

  it("another instance's token, an expired one, a shutting-down fleet: refused", async () => {
    let f = fm({ fleetConfig: { instances: { w: { working_directory: "/w" }, v: { working_directory: "/v" } } } });
    let tok = (await ask(f)).body.confirm.token;
    expect((await confirm(f, tok, "v")).status).toBe(409);
    f = fm();
    tok = (await ask(f)).body.confirm.token;
    const now = performance.now();
    const spy = vi.spyOn(performance, "now").mockReturnValue(now + 16_000);
    try { expect((await confirm(f, tok)).status).toBe(409); } finally { spy.mockRestore(); }
    f = fm();
    tok = (await ask(f)).body.confirm.token;
    f.shuttingDown = true;
    expect((await confirm(f, tok)).status).toBe(409);
    expect(f.topicCommands.sendClear).not.toHaveBeenCalled();
  });

  it("nothing to pin (no owner) or no clear for this backend: refused at the question", async () => {
    const f = fm();
    f.lifecycle.daemons.set("w", { getInteractionSnapshot: () => ({}) });
    expect((await ask(f)).status).toBe(409);
    expect((await ask(fm({ topicCommands: { supportsClear: () => false, sendClear: vi.fn() } }))).status).toBe(409);
  });
});

describe("#1476 review: an instance is an own configured entry (or a ClassicBot room)", () => {
  function fm(instances: Record<string, unknown>, classic: string[] = []) {
    const f: any = Object.create(FleetManager.prototype);
    Object.assign(f, {
      fleetConfig: { instances: Object.assign(Object.create(null), instances) as Record<string, unknown> }, webClearTokens: new Map(),
      classicChannels: { getChannelIdByInstance: (n: string) => (classic.includes(n) ? "123456789012345678" : undefined) },
      instanceIpcClients: new Map(), lifecycle: { daemons: new Map(), epochOf: () => 1 }, shuttingDown: false,
      applyModel: vi.fn(async () => "model set"), applyEffort: vi.fn(async () => "effort set"),
      saveFleetConfig: vi.fn(), restartSingleInstance: vi.fn(),
      topicCommands: { getCtxText: vi.fn(async () => "ctx"), supportsClear: () => false, sendClear: vi.fn() },
    });
    // A YAML-loaded map is an ordinary object: give it Object.prototype back, as loadConfig would.
    Object.setPrototypeOf(f.fleetConfig.instances, Object.prototype);
    return f;
  }
  it("'constructor', 'toString', '__proto__' are not instances: 404, nothing applied, the prototype untouched", async () => {
    const f = fm({ worker: { working_directory: "/w" }, general: { working_directory: "/g", general_topic: true } });
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      for (const [command, args] of [["model", "opus"], ["effort", "high"], ["ctx", ""]] as const) {
        const r = await f.webCommand({ instance: name, command, args }, { publicLink: false });
        expect(r.status, `${name} ${command}`).toBe(404);
      }
    }
    expect(f.applyModel).not.toHaveBeenCalled();
    expect(f.applyEffort).not.toHaveBeenCalled();
    expect(f.topicCommands.getCtxText).not.toHaveBeenCalled();
    expect(f.saveFleetConfig).not.toHaveBeenCalled();
    expect(f.restartSingleInstance).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as any).model).toBeUndefined();
  });
  it("controls: a configured instance — even one named 'constructor' — and a ClassicBot room are found", async () => {
    const f = fm({ worker: { working_directory: "/w" }, constructor: { working_directory: "/c" } }, ["room"]);
    for (const name of ["worker", "constructor", "room"]) expect((await f.webCommand({ instance: name, command: "ctx" }, { publicLink: false })).status, name).toBe(200);
    expect((await f.webCommand({ instance: "constructor", command: "model", args: "opus" }, { publicLink: false })).body).toEqual({ text: "model set" });
  });
});
