import {tForLocale} from "../src/locale.js";
/**
 * M-3632: Needs you → "Try again" on held Hub work. The item carries `hubRetry` only when the member says the held question
 * may be asked again; the button posts its id to /ui/needs/hub-retry (a signed-in write with CSRF), which hands it to the
 * member (back through the Hub's begin lease — see hub-representative M-3632). The words say what happens.
 */
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const token = "c".repeat(48), local = "http://127.0.0.1:19280";
function request(path: string, method = "GET", headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "127.0.0.1:19280", ...headers } as Record<string, string>, destroy: vi.fn(), socket: { destroy: vi.fn() } });
  let status = 0, body = "";
  const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, writableEnded: false,
    setHeader() {}, writeHead: (code: number) => { status = code; }, end: (text = "") => { body = text; }, write: () => true, destroy: vi.fn() });
  return { req, res, status: () => status, json: () => JSON.parse(body), feed: (value: unknown) => { req.emit("data", Buffer.from(JSON.stringify(value))); req.emit("end"); } };
}
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const ctx = (store: WebSessionStore, retry = vi.fn((_id: string) => ({ status: 200, code: "queued" }))) => ({
  webToken: token, webSessions: store, logger: { info() {}, debug() {}, error() {}, warn() {} }, sseClients: new Set(),
  getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => [], retryHubHeld: retry,
}) as any;

describe("M-3632 the held item says whether it can be tried again", () => {
  const hold = (retry: boolean) => ({ id: "hold:r1", kind: "hold" as const, agent: "desk", messageId: "m", exposureId: "e", since: 1, ...(retry ? { retry: true as const } : {}) });
  it("hubRetry only when the member offers it", () => {
    const derive = (retry: boolean) => deriveNeedsYou({ instances: [], prompts: [], deliveries: [], hubExecution: [hold(retry)], ownerOf: () => "discord" } as never);
    expect(derive(true).find(i => i.id === "hub:hold:r1")).toMatchObject({ type: "hub", reason: "hub_execution_hold", hubRetry: true });
    expect(derive(false).find(i => i.id === "hub:hold:r1")?.hubRetry).toBeUndefined();
  });
});

describe("M-3632 POST /ui/needs/hub-retry", () => {
  it("a signed-in session with CSRF: handed to the member with the item's id", async () => {
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
    const r = request("/ui/needs/hub-retry", "POST", { cookie: `agend_session=${s.sessionId}`, origin: local, "x-agend-csrf": csrfTokenFor(s.sessionId) });
    const c = ctx(store);
    handleWebRequest(r.req as never, r.res as never, new URL(r.req.url, local), c);
    r.feed({ id: "hub:hold:r1" }); await flush();
    expect(r.status()).toBe(200); expect(r.json()).toEqual({ ok: true, code: "queued" });
    expect(c.retryHubHeld).toHaveBeenCalledWith("hub:hold:r1");
  });
  it("without the CSRF value: refused, nothing retried", async () => {
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
    const r = request("/ui/needs/hub-retry", "POST", { cookie: `agend_session=${s.sessionId}`, origin: local });
    const c = ctx(store);
    handleWebRequest(r.req as never, r.res as never, new URL(r.req.url, local), c);
    r.feed({ id: "hub:hold:r1" }); await flush();
    expect(r.status()).toBeGreaterThanOrEqual(400);
    expect(c.retryHubHeld).not.toHaveBeenCalled();
  });
  it("the member's answer is the status: not retryable 409, gone 404", async () => {
    for (const [status, code] of [[409, "not-retryable"], [404, "not-found"]] as const) {
      const store = new WebSessionStore();
      const s = store.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
      const r = request("/ui/needs/hub-retry", "POST", { cookie: `agend_session=${s.sessionId}`, origin: local, "x-agend-csrf": csrfTokenFor(s.sessionId) });
      handleWebRequest(r.req as never, r.res as never, new URL(r.req.url, local), ctx(store, vi.fn(() => ({ status, code }))));
      r.feed({ id: "hub:hold:r1" }); await flush();
      expect([r.status(), r.json().code]).toEqual([status, code]);
    }
  });
});

