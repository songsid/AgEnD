/** Real signin.js, strict HTML-owned ids and fake browser timers; no fleet or authentication backend is started. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../src/ui/shared/signin.js", import.meta.url), "utf8");
const markup = readFileSync(new URL("../src/ui/signin.html", import.meta.url), "utf8");
const micro = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Reply = { ok: boolean; status: number; headers: { get: (key: string) => string | null }; json: () => Promise<unknown> };
const reply = (status = 401, body: unknown = { error: "wrong_code" }, retry?: string): Reply => ({ ok: status >= 200 && status < 300, status,
  headers: { get: k => k.toLowerCase() === "retry-after" ? retry ?? null : null }, json: async () => body });
class Node {
  textContent = ""; value = ""; hidden = false; disabled = false;
  attrs = new Map<string, string>(); handlers = new Map<string, Array<(e: any) => unknown>>();
  classList = { add() {}, remove() {}, toggle() {} }; focus = vi.fn(); select = vi.fn();
  constructor(public id = "") {}
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  addEventListener(k: string, fn: (e: any) => unknown) { this.handlers.set(k, [...this.handlers.get(k) ?? [], fn]); }
  replaceChildren(...items: Array<string | Node>) { this.textContent = items.map(x => typeof x === "string" ? x : x.textContent).join(""); }
  append(...items: Array<string | Node>) { this.textContent += items.map(x => typeof x === "string" ? x : x.textContent).join(""); }
  emit(type: string, extra: Record<string, unknown> = {}) { for (const fn of this.handlers.get(type) ?? []) fn({ type, target: this, currentTarget: this, preventDefault() {}, ...extra }); }
}
async function page(opts: { lang?: string; outside?: boolean; webOnly?: boolean; html?: string } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-10T06:00:00Z"));
  const ids = new Map<string, Node>(), translated: Node[] = [];
  for (const m of (opts.html ?? markup).matchAll(/<[a-z][^>]*>/gi)) {
    const attrs = new Map([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1]!, a[2]!]));
    const id = attrs.get("id"), key = attrs.get("data-i18n");
    if (!id && !key) continue;
    const n = new Node(id); n.attrs = attrs; n.hidden = /\shidden(?:\s|>)/.test(m[0]);
    if (id) ids.set(id, n); if (key) translated.push(n);
  }
  const element = (id: string) => { const n = ids.get(id); if (!n) throw Error(`Missing real HTML id ${id}`); return n; };
  const posts: Array<{ path: string; body: Record<string, unknown>; signal?: AbortSignal }> = [];
  const responses: Array<Reply | Promise<Reply>> = [], navigations: string[] = [];
  const windowEvents = new Map<string, () => void>();
  const context = createContext({
    document: { documentElement: {}, body: { getAttribute: (k: string) => k === "data-web-only" && opts.webOnly ? "1" : k === "data-outside" && opts.outside ? "1" : null },
      getElementById: (id: string) => ids.get(id) ?? null,
      querySelectorAll: (s: string) => s === "[data-i18n]" ? translated : [],
      createElement: () => new Node(), createTextNode: (text: string) => { const n = new Node(); n.textContent = text; return n; } },
    location: { href: "https://dashboard.example/signin", hostname: "dashboard.example", pathname: "/signin", origin: "https://dashboard.example", search: "", hash: "", replace: (s: string) => navigations.push(s) },
    history: { replaceState() {} }, navigator: { language: opts.lang ?? "en", userAgent: "fixture" },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (path: string, init: { method?: string; body?: string; signal?: AbortSignal } = {}) => {
      if (init.method !== "POST") return path === "/auth/device" ? reply(200, { returning: false }) : reply(401);
      posts.push({ path, body: JSON.parse(init.body!), signal: init.signal });
      return await (responses.shift() ?? reply());
    },
    addEventListener: (type: string, fn: () => void) => windowEvents.set(type, fn),
    AbortController, URL, URLSearchParams, JSON, Date, Number, String, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  runInContext(source, context); await micro();
  const input = async (value: string, pasted = false, isComposing = false) => {
    if (!pasted) element("code").emit("keydown", { key: value.at(-1) ?? "Backspace" });
    else element("code").emit("paste");
    element("code").value = value; element("code").emit("input", { inputType: pasted ? "insertFromPaste" : "insertText", isComposing }); await micro();
  };
  const submit = async () => { element("form").emit("submit"); await micro(); };
  const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await micro(); };
  return { element, input, submit, advance, posts, responses, navigations, windowEvents };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

for (const lang of ["en", "zh-TW"]) describe(`S-118 unified code entry (${lang})`, () => {
  it("pastes six digits immediately to TOTP, omitting account on local and chat surfaces", async () => {
    const p = await page({ lang }); await p.input("234567", true);
    expect(p.posts.map(x => [x.path, x.body])).toEqual([["/auth/totp", { code: "234567" }]]);
    await p.advance(10_000); expect(p.posts).toHaveLength(1);
  });
  it.each(["ABCDEFGH", "abcd-efgh", "23456723"])("pastes complete base32 %s to device login", async value => {
    const p = await page({ lang }); await p.input(value, true);
    expect(p.posts.map(x => [x.path, x.body])).toEqual([["/auth/login", { code: value.replace("-", "").toUpperCase() }]]);
  });
  it.each(["012345", "123456", "823456", "923456"])("typed %s cannot be a device-code prefix and submits without delay", async value => {
    const p = await page({ lang }); await p.input(value);
    expect(p.posts.map(x => x.path)).toEqual(["/auth/totp"]);
  });
  it("waits exactly 800ms for an all-2–7 typed value, then never loops on failure", async () => {
    const p = await page({ lang }); await p.input("234567");
    await p.advance(799); expect(p.posts).toHaveLength(0);
    await p.advance(1); expect(p.posts.map(x => x.path)).toEqual(["/auth/totp"]);
    await p.advance(60_000); expect(p.posts).toHaveLength(1);
  });
  it("any further key cancels the pending wait, including a key that does not change the value", async () => {
    const p = await page({ lang }); await p.input("234567"); await p.advance(400);
    p.element("code").emit("keydown", { key: "Shift" }); await p.advance(1000);
    expect(p.posts).toHaveLength(0);
  });
  it("continuing to a device code cancels the prefix timer and submits only the full device code", async () => {
    const p = await page({ lang }); await p.input("234567"); await p.advance(400);
    await p.input("234567A"); await p.input("234567AB"); await p.advance(1000);
    expect(p.posts.map(x => [x.path, x.body])).toEqual([["/auth/login", { code: "234567AB" }]]);
  });
  it("paste and explicit submit retire an old delay rather than submitting twice", async () => {
    const p = await page({ lang }); await p.input("234567"); await p.advance(400);
    await p.input("345672", true); await p.advance(1000); expect(p.posts).toHaveLength(1);
    await p.input("456723"); await p.submit(); await p.advance(1000); expect(p.posts).toHaveLength(2);
  });
  it("no partial/invalid value or letter/dash candidate is stripped into a TOTP", async () => {
    const p = await page({ lang });
    for (const value of ["", "12345", "1234567", "12-3456", "23a456", "ABC", "ABCDEFG0", "ABCD!EFGH", "AB-CD-EFGH", "１２３４５６", "01234567"]) {
      await p.input(value, true); await p.submit(); await p.advance(1000);
    }
    expect(p.posts).toHaveLength(0);
  });
  it("deduplicates canonical case/dash forms and A→B→A, including repeated input after failures", async () => {
    const p = await page({ lang });
    await p.input("abcd-efgh", true); await p.input("ABCDEFGH", true); await p.input("BCDEFGHJ", true); await p.input("ABCD-EFGH", true);
    await p.advance(5000); expect(p.posts.map(x => x.body.code)).toEqual(["ABCDEFGH", "BCDEFGHJ"]);
  });
  it("allows the finished device code after an early held TOTP and ignores the late old error", async () => {
    const p = await page({ lang }), old = deferred<Reply>(); p.responses.push(old.promise, reply(200, { ok: true }));
    await p.input("234567"); await p.advance(800); expect(p.posts).toHaveLength(1);
    await p.input("234567AB"); expect(p.posts.map(x => x.path)).toEqual(["/auth/totp", "/auth/login"]);
    expect(p.navigations).toEqual(["/ui"]);
    old.resolve(reply(401)); await micro();
    expect(p.navigations).toEqual(["/ui"]); expect(p.element("msg").textContent).toBe("");
  });
  it("a stale success cannot navigate over a later failed input", async () => {
    const p = await page({ lang }), old = deferred<Reply>(); p.responses.push(old.promise, reply(401));
    await p.input("123456", true); await p.input("ABCDEFGH", true);
    const currentError = p.element("msg").textContent; expect(currentError).not.toBe("");
    old.resolve(reply(200, { ok: true })); await micro();
    expect(p.navigations).toHaveLength(0); expect(p.element("msg").textContent).toBe(currentError);
  });
  it("a stale awaited pause body cannot settle a newer device attempt", async () => {
    const p = await page({ lang }), body = deferred<unknown>();
    p.responses.push({ ...reply(429), json: () => body.promise }, reply(401));
    await p.input("123456", true); await p.input("ABCDEFGH", true);
    const currentError = p.element("msg").textContent;
    body.resolve({ error: "paused", retryAfterMs: 120000 }); await micro();
    expect(p.element("msg").textContent).toBe(currentError); expect(p.element("go").disabled).toBe(false);
  });
  it("all uniform 401 answers offer the next code and fallback without a separate waiting state", async () => {
    const p = await page({ lang }); p.responses.push(reply(401), reply(401));
    await p.input("123456", true);
    const view = [p.element("msg").textContent, p.element("authHint").textContent];
    expect(view[0]).toMatch(lang === "en" ? /next (?:one|code)/i : /下一組/);
    expect(view[1]).toMatch(lang === "en" ? /8-character/ : /8 字元裝置登入碼/);
    expect(view[1]).toMatch(lang === "en" ? /signed-in|known device/ : /先前登入過的裝置/);
    expect(view[1]).toMatch(lang === "en" ? /may be limited/ : /可能暫時受限/);
    expect(p.element("go").disabled).toBe(false);
    await p.input("654321", true);
    expect([p.element("msg").textContent, p.element("authHint").textContent]).toEqual(view);
    expect(p.element("go").disabled).toBe(false);
    await p.advance(60_000); expect(p.posts).toHaveLength(2);
  });
  it("blocks all submission during a server pause and does not replay on expiry", async () => {
    const p = await page({ lang }); p.responses.push(reply(429, { error: "paused", retryAfterMs: 120000 }));
    await p.input("123456", true); expect(p.element("go").disabled).toBe(true);
    await p.input("ABCDEFGH", true); await p.submit(); await p.advance(119999); expect(p.posts).toHaveLength(1);
    await p.advance(1); expect(p.posts).toHaveLength(1); expect(p.element("go").disabled).toBe(false);
    await p.submit(); expect(p.posts.map(x => x.path)).toEqual(["/auth/totp", "/auth/login"]);
  });
  it("composition cannot dispatch until the complete composition ends", async () => {
    const p = await page({ lang }); p.element("code").emit("compositionstart"); await p.input("123456", false, true);
    await p.advance(1000); expect(p.posts).toHaveLength(0);
    p.element("code").emit("compositionend"); await micro(); expect(p.posts.map(x => x.path)).toEqual(["/auth/totp"]);
  });
  it("editing to a partial value retires the request and leaves manual sign-in enabled", async () => {
    const p = await page({ lang }), old = deferred<Reply>(); p.responses.push(old.promise);
    await p.input("123456", true); expect(p.element("go").disabled).toBe(true);
    await p.input("12345"); expect(p.posts[0]!.signal!.aborted).toBe(true); expect(p.element("go").disabled).toBe(false);
    old.resolve(reply(401)); await micro(); expect(p.element("msg").textContent).toBe("");
    await p.submit(); expect(p.posts).toHaveLength(1); expect(p.element("msg").textContent).not.toBe("");
  });
  it("manual retry is allowed after failure but cannot duplicate an in-flight attempt", async () => {
    const p = await page({ lang }), held = deferred<Reply>(); p.responses.push(reply(401), held.promise);
    await p.input("ABCDEFGH", true); await p.submit(); await p.submit(); expect(p.posts).toHaveLength(2);
    held.resolve(reply(401)); await micro(); await p.advance(30_000); expect(p.posts).toHaveLength(2);
  });
  it("a held request retired by pagehide cannot navigate or display a result", async () => {
    const p = await page({ lang }), old = deferred<Reply>(); p.responses.push(old.promise);
    await p.input("123456", true); p.windowEvents.get("pagehide")?.(); old.resolve(reply(200)); await micro();
    expect(p.posts[0]!.signal!.aborted).toBe(true); expect(p.navigations).toHaveLength(0);
  });
  it("leaving the page cancels a pending delay", async () => {
    const p = await page({ lang }); await p.input("234567"); p.windowEvents.get("pagehide")?.();
    await p.advance(1000); expect(p.posts).toHaveLength(0);
  });
});
