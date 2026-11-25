/**
 * M-3710 (R21079937, 11-25): with no verified person behind an admin session (Authorize this browser not done, or run out),
 * Needs you left pending contact requests out without a word — the user saw nothing, even on this computer. Now:
 *  - an admin session with no contact actor gets ONE line: how many requests wait (the count — never which, who or what)
 *    and this browser's "Authorize this browser" (the existing web-authorize chip);
 *  - a verified admin is unchanged: the requests themselves, each with Approve once / Decline;
 *  - a read-only session, or nothing pending: no line;
 *  - the line is the same over the fixed link (an admin session there);
 *  - when the account confirms, Needs you is sent again at once, so the requests replace the line.
 * Real FleetManager (no fleet start: no CLI, tmux or adapters connect), real contact store, real web handler.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const TOKEN = "c".repeat(48), LOCAL = "http://127.0.0.1:19280", PUB = "https://sample.trycloudflare.com";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); vi.restoreAllMocks(); });

/** GET /ui/poll as a session (`gateway`: over the fixed link), answered by the real handler; the body's `needs`. */
function poll(ctx: unknown, sessionId: string, gateway = false): Promise<any[]> {
  const origin = gateway ? PUB : LOCAL, exposureId = "e".repeat(32);
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/poll", destroy: vi.fn(), socket: { remoteAddress: "127.0.0.1", destroy: vi.fn() },
    headers: { host: new URL(origin).host, origin, "sec-fetch-site": "same-origin", cookie: `${gateway ? "__Host-" : ""}agend_session=${sessionId}` } });
  if (gateway) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: PUB, isCurrent: () => true });
  return new Promise((resolve, reject) => {
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableEnded: false, setHeader() {}, write: () => true, destroy: vi.fn(),
      writeHead: (c: number) => { status = c; }, end: (t = "") => (status === 200 ? resolve(JSON.parse(String(t)).needs) : reject(new Error(`${status} ${t}`))) });
    handleWebRequest(req as never, res as never, new URL("/ui/poll", origin), ctx as never);
  });
}

function contactRead(ctx: unknown, sessionId: string, path: string): Promise<{status:number;body:any}> {
  const req = Object.assign(new EventEmitter(), {method:"GET",url:path,destroy:vi.fn(),socket:{remoteAddress:"127.0.0.1"},
    headers:{host:"127.0.0.1:19280",origin:LOCAL,cookie:`agend_session=${sessionId}`}});
  return new Promise(resolve=>{let status=0;const res:any={headersSent:false,destroyed:false,writableEnded:false,setHeader(){},
    writeHead:(n:number)=>{status=n;},end:(body="")=>resolve({status,body:JSON.parse(String(body))})};
    handleWebRequest(req as never,res,new URL(path,LOCAL),ctx as never);
  });
}

