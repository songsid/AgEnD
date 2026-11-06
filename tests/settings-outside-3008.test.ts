/**
 * #3008 ② Settings → Access & security → "Connections from outside" (src/ui/settings-outside.js), as rendered — the
 * leader's wording (cid-alpha3-design, strings 1–13 and 17):
 *  - a fleet with a chat connection: no card;
 *  - this computer's admin, nothing set up: the switch can't be turned on, the hint says to set up an app first; "Set up
 *    authenticator app" shows a QR code (drawn by the vendored encoder as one SVG path), the key in groups of four and
 *    the code field; Continue waits for 6 digits; a wrong code says to check the phone's clock; a right one closes it;
 *  - set up: the date, the lost-phone line, "Set up again" (asks, with the leader's words) and "Remove" (asks); the
 *    switch turns it on (POST /ui/outside/switch) and the status says where it is open, a quick link's note included;
 *  - a wait in force says how long, as words;
 *  - from elsewhere (the server's `here: false`): "Only on the AgEnD computer.", the switch read-only, no buttons.
 * Pure helpers too: the wait's words, the key's groups, the QR path from the real vendored encoder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const schema = buildSettingsImpactSchema();
let p: AppPage, status: any, chat = false, authWebOnly: boolean | undefined;
let sent: Array<{ method: string; path: string; body: any }> = [];
let answers: Record<string, { status: number; body: any }> = {};
const realFetch = (globalThis as any).fetch;
const ENROLL = { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", uri: "otpauth://totp/AgEnD%3Apc?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=AgEnD&algorithm=SHA1&digits=6&period=30", expiresInMs: 600000 };
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  const preset = answers[`${method} ${path}`];
  if (preset) return { ok: preset.status < 300, status: preset.status, json: async () => preset.body };
  const body = (() => {
    if (method === "POST" && path === "/ui/outside/enroll") return ENROLL;
    if (method !== "GET") return { ok: true };
    if (path === "/ui/outside") return status;
    if (path === "/api/settings/web-authority") return { state: { enabled: true, loopbackOnly: false, epoch: 1 }, configured: {}, hours: { min: 1, max: 48, default: 48 }, lanHosts: [], authorized: [], ...(authWebOnly === undefined ? {} : { webOnly: authWebOnly }) };
    if (path === "/api/settings/guests") return { enabled: false, chat: true, instances: [], connections: [], guests: [] };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return { defaults: { locale: "en" }, instances: {}, ...(chat ? { channels: [{ type: "telegram", id: "telegram" }] } : {}), web: {} };
    if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
    if (path === "/api/settings/connections") return [];
    if (path === "/api/fleet") return { version: "2.3.5", instances: [] };
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/settings/access" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; answers = {}; chat = false; authWebOnly = undefined; p.window.confirm = () => true; (globalThis as any).confirm = () => true; });
afterEach(async () => { await p.unmount(); });

const base = { webOnly: true, here: true, enrolled: false, enrolledAt: null, outside: false, pausedForMs: 0, link: null };
async function open(over: Record<string, unknown> = {}) {
  status = { ...base, ...over };
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "access" }, navKey: "settings:access" }));
  await settle(14);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const click = async (el: any) => { fire(el, "click"); await settle(8); };
  const type = async (el: any, v: string) => { el.value = v; fire(el, "input"); await settle(); };
  const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(8); };
  const posts = () => sent.filter(s => s.method === "POST" && s.path.startsWith("/ui/outside")).map(s => [s.path, s.body]);
  return { $, click, type, check, posts };
}

describe("#3008 ② the helpers", () => {
  it("a wait as words, the key in groups, the QR code as one path from the real vendored encoder", async () => {
    const { waitWords, keyGroups, qrPath } = await import("/ui/js/settings-outside.js");
    expect([waitWords(15 * 60_000), waitWords(60_000), waitWords(2 * 3600_000)]).toEqual(["15 minutes", "1 minute", "2 hours"]);
    expect(keyGroups("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    const src = readFileSync(join(process.cwd(), "src", "ui", "shared", "qrcode.module.js"), "utf8");
    const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
    const shape = qrPath(mod.default, ENROLL.uri);
    expect(shape.size).toBeGreaterThan(29);                                                   // version ≥ 3 + the quiet zone
    expect(shape.d).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  });
});

describe("#3008 ② Settings → Access & security → Owner verification (Connections from outside)", () => {
  it("a fleet with a chat connection (the server says webOnly: false): no card", async () => {
    const w = await open({ webOnly: false });
    expect(w.$("#outsideCard")).toBeNull();
  });
  it("nothing set up: the switch can't be turned on; set up shows the QR code, the key and the code field; a wrong code, then a right one", async () => {
    const w = await open();
    expect([w.$("#outsideCard h3").textContent, w.$("#outSwitch").disabled, w.$("#outNeedApp").textContent])
      .toEqual(["Owner verification", true, "Set up an authenticator app first. Signing in from outside will ask for its code."]);
    await w.click(w.$("#outSetUp"));
    await settle(10);
    expect(w.$("#outEnroll .note").textContent).toBe("Scan this with Authy, Google Authenticator or Microsoft Authenticator, or type the key. Then enter the 6-digit code it shows.");
    expect(w.$("#outKey").textContent).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    expect(w.$("#outConfirm").disabled).toBe(true);
    await w.type(w.$("#outCode"), "123456");
    expect(w.$("#outConfirm").disabled).toBe(false);
    answers["POST /ui/outside/enroll/confirm"] = { status: 400, body: { error: "wrong" } };
    await w.click(w.$("#outConfirm"));
    expect(w.$("#outMsg").textContent).toBe("That code didn't work. Check that your phone's clock is right and try the newest code.");
    answers["POST /ui/outside/enroll/confirm"] = { status: 200, body: { ok: true } };
    status = { ...base, enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) };
    await w.click(w.$("#outConfirm"));
    expect(w.$("#outEnroll")).toBeNull();
    expect(w.posts()).toEqual([["/ui/outside/enroll", {}], ["/ui/outside/enroll/confirm", { code: "123456" }], ["/ui/outside/enroll/confirm", { code: "123456" }]]);
    expect(w.$("#outSetUpOn").textContent).toMatch(/^Authenticator app set up on .+\.$/);
  });
  it("the QR code is drawn (one SVG path, no inline style)", async () => {
    const w = await open();
    await w.click(w.$("#outSetUp"));
    for (let n = 0; n < 40 && !w.$("#outQr"); n++) await settle(4);
    const svg = w.$("#outQr");
    expect(svg).not.toBeNull();
    expect(svg.querySelector("path").getAttribute("d")).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
    expect(svg.getAttribute("style")).toBeNull();
  });
  it("set up: the switch turns it on; the status says where it is open (a quick link's note); Set up again and Remove ask first", async () => {
    const w = await open({ enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) });
    expect(p.root.textContent).toContain("Lost your phone? On the AgEnD computer, choose “Set up again”. There is no email or backup-code recovery.");
    status = { ...base, enrolled: true, enrolledAt: Date.UTC(2026, 10, 4), outside: true, link: { state: "open", url: "https://abc.trycloudflare.com/signin", quick: true } };
    await w.check(w.$("#outSwitch"), true);
    expect(w.$("#outOpenAt").textContent).toBe("Open at https://abc.trycloudflare.com/signin. A quick link gets a new address each time it opens.");
    await w.click(w.$("#outRemove"));
    await settle(10);
    expect(w.posts()).toEqual([["/ui/outside/switch", { on: true }], ["/ui/outside/remove", {}]]);
  });
  it("#3035 review: the switch answers before the link is up — the card follows it opening, then its end, with no reload", async () => {
    const { outsidePoll } = await import("/ui/js/settings-outside.js");
    const saved = { ...outsidePoll };
    outsidePoll.quickMs = 30; outsidePoll.slowMs = 60;
    try {
      const w = await open({ enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) });
      status = { ...base, enrolled: true, enrolledAt: Date.UTC(2026, 10, 4), outside: true, link: { state: "starting", quick: true } };
      await w.check(w.$("#outSwitch"), true);
      expect([w.$("#outSwitch").checked, w.$("#outStarting") !== null, w.$("#outOpenAt")]).toEqual([true, true, null]);
      status = { ...status, link: { state: "open", url: "https://late.trycloudflare.com/signin", quick: true } };
      for (let n = 0; n < 40 && !w.$("#outOpenAt"); n++) await settle(4);
      expect(w.$("#outOpenAt")?.textContent).toBe("Open at https://late.trycloudflare.com/signin. A quick link gets a new address each time it opens.");
      status = { ...base, enrolled: true, enrolledAt: Date.UTC(2026, 10, 4), outside: false, link: null, pausedForMs: 15 * 60_000 };   // its time ran out; a wait began
      for (let n = 0; n < 60 && (w.$("#outSwitch").checked || !w.$("#outPaused")); n++) await settle(4);
      expect([w.$("#outSwitch").checked, w.$("#outOpenAt"), w.$("#outPaused")?.textContent]).toEqual([false, null, "Too many wrong codes. Try again in 15 minutes."]);
    } finally { Object.assign(outsidePoll, saved); }
  });
  it("#3035 review r2: a read that fails (503, the network) keeps what the card showed and the reads going; a failed first read too", async () => {
    const { outsidePoll } = await import("/ui/js/settings-outside.js");
    const saved = { ...outsidePoll };
    outsidePoll.quickMs = 30; outsidePoll.slowMs = 60;
    try {
      const w = await open({ enrolled: true, enrolledAt: 1, outside: true, link: { state: "open", url: "https://x.trycloudflare.com/signin", quick: true } });
      expect(w.$("#outOpenAt")).not.toBeNull();
      answers["GET /ui/outside"] = { status: 503, body: { error: "down" } };
      const before = sent.filter(r => r.path === "/ui/outside").length;
      for (let n = 0; n < 40 && sent.filter(r => r.path === "/ui/outside").length < before + 2; n++) await settle(4);
      expect([w.$("#outsideCard") !== null, w.$("#outOpenAt") !== null]).toEqual([true, true]);       // still shown as it was
      delete answers["GET /ui/outside"];
      status = { ...base, enrolled: true, enrolledAt: 1, outside: false, link: null };
      for (let n = 0; n < 60 && w.$("#outSwitch").checked; n++) await settle(4);
      expect([w.$("#outSwitch").checked, w.$("#outOpenAt")]).toEqual([false, null]);                  // and follows again
      // A first read that fails: no card yet, then it comes.
      await p.unmount();
      answers["GET /ui/outside"] = { status: 503, body: { error: "down" } };
      const { SettingsPanel } = await import("/ui/js/panel-settings.js");
      await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "access" }, navKey: "settings:access2" }));
      await settle(14);
      expect(p.root.querySelector("#outsideCard")).toBeNull();
      delete answers["GET /ui/outside"];
      status = { ...base };
      for (let n = 0; n < 60 && !p.root.querySelector("#outsideCard"); n++) await settle(4);
      expect(p.root.querySelector("#outsideCard")).not.toBeNull();
    } finally { Object.assign(outsidePoll, saved); }
  });
  it("a wait in force says how long", async () => {
    const w = await open({ enrolled: true, enrolledAt: 1, pausedForMs: 2 * 3600_000 });
    expect(w.$("#outPaused").textContent).toBe("Too many wrong codes. Try again in 2 hours.");
  });
  it("from elsewhere: only on the AgEnD computer — the switch read-only, no buttons", async () => {
    const w = await open({ here: false, enrolled: true, enrolledAt: 1, outside: true, link: { state: "open", quick: true } });
    expect([w.$("#outHereOnly").textContent, w.$("#outSwitch").disabled, w.$("#outSwitch").checked, w.$("#outAgain"), w.$("#outRemove"), w.$("#outSetUp"), w.$("#outOpenAt")])
      .toEqual(["Only on the AgEnD computer. Go back to that computer to set up, set up again or remove the app.", true, true, null, null, null, null]);
  });
});

describe("Owner verification and Web authorization: the reference page's words", () => {
  const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  it("nothing set up: the status says so, the app hint and the no-recovery line show, and the enrolment window repeats the no-recovery line", async () => {
    const w = await open();
    const state = w.$("#outState");
    expect([text(state), state.className.includes("is-usable")]).toEqual(["Not set up", false]);
    expect(text(w.$("#outLead"))).toBe("Use your authenticator app's 6-digit code to prove, from outside, that you own this fleet.");
    expect([...w.$("#outApps").querySelectorAll(".tag")].map((e: any) => text(e))).toEqual(["Google Authenticator", "Microsoft Authenticator", "Other TOTP authenticators"]);
    expect(text(w.$("#outNoRecovery"))).toBe("If you lose the authenticator, set it up again on the AgEnD computer. There is no email or backup-code recovery.");
    await w.click(w.$("#outSetUp"));
    expect([text(w.$("#outStep1")), text(w.$("#outStep2")), text(w.$("#outConfirm"))]).toEqual(["1. Add AgEnD to your authenticator", "2. Enter the authenticator code to finish", "Verify and turn on"]);
    expect(text(w.$("#outEnrollNoRecovery"))).toBe("If you lose the authenticator, set it up again on the AgEnD computer. There is no email or backup-code recovery.");
  });
  it("set up: the status reads \"Authenticator set up\" and is marked usable", async () => {
    const w = await open({ enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) });
    const state = w.$("#outState");
    expect([text(state), state.className.includes("is-usable"), w.$("#outNoRecovery")]).toEqual(["Authenticator set up", true, null]);
  });
  it("zh-TW: the card's words follow the reference page (擁有者驗證, 重新綁定驗證器, 停用驗證器, 備援碼)", async () => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang("zh-TW");
    try {
      const w = await open();
      expect([text(w.$("#outsideCard h3")), text(w.$("#outState")), w.$("#outSetUp").textContent]).toEqual(["擁有者驗證", "尚未設定", "設定驗證器"]);
      expect(text(w.$("#outLead"))).toBe("使用驗證器 App 的 6 位數代碼，從外面證明你是這個 fleet 的擁有者。");
      expect([...w.$("#outApps").querySelectorAll(".tag")].map((e: any) => text(e))).toEqual(["Google Authenticator", "Microsoft Authenticator", "其他 TOTP 驗證器"]);
      expect(text(w.$("#outNoRecovery"))).toBe("遺失驗證器時，請回 AgEnD 主機重新綁定。沒有電子郵件或備援碼復原。");
      const on = await open({ enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) });
      expect([text(on.$("#outState")), on.$("#outState").className.includes("is-usable"), on.$("#outAgain").textContent, on.$("#outRemove").textContent])
        .toEqual(["驗證器已設定", true, "重新綁定驗證器", "停用"]);
      expect(p.root.textContent).toContain("手機遺失？請在 AgEnD 電腦上選「重新綁定驗證器」。沒有電子郵件或備援碼復原。");
      expect(p.root.textContent).not.toContain("備用碼");
      const setup = await open();
      await setup.click(setup.$("#outSetUp"));
      expect([text(setup.$("#outStep1")), text(setup.$("#outStep2")), text(setup.$("#outConfirm"))]).toEqual(["1. 在驗證器中新增 AgEnD", "2. 輸入驗證器代碼以完成綁定", "驗證並啟用"]);
      const away = await open({ here: false });
      expect(text(away.$("#outHereOnly"))).toBe("只能在 AgEnD 電腦上變更。設定、重新綁定或停用驗證器，請回到那台電腦操作。");
    } finally { i18n.setLang("en"); }
  });
  it("the Remove question has its own title and button, in both languages", async () => {
    const { confirmStore, answerConfirm } = await import("/assets/ui-confirm.js");
    const i18n = await import("/assets/app-i18n.js");
    (globalThis as any).confirm = undefined;                                           // the test drives the dialog itself
    const ask = async () => {
      const w = await open({ enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) });
      fire(w.$("#outRemove"), "click"); await settle(6);
      const q = confirmStore.get().queue[0];
      const seen = [q.title, q.confirmLabel];
      answerConfirm(q.id, false); await settle(4);
      return seen;
    };
    expect(await ask()).toEqual(["Remove the authenticator app?", "Remove"]);
    i18n.setLang("zh-TW");
    try { expect(await ask()).toEqual(["停用驗證器？", "停用"]); } finally { i18n.setLang("en"); }
  });
  it("Web authority on a web-only fleet: the authenticator wording; with a chat connection: the Discord / Telegram wording stays", async () => {
    authWebOnly = true;
    let w = await open();
    expect([text(w.$(".s-authority-brief")), text(w.$("#vaEnabled").parentNode)])
      .toEqual(["This fleet has no chat platform connected. The host owner can verify directly; a remote session confirms who the owner is with the authenticator.", "Allow web authorization by a verified owner"]);
    expect(text(w.$(".s-authority-rule"))).toBe("Signing in a device and authorizing an action are judged separately. When this is off, even a verified web session cannot approve actions that need authority.");
    authWebOnly = false;
    w = await open();
    expect([text(w.$(".s-authority-brief")).startsWith("Only signed-in fleet administrators can confirm"), text(w.$("#vaEnabled").parentNode)]).toEqual([true, "Allow web authority"]);
    authWebOnly = undefined;                                                                  // an older server: no flag, the chat wording
    w = await open();
    expect(text(w.$("#vaEnabled").parentNode)).toBe("Allow web authority");
  });
  it("Web authority in zh-TW: the reference page's lead, switch and rule", async () => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang("zh-TW");
    try {
      authWebOnly = true;
      const w = await open();
      expect([text(w.$(".s-authority-brief")), text(w.$("#vaEnabled").parentNode), text(w.$(".s-authority-rule"))]).toEqual([
        "這個 fleet 未連接聊天平台。主機 owner 可直接驗證；遠端工作階段需透過驗證器確認擁有者身分。",
        "允許已驗證擁有者的網頁授權",
        "裝置登入與擁有者授權分開判斷。關閉後，已驗證的網頁工作階段也不能核准需授權的操作。"]);
    } finally { i18n.setLang("en"); }
  });
});
