/**
 * S-120 (M-2753 story 8): Settings → 存取與安全 → 總覽, the user-approved r4 layout.
 *  - devices from GET /ui/devices only (#3553): the four role words, 登出 by `canSignOut`, a blocked one with its reason on
 *    its own line (never a tooltip only), the dialog naming that device, POST /ui/devices/signout; 4 rows, the rest a link
 *    to the full Devices card; a one-line legend for ✓ / 未驗證; no sign-in name anywhere (a690be6b);
 *  - the public link from the shell's status frame (every fleet), else /ui/outside's; 「立即關閉公開連結」 asks first, then
 *    POST /ui/public-link/close; a web-only fleet's outside link is closed by its switch, so no button there, a pointer;
 *  - shares counted from the existing share lists, paired computers from /ui/runtimes.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, O: any, store: any, i18n: any;
let sent: Array<{ method: string; path: string; body: any }> = [];
let answers: Record<string, { status: number; body: any }> = {};
let devices: any, outside: any;
const realFetch = (globalThis as any).fetch;
const now = Date.now(), m = 60_000;
const D = (handle: string, label: string, tier: string, verified: boolean, ago: number, extra: any = {}) =>
  ({ handle, label, tier, verified, via: "code", lastSeen: now - ago, current: false, canSignOut: true, ...extra });
const CHAT_DEVICES = [
  D("a1a1a1a1a1a1a1a1", "Chrome on Linux", "admin", true, 0, { current: true, canSignOut: false }),
  D("b2b2b2b2b2b2b2b2", "Safari on iPhone", "admin", true, 12 * m),
  D("c3c3c3c3c3c3c3c3", "Edge on Windows", "admin", false, 3 * 3600_000, { canSignOut: false, signOutBlocked: "other_admin" }),
  D("d4d4d4d4d4d4d4d4", "Chrome on Android", "guest", false, 25 * m),
  D("e5e5e5e5e5e5e5e5", "Firefox on Mac", "read", false, 2 * 3600_000),
];
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  const preset = answers[`${method} ${path}`];
  if (preset) return { ok: preset.status < 300, status: preset.status, json: async () => preset.body };
  const body = (() => {
    if (method !== "GET") return { ok: true, closed: true };
    if (path === "/ui/devices") return { webOnly: false, owner: true, devices };
    if (path === "/ui/outside") return outside;
    if (path === "/ui/office-share") return { enabled: true, shares: [{ id: "s1" }] };
    if (path === "/ui/page-share") return { enabled: true, shares: [{ id: "p1" }, { id: "p2" }] };
    if (path === "/ui/runtimes") return { enabled: true, machines: [{ id: "m1" }, { id: "m2" }] };
    return {};
  })();
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings/access" });
  (globalThis as any).fetch = fakeFetch;
  O = await import("/ui/js/settings-access-overview.js");
  store = await import("/assets/app-store.js");
  i18n = await import("/assets/app-i18n.js");
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => {
  sent = []; answers = {}; devices = CHAT_DEVICES;
  outside = { webOnly: false, here: true, manage: true, strict: true, enrolled: true, enrolledAt: now - 86400_000, outside: false, pausedForMs: 0, link: null };
  store.appStore.set({ publicLink: null });
});
afterEach(async () => { await p.unmount(); i18n.setLang("en"); });

const tabs: Array<[string, string | undefined]> = [];
async function mount(lang: "en" | "zh-TW" = "en", props: any = {}) {
  i18n.setLang(lang);
  tabs.length = 0;
  await p.mount(h(O.AccessOverview, { web: {}, openTab: (t: string, a?: string) => tabs.push([t, a]), ...props }));
  await settle(10);
}
const $ = (sel: string) => p.root.querySelector(sel);
const $$ = (sel: string) => p.root.querySelectorAll(sel) as any[];
const text = (el: any) => String(el?.textContent ?? "").replace(/\s+/g, " ").trim();
const row = (handle: string) => $(`#ovDevices li[data-handle="${handle}"]`);

describe("S-120: the devices summary (GET /ui/devices only)", () => {
  it("four rows with the #3553 role words, the rest a link to the full Devices card, and a legend", async () => {
    await mount("zh-TW");
    expect(sent.filter((s) => s.method === "GET").map((s) => s.path)).toContain("/ui/devices");
    expect(sent.some((s) => s.path === "/auth/sessions")).toBe(false);                     // no list of its own
    expect($$("#ovDevices li[data-handle]").length).toBe(4);
    expect(text(row("a1a1a1a1a1a1a1a1"))).toContain("擁有者 ✓");
    // The role words are #3553's (device-roles.js), whatever spelling they have when this lands (M-2820: 管理員).
    const { roleName } = await import("/assets/device-roles.js");
    expect(text(row("c3c3c3c3c3c3c3c3"))).toContain(roleName("admin", false));
    expect(text(row("d4d4d4d4d4d4d4d4"))).toContain("訪客");
    const more = $$("#ovDevices .s-ov-link").find((b: any) => text(b).includes("另外 1 個"));
    expect(more).toBeTruthy();
    more.click(); await settle(2);
    expect(tabs).toEqual([["login", "devicesCard"]]);
    expect(text($(".s-ov-legend"))).toContain("✓ 已驗證的擁有者");
  });

  it("登出 follows canSignOut; a blocked one says why on its own line; never this device", async () => {
    await mount("zh-TW");
    expect($('[data-ov-signout="a1a1a1a1a1a1a1a1"]')).toBeNull();                          // this device: none
    const blocked = $('[data-ov-signout="c3c3c3c3c3c3c3c3"]');
    expect(blocked.disabled).toBe(true);
    expect(String(blocked.getAttribute("class"))).not.toContain("btn-danger");
    expect(text(row("c3c3c3c3c3c3c3c3").querySelector(".s-ov-why"))).toBe("別的管理員的裝置，只有那位管理員本人能登出。");
    expect($('[data-ov-signout="b2b2b2b2b2b2b2b2"]').disabled).toBe(false);
    devices = [CHAT_DEVICES[0], D("f6f6f6f6f6f6f6f6", "Chrome on iPad", "admin", false, m, { canSignOut: false, signOutBlocked: "owner_required" })];
    await p.unmount(); await mount("zh-TW");
    expect(text(row("f6f6f6f6f6f6f6f6").querySelector(".s-ov-why"))).toBe("要先驗證為擁有者，才能登出其他裝置。");
  });

  it("signing out names the device in the title and posts its handle to /ui/devices/signout", async () => {
    await mount("zh-TW");
    $('[data-ov-signout="b2b2b2b2b2b2b2b2"]').click(); await settle(3);
    expect(text($("dialog") ?? p.root)).toContain("登出 Safari on iPhone？");
    $("#ovSignOutGo").click(); await settle(4);
    expect(sent.find((s) => s.method === "POST")).toEqual({ method: "POST", path: "/ui/devices/signout", body: { handle: "b2b2b2b2b2b2b2b2" } });
  });

  it("read again whenever its tab is shown: a device signed out on 裝置與登入 is not still listed here", async () => {
    // The tab panels stay mounted; the overview's tab going inactive and active again re-reads /ui/devices.
    await mount("en", { active: true });
    const gets = () => sent.filter((s) => s.method === "GET" && s.path === "/ui/devices").length;
    const first = gets();
    expect(first).toBeGreaterThan(0);
    expect($('[data-handle="b2b2b2b2b2b2b2b2"]')).not.toBeNull();
    await p.mount(h(O.AccessOverview, { web: {}, openTab: () => {}, active: false })); await settle(4);
    expect(gets()).toBe(first);                                                   // hidden: not read
    devices = devices.filter((d: any) => d.handle !== "b2b2b2b2b2b2b2b2");
    await p.mount(h(O.AccessOverview, { web: {}, openTab: () => {}, active: true })); await settle(4);
    expect(gets()).toBeGreaterThan(first);
    expect($('[data-handle="b2b2b2b2b2b2b2b2"]')).toBeNull();
  });

  it("no sign-in name anywhere (code-only sign-in, a690be6b)", async () => {
    outside = { ...outside, signinName: "han" };
    await mount("zh-TW");
    expect(text(p.root)).not.toContain("han");
    expect(text(p.root)).not.toMatch(/登入名稱|sign-in name/i);
  });
});

describe("S-120: the public link", () => {
  it("from the shell's status frame on any fleet; 「立即關閉公開連結」 asks first, then POSTs /ui/public-link/close", async () => {
    store.appStore.set({ publicLink: { state: "open", expiresAt: Date.now() + 100 * m } });
    await mount("zh-TW");
    expect(text($("#ovEntry"))).toContain("開啟中");
    expect(text($("#ovEntry"))).toContain("臨時網址");
    const btn = $("#ovCloseLink");
    expect(text(btn)).toBe("立即關閉公開連結");
    btn.click(); await settle(3);
    expect(sent.some((s) => s.path === "/ui/public-link/close")).toBe(false);              // asked first
    $("#ovCloseGo").click(); await settle(4);
    expect(sent.filter((s) => s.method === "POST").map((s) => s.path)).toEqual(["/ui/public-link/close"]);
    expect(text($("#ovLinkNote"))).toBe("公開連結已關閉。");
  });

  // #3600 (alpha.12 acceptance, P3): the close takes effect at once, but the status frame only says so on its next tick
  // (~10 s). The card shows the link closed as soon as the close went through, and a refused close changes nothing.
  it("after a close that went through the card says closed at once, before the next status frame; that frame decides after", async () => {
    store.appStore.set({ publicLink: { state: "open", expiresAt: Date.now() + 100 * m } });
    await mount("zh-TW");
    $("#ovCloseLink").click(); await settle(3);
    $("#ovCloseGo").click(); await settle(4);
    expect(text($("#ovEntry"))).not.toContain("開啟中");          // the same (stale) frame is still in the store
    expect(text($("#ovEntry"))).toContain("已關閉");
    expect($("#ovCloseLink")).toBeNull();
    // The next frame is what counts again: a link opened since then shows as open, with its button.
    store.appStore.set({ publicLink: { state: "open", expiresAt: Date.now() + 50 * m } }); await settle(4);
    expect(text($("#ovEntry"))).toContain("開啟中");
    expect($("#ovCloseLink")).not.toBeNull();
  });

  it.each([
    ["refused (the outside link, 409)", { status: 409, body: { error: "outside_link" } }],
    ["failed (500)", { status: 500, body: { error: "public_link_close_failed" } }],
    ["nothing was open (closed: false)", { status: 200, body: { closed: false } }],
  ])("a close that %s leaves the badge and the button as they were", async (_why, preset) => {
    store.appStore.set({ publicLink: { state: "open", expiresAt: Date.now() + 100 * m } });
    answers["POST /ui/public-link/close"] = preset;
    await mount("zh-TW");
    $("#ovCloseLink").click(); await settle(3);
    $("#ovCloseGo").click(); await settle(4);
    expect(text($("#ovEntry"))).toContain("開啟中");
    expect($("#ovCloseLink")).not.toBeNull();
  });

  it("no button while it is closed or over the public link itself", async () => {
    await mount("zh-TW");
    expect($("#ovCloseLink")).toBeNull();
    expect(text($("#ovEntry"))).toContain("已關閉");
    await p.unmount();
    store.appStore.set({ publicLink: { state: "open", expiresAt: Date.now() + 100 * m } });
    await mount("zh-TW", { overPublicLink: true });
    expect($("#ovCloseLink")).toBeNull();
  });

  it("a web-only fleet's outside link: no close button, a pointer to its switch (the route would answer 409)", async () => {
    outside = { ...outside, webOnly: true, outside: true, link: { state: "open", expiresAt: Date.now() + 100 * m, quick: true } };
    await mount("zh-TW");
    expect($("#ovCloseLink")).toBeNull();
    expect(text($("#ovOutsideOwned"))).toContain("從外面連線");
    $("#ovOutsideOwned .s-ov-link").click(); await settle(2);
    expect(tabs).toEqual([["login", "outsideCard"]]);
  });

  it("a tab whose app-store.js predates S-120 (no publicLink): /ui/outside's link, nothing broken", async () => {
    store.appStore.set({ publicLink: undefined });
    outside = { ...outside, webOnly: true, outside: false, link: { state: "open", expiresAt: Date.now() + 61 * m, quick: true } };
    await mount("en");
    expect(text($("#ovEntry"))).toContain("1 h 1 min left");
  });

  it("the time left is in the page's language", async () => {
    store.appStore.set({ publicLink: { state: "open", expiresAt: Date.now() + 100 * m + 20_000 } });
    await mount("en");
    expect(text($("#ovEntry"))).toContain("1 h 40 min left");
    expect(text($("#ovEntry"))).not.toMatch(/小時|分/);
  });
});

describe("S-120: counts from existing reads", () => {
  it("shares from both share lists, paired computers from /ui/runtimes", async () => {
    await mount("zh-TW");
    expect(text($("#ovEntry"))).toContain("3 個開放中");
    expect(text($('[data-ov-go="runtimes"]'))).toContain("已連上 2 台");
  });
});

describe("M-2855 (2): the page carries its own tab label and stylesheet — a tab opened before S-120 holds an older settings-layout.js and app.css", () => {
  const read = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
  it("the stylesheet is linked once, when the module loads (before any render); linking again adds none", () => {
    const links = () => p.document.querySelectorAll('link[data-access-overview-css="1"]');
    expect(links().length).toBe(1);
    expect(links()[0].getAttribute("href")).toBe("/assets/access-overview.css");
    expect(links()[0].getAttribute("rel")).toBe("stylesheet");
    O.linkAccessOverviewCss();
    expect(links().length).toBe(1);
  });
  it("the tab label is the page's own word, in both languages; the settings page asks it, and no settingsLayout key is left to miss", () => {
    i18n.setLang("en"); expect(O.accessOverviewLabel()).toBe("Overview");
    i18n.setLang("zh-TW"); expect(O.accessOverviewLabel()).toBe("總覽");
    const panel = read("ui/panel-settings.js");
    expect(panel).toMatch(/\{ id: "overview", label: accessOverviewLabel\(\) \}/);
    expect(panel).not.toMatch(/layoutText\("accessOverview"\)/);
    expect(read("ui/settings-layout.js")).not.toMatch(/accessOverview/);
  });
  it("every s-ov class the page uses has its rule in access-overview.css; app.css holds none of them; the server serves the file", async () => {
    const used = new Set([...read("ui/settings-access-overview.js").matchAll(/\bs-ov(?:-[a-z]+)*\b/g)].map(x => x[0]).filter(c => !c.endsWith("-")));
    const css = read("ui/shared/access-overview.css");
    for (const c of used) expect(css, c).toMatch(new RegExp(`\\.${c}(?![a-z-])`));
    expect(css).toMatch(/\.tag\.tag-ok\b/);
    expect(read("ui/shared/app.css")).not.toMatch(/\.s-ov\b|\.s-ov-|\.tag-ok\b/);
    const { handleAuthRequest } = await import("../src/auth-api.js");
    const got = await new Promise<{ status: number; type: string; body: string }>(resolve => {
      const res: any = { writeHead(s: number, h: Record<string, string>) { this.s = s; this.h = h; }, end(b: Buffer | string) { resolve({ status: this.s, type: this.h?.["Content-Type"], body: String(b) }); } };
      handleAuthRequest({ method: "GET", url: "/assets/access-overview.css", headers: { host: "127.0.0.1" } } as any, res, new URL("http://127.0.0.1/assets/access-overview.css"), {} as any);
    });
    expect(got.status).toBe(200);
    expect(got.type).toMatch(/^text\/css/);
    expect(got.body).toBe(css);
  });
});
