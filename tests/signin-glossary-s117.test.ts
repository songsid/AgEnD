/**
 * S-117 (M-2753, Argon's user stories 1 and 7 and the §3A glossary):
 * - Story 1: a fresh install whose chat is not connected yet is never told to send /web — the server marks the sign-in
 *   page "no chat" when no chat connection is up, not only when none is configured. On this computer (a loopback
 *   address) the page offers signing in again here: the desktop shortcut on Windows, `agend web` otherwise.
 * - Story 7: an AI provider's account is connected, never "signed in with a device code": 連接 AI 帳號 / 已連接 /
 *   撤銷連接, finished on the provider's official website (前往…官方網站完成授權); the provider's code is 授權碼.
 * - Glossary: no bare 代碼 anywhere — 裝置登入碼 (the dashboard's one-time code), 授權碼 (a provider's), 設定碼 (setup),
 *   結束碼 (an exit status), 兌換碼 (bonus codes).
 * Alpha (the twin): the server's mark for a chat fleet whose chat is not connected is its own (data-no-chat), so it never
 * turns on a web-only fleet's authenticator or other-device sign-in; a used launch link (#3270's auto sign-in) says how
 * to sign in again here; 6 位數驗證碼（驗證器 App）, 裝置登入碼 for another device, 手動配對碼 for the Hub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocale, t as hostT } from "../src/locale.js";
import { page as appPage, type AppPage } from "./helpers/app-harness.js";

const ROOT = process.cwd();
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|js|html|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("S-117 glossary: no bare 代碼", () => {
  // src/tips.ts is the source of the website's tips pages (website changes ship with a release): its wording follows then.
  const LATER = new Set(["src/tips.ts"]);
  it("no source file says 代碼 (use 裝置登入碼 / 授權碼 / 設定碼 / 結束碼 / 兌換碼)", () => {
    const hits = files(join(ROOT, "src")).filter((f) => !LATER.has(f.slice(ROOT.length + 1))).flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [f.slice(ROOT.length + 1), i + 1, l] as const))
      .filter(([, , l]) => l.includes("代碼")).map(([f, n]) => `${f}:${n}`);
    expect(hits).toEqual([]);
  });
  it("the dashboard's one-time code is 裝置登入碼 in the chat replies and on the sign-in page", () => {
    setLocale("zh-TW");
    try {
      expect(hostT("dashboard.code", "AB12", 5)).toContain("裝置登入碼");
      expect(hostT("dashboard.private_local", "x", "AB12", 5)).toContain("裝置登入碼");
    } finally { setLocale("en"); }
    const signin = readFileSync(join(ROOT, "src/ui/shared/signin.js"), "utf8");
    expect(signin).toContain('label: "一次性裝置登入碼"');
    expect(signin).toContain('lead: "輸入裝置登入碼。"');
  });
});

let pg: AppPage | null = null;
afterEach(async () => {
  if (pg) { (await import("/assets/app-i18n.js")).setLang("en", { store: false }); pg.restore(); pg = null; }
  setLocale("en");
});
async function ui(lang: "en" | "zh-TW") {
  pg = appPage({ url: "http://127.0.0.1:19280/settings/agents", storage: { agend_tour_done: "1" } });
  (await import("/assets/app-i18n.js")).setLang(lang, { store: false });
  await import("/ui/js/backend-signin.js");
  return (await import("/assets/app-i18n.js")).t as (k: string, ...a: unknown[]) => string;
}

describe("S-117 story 7: an AI account is connected, on the provider's official website", () => {
  it("zh-TW: Settings' AI accounts list and its dialog", async () => {
    const t = await ui("zh-TW");
    const s = (k: string) => t(`signin.${k}`);
    expect([s("listTitle"), s("title"), s("signIn"), s("signInAgain"), s("stUsable"), s("stNotSignedIn"), s("code")])
      .toEqual(["AI 帳號", "連接 AI 帳號：{0}", "連接帳號", "重新連接", "已連接", "未連接", "授權碼"]);
    expect(s("deviceStep")).toContain("前往官方網站完成授權");
    expect(s("listHint")).toContain("連接 AI 帳號");
    expect(s("logoutFirst")).toContain("撤銷連接");
    for (const k of ["title", "signIn", "signInAgain", "stUsable", "stNotSignedIn", "deviceStep", "confirmDevice", "go"]) expect(s(k), k).not.toMatch(/登入|裝置碼/);
  });
  it("English says the same: Connect, connected, the provider's official website", async () => {
    const t = await ui("en");
    const s = (k: string) => t(`signin.${k}`);
    expect([s("listTitle"), s("title"), s("signIn"), s("stUsable"), s("stNotSignedIn"), s("code")])
      .toEqual(["AI accounts", "Connect an AI account: {0}", "Connect account", "connected", "not connected", "Authorization code"]);
    expect(s("deviceStep")).toContain("official website");
  });
  it("setup's sign-in controls say the same in both languages", async () => {
    const { SIGNIN_STRINGS } = await import("/ui/js/structured-signin.js");
    expect([SIGNIN_STRINGS["zh-TW"].heading, SIGNIN_STRINGS["zh-TW"].openProvider, SIGNIN_STRINGS["zh-TW"].deviceCode, SIGNIN_STRINGS["zh-TW"].signIn])
      .toEqual(["連接你的 AI 帳號", "前往官方網站完成授權", "授權碼：", "連接帳號"]);
    expect([SIGNIN_STRINGS.en.heading, SIGNIN_STRINGS.en.openProvider, SIGNIN_STRINGS.en.deviceCode, SIGNIN_STRINGS.en.signIn])
      .toEqual(["Connect your AI accounts", "Finish on the provider's official website", "Authorization code:", "Connect account"]);
  });
  it("chat /login says connect, and the provider's code is 授權碼", () => {
    setLocale("zh-TW");
    expect([hostT("login.offer_action", "Claude Code"), hostT("login.auth_code", "X1"), hostT("login.device_confirm_go"), hostT("login.choose_backend")])
      .toEqual(["🔑 連接 Claude Code 帳號", "授權碼：X1", "開始連接", "要連接哪個 AI 帳號？"]);
    expect(hostT("login.auth_hint", "Codex")).toContain("前往官方網站完成授權");
    expect(hostT("login.completed", "Codex")).toContain("Codex 帳號已連接");
    setLocale("en");
    expect([hostT("login.offer_action", "Claude Code"), hostT("login.auth_code", "X1"), hostT("login.device_confirm_go"), hostT("login.choose_backend")])
      .toEqual(["🔑 Connect your Claude Code account", "Authorization code: X1", "Start connecting", "Which AI account should be connected?"]);
  });
});

/** The real signin.js in a vm, at `host`, with a browser `ua`; the server's "no chat" mark is `noChat`. */
async function signin(language: string, { host = "127.0.0.1", noChat = false, ua = "Mozilla/5.0 (X11; Linux x86_64)", answer = 401 } = {}) {
  const vm = await import("node:vm");
  const handlers: Record<string, (e?: unknown) => Promise<void>> = {};
  const el = (id: string) => ({ id, hidden: id === "resend" || id === "form", textContent: "", value: "ABCD-EFGH", disabled: false,
    classList: { add() {}, remove() {} }, addEventListener(type: string, fn: (e?: unknown) => Promise<void>) { handlers[`${id}:${type}`] = fn; }, focus() {}, select() {} });
  const elements: Record<string, ReturnType<typeof el>> = {};
  const i18n = ["lead", "hint", "nobot", "nobot_body"].map(attr => ({ attr, textContent: "", children: null as unknown[] | null,
    getAttribute() { return this.attr; }, replaceChildren(...c: unknown[]) { this.children = c; } }));
  const help = [{ hidden: false, querySelector: (sel: string) => (sel.includes("nobot") ? {} : null) }];
  const origin = `http://${host}:19280`;
  const context = vm.createContext({
    document: { documentElement: {}, getElementById: (id: string) => (elements[id] ??= el(id)),
      querySelectorAll: (sel: string) => (sel === "details.help" ? help : i18n),
      ...(noChat ? { body: { getAttribute: (name: string) => (name === "data-no-chat" ? "1" : null) } } : {}),
      createElement: (tag: string) => ({ tag, textContent: "" }) },
    location: { href: `${origin}/signin`, hostname: host, pathname: "/signin", search: "", hash: "", origin, replace() {} },
    history: { replaceState() {} }, navigator: { language, userAgent: ua }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url: string) => {
      if (url === "/auth/session") return { ok: false, status: 401 };
      if (url === "/auth/device") return { ok: true, status: 200, json: async () => ({ returning: false }) };
      return { ok: answer < 300, status: answer };
    },
    URL, URLSearchParams, JSON, Date, Number, String,
  });
  vm.runInContext(readFileSync(join(ROOT, "src/ui/shared/signin.js"), "utf8"), context);
  await new Promise((r) => setTimeout(r, 20));
  const text = (attr: string) => { const x = i18n.find((e) => e.attr === attr)!; return x.children ? x.children.map((c) => typeof c === "string" ? c : (c as { textContent: string }).textContent).join("") : x.textContent; };
  const parts = (attr: string) => i18n.find((e) => e.attr === attr)!.children?.map((c) => typeof c === "string" ? "text" : (c as { tag: string }).tag) ?? null;
  const submit = async () => { await handlers["form:submit"]?.({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 20)); return elements.msg?.textContent ?? ""; };
  return { text, parts, submit, help };
}

