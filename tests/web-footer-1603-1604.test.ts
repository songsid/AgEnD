/**
 * #1603: polling is a working transport — no strip for it; the reconnecting countdown (#1581) and a failed catch-up
 * still show. #1604: the sidebar footer is one row (Settings + Session); this browser's choices (theme, language, HTML
 * previews, the tour) are Settings → This device; the anonymous View reader keeps theme and language in a popover
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
  g.fetch = realFetch; delete g.AgendTheme; delete g.AgendPreview;
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

describe("#1604: Settings → This device", () => {
  it("is a Settings section of its own, first; the page and the server both route /settings/device", async () => {
    const { SETTINGS_SECTIONS, parseRoute } = await import("/assets/app-route.js");
    expect(SETTINGS_SECTIONS[0]).toBe("device");
    expect(parseRoute("/settings/device")).toEqual({ panel: "settings", section: "device" });
    expect(shellRoute("GET", "/settings/device")).toEqual({ kind: "shell", route: { panel: "settings", section: "device" } });
  });
  it("theme, language, HTML previews (through the app's confirm) and the tour — shown without waiting for the configuration", async () => {
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
    const sec = pg.root.querySelector(".s-device") as any;
    expect(sec, "drawn while the configuration is still loading").toBeTruthy();
    expect(pg.root.querySelector(".seg-item.active")?.textContent?.trim()).toBe("This device");
    const theme = sec.querySelector('select[aria-label="Theme"]');
    theme.value = "light"; fire(theme, "change"); await settle();
    expect(themes).toEqual(["light"]);
    const box = sec.querySelector('label.check input[type="checkbox"]');
    expect(sec.querySelector("label.check").textContent.trim()).toBe("Allow HTML previews on this device");
    box.checked = true; fire(box, "change"); await settle(6);
    expect([asked.length, pg.storage.get("agend_html_preview")]).toEqual([1, "on"]);   // asked once (the same question), then allowed — the device's own key
    expect(asked[0]).toMatch(/Allow HTML previews on this device\?/);
    expect(sec.querySelector("#tourBtn")?.textContent?.trim()).toBe("Tour");
    delete g.confirm;
  });
});
