/**
 * Refs #3061 (P2a, P2b): Settings → Access & security → Sign-in & authorization → "Devices & sign-in" (src/ui/settings-devices.js),
 * as rendered. P2b (the last describe): the signed-in devices — this one marked, how each was approved, whether its owner is
 * verified, when it was last active — a Sign out for the others that only the owner gets (the server decides; a disabled
 * button is the page saying so), its confirmation and answers, and the QR link (?approve=<code>) that opens the dialog with
 * the code filled in. P2a, as rendered:
 *  - a fleet with a chat connection (the server says webOnly: false): no card;
 *  - not the verified owner (the server's `owner: false`): the card, its explanation, a DISABLED "Add device" and the line
 *    saying who can;
 *  - the owner: "Add device" opens the dialog; Continue waits for 8 characters; it looks the code up (POST /ui/devices/lookup)
 *    and shows who is asking — the label, the code, whether it came from this computer or the network, its address, the time
 *    left — what is and is not granted, and that approving copies nothing; Allow / Deny post the decision for that code;
 *  - the answers: nothing waits with that code (404), a pause (429, as words), already decided (409), the owner's authority
 *    gone (403 — and the card reads its state again); a request that runs out while it is on screen goes back to the field;
 *  - zh-TW follows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const schema = buildSettingsImpactSchema();
let p: AppPage, devices: any, chat = false;
let sent: Array<{ method: string; path: string; body: any }> = [];
let answers: Record<string, { status: number; body: any }> = {};
const realFetch = (globalThis as any).fetch;
const REQUEST = { code: "ABCD-EFGH", label: "Chrome on Android", peer: "network", address: "192.168.1.23", expiresAt: 0, state: "pending" };
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  const preset = answers[`${method} ${path}`];
  if (preset) return { ok: preset.status < 300, status: preset.status, json: async () => preset.body };
  const body = (() => {
    if (method === "POST" && path === "/ui/devices/lookup") return { request: { ...REQUEST, expiresAt: Date.now() + 240_000 } };
    if (method === "POST" && path.startsWith("/ui/devices/")) return { request: { ...REQUEST, state: path.endsWith("approve") ? "approved" : "denied" } };
    if (method !== "GET") return { ok: true };
    if (path === "/ui/devices") return devices;
    if (path === "/ui/outside") return { webOnly: true, here: true, enrolled: false, enrolledAt: null, outside: false, pausedForMs: 0, link: null };
    if (path === "/api/settings/web-authority") return { state: { enabled: true, loopbackOnly: false, epoch: 1 }, configured: {}, hours: { min: 1, max: 48, default: 48 }, lanHosts: [], authorized: [] };
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
beforeEach(() => { sent = []; answers = {}; chat = false; });
afterEach(async () => { await p.unmount(); });

async function open(state: Record<string, unknown> = { webOnly: true, owner: true }) {
  devices = state;
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "access" }, navKey: "settings:access" }));
  await settle(14);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const click = async (el: any) => { fire(el, "click"); await settle(8); };
  const type = async (el: any, v: string) => { el.value = v; fire(el, "input"); await settle(); };
  const posts = () => sent.filter(s => s.method === "POST" && s.path.startsWith("/ui/devices")).map(s => [s.path, s.body]);
  const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  return { $, click, type, posts, text };
}
/** Add device → type a code → Continue: the confirm screen. */
async function toConfirm() {
  const w = await open();
  await w.click(w.$("#devicesAdd"));
  await w.type(w.$("#devCodeInput"), "abcd-efgh");
  await w.click(w.$("#devFind"));
  return w;
}

describe("#3061 P2a: the helpers", () => {
  it("a pause as words, the time left as m:ss", async () => {
    const { pauseWords, leftClock } = await import("/ui/js/settings-devices.js");
    expect([pauseWords(120_000), pauseWords(60_000), pauseWords(1), pauseWords(5 * 60_000)]).toEqual(["2 minutes", "1 minute", "1 minute", "5 minutes"]);
    expect([leftClock(240_000), leftClock(59_001), leftClock(0), leftClock(-5000), leftClock(300_000)]).toEqual(["4:00", "1:00", "0:00", "0:00", "5:00"]);
  });
});