describe("S-117 story 1: signing in again on this computer; no /web without a chat", () => {
  for (const [lang, local, localWin] of [
    ["en", "On this computer, run agend web in a terminal: it opens the sign-in page and shows a new device sign-in code.",
      "On this computer, open the “AgEnD 儀表板” shortcut on the desktop: it opens the sign-in page with a new device sign-in code. Or run agend web in a WSL terminal."],
    ["zh-TW", "在這台電腦重新登入：在終端機執行 agend web，它會開啟登入頁並顯示新的裝置登入碼。",
      "在這台電腦重新登入：點桌面上的「AgEnD 儀表板」捷徑，它會開啟登入頁並帶上新的裝置登入碼；或在 WSL 終端機執行 agend web。"],
  ] as const) {
    it(`${lang}: on this computer the hint signs in again here (agend web as <code>), with or without a chat`, async () => {
      for (const noChat of [false, true]) {
        const p = await signin(lang, { noChat });
        expect([p.text("hint"), p.parts("hint")], `noChat=${noChat}`).toEqual([local, ["text", "code", "text"]]);
        expect(p.help[0].hidden, "the \"No chat bot?\" help is the hint here").toBe(true);
        expect(await p.submit()).not.toContain("/web");
      }
    });
    it(`${lang}: on a Windows browser on this computer, the desktop shortcut first`, async () => {
      const p = await signin(lang, { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
      expect(p.text("hint")).toBe(localWin);
    });
  }
  it("from another device, a fleet whose chat is connected still says /web; one without a chat never does", async () => {
    const chat = await signin("zh-TW", { host: "192.168.1.20" });
    expect(chat.text("hint")).toContain("/web");
    expect(chat.help[0].hidden).toBe(false);
    const none = await signin("zh-TW", { host: "192.168.1.20", noChat: true });
    expect(none.text("hint")).not.toContain("/web");
    expect(await none.submit()).not.toContain("/web");
  });
});

describe("S-117 story 1: the server marks the page when no chat is connected", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const get = (port: number, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    r.on("error", reject); r.end();
  });
  it("a configured chat that is not connected (a fresh install) is marked data-no-chat (words only); once connected, not", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const dir = mkdtempSync(join(tmpdir(), "agend-s117-")); dirs.push(dir);
    const fm = new FleetManager(dir), any = fm as any;
    fm.logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => fm.logger } as never;
    fm.fleetConfig = { defaults: {}, instances: {}, channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } } as never;
    any.initializeWebAuthTokens(); any.startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
    const port = ((any.healthServer as Server).address() as { port: number }).port;
    try {
      const marked = async () => {
        const a = await get(port, "/signin"), b = await get(port, "/ui", { accept: "text/html" });
        return [a.body.includes('<body data-no-chat="1">'), b.body.includes('<body data-no-chat="1">')];
      };
      expect(await marked()).toEqual([true, true]);
      any.adapterState.set("telegram", { status: "connected", retryCount: 0 });
      expect(await marked()).toEqual([false, false]);
    } finally { await new Promise<void>((r) => { const s = any.healthServer as Server; any.healthServer = null; s.close(() => r()); }); }
  }, 20_000);
});

