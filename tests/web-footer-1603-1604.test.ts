/**
 * #1603: polling is a working transport — no strip for it; the reconnecting countdown (#1581) and a failed catch-up
 * still show. #1604: the sidebar footer is one row (Settings + Session); this browser's choices (theme, language, HTML
 * previews, the tour) are Settings → Preferences / Look; the anonymous View reader keeps theme and language in a popover
 * beside Sign in. The real Shell, store, router and Settings panel in the mini DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { shellRoute } from "../src/web-shell-routes.js";

const g = globalThis as any;
const mounted: AppPage[] = [];
const realFetch = g.fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  g.fetch = realFetch; delete g.AgendTheme; delete g.AgendPreview; delete g.confirm;
  const { appStore } = await import("/assets/app-store.js");
  appStore.set({ connection: "connecting", hydration: "none", retryAt: undefined });
  const i18n = await import("/assets/app-i18n.js"); i18n.setLang("en");
});
async function shell(opts: { viewOnly?: boolean; path?: string } = {}) {
  const pg = page({ url: `http://127.0.0.1:19280${opts.path ?? "/ui"}`, storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  g.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: [] });
  await pg.mount(h(Shell, { panels: new Map(), onNewInstance() {}, viewOnly: !!opts.viewOnly }));
  return pg;
}
const conn = (p: AppPage) => p.root.querySelector(".conn")?.textContent?.trim() ?? null;

describe("#1603: the connection line", () => {
  it("polling (the public link, a buffering proxy) shows nothing — messages still arrive", async () => {
    const p = await shell();
    const { appStore } = await import("/assets/app-store.js");
    appStore.set({ connection: "polling" });
    await settle();
    expect(conn(p)).toBeNull();
  });
  it("reconnecting still says so, with the countdown; a failed catch-up still says so, with Retry", async () => {
    const p = await shell();
    const { appStore } = await import("/assets/app-store.js");
    appStore.set({ connection: "reconnecting", retryAt: performance.now() + 9_000 });
    await settle();
    expect(conn(p)).toBe("Can't reach AgEnD — it may be restarting. Trying again in 9 s.");
    appStore.set({ connection: "live", hydration: "failed", retryHydration: () => {} });
    await settle();
    expect(conn(p)).toContain("Could not load what is open now");
    expect(!!p.root.querySelector(".conn button")).toBe(true);
  });
  it("the strings nothing shows any more are gone", async () => {
    const { t } = await import("/assets/app-i18n.js");
    expect(["app.connPolling", "app.connDown", "app.connConnecting"].map(k => t(k))).toEqual(["app.connPolling", "app.connDown", "app.connConnecting"]);
  });
});

describe("#1604: the sidebar footer is one row", () => {
  it("signed in: exactly Settings and Session — no preview opt-in, Tour, theme or language rows", async () => {
    const p = await shell();
    const foot = p.root.querySelector(".side-foot")!;
    const controls = [...foot.querySelectorAll("a, button, select, input, summary")] as any[];
    expect(controls.map(c => (c.textContent || c.getAttribute("aria-label") || "").trim())).toEqual(["Settings", "Sign in"]);
    expect(foot.querySelector('a[href="/settings"]')).toBeTruthy();
    expect(foot.querySelector(".session button")).toBeTruthy();
  });
  it("the anonymous View reader: Sign in and one compact control that opens theme and language — which still work", async () => {
    const themes: string[] = [];
    g.AgendTheme = { get: () => "system", set: (v: string) => themes.push(v) };
    const p = await shell({ viewOnly: true, path: "/view" });
    const foot = p.root.querySelector(".side-foot")!;
    const top = [...foot.children] as any[];
    expect(top.map((c: any) => c.tagName.toLowerCase())).toEqual(["a", "details"]);
    expect(top[0].textContent.trim()).toBe("Sign in");
    const pop = foot.querySelector("details.prefs-pop") as any;
    expect(pop.querySelector("summary").getAttribute("aria-label")).toBe("Theme and language");
    const theme = pop.querySelector('select[aria-label="Theme"]'), language = pop.querySelector('select[aria-label="Language"]');
    theme.value = "dark"; fire(theme, "change"); await settle();
    language.value = "zh-TW"; fire(language, "change"); await settle();
    const { lang } = await import("/assets/app-i18n.js");
    expect([themes, lang()]).toEqual([["dark"], "zh-TW"]);
  });
});

describe("#1604: Settings → Preferences and Look", () => {
  it("is a Settings section of its own, first (#2347: Preferences); the page and the server route it, and the old /settings/device", async () => {
    const { SETTINGS_SECTIONS, parseRoute } = await import("/assets/app-route.js");
    expect(SETTINGS_SECTIONS[0]).toBe("preferences");
    for (const path of ["/settings/preferences", "/settings/device"]) {
      expect(parseRoute(path)).toEqual({ panel: "settings", section: "preferences" });
      expect(shellRoute("GET", path)).toEqual({ kind: "shell", route: { panel: "settings", section: "preferences" } });
    }
  });
  it("Preferences' language, HTML previews and tour, and Look's theme — shown without waiting for the configuration", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/settings/device", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    g.fetch = () => new Promise(() => {});                              // the configuration never answers
    const themes: string[] = [];
    g.AgendTheme = { get: () => "system", set: (v: string) => themes.push(v) };
    const asked: string[] = [];
    g.confirm = (m: string) => { asked.push(m); return true; };
    // @ts-expect-error — a JS module of the app, with no types
    const S = await import("../src/ui/panel-settings.js");      // (its chat import brings the real preview.js)
    await pg.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "device" }, navKey: "settings:device|1|en" }));
    await settle(4);
    const sec = pg.root.querySelector(".s-device.s-synced") as any;    // the account's language/content group
    expect(sec, "drawn while the configuration is still loading").toBeTruthy();
    expect(pg.root.querySelector(".seg-item.active")?.textContent?.trim()).toBe("Preferences");   // #1665: synced across devices, and what stays on this one
    expect(sec.querySelector('select[aria-label="Language"]')).toBeTruthy();
    expect(pg.root.querySelector("#pref-theme"), "theme moved to Look, linked from Preferences").toBeNull();
    expect(pg.root.querySelector('a.s-pref-look-link[href="/settings/look"]')?.textContent).toBe("Theme, appearance and effects are in Look");
    const box = sec.querySelector("#pref-previews");
    expect(sec.querySelector("label.check > span").textContent.trim()).toBe("Allow HTML previews");
    box.checked = true; fire(box, "change"); await settle(6);
    expect([asked.length, pg.storage.get("agend_html_preview")]).toEqual([1, "on"]);   // asked once (the same question), then allowed — the device's own key
    expect(asked[0]).toMatch(/Allow HTML previews\?\n\nThis applies on every device where you are signed in\./);
    expect(pg.root.querySelector(".s-local #tourBtn")?.textContent?.trim()).toBe("Replay tour");   // #1665: replay is still this device's action
    await pg.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "look" }, navKey: "settings:look|1|en" }));
    await settle(4);
    expect(pg.root.querySelector(".seg-item.active")?.textContent?.trim()).toBe("Look");
    const theme = [...pg.root.querySelectorAll('#pref-theme input[type="radio"]')].find((input: any) => input.value === "light") as any;
    expect(theme, "Look's theme control also draws while the configuration is still loading").toBeTruthy();
    theme.checked = true; fire(theme, "change"); await settle();
    expect(themes).toEqual(["light"]);
    delete g.confirm;
  });
  it("#1665: personal details, account content and local guidance keep their owners; public preferences and Look say changes stay here", async () => {
    for (const publicLink of [false, true]) {
      const pg = page({ url: "http://127.0.0.1:19280/settings/device" });
      mounted.push(pg);
      if (publicLink) pg.document.body.setAttribute("data-public-link", "1");
      g.fetch = () => new Promise(() => {});
      // @ts-expect-error — a JS module of the app, with no types
      const S = await import("../src/ui/panel-settings.js");
      await pg.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "device" }, navKey: `settings:device|${publicLink}|en` }));
      await settle(4);
      // #1827: the name form now lives inside Personal details; it still leads the page.
      const cards = [...pg.root.querySelectorAll(".s-device")] as any[];
      expect(cards.map((c) => c.querySelector("h3").textContent), String(publicLink)).toEqual(["Personal details", "Language and content", "Help and guidance"]);
      expect(cards[0].querySelector(".s-profile #profile-name")).toBeTruthy();
      const account = pg.root.querySelector(".s-device.s-synced") as any;
      const local = pg.root.querySelector(".s-device.s-local") as any;
      const scope = account.querySelector(".s-scope");
      const publicNote = "On the public link these are read-only: a change here stays in this browser.";
      expect([scope.textContent, scope.getAttribute("title")], String(publicLink)).toEqual([
        "Your account", publicLink ? publicNote : "Changes here apply on every device where you are signed in.",
      ]);
      expect(account.querySelector("p.sub")?.textContent ?? null).toBe(publicLink ? publicNote : null);
      expect(account.querySelector("#pref-lang")).toBeTruthy();
      expect(local.querySelector("#tourBtn")?.textContent).toBe("Replay tour");
      expect(local.querySelector("#pref-lang, #pref-previews, #profile-name"), "account controls stay out of local guidance").toBeNull();
      await pg.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "look" }, navKey: `settings:look|${publicLink}|en` }));
      await settle(4);
      const theme = pg.root.querySelector("#pref-theme") as any;
      expect(theme.querySelector("legend")?.textContent, String(publicLink)).toBe("Theme");
      expect([...theme.querySelectorAll('input[type="radio"]')].map((input: any) => input.value)).toEqual(["light", "dark", "system"]);
      const lookHints = [...pg.root.querySelectorAll(".s-look-display p.sub")].map((p: any) => p.textContent);
      expect(lookHints.includes(publicNote), "public Look retains the browser-only scope warning").toBe(publicLink);
      await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1);
    }
  });
});