describe("the web handler: who gets the line", () => {
  const ticket = { id: "contact:R1", type: "contact", reason: "contact_request", instance: "worker", since: 1, detail: "", contactTicket: { id: "R1", source: "lead", target: "worker" } };
  function ctx(opts: { actor?: boolean; count?: number } = {}) {
    const sessions = new WebSessionStore();
    const c: any = { webToken: TOKEN, webSessions: sessions, logger: { info() {}, debug() {}, error() {}, warn() {} }, sseClients: new Set(),
      getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => [ticket],
      contactActor: () => (opts.actor ? { platform: "discord", adapterId: "a", userId: "fake-admin", label: "Admin" } : null),
      contactNeeds: vi.fn(() => [ticket]), contactSuggestionActor: () => null,
      contactPendingCount: vi.fn(() => ({ count: opts.count ?? 2, since: 1_000 })) };
    const session = (tier: "admin" | "read", gateway = false) => sessions.create({ tier, surface: gateway ? "gateway" : "local", label: "t", tokenEpoch: tokenEpoch(TOKEN),
      ...(gateway ? { exposureId: "e".repeat(32) } : {}) } as never).sessionId;
    return { c, session };
  }
  const verifyLine = (needs: any[]) => needs.filter((i) => i.reason === "contact_verify_needed");
  it("an admin session with no verified person: one line with the count only — no ticket, no id, no names", async () => {
    const { c, session } = ctx();
    const needs = await poll(c, session("admin"));
    expect(needs).toEqual([{ id: "contact-verify", type: "contact", reason: "contact_verify_needed", instance: "", since: 1_000, detail: "", contactVerify: { count: 2 } }]);
    expect(JSON.stringify(needs)).not.toMatch(/R1|lead|worker/);
  });
  it("the same over the fixed link (decision 7933bf90)", async () => {
    const { c, session } = ctx({ count: 1 });
    expect(verifyLine(await poll(c, session("admin", true), true)).map((i) => i.contactVerify)).toEqual([{ count: 1 }]);
  });
  it("a verified admin: unchanged — the requests themselves, and no line", async () => {
    const { c, session } = ctx({ actor: true });
    const needs = await poll(c, session("admin"));
    expect(needs.map((i) => i.reason)).toEqual(["contact_request"]);
    expect(c.contactPendingCount).not.toHaveBeenCalled();
  });
  it("a read-only session, or nothing pending: no line", async () => {
    { const { c, session } = ctx(); expect(verifyLine(await poll(c, session("read")))).toEqual([]); expect(c.contactPendingCount).not.toHaveBeenCalled(); }
    { const { c, session } = ctx({ count: 0 }); expect(await poll(c, session("admin"))).toEqual([]); }
  });
});

