/**
 * #3008 ②: the sign-in page served through the link "Allow connections from outside" opened (<body data-web-only="1"
 * data-outside="1">, auth-api serveSigninPage) asks for the authenticator app's code and posts it to /auth/totp — the
 * leader's wording (cid-alpha3-design, strings 11–13 and 17), in English and 繁體中文:
 *  - its label, lead and hint (lost phone: "Set up again" on the AgEnD computer); a numeric 6-digit field; no
 *    "Send me a new code" (nothing is sent from outside);
 *  - a wrong code (401) says to check the phone's clock and try the newest code;
 *  - a wait (429) says how long, as words: "15 minutes" / 「15 分鐘」, "2 hours" / 「2 小時」 (from retryAfterMs, else
 *    Retry-After);
 *  - the page on this computer (no data-outside), and a chat fleet's, keep posting /auth/login.
 * The real signin.js in a vm, as signin-copy-1854.test.ts loads it; and the server's marks on the real page.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveSigninPage } from "../src/auth-api.js";

const SRC = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");

async function page(language: string, opts: { outside?: boolean; webOnly?: boolean; status?: number; body?: unknown; retryAfter?: string } = {}) {
  const vm = await import("node:vm");
  vi.useRealTimers();
  const handlers: Record<string, (e?: unknown) => Promise<void>> = {};
  const attrs: Record<string, string> = {};
  const el = (id: string) => ({ id, hidden: id === "resend" || id === "form", textContent: "", value: "123456", disabled: false,
    classList: { add() {}, remove() {} }, addEventListener(type: string, fn: (e?: unknown) => Promise<void>) { handlers[`${id}:${type}`] = fn; },
    focus() {}, select() {}, setAttribute(name: string, value: string) { if (id === "code") attrs[name] = value; } });
  const elements: Record<string, ReturnType<typeof el>> = {};
  const i18n = ["label", "lead", "hint"].map(attr => ({ attr, textContent: "", children: null as unknown[] | null,
    getAttribute() { return this.attr; }, replaceChildren(...c: unknown[]) { this.children = c; } }));
  const posts: Array<{ url: string; body: unknown }> = [];
  const asked: string[] = [];
  const webOnly = opts.webOnly ?? true;
  const context = vm.createContext({
    document: { documentElement: {}, getElementById: (id: string) => (elements[id] ??= el(id)),
      querySelectorAll: (sel: string) => (sel === "details.help" ? [] : i18n),
      body: { getAttribute: (name: string) => (name === "data-web-only" && webOnly ? "1" : name === "data-outside" && opts.outside ? "1" : null) },
      createElement: (tag: string) => ({ tag, textContent: "" }) },
    location: { href: "https://x.trycloudflare.com/signin", pathname: "/signin", search: "", hash: "", origin: "https://x.trycloudflare.com", replace() {} },
    history: { replaceState() {} }, navigator: { language }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url: string, init?: { body?: string }) => {
      asked.push(url);
      if (url === "/auth/session") return { ok: false, status: 401 };
      if (url === "/auth/device") return { ok: true, status: 200, json: async () => ({ returning: true }) };
      posts.push({ url, body: JSON.parse(init!.body!) });
      const status = opts.status ?? 401;
      return { ok: status < 300, status, headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? opts.retryAfter ?? null : null) },
        json: async () => { if (opts.body === undefined) throw new Error("no body"); return opts.body; } };
    },
    URL, URLSearchParams, JSON, Date, Number, String, Math,
  });
  vm.runInContext(SRC, context);
  for (let n = 0; n < 50; n++) await new Promise(r => setImmediate(r));
  const $ = (id: string) => elements[id] ??= el(id);
  const text = (attr: string) => i18n.find(x => x.attr === attr)!.textContent;
  return { $, text, posts, asked, attrs, submit: async () => { await handlers["form:submit"]!({ preventDefault() {} }); } };
}

const WORDS = {
  en: { label: "Authenticator code", lead: "Open your authenticator app and enter the 6-digit code for AgEnD.", hint: "Lost your phone? On the AgEnD computer, choose “Set up again”.",
    wrong: "That code didn't work. Check that your phone's clock is right and try the newest code.", wait: "Too many wrong codes. Try again in 15 minutes.", wait2h: "Too many wrong codes. Try again in 2 hours." },
  "zh-TW": { label: "驗證器代碼", lead: "打開驗證器 App，輸入 AgEnD 的 6 位數代碼。", hint: "手機遺失？請在 AgEnD 電腦上選「重新設定」。",
    wrong: "代碼不對。請確認手機時間正確，並輸入最新的代碼。", wait: "錯誤次數太多，請 15 分鐘 後再試。", wait2h: "錯誤次數太多，請 2 小時 後再試。" },
} as const;

describe("#3008 ② the sign-in page from outside", () => {
  for (const language of ["en", "zh-TW"] as const) {
    it(`${language}: asks for the authenticator's code, numeric, posted to /auth/totp; no "Send me a new code"`, async () => {
      const p = await page(language, { outside: true });
      expect([p.text("label"), p.text("lead"), p.text("hint")]).toEqual([WORDS[language].label, WORDS[language].lead, WORDS[language].hint]);
      expect([p.attrs.inputmode, p.attrs.maxlength, p.attrs.placeholder]).toEqual(["numeric", "7", "123456"]);
      expect([p.asked.includes("/auth/device"), p.$("resend").hidden]).toEqual([false, true]);
      await p.submit();
      expect([p.posts, p.$("msg").textContent]).toEqual([[{ url: "/auth/totp", body: { code: "123456" } }], WORDS[language].wrong]);
    });
    it(`${language}: a wait says how long, as words (the body's retryAfterMs, else Retry-After)`, async () => {
      const a = await page(language, { outside: true, status: 429, body: { error: "paused", retryAfterMs: 15 * 60_000 } });
      await a.submit();
      expect(a.$("msg").textContent).toBe(WORDS[language].wait);
      const b = await page(language, { outside: true, status: 429, retryAfter: String(2 * 3600) });
      await b.submit();
      expect(b.$("msg").textContent).toBe(WORDS[language].wait2h);
    });
  }
  it("this computer's page (no data-outside) and a chat fleet's keep the one-time code and /auth/login", async () => {
    for (const p of [await page("en", { outside: false }), await page("en", { webOnly: false, outside: true })]) {
      await p.submit();
      expect(p.posts.map(x => x.url)).toEqual(["/auth/login"]);
      expect(p.text("label")).toBe("One-time code");
    }
  });
  it("the server marks the page: web-only + outside → both marks; outside alone (a chat fleet) → none", () => {
    const served = (opts: { webOnly?: boolean; outside?: boolean }) => {
      let body = "";
      const res = { writeHead() { return res; }, setHeader() {}, end(b: string) { body = String(b); }, getHeader() { return undefined; } } as never;
      serveSigninPage(res, 200, opts);
      return body.match(/<body[^>]*>/)?.[0];
    };
    expect(served({ webOnly: true, outside: true })).toBe('<body data-web-only="1" data-outside="1">');
    expect(served({ webOnly: true })).toBe('<body data-web-only="1">');
    expect(served({ outside: true })).toBe("<body>");
  });
});
