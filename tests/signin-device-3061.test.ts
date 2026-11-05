/**
 * Refs #3061 (P2a): the sign-in page's "Sign in with another device" (signin.html + shared/signin.js), the real script in a vm
 * as signin-outside-3008.test.ts loads it:
 *  - the button shows only on a web-only fleet's own listener (<body data-web-only data-device-login>), never from outside
 *    (the app's code only) and never on a chat fleet's page;
 *  - it asks POST /auth/device-login (never a GET), shows the code, counts down, and polls POST /auth/device-login/poll;
 *  - approved → it carries on to the page that was asked for; denied and expired say so and offer a new code; the pause (429),
 *    a full room (503) and an absent route (404) are said in words;
 *  - Back withdraws the request (POST …/cancel) and returns to the one-time code form;
 *  - English and 繁體中文.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");
const HTML = readFileSync(join(process.cwd(), "src", "ui", "signin.html"), "utf8");
afterEach(() => { vi.useRealTimers(); });

type Reply = { status: number; body?: unknown; retryAfter?: string };
async function page(language: string, opts: { deviceLogin?: boolean; webOnly?: boolean; outside?: boolean; replies?: Record<string, Reply[]> } = {}) {
  const vm = await import("node:vm");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const handlers: Record<string, (e?: unknown) => unknown> = {};
  const hiddenAtStart = new Set(["resend", "form", "another", "device", "devNew"]);
  const elements: Record<string, any> = {};
  const el = (id: string) => (elements[id] ??= { id, hidden: hiddenAtStart.has(id), textContent: "", value: "123456", disabled: false,
    classes: new Set<string>(), classList: { add(c: string) { elements[id].classes.add(c); }, remove(c: string) { elements[id].classes.delete(c); } },
    addEventListener(type: string, fn: (e?: unknown) => unknown) { handlers[`${id}:${type}`] = fn; }, focus() {}, select() {}, setAttribute() {} });
  const i18n = [...HTML.matchAll(/data-i18n="([a-z_]+)"/g)].map(m => ({ attr: m[1]!, textContent: "", getAttribute() { return this.attr; }, replaceChildren(...c: unknown[]) { this.textContent = c.join(""); } }));
  const calls: Array<{ url: string; method: string }> = [];
  const replaced: string[] = [];
  const replies = opts.replies ?? {};
  const webOnly = opts.webOnly ?? true;
  const context = vm.createContext({
    document: { documentElement: {}, getElementById: (id: string) => el(id),
      querySelectorAll: (sel: string) => (sel === "details.help" ? [] : i18n),
      body: { getAttribute: (name: string) => (name === "data-web-only" && webOnly ? "1" : name === "data-outside" && opts.outside ? "1" : name === "data-device-login" && opts.deviceLogin ? "1" : null) },
      createElement: (tag: string) => ({ tag, textContent: "" }) },
    location: { href: "http://127.0.0.1:19280/signin", pathname: "/signin", search: "", hash: "", origin: "http://127.0.0.1:19280", replace(to: string) { replaced.push(to); } },
    history: { replaceState() {} }, navigator: { language }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/auth/session") return { ok: false, status: 401 };
      if (url === "/auth/device") return { ok: true, status: 200, json: async () => ({ returning: false }) };
      const queue = replies[url];
      const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (!next) throw new Error(`no reply for ${url}`);
      return { ok: next.status < 300, status: next.status, headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? next.retryAfter ?? null : null) },
        json: async () => { if (next.body === undefined) throw new Error("no body"); return next.body; } };
    },
    URL, URLSearchParams, JSON, Date, Number, String, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(SRC, context);
  const flush = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); for (let n = 0; n < 20; n++) await Promise.resolve(); };
  await flush();
  const text = (id: string) => elements[id]?.textContent as string;
  return { el, handlers, calls, replaced, flush, text, i18n: (attr: string) => i18n.find(x => x.attr === attr)?.textContent, click: async (id: string) => { await handlers[`${id}:click`]!(); await flush(); },
    posts: () => calls.filter(c => c.url.startsWith("/auth/device-login")).map(c => `${c.method} ${c.url}`) };
}

const ASKED: Reply = { status: 200, body: { code: "ABCD-EFGH", expiresAt: Date.now() + 300_000, ttlMs: 300_000 } };
const PENDING: Reply = { status: 200, body: { state: "pending", expiresAt: Date.now() + 300_000 } };

describe("#3061 P2a the sign-in page: Sign in with another device", () => {
  it("the button shows only on a web-only fleet's own listener — not from outside, not on a chat fleet's page, not unmarked", async () => {
    expect((await page("en", { deviceLogin: true })).el("another").hidden).toBe(false);
    expect((await page("en", { deviceLogin: true, outside: true })).el("another").hidden).toBe(true);
    expect((await page("en", { deviceLogin: true, webOnly: false })).el("another").hidden).toBe(true);
    expect((await page("en", {})).el("another").hidden).toBe(true);
  });

  it("the markup: the button, the code, the countdown line and the way back — all in the page's own words (no inline script)", () => {
    expect(HTML).toContain('id="another"');
    for (const id of ["device", "devCode", "devStatus", "devNew", "devBack"]) expect(HTML).toContain(`id="${id}"`);
    expect(HTML).not.toMatch(/\son[a-z]+=|style="/);
  });

  it("asks with a POST, shows the code and a countdown, polls with POSTs until approved — then carries on to the app", async () => {
    const p = await page("en", { deviceLogin: true, replies: {
      "/auth/device-login": [ASKED],
      "/auth/device-login/poll": [PENDING, PENDING, { status: 200, body: { state: "approved", ok: true, tier: "admin" } }],
    } });
    await p.click("another");
    expect([p.el("form").hidden, p.el("device").hidden]).toEqual([true, false]);
    expect(p.text("devCode")).toBe("ABCD-EFGH");
    expect(p.text("devStatus")).toBe("Waiting for approval… Expires in 5:00.");
    await p.flush(2000);
    expect(p.text("devStatus")).toMatch(/^Waiting for approval… Expires in 4:5\d\.$/);
    await p.flush(2000);
    await p.flush(2000);
    expect(p.replaced).toEqual(["/ui"]);
    expect(p.text("devStatus")).toBe("Approved — signing in…");
    expect(p.posts()).toEqual(["POST /auth/device-login", "POST /auth/device-login/poll", "POST /auth/device-login/poll", "POST /auth/device-login/poll"]);
    expect(p.calls.every(c => c.method === "POST" || !c.url.startsWith("/auth/device-login"))).toBe(true);      // never a GET
  });

  it("denied and expired say so, strike the code, and offer a new one — which asks again; polling stops", async () => {
    const p = await page("en", { deviceLogin: true, replies: {
      "/auth/device-login": [ASKED, { status: 200, body: { code: "WXYZ-2345", ttlMs: 300_000 } }],
      "/auth/device-login/poll": [{ status: 200, body: { state: "denied" } }, PENDING, { status: 200, body: { state: "expired" } }],
    } });
    await p.click("another");
    await p.flush(2000);
    expect([p.text("devStatus"), p.el("devNew").hidden, p.el("devCode").classes.has("spent")]).toEqual(["This request was denied.", false, true]);
    const seen = p.posts().length;
    await p.flush(10_000);
    expect(p.posts().length).toBe(seen);                                                                          // stopped
    await p.click("devNew");
    expect([p.text("devCode"), p.el("devNew").hidden, p.el("devCode").classes.has("spent")]).toEqual(["WXYZ-2345", true, false]);
    await p.flush(2000);                                                                                          // pending
    await p.flush(2000);                                                                                          // expired
    expect([p.text("devStatus"), p.el("devNew").hidden]).toEqual(["This code has expired.", false]);
  });

  it("Back withdraws the request and returns to the one-time code form; leaving stops the polling", async () => {
    const p = await page("en", { deviceLogin: true, replies: {
      "/auth/device-login": [ASKED], "/auth/device-login/poll": [PENDING], "/auth/device-login/cancel": [{ status: 200, body: { ok: true } }],
    } });
    await p.click("another");
    await p.flush(2000);
    await p.click("devBack");
    expect([p.el("form").hidden, p.el("device").hidden]).toEqual([false, true]);
    expect(p.posts().at(-1)).toBe("POST /auth/device-login/cancel");
    const seen = p.posts().length;
    await p.flush(10_000);
    expect(p.posts().length).toBe(seen);
  });

  it.each([
    [429, { error: "limited", retryAfterMs: 120_000 }, "Too many codes asked for. Try again in 2 minutes."],
    [503, { error: "busy" }, "Too many devices are waiting right now. Try again in a moment."],
    [404, { error: "not_found" }, "Signing in with another device isn't available here."],
    [500, undefined, "Could not get a code. Check the connection and try again."],
  ] as const)("asking answered %i: said in words, with a way to ask again", async (status, body, words) => {
    const p = await page("en", { deviceLogin: true, replies: { "/auth/device-login": [{ status, ...(body ? { body } : {}) }] } });
    await p.click("another");
    expect([p.text("devStatus"), p.el("devNew").hidden]).toEqual([words, false]);
    expect(p.posts()).toEqual(["POST /auth/device-login"]);                                                       // and no polling for a code that never came
  });

  it("a poll the network drops is tried again; the code's own time well past ends it", async () => {
    const p = await page("en", { deviceLogin: true, replies: { "/auth/device-login": [{ status: 200, body: { code: "ABCD-EFGH", ttlMs: 10_000 } }], "/auth/device-login/poll": [{ status: 500 }] } });
    await p.click("another");
    await p.flush(2000); await p.flush(2000); await p.flush(2000);
    expect(p.text("devStatus")).toBe("Could not reach AgEnD. Still trying…");
    await p.flush(30_000);
    expect(p.text("devStatus")).toBe("This code has expired.");
  });

  it("zh-TW: the button, the page and the answers", async () => {
    const p = await page("zh-TW", { deviceLogin: true, replies: {
      "/auth/device-login": [ASKED], "/auth/device-login/poll": [{ status: 200, body: { state: "expired" } }] } });
    expect([p.i18n("another"), p.i18n("dev_title"), p.i18n("dev_new"), p.i18n("dev_back")]).toEqual(["使用其他裝置登入", "使用其他裝置登入", "取得新代碼", "返回"]);
    expect(p.i18n("dev_lead")).toBe("在已登入且已驗證擁有者的裝置上，開啟「設定 → 存取與安全 → 新增裝置」，輸入這組代碼。");
    await p.click("another");
    expect(p.text("devStatus")).toBe("等待核准中… 5:00 後失效。");
    await p.flush(2000);
    expect(p.text("devStatus")).toBe("這組代碼已失效。");
  });
});
