/**
 * #2308: Settings → Web appearance → App icon, on the page — the icon now (from its versioned address), an admin's
 * Choose / Restore default, a read-only session's note instead of controls, the host's refusal said in words, and this
 * page's own icon links following a change at once (the SVG dropped for a custom icon, back for the default).
 *
 * Isolation: the app harness's mini DOM; fetch and the page's auth are fakes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const g = globalThis as any;
let pg: AppPage | null = null;
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } });

const V = "0123456789abcdef";
function fakeFetch(state: { custom: boolean; version: string }, calls: string[], answer: (method: string) => { status: number; body: unknown } = () => ({ status: 200, body: { custom: false, version: "default", updatedAt: null } })) {
  return async (url: string, init: any = {}) => {
    const method = init.method || "GET";
    if (url === "/ui/app-icon") {
      calls.push(method);
      if (method === "GET") return { ok: true, status: 200, json: async () => ({ ...state, updatedAt: null }) };
      const a = answer(method);
      return { ok: a.status < 300, status: a.status, json: async () => a.body };
    }
    if (url === "/ui/mods") return { ok: true, status: 200, json: async () => ({ mods: [], proposals: [] }) };
    if (url === "/ui/prefs") return { ok: true, status: 200, json: async () => ({ values: {}, rev: 1 }) };
    if (url === "/ui/owner-css/state") return { ok: true, status: 200, json: async () => ({ active: null, pending: null, text: "", versions: [], assets: [], limits: { maxAssets: 16 } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
async function mount(state: { custom: boolean; version: string }, canWrite: boolean, calls: string[], answer?: (method: string) => { status: number; body: unknown }) {
  pg = page({ url: "http://127.0.0.1:19280/settings/appearance", storage: { agend_tour_done: "1" } });
  pg.document.body.dataset.mode = "full";
  // The page's head as the host sends it (withAppIconLinks): the bundled set.
  for (const [rel, href, type] of [["icon", "/favicon.ico?v=default", ""], ["icon", "/favicon.svg?v=default", "image/svg+xml"], ["apple-touch-icon", "/apple-touch-icon.png?v=default", ""], ["manifest", "/manifest.webmanifest?v=default", ""]]) {
    const l = pg.document.createElement("link"); l.setAttribute("rel", rel!); l.setAttribute("href", href!); if (type) l.setAttribute("type", type);
    pg.document.head.appendChild(l);
  }
  g.fetch = fakeFetch(state, calls, answer);
  g.window.AgendAuth = { canWrite: async () => canWrite };
  (await import("/assets/app-i18n.js")).setLang("en", { store: false });
  const { AppearanceSection } = await import("/ui/js/settings-appearance.js");
  await pg.mount(h(AppearanceSection, { part: "dashboard" }));          // #2347: the app icon is in Web dashboard
  await settle(4);
  return pg.root.querySelector(".s-app-icon") as any;
}
const hrefs = () => [...(pg!.document.head as any).querySelectorAll("link")].map((l: any) => `${l.getAttribute("rel")} ${l.getAttribute("href")}`);

describe("the App icon card", () => {
  it("a read-only session sees the icon and a note, no controls", async () => {
    const card = await mount({ custom: true, version: V }, false, []);
    expect(card.querySelector("img.s-app-icon-big").getAttribute("src")).toBe(`/apple-touch-icon.png?v=${V}`);
    expect(card.querySelector("figcaption").textContent).toBe("Your icon");
    expect(card.querySelector("input[type=file]")).toBeNull();
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(card.textContent).toContain("Only an admin's session can change it.");
  });

  it("an admin: Choose image… (PNG, JPG, WebP); Restore default only for a custom icon", async () => {
    let card = await mount({ custom: false, version: "default" }, true, []);
    expect(card.querySelector("input[type=file]").getAttribute("accept")).toBe("image/png,image/jpeg,image/webp");
    expect([...card.querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Choose image…"]);
    expect(card.querySelector("figcaption").textContent).toBe("The AgEnD icon (default)");
    await pg!.unmount(); pg!.restore(); pg = null;
    card = await mount({ custom: true, version: V }, true, []);
    expect([...card.querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Choose image…", "Restore default"]);
  });

  it("Restore default: DELETE, the card shows the default, this page's links go back to the bundled set (SVG included)", async () => {
    const calls: string[] = [];
    const card = await mount({ custom: true, version: V }, true, calls);
    // As a custom icon's page is sent: no SVG, its version on the links.
    const { refreshAppIconLinks } = await import("/ui/js/settings-appearance.js");
    refreshAppIconLinks(V, true);
    expect(hrefs()).toEqual([`icon /favicon.ico?v=${V}`, `apple-touch-icon /apple-touch-icon.png?v=${V}`, `manifest /manifest.webmanifest?v=${V}`]);
    fire([...card.querySelectorAll("button")].find((b: any) => b.textContent === "Restore default"), "click");
    await settle(4);
    expect(calls).toEqual(["GET", "DELETE"]);
    const now = pg!.root.querySelector(".s-app-icon") as any;
    expect(now.querySelector("img.s-app-icon-big").getAttribute("src")).toBe("/apple-touch-icon.png?v=default");
    expect(hrefs()).toEqual(["icon /favicon.ico?v=default", "apple-touch-icon /apple-touch-icon.png?v=default", "manifest /manifest.webmanifest?v=default", "icon /favicon.svg?v=default"]);
  });

  it("the host's refusal is said in words, and nothing on the page changes", async () => {
    const calls: string[] = [];
    const card = await mount({ custom: true, version: V }, true, calls, () => ({ status: 403, body: { error: "app_icon_admin_only" } }));
    fire([...card.querySelectorAll("button")].find((b: any) => b.textContent === "Restore default"), "click");
    await settle(4);
    const now = pg!.root.querySelector(".s-app-icon") as any;
    expect(now.querySelector("[role=alert]").textContent).toBe("Only an admin's session can change the app icon.");
    expect(now.querySelector("img.s-app-icon-big").getAttribute("src")).toBe(`/apple-touch-icon.png?v=${V}`);
    expect(hrefs()).toContain("icon /favicon.svg?v=default");
  });
});
