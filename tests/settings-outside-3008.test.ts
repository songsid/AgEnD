/**
 * #3008 ② / AGEND-122 (R1) Settings → Access & security → "Owner verification" (src/ui/settings-outside.js), as rendered — the
 * leader's wording (cid-alpha3-design, strings 1–13 and 17). The card is driven by what GET /ui/outside says: `webOnly`, `here`
 * (this computer's host admin: the switch), `manage` (this session may set up / replace / remove the app: an admin on a direct
 * connection, this computer or another device, a chat fleet too), `codeNeeded` (replacing or removing asks the current code):
 *  - a fleet with a chat connection: the card shows to a session that can `manage` it (no switch, the confirm lead), and read-only
 *    when an app is set up; with neither a say nor an app there is nothing to show;
 *  - an admin who can manage, nothing set up: the switch can't be turned on, the hint says to set up an app first; "Set up
 *    authenticator app" shows a QR code (drawn by the vendored encoder as one SVG path), the key in groups of four and
 *    the code field; Continue waits for 6 digits; a wrong code says to check the phone's clock; a right one closes it;
 *  - set up: the date, the lost-phone line, "Set up again" (asks, with the leader's words) and "Remove" (asks); the
 *    switch turns it on (POST /ui/outside/switch) and the status says where it is open, a quick link's note included;
 *  - a wait in force says how long, as words;
 *  - from another device (`here: false`, `manage: true`): the buttons are there, the switch is read-only and says it is the
 *    AgEnD computer's; a session that cannot manage (`manage: false`): "This can only be changed on the computer running AgEnD.",
 *    no buttons; `codeNeeded`: Set up again / Remove ask for the current code first (the dialog, wrong / paused answers, its words).
 *  - the caller's OWN switch `#outStrict` ("Ask for my authenticator code to confirm changes from other devices", per admin — no
 *    fleet.yaml key): shown when `manage` and an app is set up; turning it on posts `{ on: true }` to /ui/outside/strict and asks
 *    nothing; turning it off posts `{ on: false }` at once when `codeNeeded` is false, and opens the current-code dialog
 *    (`ask.kind === "strict"`) when it is true, then posts `{ on: false, code }` (401 → "That code didn't work", 429 → paused);
 *  - the Web authority card has NO `#vaRemoteCode` any more (the fleet-wide toggle is gone, and so is its registry entry).
 * Pure helpers too: the wait's words, the key's groups, the QR path from the real vendored encoder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const schema = buildSettingsImpactSchema();
let p: AppPage, status: any, chat = false, authWebOnly: boolean | undefined, authConfigured: Record<string, unknown> = {};
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
    if (path === "/api/settings/web-authority") return { state: { enabled: true, loopbackOnly: false, epoch: 1 }, configured: authConfigured, hours: { min: 1, max: 48, default: 48 }, lanHosts: [], authorized: [], ...(authWebOnly === undefined ? {} : { webOnly: authWebOnly }) };
    if (path === "/api/settings/guests") return { enabled: false, chat: true, instances: [], connections: [], guests: [] };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return { defaults: { locale: "en" }, instances: {}, ...(chat ? { channels: [{ type: "telegram", id: "telegram" }] } : {}), web: { verified_authority: authConfigured } };
    if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
    if (path === "/api/settings/connections") return [];
    if (path === "/api/fleet") return { version: "2.3.5", instances: [] };
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/settings/access" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; answers = {}; chat = false; authWebOnly = undefined; authConfigured = {}; p.window.confirm = () => true; (globalThis as any).confirm = () => true; });
afterEach(async () => { await p.unmount(); });

const base = { webOnly: true, here: true, manage: true, codeNeeded: false, strict: false, enrolled: false, enrolledAt: null, outside: false, pausedForMs: 0, link: null };
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
  it("a fleet with a chat connection (webOnly: false): the card shows to a session that can manage the app — no outside switch, the reworded your-own lead, set up works", async () => {
    const w = await open({ webOnly: false, here: false, manage: true });
    expect([w.$("#outsideCard h3")?.textContent, w.$("#outSwitch"), w.$("#outNeedApp"), w.$("#outSwitchHere"), !!w.$("#outSetUp")]).toEqual(["Owner verification", null, null, null, true]);
    expect(w.$("#outLead").textContent).toBe("Your own authenticator app. With it you can ask for its 6-digit code each time you confirm a change from another device; nobody else can set it up, change it or switch that on or off for you.");
    expect([w.$("#outStrict"), w.$("#outAgain")]).toEqual([null, null]);                       // no app yet: no own switch to show
    await w.click(w.$("#outSetUp"));
    await settle(10);
    expect([w.posts(), !!w.$("#outEnroll")]).toEqual([[["/ui/outside/enroll", {}]], true]);
  });
  it("a chat fleet, a session that cannot manage it: nothing to show without an app; read-only with one (no buttons)", async () => {
    const none = await open({ webOnly: false, here: false, manage: false });
    expect(none.$("#outsideCard")).toBeNull();
    const set = await open({ webOnly: false, here: false, manage: false, enrolled: true, enrolledAt: 1 });
    expect([set.$("#outState").textContent, set.$("#outHereOnly").textContent, set.$("#outSetUp"), set.$("#outAgain"), set.$("#outRemove"), set.$("#outSwitch")])
      .toEqual(["Authenticator set up", "This can only be changed on the computer running AgEnD.", null, null, null, null]);
  });
  it("an older server (no `manage`): read as before — only this computer's admin manages", async () => {
    const away = await open({ manage: undefined, codeNeeded: undefined, strict: undefined, here: false });
    expect([away.$("#outHereOnly") !== null, away.$("#outSetUp")]).toEqual([true, null]);
    const here = await open({ manage: undefined, here: true });
    expect([here.$("#outHereOnly"), here.$("#outSetUp") !== null]).toEqual([null, true]);
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
  it("from another device (here: false, manage: true): the admin sets up again or removes; the switch stays read-only and says whose it is", async () => {
    const w = await open({ here: false, enrolled: true, enrolledAt: 1, outside: true, link: { state: "open", quick: true } });
    expect([w.$("#outHereOnly"), w.$("#outSwitch").disabled, w.$("#outSwitch").checked, w.$("#outSwitchHere").textContent, !!w.$("#outAgain"), !!w.$("#outRemove"), w.$("#outOpenAt")])
      .toEqual([null, true, true, "Connections from outside are turned on and off on the computer running AgEnD.", true, true, null]);   // the link's address is this computer's only
    const none = await open({ here: false });
    expect([none.$("#outSwitch").disabled, !!none.$("#outSetUp")]).toEqual([true, true]);
  });
  it("a session that cannot manage it (manage: false — over a link, a guest, not an admin): the state only, no buttons, the switch read-only", async () => {
    const w = await open({ here: false, manage: false, enrolled: true, enrolledAt: 1, outside: true, link: { state: "open", quick: true } });
    expect([w.$("#outHereOnly").textContent, w.$("#outSwitch").disabled, w.$("#outSwitch").checked, w.$("#outAgain"), w.$("#outRemove"), w.$("#outSetUp"), w.$("#outSwitchHere"), w.$("#outOpenAt")])
      .toEqual(["This can only be changed on the computer running AgEnD.", true, true, null, null, null, null, null]);
    const unset = await open({ here: false, manage: false });
    expect([unset.$("#outHereOnly") !== null, unset.$("#outSetUp")]).toEqual([true, null]);
  });
  it("the AgEnD computer's own admin (here: true): the switch works whatever strict says — the code is never asked there", async () => {
    const w = await open({ enrolled: true, enrolledAt: 1, strict: true, codeNeeded: false });
    await w.check(w.$("#outSwitch"), true);
    await w.click(w.$("#outRemove"));
    await settle(10);
    expect(w.posts()).toEqual([["/ui/outside/switch", { on: true }], ["/ui/outside/remove", {}]]);   // no code dialog, no code in the body
    expect(p.root.querySelector("#outAsk")).toBeNull();
  });
  // AGEND-122: the owner's strict option is on and this session is off the AgEnD computer: replacing or removing the app asks for
  // the CURRENT code, in a dialog of its own, before anything happens (the server asks again and answers 400 / 401 / 429).
  describe("the current code (codeNeeded): Set up again and Remove ask for it first", () => {
    const away = { here: false, manage: true, codeNeeded: true, strict: true, enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) };
    it("Set up again: the code dialog first, no enrolment request until it is right; the code goes with the request; then the set-up dialog", async () => {
      const w = await open(away);
      await w.click(w.$("#outAgain"));
      expect([!!w.$("#outAsk"), w.$("#outAsk .note").textContent, w.$("#outAskGo").disabled, w.$("#outEnroll"), w.posts()]).toEqual([true,
        "Your authenticator is asked for here: enter the code your authenticator app shows now to continue.", true, null, []]);
      expect(w.$("dialog .dlg-title").textContent).toBe("Enter the current code");
      await w.type(w.$("#outAskCode"), "12345");
      expect(w.$("#outAskGo").disabled).toBe(true);                                         // 6 digits first
      await w.type(w.$("#outAskCode"), "123 456");
      expect(w.$("#outAskGo").disabled).toBe(false);
      await w.click(w.$("#outAskGo"));
      await settle(10);
      expect(w.posts()).toEqual([["/ui/outside/enroll", { code: "123 456" }]]);
      expect([w.$("#outAsk"), !!w.$("#outEnroll"), w.$("dialog .dlg-title").textContent, w.$("#outKey").textContent]).toEqual([null, true, "Set up again", "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP"]);
    });
    it("Set up again: a wrong code is answered in the dialog (and cleared), a paused one says how long; Cancel changes nothing", async () => {
      const w = await open(away);
      await w.click(w.$("#outAgain"));
      answers["POST /ui/outside/enroll"] = { status: 401, body: { error: "wrong" } };
      await w.type(w.$("#outAskCode"), "111111");
      await w.click(w.$("#outAskGo"));
      expect([w.$("#outAskMsg").textContent, w.$("#outAskCode").value, !!w.$("#outAsk"), w.$("#outEnroll")])
        .toEqual(["That code didn't work. Check that your phone's clock is right and try the newest code.", "", true, null]);
      answers["POST /ui/outside/enroll"] = { status: 429, body: { error: "paused", retryAfterMs: 15 * 60_000 } };
      await w.type(w.$("#outAskCode"), "222222");
      await w.click(w.$("#outAskGo"));
      expect(w.$("#outAskMsg").textContent).toBe("Too many wrong codes. Try again in 15 minutes.");
      await w.click(w.$("#outAskCancel"));
      expect([w.$("#outAsk"), w.$("#outEnroll"), w.posts().map(x => x[0])]).toEqual([null, null, ["/ui/outside/enroll", "/ui/outside/enroll"]]);
    });
    it("Remove: a code first — no confirm question, nothing sent until the code; the code goes with the request; the dialog closes when it worked", async () => {
      const w = await open(away);
      await w.click(w.$("#outRemove"));
      expect([w.$("dialog .dlg-title").textContent, w.$("#outAsk").textContent.includes("Your code will no longer be accepted"), w.posts()]).toEqual(["Remove the authenticator app?", true, []]);
      await w.type(w.$("#outAskCode"), "654321");
      await w.click(w.$("#outAskGo"));
      await settle(10);
      expect([w.posts(), w.$("#outAsk")]).toEqual([[["/ui/outside/remove", { code: "654321" }]], null]);
    });
    it("Remove: wrong code → says so and stays; paused → how long", async () => {
      const w = await open(away);
      await w.click(w.$("#outRemove"));
      answers["POST /ui/outside/remove"] = { status: 401, body: { error: "wrong" } };
      await w.type(w.$("#outAskCode"), "000000");
      await w.click(w.$("#outAskGo"));
      expect([w.$("#outAskMsg").textContent, !!w.$("#outAsk")]).toEqual(["That code didn't work. Check that your phone's clock is right and try the newest code.", true]);
      answers["POST /ui/outside/remove"] = { status: 429, body: { error: "paused", retryAfterMs: 2 * 3600_000 } };
      await w.type(w.$("#outAskCode"), "000001");
      await w.click(w.$("#outAskGo"));
      expect(w.$("#outAskMsg").textContent).toBe("Too many wrong codes. Try again in 2 hours.");
    });
    it("not needed (this computer, or the option off): no dialog — Set up again opens the set-up at once, Remove asks its old question", async () => {
      const w = await open({ ...away, codeNeeded: false });
      await w.click(w.$("#outAgain"));
      await settle(10);
      expect([w.$("#outAsk"), !!w.$("#outEnroll"), w.posts()]).toEqual([null, true, [["/ui/outside/enroll", {}]]]);
    });
    it("a first-time set-up asks no code (it only tightens), even in strict mode", async () => {
      const w = await open({ here: false, manage: true, codeNeeded: false, strict: true, enrolled: false });
      await w.click(w.$("#outSetUp"));
      await settle(10);
      expect([w.$("#outAsk"), w.posts()]).toEqual([null, [["/ui/outside/enroll", {}]]]);
    });
    it("zh-TW: the code dialog's words", async () => {
      const i18n = await import("/assets/app-i18n.js");
      i18n.setLang("zh-TW");
      try {
        const w = await open(away);
        await w.click(w.$("#outAgain"));
        expect([w.$("dialog .dlg-title").textContent, w.$("#outAsk .note").textContent, w.$("#outAskGo").textContent, w.$("#outAskCode").parentNode.querySelector("label").textContent])
          .toEqual(["請輸入目前的驗證碼", "這裡要求你的驗證器：請輸入驗證器 App 現在顯示的驗證碼才能繼續。", "繼續", "6 位數驗證碼（驗證器 App）"]);
        answers["POST /ui/outside/enroll"] = { status: 429, body: { error: "paused", retryAfterMs: 60 * 60_000 } };
        await w.type(w.$("#outAskCode"), "123456");
        await w.click(w.$("#outAskGo"));
        expect(w.$("#outAskMsg").textContent).toBe("錯誤次數太多，請 1 小時 後再試。");
      } finally { i18n.setLang("en"); }
    });
  });
});

// AGEND-122 (per admin): the card's own switch, "Ask for my authenticator code to confirm changes from other devices".
describe("#outStrict: the caller's own switch", () => {
  const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const mine = { enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) };
  const WRONG = "That code didn't work. Check that your phone's clock is right and try the newest code.";
  it("shown only to a session that can manage and has an app: not without an app, not when it cannot manage; an absent field reads as off", async () => {
    const w = await open({ ...mine });
    const box = w.$("#outStrict");
    expect([box.checked, box.disabled, box.getAttribute("role"), text(box.parentNode)]).toEqual([false, false, "switch", "Ask for my authenticator code to confirm changes from other devices"]);
    expect(text(w.$("#outStrict-hint"))).toContain("Off (the default): you apply a change from any device with Apply now. On: off the computer running AgEnD, each of YOUR confirmations takes the code for that change.");
    expect(text(w.$("#outStrict-hint"))).toContain("It never applies to other admins");
    expect((await open()).$("#outStrict")).toBeNull();                                          // no app: nothing to ask the code of
    expect((await open({ ...mine, manage: false, here: false })).$("#outStrict")).toBeNull();     // read-only session: not its switch to flip
    expect((await open({ ...mine, strict: undefined })).$("#outStrict").checked).toBe(false);      // a server that does not say: off
    expect((await open({ ...mine, strict: true })).$("#outStrict").checked).toBe(true);
  });
  it("shown on a chat fleet too (webOnly: false), away from the computer — it is the admin's own, not the fleet's", async () => {
    const w = await open({ webOnly: false, here: false, manage: true, ...mine, strict: true, codeNeeded: true });
    expect([w.$("#outStrict").checked, w.$("#outSwitch")]).toEqual([true, null]);
  });
  it("turning it ON posts { on: true } to /ui/outside/strict and asks nothing — no dialog, no code, no other write", async () => {
    const w = await open({ ...mine, here: false, codeNeeded: false });
    status = { ...status, strict: true };
    await w.check(w.$("#outStrict"), true);
    expect(w.posts()).toEqual([["/ui/outside/strict", { on: true }]]);
    expect([p.root.querySelector("#outAsk"), w.$("#outStrict").checked]).toEqual([null, true]);
    expect(sent.some(r => r.method !== "GET" && r.path.startsWith("/api/settings"))).toBe(false);   // not a fleet.yaml setting any more
  });
  it("turning it OFF with no code needed (this computer, or its own switch is off) posts { on: false } at once — no dialog", async () => {
    const w = await open({ ...mine, strict: true, codeNeeded: false });
    status = { ...status, strict: false };
    await w.check(w.$("#outStrict"), false);
    expect(w.posts()).toEqual([["/ui/outside/strict", { on: false }]]);
    expect([p.root.querySelector("#outAsk"), w.$("#outStrict").checked]).toEqual([null, false]);
  });
  it("turning it OFF with codeNeeded asks the current code first (kind strict): nothing sent until it is typed; the code goes with { on: false }", async () => {
    const w = await open({ ...mine, here: false, strict: true, codeNeeded: true });
    await w.check(w.$("#outStrict"), false);
    expect(w.posts()).toEqual([]);
    expect([w.$("dialog .dlg-title").textContent, text(w.$("#outAsk")).includes("Turning this off needs your current code."), w.$("#outAskGo").disabled, w.$("#outAskGo").textContent, w.$("#outEnroll")])
      .toEqual(["Enter the current code", true, true, "Continue", null]);
    expect(text(w.$("#outAsk")).includes("no longer be accepted")).toBe(false);                  // not the remove words
    await w.type(w.$("#outAskCode"), "12345");
    expect(w.$("#outAskGo").disabled).toBe(true);                                                // 6 digits first
    await w.type(w.$("#outAskCode"), "123 456");
    status = { ...status, strict: false };
    await w.click(w.$("#outAskGo"));
    await settle(10);
    expect([w.posts(), w.$("#outAsk"), w.$("#outStrict").checked]).toEqual([[["/ui/outside/strict", { on: false, code: "123 456" }]], null, false]);
  });
  it("a wrong code (401) says so in the dialog, clears the field and stays; a pause (429) says how long; Cancel sends nothing more and the switch stays on", async () => {
    const w = await open({ ...mine, here: false, strict: true, codeNeeded: true });
    await w.check(w.$("#outStrict"), false);
    answers["POST /ui/outside/strict"] = { status: 401, body: { error: "wrong" } };
    await w.type(w.$("#outAskCode"), "111111");
    await w.click(w.$("#outAskGo"));
    expect([w.$("#outAskMsg").textContent, w.$("#outAskCode").value, !!w.$("#outAsk")]).toEqual([WRONG, "", true]);
    answers["POST /ui/outside/strict"] = { status: 429, body: { error: "paused", retryAfterMs: 15 * 60_000 } };
    await w.type(w.$("#outAskCode"), "222222");
    await w.click(w.$("#outAskGo"));
    expect(w.$("#outAskMsg").textContent).toBe("Too many wrong codes. Try again in 15 minutes.");
    await w.click(w.$("#outAskCancel"));
    expect([w.$("#outAsk"), w.posts()]).toEqual([null, [["/ui/outside/strict", { on: false, code: "111111" }], ["/ui/outside/strict", { on: false, code: "222222" }]]]);
    expect(w.$("#outStrict").checked).toBe(true);                                                // the server never turned it off
  });
  it("a refused write (the server says no) and the switch goes back to what the server holds", async () => {
    const w = await open({ ...mine, strict: false });
    answers["POST /ui/outside/strict"] = { status: 409, body: { error: "not_enrolled" } };
    await w.check(w.$("#outStrict"), true);
    await settle(10);
    expect([w.posts(), w.$("#outStrict").checked]).toEqual([[["/ui/outside/strict", { on: true }]], false]);
  });
  it("Set up again with codeNeeded still asks (kind again) — it is not the switch's dialog", async () => {
    const w = await open({ ...mine, here: false, strict: true, codeNeeded: true });
    await w.click(w.$("#outAgain"));
    expect([text(w.$("#outAsk")).includes("Turning this off"), w.posts()]).toEqual([false, []]);
  });
  it("zh-TW: the switch, its hint, the dialog's own line, a wrong code, and the chat fleet's reworded lead", async () => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang("zh-TW");
    try {
      const w = await open({ ...mine, here: false, strict: true, codeNeeded: true });
      expect([text(w.$("#outStrict").parentNode), text(w.$("#outStrict-hint")).startsWith("關閉（預設）：你可以在任何裝置按「直接套用」完成變更。開啟：在執行 AgEnD 的那台電腦以外，「你自己」的每次確認都要輸入該項變更的驗證碼。只約束你自己，不影響其他管理員")])
        .toEqual(["從其他裝置確認變更時要我的驗證碼", true]);
      await w.check(w.$("#outStrict"), false);
      expect([w.$("dialog .dlg-title").textContent, text(w.$("#outAsk")).includes("關閉需要你目前的驗證碼。"), w.posts()]).toEqual(["請輸入目前的驗證碼", true, []]);
      await w.type(w.$("#outAskCode"), "123456");
      answers["POST /ui/outside/strict"] = { status: 401, body: { error: "wrong" } };
      await w.click(w.$("#outAskGo"));
      expect(w.$("#outAskMsg").textContent).toBe("驗證碼不對。請確認手機時間正確，並輸入最新的驗證碼。");
      const chat = await open({ webOnly: false, here: false, manage: true });
      expect(text(chat.$("#outLead"))).toBe("你自己的驗證器 App。可以在每次從其他裝置確認變更時要求它的 6 位數驗證碼；別人無法替你設定、更換或開關。");
    } finally { i18n.setLang("en"); }
  });
});

// AGEND-122: a phone-sized card — Owner verification's buttons, the dialog's code fields and its switches are tap targets (style guide rule 7).
describe("#3008 ② the card on a phone: tap targets (CSS, read as text like the other CSS ratchets)", () => {
  const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("a phone media query gives .s-outside buttons, fields and label.check min-height: var(--tap)", () => {
    // every top-level `@media (max-width: …) { … }` block (the phone ones), brace-balanced
    const phone: string[] = [];
    for (const m of css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{/g)) {
      if (Number(m[1]) < 600) continue;                                                            // a phone is a width below the 900px desktop split
      let depth = 1, i = m.index! + m[0].length;
      for (; i < css.length && depth > 0; i++) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; }
      phone.push(css.slice(m.index!, i));
    }
    const rule = phone.flatMap(b => [...b.matchAll(/([^{}]*\.s-outside[^{}]*)\{([^{}]*)\}/g)]).find(r => /min-height:\s*var\(--tap\)/.test(r[2]));
    expect(rule, "no phone media-query rule sets min-height: var(--tap) on .s-outside").toBeDefined();
    const selector = rule![1].replace(/\s+/g, " ");
    expect([/\.btn/.test(selector), /\.field input/.test(selector), /label\.check/.test(selector)]).toEqual([true, true, true]);
  });
  it("and no desktop-wide rule makes them tall (the rule lives only inside the phone query)", () => {
    const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");               // CSS with every one-level media block cut out
    expect(outside).not.toMatch(/\.s-outside[^{}]*\{[^{}]*min-height:\s*var\(--tap\)/);
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
      expect(text(w.$("#outLead"))).toBe("使用驗證器 App 的 6 位數驗證碼，從外面證明你是這個 fleet 的擁有者。");
      expect([...w.$("#outApps").querySelectorAll(".tag")].map((e: any) => text(e))).toEqual(["Google Authenticator", "Microsoft Authenticator", "其他 TOTP 驗證器"]);
      expect(text(w.$("#outNoRecovery"))).toBe("遺失驗證器時，請回 AgEnD 主機重新綁定。沒有電子郵件或備援碼復原。");
      const on = await open({ enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) });
      expect([text(on.$("#outState")), on.$("#outState").className.includes("is-usable"), on.$("#outAgain").textContent, on.$("#outRemove").textContent])
        .toEqual(["驗證器已設定", true, "重新綁定驗證器", "停用"]);
      expect(p.root.textContent).toContain("手機遺失？請在 AgEnD 電腦上選「重新綁定驗證器」。沒有電子郵件或備援碼復原。");
      expect(p.root.textContent).not.toContain("備用碼");
      const setup = await open();
      await setup.click(setup.$("#outSetUp"));
      expect([text(setup.$("#outStep1")), text(setup.$("#outStep2")), text(setup.$("#outConfirm"))]).toEqual(["1. 在驗證器中新增 AgEnD", "2. 輸入 6 位數驗證碼以完成綁定", "驗證並啟用"]);
      const away = await open({ here: false, manage: false });
      expect(text(away.$("#outHereOnly"))).toBe("只能在執行 AgEnD 的那台電腦上變更。");
      const other = await open({ here: false });
      expect(text(other.$("#outSwitchHere"))).toBe("從外面連線的開關，要在執行 AgEnD 的那台電腦上操作。");
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
  // AGEND-122 (per admin): the fleet-wide "Ask for an authenticator code..." toggle of the Web authority card is gone — each admin's own
  // switch lives in the Owner verification card (#outStrict). Nothing of the old one may come back (it wrote a fleet.yaml key that no longer exists).
  it("the Web authority card has no #vaRemoteCode (the fleet-wide toggle, its hint and its set-up note are gone), whatever the server says", async () => {
    for (const [onlyWeb, configured] of [[true, {}], [false, {}], [undefined, { remote_confirm_code: true }]] as const) {
      authWebOnly = onlyWeb as any; authConfigured = configured;
      const w = await open({ enrolled: true, enrolledAt: 1, strict: true });
      expect([!!w.$("#vaEnabled"), w.$("#vaRemoteCode"), w.$("#vaRemoteCode-hint"), w.$("#vaRemoteCodeNeedApp")]).toEqual([true, null, null, null]);
      expect(p.root.textContent).not.toContain("Ask for an authenticator code to confirm changes from other devices");
    }
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
