/**
 * #1844 (A): Fleet overview's header has "Docs" — a link out to the project's docs site (website/, GitHub Pages) in the
 * dashboard's language, in a new tab, in front of the shared controls (Aa, Usage). It is not a Fleet tab: the tab row is
 * unchanged (seven items did not fit at 1280 px in English or on a phone), it has no route, and the app's router leaves
 * it to the browser. The real Shell, router and Fleet panel in a mini DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fire } from "./helpers/mini-dom.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

// #1854: the short Web Guide, not Getting Started.
const EN = "https://songsid.github.io/AgEnD/docs/web-guide/";
const ZH = "https://songsid.github.io/AgEnD/zh-tw/docs/web-guide/";

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
  const { setLang } = await import("/assets/app-i18n.js");
  setLang("en");
});

async function shell(path: string, opts: { narrow?: boolean } = {}) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" }, matchNarrow: opts.narrow });
  mounted.push(pg);
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => ({ ok: true, status: 200,
    json: async () => (String(url).startsWith("/ui/org") ? { teams: [], general: null, instances: [] } : []) });
  const { startRouter, navStore } = await import("/assets/app-nav.js");
  const { applyStatus, appStore } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  // @ts-expect-error — a JS module of the app, with no types
  const { FleetPanel } = await import("../src/ui/panel-fleet.js");
  appStore.set({ viewOnly: false });
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code", tags: [] }] });
  await pg.mount(h(Shell, { panels: new Map<string, unknown>([["fleet", { Component: FleetPanel }]]), onNewInstance() {} }));
  await settle(4);
  return { pg, navStore };
}
const row = (pg: AppPage) => [...pg.root.querySelectorAll(".p-fleet nav.seg > a")] as any[];
const actions = (pg: AppPage) => [...(pg.root.querySelector(".p-fleet .panel-head .panel-actions") as any).children] as any[];
const docs = (pg: AppPage) => pg.root.querySelector(".p-fleet .panel-head a.hd-docs") as any;
const shape = (a: any) => ({ href: a?.getAttribute("href"), target: a?.getAttribute("target"), rel: a?.getAttribute("rel"),
  label: a?.getAttribute("aria-label"), text: a?.textContent.trim(), current: a?.getAttribute("aria-current") ?? null, active: !!a?.classList.contains("active") });

describe("Fleet overview → Docs", () => {
  it("is in the header on every Fleet tab, before Aa and Usage: the docs site, a new tab, no opener", async () => {
    const out: unknown[] = [];
    for (const path of ["/ui/fleet/org", "/ui/fleet", "/ui/fleet/cache", "/ui/fleet/config"]) {
      const { pg } = await shell(path);
      out.push([path, actions(pg).map(e => e.className), shape(docs(pg))]);
      const p = mounted.pop()!; await p.unmount(); p.restore();
    }
    const order = ["btn btn-ghost btn-sm hd-docs", "btn btn-ghost btn-sm hd-text", "btn btn-ghost btn-sm hd-usage"];
    const want = { href: EN, target: "_blank", rel: "noopener noreferrer", label: "Docs (opens in a new tab)", text: "Docs", current: null, active: false };
    expect(out).toEqual(["/ui/fleet/org", "/ui/fleet", "/ui/fleet/cache", "/ui/fleet/config"].map(p => [p, order, want]));
  });
  it("is not a Fleet tab: the tab row is the seven tabs (#2122 added Usage), unchanged", async () => {
    const { pg } = await shell("/ui/fleet/org");
    expect([row(pg).map(a => a.getAttribute("href")), pg.root.querySelectorAll(".p-fleet nav.seg a[target]").length]).toEqual(
      [["/ui/fleet", "/ui/fleet/schedules", "/ui/fleet/teams", "/ui/fleet/org", "/ui/fleet/cache", "/ui/fleet/usage", "/ui/fleet/config"], 0]);
  });
  it("follows the dashboard's language: zh-TW opens /zh-tw/docs, and back to English", async () => {
    const { pg } = await shell("/ui/fleet/org");
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW"); await settle(4);
    const zh = shape(docs(pg));
    setLang("en"); await settle(4);
    expect([zh, docs(pg).getAttribute("href")]).toEqual([
      { href: ZH, target: "_blank", rel: "noopener noreferrer", label: "文件（在新分頁開啟）", text: "文件", current: null, active: false }, EN]);
  });
  it("a click is the browser's (target=_blank): the app does not navigate and stays on the Org chart", async () => {
    const { pg, navStore } = await shell("/ui/fleet/org");
    const ev = fire(docs(pg), "click", { button: 0 }) as any;
    await settle(4);
    expect([navStore.get().route, pg.window.location.pathname, ev?.defaultPrevented ?? false]).toEqual([{ panel: "fleet", tab: "org" }, "/ui/fleet/org", false]);
  });
  it("on a phone it is still there: the icon (the word is hidden there), named for screen readers", async () => {
    const { pg } = await shell("/ui/fleet/org", { narrow: true });
    const d = docs(pg);
    expect([d?.getAttribute("href"), d?.getAttribute("aria-label"), d?.querySelectorAll("svg").length, d?.querySelector("span")?.className]).toEqual(
      [EN, "Docs (opens in a new tab)", 2, "hide-narrow"]);
  });
  it("docsUrl: one page per language, under the site's /AgEnD base", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const { docsUrl } = await import("../src/ui/panel-fleet.js");
    expect([docsUrl("en"), docsUrl("zh-TW")]).toEqual([EN, ZH]);
  });
  it("#1854: the page it opens exists in both languages and is in the site's sidebar", () => {
    const site = (path: string) => readFileSync(new URL(`../website/${path}`, import.meta.url), "utf8");
    const page = { en: site("src/content/docs/docs/web-guide.md"), zh: site("src/content/docs/zh-tw/docs/web-guide.md") };
    expect([page.en.match(/^title: (.+)$/m)?.[1], page.zh.match(/^title: (.+)$/m)?.[1]]).toEqual(["Web Guide", "網頁使用說明"]);
    expect(site("astro.config.mjs")).toContain("{ label: 'Web Guide', translations: { 'zh-TW': '網頁使用說明' }, slug: 'docs/web-guide' }");
  });
  it("it is a header btn-sm, so #1842's one header row applies to it (36 px)", () => {
    const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
    expect(/\n\.panel-head \.btn-sm \{ min-height: 36px; \}/.test(css)).toBe(true);
  });
});