describe("M-3632 the Try again button", () => {
  type Req = { method: string; url: string; body: any };
  type Answer = { status: number; body: unknown };
  let reqs: Req[] = [], answer: (r: Req) => Answer | Promise<Answer> = () => ({ status: 200, body: { ok: true } });
  const fetchFake = async (url: string, init: any = {}) => {
    const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null }; reqs.push(r);
    const a = await answer(r); return { ok: a.status < 300, status: a.status, json: async () => a.body };
  };
  let p: AppPage, N: any, app: any, i18n: any;
  const ITEM = { id: "hub:hold:r1", type: "hub", instance: "desk", reason: "hub_execution_hold", detail: "", since: Date.now() - 60_000, hubRetry: true };
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/needs", storage: { agend_tour_done: "1" } });
    (globalThis as any).fetch = fetchFake;
    app = await import("/assets/app-store.js"); app.appStore.set({ proposals: [] });
    i18n = await import("/assets/app-i18n.js");
    N = await import("/ui/js/panel-needs.js");
  });
  afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
  beforeEach(async () => { await p.unmount(); reqs = []; answer = () => ({ status: 200, body: { ok: true } }); app.appStore.set({ ready: true, needsLoaded: true, needs: [{ ...ITEM }], instances: [] }); });
  const posts = () => reqs.filter(r => r.url === "/ui/needs/hub-retry");
  const tryButton = () => p.root.querySelectorAll("button").find((b: any) => /Try again|Trying again/.test(b.textContent));
  const mount = () => p.mount(h(N.NeedsPanel, { route: { panel: "needs" }, navKey: "needs:|1|en" }));
  const button = (text: string) => p.root.querySelectorAll("button").find((b: any) => b.textContent.includes(text));
  it.each([["en", "Try again", "nothing is sent without its OK"], ["zh-TW", "再試一次", "未經 Hub 同意不會送出"]])("%s: the held item explains and offers Try again", async (lang, label, words) => {
    i18n.setLang(lang, { store: false });
    await mount(); await settle(4);
    expect(button(label)).toBeTruthy();
    expect(p.root.textContent).toContain(words);
    i18n.setLang("en", { store: false });
  });
  it.each(["en","zh-TW"]as const)("%s: room-clock warning shows its locale detail without a Try again action",async lang=>{
    i18n.setLang(lang,{store:false});
    const items=deriveNeedsYou({instances:[],prompts:[],deliveries:[],ownerOf:()=>undefined,hubExecution:[{id:"room-clock:fixture",kind:"hold",agent:"desk",messageId:"fixture",exposureId:"fixture",since:Date.now(),detail:tForLocale(lang,"hub.room.clockSkew")}]});
    expect(items[0]).not.toHaveProperty("hubRetry");app.appStore.set({needs:items});await mount();await settle(4);
    expect(p.root.textContent).toContain(tForLocale(lang,"hub.room.clockSkew"));expect(button(lang==="en"?"Try again":"再試一次")).toBeFalsy();expect(posts()).toEqual([]);
    i18n.setLang("en",{store:false});
  });
  it("one POST with the item's id; the button is off while it runs", async () => {
    i18n.setLang("en", { store: false });
    await mount(); await settle(4);
    button("Try again").click(); await settle(4);
    expect(reqs.filter(r => r.url === "/ui/needs/hub-retry")).toEqual([{ method: "POST", url: "/ui/needs/hub-retry", body: { id: "hub:hold:r1" } }]);
    expect(button("Try again")?.disabled ?? button("Trying again")?.disabled).toBe(true);
  });
  it("an item without hubRetry has no Try again", async () => {
    app.appStore.set({ needs: [{ ...ITEM, hubRetry: undefined }] });
    await mount(); await settle(4);
    expect(button("Try again")).toBeFalsy();
  });
  it("Prism #4410: the same question held again (newer since) gets its own working button; the same hold stays claimed", async () => {
    i18n.setLang("en", { store: false });
    await mount(); await settle(4);
    tryButton().click(); await settle(4);
    expect(tryButton().disabled).toBe(true);
    app.appStore.set({ needs: [{ ...ITEM }] }); await settle(4);           // the same hold listed again: still claimed
    expect(tryButton().disabled).toBe(true);
    app.appStore.set({ needs: [{ ...ITEM, since: ITEM.since + 5_000 }] }); await settle(4);   // held again, same id
    expect(tryButton().disabled).toBe(false);
    tryButton().click(); await settle(4);
    expect(posts()).toHaveLength(2);
  });
  it("Prism #4410: a list that refreshes before the POST answers does not leave the new hold's button off", async () => {
    i18n.setLang("en", { store: false });
    let release!: () => void;
    answer = (r) => r.url === "/ui/needs/hub-retry" ? new Promise(res => { release = () => res({ status: 200, body: { ok: true } }); }) : { status: 200, body: {} };
    await mount(); await settle(4);
    tryButton().click(); await settle(2);
    tryButton().click(); await settle(2);
    expect(posts()).toHaveLength(1);                                     // in flight: one POST for this hold
    app.appStore.set({ needs: [{ ...ITEM, since: ITEM.since + 5_000 }] }); await settle(4);
    expect(tryButton().disabled).toBe(false);
    release(); await settle(4);
    expect(tryButton().disabled).toBe(false);
  });
  it.each([["en", "Close this question"], ["zh-TW", "不處理這題"]])("M-3678 %s uncertain hold can close only after confirmation; Cancel permits retry",async(lang,label)=>{
    (globalThis as any).confirm=undefined;
    i18n.setLang(lang,{store:false});app.appStore.set({needs:[{...ITEM,hubRetry:undefined,hubClose:true}]});
    await mount();await settle(4);const C:any=await import("/assets/ui-confirm.js");
    button(label).click();await settle(3);expect(C.confirmStore.get().queue).toHaveLength(1);
    expect(C.confirmStore.get().queue[0].message).toContain(lang==="en"?"This can't be undone.":"關閉後無法復原。");
    expect(reqs.filter(r=>r.url==="/ui/needs/hub-close")).toHaveLength(0);
    expect(p.root.textContent).not.toContain(lang==="en"?"Closing…":"結束中…");
    C.answerConfirm(C.confirmStore.get().queue[0].id,false);await settle(3);expect(button(label).disabled).toBe(false);
    button(label).click();await settle(2);C.answerConfirm(C.confirmStore.get().queue[0].id,true);await settle(4);
    expect(reqs.filter(r=>r.url==="/ui/needs/hub-close")).toEqual([{method:"POST",url:"/ui/needs/hub-close",body:{id:ITEM.id}}]);
    i18n.setLang("en",{store:false});
  });
  it("M-3678 refusal explains verification and keeps the close action usable",async()=>{
    (globalThis as any).confirm=undefined;
    i18n.setLang("en",{store:false});app.appStore.set({needs:[{...ITEM,hubRetry:undefined,hubClose:true}]});
    answer=()=>({status:403,body:{code:"verification-required"}});await mount();await settle(3);
    const C:any=await import("/assets/ui-confirm.js");button("Close this question").click();await settle(2);
    C.answerConfirm(C.confirmStore.get().queue[0].id,true);await settle(4);
    expect(button("Close this question").disabled).toBe(false);
    const T:any=await import("/assets/ui-toast.js");await p.mount(h(T.Toasts,{}));await settle(3);expect(p.root.textContent).toContain("Verify your admin account");
  });

});

