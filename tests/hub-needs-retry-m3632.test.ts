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
  let reqs: Req[] = [], answer: (r: Req) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });
  const fetchFake = async (url: string, init: any = {}) => {
    const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null }; reqs.push(r);
    const a = answer(r); return { ok: a.status < 300, status: a.status, json: async () => a.body };
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
  beforeEach(async () => { await p.unmount(); reqs = []; app.appStore.set({ ready: true, needsLoaded: true, needs: [{ ...ITEM }], instances: [] }); });
  const mount = () => p.mount(h(N.NeedsPanel, { route: { panel: "needs" }, navKey: "needs:|1|en" }));
  const button = (text: string) => p.root.querySelectorAll("button").find((b: any) => b.textContent.includes(text));
  it.each([["en", "Try again", "nothing is sent without its OK"], ["zh-TW", "再試一次", "未經 Hub 同意不會送出"]])("%s: the held item explains and offers Try again", async (lang, label, words) => {
    i18n.setLang(lang, { store: false });
    await mount(); await settle(4);
    expect(button(label)).toBeTruthy();
    expect(p.root.textContent).toContain(words);
    i18n.setLang("en", { store: false });
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
});