describe("S-117 alpha: the used launch link, the authenticator, another device, the Hub", () => {
  it("a used or expired launch link says how to sign in again on this computer (Windows: the desktop shortcut)", () => {
    const src = readFileSync(join(ROOT, "src/ui/shared/signin.js"), "utf8");
    expect(src).toContain('autofail: "自動登入沒有成功：這個連結的裝置登入碼已過期或已用過。在這台電腦重新登入：在終端機執行 agend web，它會開啟新的登入連結。"');
    expect(src).toContain('autofail_local_win: "自動登入沒有成功：這個連結的裝置登入碼已過期或已用過。在這台電腦重新登入：點桌面上的「AgEnD 儀表板」捷徑；或在 WSL 終端機執行 agend web。"');
    expect(src).toContain('label_outside: "6 位數驗證碼（驗證器 App）"');
  });
  it("the authenticator is 6 位數驗證碼（驗證器 App）; another device's code is 裝置登入碼; the Hub's is 手動配對碼", async () => {
    setLocale("zh-TW");
    try { expect(hostT("settings_confirm.totp_label")).toBe("6 位數驗證碼（驗證器 App）"); } finally { setLocale("en"); }
    const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
    expect(read("src/ui/shared/app-shell.js")).toContain('codeLabel: "6 位數驗證碼（驗證器 App）"');
    expect(read("src/ui/settings-devices.js")).toContain('codeLabel: "新裝置上的裝置登入碼"');
    expect(read("src/ui/hub-quick-strings.js")).toContain('code: "手動配對碼"');
  });
});