describe("#3061 P2a: Settings → Devices & sign-in", () => {
  it("a fleet with a chat connection (webOnly: false): no card; a failed read: no card", async () => {
    expect((await open({ webOnly: false, owner: false })).$("#devicesCard")).toBeNull();
    answers["GET /ui/devices"] = { status: 503, body: { error: "down" } };
    expect((await open()).$("#devicesCard")).toBeNull();
  });

  it("not the verified owner: the card and its words, a disabled Add device, and who can", async () => {
    const w = await open({ webOnly: true, owner: false });
    expect(w.text(w.$("#devicesCard h3"))).toBe("Devices & sign-in");
    expect(w.text(w.$("#devicesLead"))).toBe("Sign in a new device with an 8-character code. You approve it here, on a device that is already signed in as the owner.");
    expect(w.text(w.$("#devicesNoCopy"))).toBe("Approving does not copy this device's sign-in. The new device gets a session of its own.");
    expect(w.text(w.$("#devicesOwnerOnly"))).toBe("Only a device whose owner is verified can add a device. Use the AgEnD computer, or sign in with the authenticator app.");
    expect(w.$("#devicesAdd").disabled).toBe(true);
    await w.click(w.$("#devicesAdd"));
    expect(w.$("#devLead")).toBeNull();                                                   // no dialog opened
  });

  it("the card sits right after Owner verification, before the sign-in session settings", async () => {
    const w = await open();
    const order = [...p.root.querySelectorAll("section.card")].map((e: any) => e.id || (e.className || "").split(" ").find((c: string) => c.startsWith("s-access-session")) || "");
    expect(order.indexOf("outsideCard")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("devicesCard")).toBe(order.indexOf("outsideCard") + 1);
    expect(w.$("#devicesAdd").disabled).toBe(false);
  });

  it("the owner: Add device → the code field (Continue waits for 8 characters) → the confirm screen: who asks, what is granted, nothing is copied", async () => {
    const w = await open();
    expect(w.$("#devicesOwnerOnly")).toBeNull();
    await w.click(w.$("#devicesAdd"));
    expect(w.text(w.$(".dlg-title"))).toBe("Add device");
    expect(w.text(w.$("#devLead"))).toBe("On the new device, choose “Sign in with another device”, then enter the code it shows.");
    expect(w.$("#devFind").disabled).toBe(true);
    await w.type(w.$("#devCodeInput"), "abcd-efg");
    expect(w.$("#devFind").disabled).toBe(true);                                          // seven characters
    await w.type(w.$("#devCodeInput"), "abcd-efgh");
    expect(w.$("#devFind").disabled).toBe(false);
    await w.click(w.$("#devFind"));
    expect(w.posts()).toEqual([["/ui/devices/lookup", { code: "abcd-efgh" }]]);
    expect(w.text(w.$("#devConfirmLead"))).toBe("Allow this device to sign in?");
    expect([w.text(w.$("#devLabel")), w.text(w.$("#devCodeShown")), w.text(w.$("#devFrom")), w.text(w.$("#devAddress"))])
      .toEqual(["Chrome on Android", "ABCD-EFGH", "The network (LAN or tailnet)", "192.168.1.23"]);
    expect(w.text(w.$("#devLeft"))).toMatch(/^[34]:\d\d$/);
    expect(w.text(w.$("#devGrants"))).toBe("General web actions only. Owner authorization is not included; it is verified separately.");
    expect(w.text(w.$("#devNoCopy"))).toBe("Approving does not copy this device's sign-in. The new device gets a session of its own.");
    expect([w.text(w.$("#devBack")), w.text(w.$("#devDeny")), w.text(w.$("#devAllow"))]).toEqual(["Back", "Deny", "Allow"]);
  });

  it("a request from this computer says so", async () => {
    answers["POST /ui/devices/lookup"] = { status: 200, body: { request: { ...REQUEST, peer: "host", address: "127.0.0.1", expiresAt: Date.now() + 200_000 } } };
    const w = await toConfirm();
    expect(w.text(w.$("#devFrom"))).toBe("This computer");
  });

  it("Allow posts the approval for THAT code (as the server gave it) and says what happens; Done closes it", async () => {
    const w = await toConfirm();
    await w.click(w.$("#devAllow"));
    expect(w.posts()).toEqual([["/ui/devices/lookup", { code: "abcd-efgh" }], ["/ui/devices/approve", { code: "ABCD-EFGH" }]]);
    expect(w.text(w.$("#devDone"))).toBe("Approved. The new device signs in within a few seconds.");
    await w.click(w.$("#devDoneBtn"));
    expect([w.$("#devDone"), w.$("#devCodeInput")]).toEqual([null, null]);
  });

  it("Deny posts the denial; Back returns to the field", async () => {
    const w = await toConfirm();
    await w.click(w.$("#devBack"));
    expect(w.$("#devCodeInput")).not.toBeNull();
    await w.click(w.$("#devFind"));
    await w.click(w.$("#devDeny"));
    expect(w.posts().at(-1)).toEqual(["/ui/devices/deny", { code: "ABCD-EFGH" }]);
    expect(w.text(w.$("#devDone"))).toBe("Denied. The new device was told it may not sign in.");
  });

  it("the server's answers, in words: nothing waits with that code (404); a pause (429); already decided (409)", async () => {
    const w = await open();
    await w.click(w.$("#devicesAdd"));
    await w.type(w.$("#devCodeInput"), "ZZZZ-ZZZZ");
    answers["POST /ui/devices/lookup"] = { status: 404, body: { error: "not_found" } };
    await w.click(w.$("#devFind"));
    expect(w.text(w.$("#devMsg"))).toBe("No device is waiting with that code. Check the code on the new device; it may have expired.");
    answers["POST /ui/devices/lookup"] = { status: 429, body: { error: "paused", retryAfterMs: 100_000 } };
    await w.click(w.$("#devFind"));
    expect(w.text(w.$("#devMsg"))).toBe("Too many wrong codes. Try again in 2 minutes.");
    answers["POST /ui/devices/lookup"] = { status: 409, body: { error: "already_decided" } };
    await w.click(w.$("#devFind"));
    expect(w.text(w.$("#devMsg"))).toBe("That request was already decided.");
    await w.type(w.$("#devCodeInput"), "ZZZZ-ZZZY");                                      // typing again clears the line
    expect(w.$("#devMsg")).toBeNull();
  });

  it("the owner's authority gone (403): said so, and the card reads its state again", async () => {
    const w = await toConfirm();
    devices = { webOnly: true, owner: false };
    answers["POST /ui/devices/approve"] = { status: 403, body: { error: "owner_required" } };
    await w.click(w.$("#devAllow"));
    expect(w.text(w.$("#devMsg"))).toBe("This device can no longer approve sign-ins: its owner verification has ended.");
    await settle(10);
    expect(w.$("#devicesOwnerOnly")).not.toBeNull();
    expect(sent.filter(s => s.method === "GET" && s.path === "/ui/devices").length).toBeGreaterThanOrEqual(2);
  });

  it("a request that runs out while it is on screen goes back to the field with the reason; the countdown counts", async () => {
    answers["POST /ui/devices/lookup"] = { status: 200, body: { request: { ...REQUEST, expiresAt: Date.now() + 1500 } } };
    const w = await toConfirm();
    expect(w.text(w.$("#devLeft"))).toMatch(/^0:0[12]$/);
    for (let n = 0; n < 60 && !w.$("#devMsg"); n++) await new Promise(r => setTimeout(r, 100));
    expect(w.text(w.$("#devMsg"))).toBe("That code has expired. Ask the new device for a new one.");
    expect(w.$("#devCodeInput")).not.toBeNull();
  }, 10_000);

  it("zh-TW: the card, the dialog and the answers", async () => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang("zh-TW");
    try {
      const w = await open({ webOnly: true, owner: false });
      expect([w.text(w.$("#devicesCard h3")), w.text(w.$("#devicesAdd")), w.text(w.$("#devicesOwnerOnly"))]).toEqual(["裝置與登入", "新增裝置", "只有已驗證擁有者的裝置才能新增裝置。請使用 AgEnD 電腦，或用驗證器 App 登入。"]);
      const o = await open();
      await o.click(o.$("#devicesAdd"));
      await o.type(o.$("#devCodeInput"), "abcd-efgh");
      await o.click(o.$("#devFind"));
      expect([o.text(o.$("#devConfirmLead")), o.text(o.$("#devFrom")), o.text(o.$("#devGrants")), o.text(o.$("#devAllow")), o.text(o.$("#devDeny"))])
        .toEqual(["允許這台裝置登入？", "網路（區網或 tailnet）", "只能使用一般的網頁功能，不含擁有者授權；擁有者授權需另外驗證。", "允許", "拒絕"]);
      answers["POST /ui/devices/approve"] = { status: 404, body: { error: "not_found" } };
      await o.click(o.$("#devAllow"));
      expect(o.text(o.$("#devMsg"))).toBe("沒有等待中的裝置使用這組代碼。請確認新裝置上的代碼；它可能已失效。");
    } finally { i18n.setLang("en"); }
  });
});


