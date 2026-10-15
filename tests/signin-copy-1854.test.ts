/**
 * #1854 rank 2: the sign-in page says what the person has to do — a code comes from pressing a sign-in button after
 * /web in General, not from /web alone — and a server that could not confirm the sign-in is not reported as a wrong
 * code. The operator's way in (`agend web --code`) is collapsed help, not the primary path. The 401/429 handling and
 * the returning-device button keep their gates (returning-device-1570.test.ts). The real signin.js in a vm.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");
const HTML = readFileSync(join(process.cwd(), "src", "ui", "signin.html"), "utf8");

const COPY = {
  en: {
    lead: "Enter your sign-in code.",
    hint: "No code? Send /web in General, then press a sign-in button to get one.",
    nobot: "No chat bot?",
    nobot_body: "Ask the operator to run agend web --code on the AgEnD computer.",
    refused: "The code is invalid or no longer works. Send /web in General, then press a sign-in button for a new code.",
    unconfirmed: "Sign-in could not be confirmed. Get a new code and try again; if it keeps failing, contact the operator.",
  },
  "zh-TW": {
    lead: "輸入登入碼。",
    hint: "沒收到？在 General 傳 /web，再按登入按鈕取碼。",
    nobot: "沒有聊天 bot？",
    nobot_body: "請管理員在 AgEnD 電腦執行 agend web --code。",
    refused: "登入碼無效或已失效。請在 General 傳 /web，再按登入按鈕取新碼。",
    unconfirmed: "登入暫時無法確認。請重新取碼再試；若仍失敗，請聯絡管理員。",
  },
} as const;

/** Load the page script for one browser language; `answer` is /auth/login's status. Every data-i18n element is returned. */
async function page(language: string, answer = 401) {
  const vm = await import("node:vm");
  vi.useRealTimers();
  const handlers: Record<string, (e?: unknown) => Promise<void>> = {};
  const el = (id: string) => ({ id, hidden: id === "resend" || id === "form", textContent: "", value: "ABCD-EFGH", disabled: false,
    classList: { add() {}, remove() {} }, addEventListener(type: string, fn: (e?: unknown) => Promise<void>) { handlers[`${id}:${type}`] = fn; }, focus() {}, select() {} });
  const elements: Record<string, ReturnType<typeof el>> = {};
  const i18n = ["lead", "hint", "nobot", "nobot_body"].map(attr => ({ attr, textContent: "", children: null as unknown[] | null,
    getAttribute() { return this.attr; }, replaceChildren(...c: unknown[]) { this.children = c; } }));
  const logins: unknown[] = [];
  const context = vm.createContext({
    document: { documentElement: {}, getElementById: (id: string) => (elements[id] ??= el(id)), querySelectorAll: () => i18n,
      createElement: (tag: string) => ({ tag, textContent: "" }) },
    location: { href: "http://127.0.0.1:1/signin", pathname: "/signin", search: "", hash: "", origin: "http://127.0.0.1:1", replace() {} },
    history: { replaceState() {} }, navigator: { language }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url: string, init?: { body?: string }) => {
      if (url === "/auth/session") return { ok: false, status: 401 };
      if (url === "/auth/device") return { ok: true, status: 200, json: async () => ({ returning: false }) };
      if (url === "/auth/login") logins.push(JSON.parse(init!.body!));
      return { ok: answer < 300, status: answer };
    },
    URL, URLSearchParams, JSON, Date, Number, String,
  });
  vm.runInContext(SRC, context);
  for (let n = 0; n < 50; n++) await new Promise(r => setImmediate(r));
  const $ = (id: string) => elements[id] ??= el(id);
  const text = (attr: string) => { const e = i18n.find(x => x.attr === attr)!; return e.children ? e.children.map(c => typeof c === "string" ? c : (c as { textContent: string }).textContent).join("") : e.textContent; };
  return { $, text, i18n, logins, submit: async () => { await handlers["form:submit"]!({ preventDefault() {} }); } };
}

describe("#1854 rank 2: the sign-in page", () => {
  for (const language of ["en", "zh-TW"] as const) {
    it(`${language}: the lead, the hint and the collapsed help are the proposal's words`, async () => {
      const p = await page(language);
      expect(["lead", "hint", "nobot", "nobot_body"].map(p.text)).toEqual(["lead", "hint", "nobot", "nobot_body"].map(k => COPY[language][k as keyof typeof COPY.en]));
    });
    it(`${language}: a wrong, expired or used code (401) says how to get a new one — press a sign-in button after /web`, async () => {
      const p = await page(language, 401);
      await p.submit();
      expect([p.$("msg").textContent, p.logins]).toEqual([COPY[language].refused, [{ code: "ABCD-EFGH" }]]);
    });
    it(`${language}: a sign-in the server could not confirm (503, and any 5xx) is not called a wrong code`, async () => {
      for (const status of [503, 500]) {
        const p = await page(language, status);
        await p.submit();
        expect(p.$("msg").textContent, String(status)).toBe(COPY[language].unconfirmed);
      }
    });
  }
  it("429 keeps its own message (rate limit, not the code)", async () => {
    const p = await page("en", 429);
    await p.submit();
    expect(p.$("msg").textContent).toBe("Too many wrong codes — sign-in is paused for a few minutes.");
  });
  it("the primary path names no terminal command; agend web --code is only in the help", async () => {
    const p = await page("en");
    expect([p.text("lead") + p.text("hint")].join("").includes("agend")).toBe(false);
    const body = p.i18n.find(x => x.attr === "nobot_body")!;
    expect(body.children!.map(c => typeof c === "string" ? "text" : (c as { tag: string }).tag)).toEqual(["text", "code", "text"]);
  });
  it("the page's static copy matches English, and the help is a closed <details> (opened only when asked for)", () => {
    const tag = (attr: string) => new RegExp(`data-i18n="${attr}">([^]*?)</(?:p|div|summary)>`).exec(HTML)?.[1].replace(/<\/?code>/g, "");
    expect(["lead", "hint", "nobot", "nobot_body"].map(tag)).toEqual(["lead", "hint", "nobot", "nobot_body"].map(k => COPY.en[k as keyof typeof COPY.en]));
    expect(/<details class="help"><summary data-i18n="nobot">/.test(HTML)).toBe(true);
    expect(/<details[^>]*\sopen/.test(HTML)).toBe(false);
  });
});