describe("the fleet: the count, and Needs you again once the account confirms", () => {
  function fleet() {
    const dir = mkdtempSync(join(tmpdir(), "m3710-"));
    const fm = new FleetManager(dir), any = fm as any;
    const channel = { id: "a", type: "discord", mode: "topic", group_id: "-1001", access: { mode: "open", allowed_users: ["fake-admin"] } };
    fm.fleetConfig = { defaults: { backend: "codex" }, channels: [channel], web: { verified_authority: { enabled: true } },
      instances: { general: { working_directory: dir, general_topic: true, channel_id: "a", topic_id: 1 }, lead: { working_directory: dir, channel_id: "a", topic_id: 2 },
        worker: { working_directory: dir, channel_id: "a", topic_id: 3 } } } as any;
    const adapter = Object.assign(new EventEmitter(), { id: "a", type: "discord", notifyAlert: vi.fn(async () => ({ chatId: "-1001", messageId: "m" })), editMessageRemoveButtons: vi.fn(async () => {}) });
    fm.adapters.set("a", adapter as any);
    writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
    any.scheduleDeliveryOutboxPump = () => {};
    any.ensureDeliveryOutbox();
    cleanups.push(() => { any.deliveryOutbox?.close(); rmSync(dir, { recursive: true, force: true }); });
    const store = any.deliveryOutbox.contactAuthorizations;
    const hold = (n: number) => store.hold({ operationId: `op-${n}`, source: "lead", target: "worker", sourceGeneration: any.contactGeneration("lead"),
      targetGeneration: any.contactGeneration("worker"), verb: "send_to_instance", origin: { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] },
      message: "Please run the release checklist.", correlationId: `c-${n}`, resultRecipient: "lead", payload: { content: "Please run the release checklist." } });
    return { fm, any, hold };
  }
  it("contactPendingCount: how many wait and since the oldest; nothing that names them", () => {
    const { any, hold } = fleet();
    expect(any.contactPendingCount()).toEqual({ count: 0, since: expect.any(Number) });
    const first = hold(1); hold(2);
    expect(any.contactPendingCount()).toEqual({ count: 2, since: Date.parse(first.createdAt) });
  });
  it("an unverified admin sees the line; after Authorize this browser, Needs you is sent again and the request replaces the line", async () => {
    const { any, hold } = fleet();
    const ticket = hold(1);
    any.needsYouItems = () => [];       // the rest of Needs you (agents, prompts) is not this test's
    const emitted = vi.spyOn(any, "emitSseEvent");
    const s = any.webSessions.create({ tier: "admin", surface: "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: "fake-admin" } });
    const before = await poll(any, s.sessionId);
    expect(before.map((i: any) => [i.reason, i.contactVerify?.count])).toEqual([["contact_verify_needed", 1]]);
    const path=`/ui/api/contact-authorizations/${ticket.id}`;
    expect((await contactRead(any,s.sessionId,path)).status).toBe(403);

    expect(any.authorizeWebSession(s.record, "loopback", false)).toMatchObject({ ok: true });
    expect(emitted).toHaveBeenCalledWith("needs", expect.anything());
    const after = await poll(any, s.sessionId);
    expect(after.map((i: any) => [i.reason, i.contactTicket?.id])).toEqual([["contact_request", ticket.id]]);
    const readable=await contactRead(any,s.sessionId,path);
    expect(readable.status).toBe(200);
    expect(readable.body).toMatchObject({id:ticket.id,reason:"unknown-origin",origin:{kind:"unknown"}});

  });
  it("a failing refresh never fails the authorization itself (logged)", () => {
    const { any } = fleet();
    any.needsYouItems = () => { throw new Error("boom"); };
    const warn = vi.spyOn(any.logger, "warn");
    const s = any.webSessions.create({ tier: "admin", surface: "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: "fake-admin" } });
    expect(any.authorizeWebSession(s.record, "loopback", false)).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalledWith(expect.anything(), "Needs you refresh after a web authorization failed");
  });
});

describe("Needs you shows the line with Authorize this browser, in en and zh-TW", () => {
  type Req = { method: string; url: string };
  let reqs: Req[] = [], authState: unknown = { state: "none", reason: "not_authorized" }, recoveryTicket: any = null;
  const fetchFake = async (url: string, init: any = {}) => {
    reqs.push({ method: init.method || "GET", url });
    const body = url === "/ui/authorization" ? (init.method === "POST" ? { ok: true, expiresInMs: 300_000 } : authState) : url === "/ui/api/contact-authorizations/Rrecovery" ? recoveryTicket : {};
    return { ok: true, status: 200, json: async () => body };
  };
  let p: AppPage, N: any, app: any, i18n: any, auth: any;
  const LINE = { id: "contact-verify", type: "contact", reason: "contact_verify_needed", instance: "", since: Date.now() - 60_000, detail: "", contactVerify: { count: 2 } };
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/needs", storage: { agend_tour_done: "1" } });
    (globalThis as any).fetch = fetchFake;
    app = await import("/assets/app-store.js"); app.appStore.set({ proposals: [] });
    i18n = await import("/assets/app-i18n.js");
    auth = await import("/assets/web-authorize.js");
    N = await import("/ui/js/panel-needs.js");
  });
  afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
  beforeEach(async () => { await p.unmount(); reqs = []; recoveryTicket = null; authState = { state: "none", reason: "not_authorized" }; auth.resetWebAuthorization();
    app.appStore.set({ ready: true, needsLoaded: true, needs: [{ ...LINE }], instances: [] }); });
  const text = () => (p.root.textContent || "").replace(/\s+/g, " ").trim();
  const mount = (lang: string) => { i18n.setLang(lang); return p.mount(h(N.NeedsPanel, { route: { panel: "needs" }, navKey: `needs:|1|${lang}` })); };
  it.each([
    ["en", "2 contact requests need a verified browser", "Authorize this browser to see who is asking, and to approve or decline.", "Authorize this browser", "Task board (nobody assigned)"],
    ["zh-TW", "有 2 個聯絡申請需要已驗證的瀏覽器", "授權這個瀏覽器後，才能看到是誰提出，並核准或拒絕。", "授權這個瀏覽器", "任務看板（沒有負責人）"],
  ])("%s: the count, what verifying gives, and the Authorize button — under no agent's heading", async (lang, title, body, button, wrongHead) => {
    await mount(lang); await settle(6);
    expect(p.root.querySelector(".contact-verify-need .n-title")?.textContent.trim()).toBe(title);
    expect(text()).toContain(body);
    expect(text()).not.toContain(wrongHead);
    const ask = p.root.querySelectorAll(".contact-verify-need button").find((b: any) => b.textContent.trim() === button);
    expect(ask).toBeTruthy();
    ask.click(); await settle(6);
    expect(reqs.filter((r) => r.url === "/ui/authorization" && r.method === "POST")).toHaveLength(1);
  });
  it("#4447 capture check: the header, the badge count and the tab title count the line as its requests — and stay put once the requests replace it", async () => {
    const shell = await import("/assets/app-shell.js") as any;
    await mount("en"); await settle(6);
    const counts = () => [p.root.querySelector(".p-needs")?.textContent.match(/(\d+) waiting/)?.[1], shell.needsCount(app.appStore.get()), document.title.match(/^\((\d+)\)/)?.[1]];
    expect(counts()).toEqual(["2", 2, "2"]);
    const request = (id: string) => ({ id: `contact:${id}`, type: "contact", reason: "contact_request", instance: "worker", since: 1, detail: "", contactTicket: { id, source: "lead", target: "worker" } });
    app.appStore.set({ needs: [request("R1"), request("R2")] }); await settle(6);
    expect(counts()).toEqual(["2", 2, "2"]);
  });
  it.each([["en","Authorize this browser","Demo source → Settings → Permissions and press Clear retained origin"],["zh-TW","授權這個瀏覽器","Demo source 的「設定」→「權限」，按「清除保留的來源」"]])(
    "M-3713 %s: Authorize leads to the unknown-origin recovery hint on the real Needs you card", async(lang,button,hint)=>{
      await mount(lang);await settle(6);
      const ask=p.root.querySelectorAll(".contact-verify-need button").find((b:any)=>b.textContent.trim()===button);
      expect(ask).toBeTruthy();expect(text()).not.toContain(hint);
      ask.click();await settle(6);
      expect(reqs.filter(r=>r.url==="/ui/authorization"&&r.method==="POST")).toHaveLength(1);
      recoveryTicket={id:"Rrecovery",revision:1,state:"pending",source:"lead",target:"worker",verb:"send_to_instance",reason:"unknown-origin",
        origin:{kind:"unknown",people:[],receiptIds:[],chain:["lead"]},message:"A synthetic request",canDecide:true,
        createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1_800_000).toISOString()};
      authState={state:"verified"};
      app.appStore.set({instances:[{name:"lead",display_name:"Demo source"},{name:"worker",display_name:"Demo target"}],needs:[{id:"contact:Rrecovery",type:"contact",reason:"contact_request",instance:"worker",since:1,detail:"",
        contactTicket:{id:"Rrecovery",source:"lead",target:"worker"}}]});await settle(8);
      expect(p.root.querySelector(".contact-verify-need")).toBeNull();
      expect(p.root.querySelector(".contact-ticket")).toBeTruthy();
      expect(text()).toContain(hint);
      expect(text()).toContain(lang==="en"?"Demo source's retained history has an unknown origin":"Demo source 保留的歷史來源不明");
      expect(reqs.some(r=>r.url==="/ui/api/contact-authorizations/Rrecovery")).toBe(true);
    });
  it("one request: singular", async () => {
    app.appStore.set({ needs: [{ ...LINE, contactVerify: { count: 1 } }] });
    await mount("en"); await settle(6);
    expect(p.root.querySelector(".contact-verify-need .n-title")?.textContent.trim()).toBe("1 contact request needs a verified browser");
  });
  it("can't be authorized here (e.g. only this computer): says why instead of a button", async () => {
    authState = { state: "none", reason: "loopback_only" };
    await mount("en"); await settle(6);
    expect(text()).toContain("Only this computer can authorize, and this browser is not on it.");
  });
});