// ── P2b ──
const NOW = Date.now();
const ROWS = [
  { handle: "aaaaaaaaaaaaaaaa", label: "Firefox on Linux", via: "host", ownerVerified: true, current: true, surface: "local", created: NOW - 3_600_000, lastSeen: NOW, expiresAt: NOW + 3_600_000 },
  { handle: "bbbbbbbbbbbbbbbb", label: "Chrome on Android", via: "device", ownerVerified: false, current: false, surface: "local", created: NOW - 900_000, lastSeen: NOW - 5 * 60_000, expiresAt: NOW + 3_600_000 },
  { handle: "cccccccccccccccc", label: "Safari on iPhone", via: "totp", ownerVerified: true, current: false, surface: "gateway", created: NOW - 7_200_000, lastSeen: NOW - 3 * 3_600_000, expiresAt: NOW + 3_600_000 },
  { handle: "dddddddddddddddd", label: "Edge on Windows", via: "code", ownerVerified: false, current: false, surface: "local", created: NOW - 7_200_000, lastSeen: NOW - 20_000, expiresAt: NOW + 3_600_000 },
];
/** A row as [its name (and mark), its details, its button]. */
const rowText = (w: any, handle: string) => [w.text(w.$(`[data-handle="${handle}"] .s-dev-name`)), w.text(w.$(`[data-handle="${handle}"] .s-dev-meta`)), w.text(w.$(`[data-handle="${handle}"] [data-signout]`))];