// After #3503 (AGEND-122): a held Settings change is confirmed by a signed-in admin's own Apply — authorizing the browser
// (#1939, still how chat messages carry your authority) is no longer a step of it, so the docs and the agents' skill must
// not describe #2170's "web-verified browser" rule; #3503's authenticator words follow the glossary.
describe("S-117 after #3503: browser authorization is not how a Settings change is confirmed", () => {
  const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
  it("docs and the web-dashboard skill describe the admin's own Apply, not a web-verified browser", () => {
    for (const f of ["docs/web-dashboard.md", "docs/web-dashboard.zh-TW.md", "src/general-knowledge/skills/web-dashboard/SKILL.md"]) {
      expect(read(f), f).not.toMatch(/#2170/);
      expect(read(f), f).toMatch(/AGEND-122/);
    }
    expect(read("docs/web-dashboard.md")).toContain("no DM step and no browser authorization are needed for it");
    expect(read("docs/web-dashboard.zh-TW.md")).toContain("不需要私訊確認，也不需要授權瀏覽器");
  });
  it("the pending card no longer offers Authorize this browser; the chat's own line still does (#1939)", () => {
    expect(read("src/ui/shared/app-shell.js")).not.toMatch(/Authorize this browser|webauth\.authorize|useWebAuthorization/);
    expect(read("src/ui/panel-chat.js")).toContain("ComposerAuth");
  });
  it("#3503's authenticator field and docs use the glossary's 6 位數驗證碼（驗證器 App）, never 代碼", () => {
    expect(read("src/ui/settings-outside.js")).toContain('askCode: "6 位數驗證碼（驗證器 App）"');
    const zh = read("docs/web-dashboard.zh-TW.md");
    const card = zh.slice(zh.indexOf("**卡片上的說明（#2868）。**"), zh.indexOf("**哪個 bot 的 admin 能確認？**"));
    expect(card.length).toBeGreaterThan(100);
    expect(card).not.toContain("代碼");
  });
});