describe("M-3678 close API authority",()=>{
  it.each([false,true])("verified actor=%s with CSRF",async verified=>{
    const store=new WebSessionStore(),session=store.create({tier:"admin",surface:"local",label:"t",tokenEpoch:tokenEpoch(token)});
    const r=request("/ui/needs/hub-close","POST",{cookie:`agend_session=${session.sessionId}`,origin:local,"x-agend-csrf":csrfTokenFor(session.sessionId)});
    const actor={platform:"host",adapterId:"host",userId:"operator"};
    const c={...ctx(store),contactActor:()=>verified?actor:null,closeHubHeld:vi.fn(async()=>({status:200,code:"closed"}))};
    handleWebRequest(r.req as never,r.res as never,new URL(r.req.url,local),c as never);r.feed({id:"hub:hold:r1"});await flush();
    expect(r.status()).toBe(verified?200:403);
    if(verified)expect(c.closeHubHeld).toHaveBeenCalledWith("hub:hold:r1",actor);else expect(c.closeHubHeld).not.toHaveBeenCalled();
  });
  it("missing CSRF cannot close even with a verified actor",async()=>{
    const store=new WebSessionStore(),session=store.create({tier:"admin",surface:"local",label:"t",tokenEpoch:tokenEpoch(token)});
    const r=request("/ui/needs/hub-close","POST",{cookie:`agend_session=${session.sessionId}`,origin:local});
    const c={...ctx(store),contactActor:()=>({platform:"host",adapterId:"host",userId:"operator"}),closeHubHeld:vi.fn()};
    handleWebRequest(r.req as never,r.res as never,new URL(r.req.url,local),c as never);r.feed({id:"hub:hold:r1"});await flush();
    expect(r.status()).toBe(401);expect(c.closeHubHeld).not.toHaveBeenCalled();
  });
});