describe("#3061 P2b: the signed-in devices", () => {
  it("every device, this one marked: how it was approved, whether its owner is verified, when it was last active", async () => {
    const w = await open({ webOnly: true, owner: true, devices: ROWS });
    expect(w.text(w.$("#devicesListTitle"))).toBe("Signed-in devices");
    expect([...p.root.querySelectorAll(".s-dev-row")].length).toBe(4);
    expect(rowText(w, "aaaaaaaaaaaaaaaa")).toEqual(["Firefox on Linux This device", "Approved by this computer · Owner verified · active just now", ""]);
    expect(rowText(w, "bbbbbbbbbbbbbbbb")).toEqual(["Chrome on Android", "Approved by device code · Signed in, owner not verified yet · active 5 min ago", "Sign out"]);
    expect(rowText(w, "cccccccccccccccc")).toEqual(["Safari on iPhone", "Approved by authenticator app · Owner verified · active 3 h ago", "Sign out"]);
    expect(rowText(w, "dddddddddddddddd")).toEqual(["Edge on Windows", "Approved by sign-in code · Signed in, owner not verified yet · active just now", "Sign out"]);
    // Only the others have a Sign out — never the device being used.
    expect(w.$('[data-handle="aaaaaaaaaaaaaaaa"] [data-signout]')).toBeNull();
    expect([...p.root.querySelectorAll("[data-signout]")].map((b: any) => b.disabled)).toEqual([false, false, false]);
    expect([w.$('[data-handle="bbbbbbbbbbbbbbbb"] [data-owner]').getAttribute("data-owner"), w.$('[data-handle="cccccccccccccccc"] [data-owner]').getAttribute("data-owner")]).toEqual(["no", "yes"]);
    // Labels are other browsers' User-Agents: text, never markup.
    const hostile = [{ ...ROWS[0], label: "<img src=x onerror=alert(1)>" }];
    const x = await open({ webOnly: true, owner: true, devices: hostile });
    expect(x.$(".s-dev-row img")).toBeNull();
    expect(x.text(x.$(".s-dev-name"))).toContain("<img src=x onerror=alert(1)>");
  });

  it("not the owner: the list is shown, every Sign out is disabled, and the line says who can — nothing is posted", async () => {
    const w = await open({ webOnly: true, owner: false, devices: ROWS });
    expect([...p.root.querySelectorAll("[data-signout]")].map((b: any) => b.disabled)).toEqual([true, true, true]);
    expect(w.text(w.$("#devicesSignOutOwnerOnly"))).toBe("Only a device whose owner is verified can sign out another device.");
    await w.click(w.$('[data-signout="bbbbbbbbbbbbbbbb"]'));
    expect(w.$("#devSignOutLead")).toBeNull();
    expect(sent.filter(s => s.path === "/ui/devices/signout")).toEqual([]);
    // Alone (no other device) there is nothing to sign out and no line about it.
    const alone = await open({ webOnly: true, owner: false, devices: [ROWS[0]] });
    expect(alone.$("#devicesSignOutOwnerOnly")).toBeNull();
  });

  it("the owner: Sign out asks first, then posts that device's handle; the list is read again and the line says it", async () => {
    const w = await open({ webOnly: true, owner: true, devices: ROWS });
    await w.click(w.$('[data-signout="bbbbbbbbbbbbbbbb"]'));
    expect(w.text(w.$("#devSignOutLead"))).toBe("Chrome on Android will have to sign in again.");
    expect(sent.filter(s => s.path === "/ui/devices/signout")).toEqual([]);              // nothing yet
    await w.click(w.$("#devSignOutCancel"));
    expect([w.$("#devSignOutLead"), sent.filter(s => s.path === "/ui/devices/signout").length]).toEqual([null, 0]);
    await w.click(w.$('[data-signout="bbbbbbbbbbbbbbbb"]'));
    devices = { webOnly: true, owner: true, devices: ROWS.filter(r => r.handle !== "bbbbbbbbbbbbbbbb") };
    const before = sent.filter(s => s.method === "GET" && s.path === "/ui/devices").length;
    await w.click(w.$("#devSignOutGo"));
    expect(sent.filter(s => s.path === "/ui/devices/signout").map(s => s.body)).toEqual([{ handle: "bbbbbbbbbbbbbbbb" }]);
    expect(w.text(w.$("#devicesNote"))).toBe("Chrome on Android was signed out.");
    expect(sent.filter(s => s.method === "GET" && s.path === "/ui/devices").length).toBeGreaterThan(before);
    expect(w.$('[data-handle="bbbbbbbbbbbbbbbb"]')).toBeNull();
    expect([...p.root.querySelectorAll(".s-dev-row")].length).toBe(3);
  });

  it("the server's answers, in words: the owner's authority gone (403: the card reads again), already gone (404), not saved (500), anything else", async () => {
    const w = await open({ webOnly: true, owner: true, devices: ROWS });
    const attempt = async () => { await w.click(w.$('[data-signout="cccccccccccccccc"]')); await w.click(w.$("#devSignOutGo")); return w.text(w.$("#devicesNote")); };
    answers["POST /ui/devices/signout"] = { status: 404, body: { error: "not_found" } };
    expect(await attempt()).toBe("That device is already signed out.");
    answers["POST /ui/devices/signout"] = { status: 500, body: { ok: false, durable: false, error: "not_durable" } };
    expect(await attempt()).toMatch(/^Signed out for now, but the change could not be saved: a restart may bring the session back\./);
    answers["POST /ui/devices/signout"] = { status: 502, body: {} };
    expect(await attempt()).toBe("That did not work — try again.");
    devices = { webOnly: true, owner: false, devices: ROWS };
    answers["POST /ui/devices/signout"] = { status: 403, body: { error: "owner_required" } };
    expect(await attempt()).toBe("This device can no longer approve sign-ins: its owner verification has ended.");
    await settle(10);
    expect([...p.root.querySelectorAll("[data-signout]")].map((b: any) => b.disabled)).toEqual([true, true, true]);
  });

  it("the QR link: ?approve=<code> opens the dialog with the code filled in for the owner — Continue is still pressed, nothing is looked up — and leaves the address", async () => {
    history.replaceState(null, "", "/settings/access?approve=ABCD-EFGH&keep=1");
    const w = await open({ webOnly: true, owner: true, devices: ROWS });
    expect(w.text(w.$(".dlg-title"))).toBe("Add device");
    expect(w.$("#devCodeInput").value).toBe("ABCD-EFGH");
    expect(w.$("#devFind").disabled).toBe(false);
    expect(sent.filter(s => s.path.startsWith("/ui/devices/") && s.method === "POST")).toEqual([]);   // no lookup by itself
    expect(location.search).toBe("?keep=1");                                              // the code is out of the address (and the history)
    await w.click(w.$("#devFind"));
    expect(w.posts()).toEqual([["/ui/devices/lookup", { code: "ABCD-EFGH" }]]);
    expect(w.text(w.$("#devConfirmLead"))).toBe("Allow this device to sign in?");
  });

  it("the QR link for anyone but the owner opens nothing (and is still taken out of the address); a value that is not a code is ignored", async () => {
    history.replaceState(null, "", "/settings/access?approve=ABCD-EFGH");
    const w = await open({ webOnly: true, owner: false, devices: ROWS });
    expect([w.$(".dlg-title"), w.$("#devCodeInput"), location.search]).toEqual([null, null, ""]);
    for (const bad of ["x", "ABCD-EFGH-IJKL-MNOP", "<script>", "ABCD%20EFGH", "ABCD_EFGH"]) {
      history.replaceState(null, "", `/settings/access?approve=${bad}`);
      const o = await open({ webOnly: true, owner: true, devices: ROWS });
      expect([o.$(".dlg-title"), o.$("#devCodeInput")], bad).toEqual([null, null]);
    }
    // Read once per page: opened, closed, it does not come back with the next read of the list.
    history.replaceState(null, "", "/settings/access?approve=WXYZ-2345");
    const once = await open({ webOnly: true, owner: true, devices: ROWS });
    await once.click(once.$("#devCancel"));
    await once.click(once.$("#devicesRefresh"));
    expect(once.$("#devCodeInput")).toBeNull();
  });

  it("the helpers: how long ago as words; the code a QR link carries", async () => {
    const { agoWords, approveCodeFrom } = await import("/ui/js/settings-devices.js");
    const now = 10_000_000_000;
    expect([agoWords(now - 10_000, now), agoWords(now - 5 * 60_000, now), agoWords(now - 89 * 60_000, now), agoWords(now - 3 * 3_600_000, now)]).toEqual(["just now", "5 min ago", "89 min ago", "3 h ago"]);
    expect([approveCodeFrom("?approve=ABCD-EFGH"), approveCodeFrom("?x=1&approve=wxyz2345"), approveCodeFrom(""), approveCodeFrom("?approve="), approveCodeFrom("?approve=a b")]).toEqual(["ABCD-EFGH", "wxyz2345", "", "", ""]);
  });

  it("zh-TW: the list, the marks, the confirmation and the answers", async () => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang("zh-TW");
    try {
      const w = await open({ webOnly: true, owner: true, devices: ROWS });
      expect(w.text(w.$("#devicesListTitle"))).toBe("已登入的裝置");
      expect(rowText(w, "aaaaaaaaaaaaaaaa")).toEqual(["Firefox on Linux 這台裝置", "核准方式：主機 · 已驗證擁有者 · 剛剛活動", ""]);
      expect(rowText(w, "bbbbbbbbbbbbbbbb")).toEqual(["Chrome on Android", "核准方式：裝置代碼 · 已登入，尚未驗證擁有者 · 5 分鐘前活動", "登出"]);
      expect(rowText(w, "cccccccccccccccc")[1]).toContain("核准方式：驗證器 App");
      expect(rowText(w, "dddddddddddddddd")[1]).toContain("核准方式：登入碼");
      await w.click(w.$('[data-signout="bbbbbbbbbbbbbbbb"]'));
      expect([w.text(w.$(".dlg-title")), w.text(w.$("#devSignOutLead")), w.text(w.$("#devSignOutGo"))]).toEqual(["登出這台裝置？", "Chrome on Android 需要重新登入。", "登出"]);
      await w.click(w.$("#devSignOutGo"));
      expect(w.text(w.$("#devicesNote"))).toBe("已登出 Chrome on Android。");
      const n = await open({ webOnly: true, owner: false, devices: ROWS });
      expect(n.text(n.$("#devicesSignOutOwnerOnly"))).toBe("只有已驗證擁有者的裝置才能登出其他裝置。");
    } finally { i18n.setLang("en"); }
  });
});
