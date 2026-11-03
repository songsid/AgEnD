/**
 * v2.3.4-beta.4 P1 (the user, hmsg-985db235 and hmsg-5ab1997d): after an upgrade, a tab opened before it kept its old
 * stylesheet and View words, but loaded the new View (panel-view.js is loaded on first use). The old stylesheet has no
 * rule for the terminal's box (.v-term-box, #2969), so the box grew with its text:
 *  - Claude Code: fit() measured the box its own text sized, and shrank the text 0.5% every refresh, for ever;
 *  - Codex: the box was as tall as the whole history — the View sat at its top and never followed;
 *  - the words added since showed as raw keys (view.earlierInLog).
 * Now:
 *  - fit() converges: a box whose height changed right after a new size, in proportion to it, is following its text —
 *    from then on the width alone decides (a height change not in proportion, a phone's address bar, still limits);
 *  - healStalePage: a page whose stylesheet lacks the View's mark (--v-term-rev) links it again, once; a page whose View
 *    words lack theirs (view.rev) imports them again, once; never on a page with no app.css linked;
 *  - every word the View asks for (tn("…")) is in both languages, and the marks agree with VIEW_REV.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { MiniEvent } from "./helpers/mini-dom.js";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf-8");
const ROSTER = [{ instance_name: "alpha", display_name: "Alpha", status: "running", backend: "codex", tags: [], has_avatar: false }];
const paneCols = 100, paneRows = 30;
let resizeCallbacks: Array<() => void> = [];
let p: AppPage, view: any, i18n: any;
const g = globalThis as any;
let style: (el: any) => Record<string, string> = () => ({});

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/view/alpha", storage: { agend_tour_done: "1" } });
  g.fetch = async (u: string) => {
    if (u === "/api/profiles") return { ok: true, status: 200, json: async () => ROSTER };
    if (u.startsWith("/api/pane/")) return { ok: true, status: 200,
      headers: { get: (k: string) => (k === "X-Pane-Cols" ? String(paneCols) : k === "X-Pane-Rows" ? String(paneRows) : null) }, text: async () => "PANE" };
    if (u.startsWith("/api/ai-usage")) return { ok: true, status: 200, json: async () => ({ providers: [], fetchedAt: Date.now() }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  g.getComputedStyle = (el: any) => ({ paddingLeft: "6px", paddingRight: "6px", paddingTop: "5px", paddingBottom: "5px", fontFamily: "monospace", fontSize: "1px", lineHeight: "1.2",
    getPropertyValue: (k: string) => style(el)[k] ?? "" });
  g.ResizeObserver = class { constructor(cb: () => void) { resizeCallbacks.push(cb); } observe() { /* none */ } disconnect() { /* none */ } };
  i18n = await import("/assets/app-i18n.js");
  view = await import("/assets/panel-view.js");
});
afterAll(async () => { await p.unmount(); p.restore(); for (const k of ["fetch", "getComputedStyle", "ResizeObserver"]) delete g[k]; });
afterEach(async () => {
  await p.unmount();
  resizeCallbacks = []; style = () => ({});
  p.storage.clear();
  p.document.body.innerHTML = ""; p.document.head.innerHTML = "";
  p.root = p.document.createElement("div"); p.root.id = "app"; p.document.body.appendChild(p.root);
  view.resetHealed();
});

const mount = async () => { await p.mount(h(view.ViewPanel, { route: { panel: "view", instance: "alpha" }, navKey: "view:alpha|1|en" })); await settle(6); };
const term = () => p.root.querySelector(".v-term")!;
const pre = () => p.root.querySelector(".v-pre")!;
const px = () => parseFloat(pre().style.fontSize);
const wait = (ms = 120) => new Promise(r => setTimeout(r, ms));
const refit = async () => { resizeCallbacks.at(-1)!(); await wait(); };
/** A box that grows with its text, as with a stylesheet that has no rule for its container: its height is the text's. */
function boxFollowsText(width = 1012) {
  const t = term() as any, s = (pre() as any).style;
  t.clientWidth = width;
  const sizeTo = (v: string) => { t.clientHeight = Math.round(paneRows * 1.2 * parseFloat(v) + 10); };
  let fs = s.fontSize || "";
  Object.defineProperty(s, "fontSize", { configurable: true, get: () => fs, set: (v: string) => { fs = v; sizeTo(v); } });
  t.clientHeight = 610;
}

describe("fit() converges", () => {
  it("a box that grows with its text: at most one change, then the same size refresh after refresh — never shrinking on", async () => {
    await mount();
    boxFollowsText();
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) { await refit(); seen.push(px()); }
    const changes = seen.slice(1).filter((v, i) => v !== seen[i]).length;
    expect(changes, seen.join(" → ")).toBeLessThanOrEqual(1);
    expect(seen.at(-1)).toBe(seen.at(-2));
    // Found following at once (within the call that moved it), the width decides: 1000 / (100 × 0.6) × 0.995 = 16.58.
    expect(seen.at(-1)).toBeCloseTo(16.58, 2);
  });
  it("the same over the 800 ms refresh (no resize at all): the text keeps its size", async () => {
    await mount();
    boxFollowsText();
    await refit(); await refit();                                                 // the one step that finds it following
    const first = px();
    await wait(2600);                                                            // three refreshes
    expect(px()).toBe(first);
  });
  it("a box of its own that gets shorter for another reason (a phone's address bar) still limits the text", async () => {
    await mount();
    const t = term() as any;
    t.clientWidth = 1012; t.clientHeight = 610;
    await refit();
    expect(px()).toBeCloseTo(16.58, 2);
    t.clientHeight = 410;                                                         // not in proportion to any size change
    await refit();
    // 400 / (30 × 1.2) × 0.995 = 11.06
    expect(px()).toBeCloseTo(11.06, 2);
    t.clientHeight = 310;
    await refit();
    expect(px()).toBeCloseTo((300 / 36) * 0.995, 2);
  });
  it("following its text is forgotten when the person picks another size (Aa): back on Fit, the height limits again", async () => {
    const HT = await import("/assets/header-tools.js");
    await mount();
    boxFollowsText();
    await refit(); await refit();
    expect(px()).toBeCloseTo(16.58, 2);                                            // following: the width decides
    // The box is its own again (the stylesheet read anew), and the person goes S, then back to Fit.
    const t = term() as any, st = (pre() as any).style;
    let fs = st.fontSize;
    Object.defineProperty(st, "fontSize", { configurable: true, get: () => fs, set: (v: string) => { fs = v; } });
    t.clientHeight = 310;
    HT.setTextSize("s", { view: true }); await settle(4); await wait();
    HT.setViewFit(); await settle(4); await wait();
    expect(px()).toBeCloseTo((300 / 36) * 0.995, 2);
  });
  it("a box that loses a fixed few pixels when the text resizes (a scrollbar coming) is not following its text: it keeps limiting", async () => {
    await mount();
    const t = term() as any, st = (pre() as any).style;
    t.clientWidth = 1012; t.clientHeight = 610;
    await refit();
    expect(px()).toBeCloseTo(16.58, 2);
    // A scrollbar appears with the next size: 15 px off the box, not in proportion to the text.
    let fs = st.fontSize, once = true;
    Object.defineProperty(st, "fontSize", { configurable: true, get: () => fs, set: (v: string) => { fs = v; if (once) { once = false; t.clientHeight -= 15; } } });
    t.clientHeight = 500; await refit();
    t.clientHeight = 310; await refit();
    expect(px()).toBeCloseTo((300 / 36) * 0.995, 2);                                // still the height's fit
  });
  it("#2991 review: a box of its own made shorter step by step (each size then in proportion) keeps limiting — and so does a later change", async () => {
    await mount();
    const t = term() as any;
    t.clientWidth = 1012;
    const seen: number[] = [];
    for (const hgt of [610, 600, 590, 310]) { t.clientHeight = hgt; await refit(); seen.push(px()); }
    // Each the height's fit: (h − 10) / (30 × 1.2) × 0.995, never fixed by the width.
    expect(seen.map((v) => Math.round(v * 100) / 100)).toEqual([600, 590, 580, 300].map((h) => Math.round((h / 36) * 0.995 * 100) / 100));
    expect(seen.at(-1)).toBeCloseTo(8.29, 2);
    // Later, independent changes: taller again (the width limits), then shorter (the height limits again).
    t.clientHeight = 1010; await refit();
    expect(px()).toBeCloseTo(16.58, 2);
    t.clientHeight = 410; await refit();
    expect(px()).toBeCloseTo(11.06, 2);
  });
});

describe("a tab opened before an upgrade reads the View's stylesheet and words again", () => {
  const linkApp = () => { const l = p.document.createElement("link"); l.setAttribute("rel", "stylesheet"); l.setAttribute("href", "/assets/app.css"); p.document.head.appendChild(l); return l; };
  const links = () => p.document.head.querySelectorAll('link[rel="stylesheet"]').map((l: any) => l.getAttribute("href"));
  it("an older stylesheet (no --v-term-rev): app.css linked again after it, once", async () => {
    linkApp();
    await mount();
    expect(links().filter((u: string) => u.startsWith("/assets/app.css?rev=2-"))).toHaveLength(1);
    expect(view.healStalePage(p.document, () => Promise.resolve()).css).toBe(false);   // once per page
  });
  it("the current stylesheet (its mark in force), or a page with no app.css linked: nothing linked", async () => {
    linkApp();
    style = (el: any): Record<string, string> => (el && el.classList && el.classList.contains("v-term-box") ? { "--v-term-rev": " 2" } : {});
    await mount();
    expect(links()).toEqual(["/assets/app.css"]);
    view.resetHealed(); p.document.head.innerHTML = ""; style = () => ({});
    expect(view.healStalePage(p.document, () => Promise.resolve()).css).toBe(false);
    expect(links()).toEqual([]);
  });
  it("older words (no view.rev, or another): view-strings.js imported again, once; the words then resolve", async () => {
    const loads: string[] = [];
    i18n.register("view", { en: { rev: "1" }, "zh-TW": { rev: "1" } });                // as an older table
    try {
      const r = view.healStalePage(p.document, (u: string) => { loads.push(u); i18n.register("view", { en: { rev: view.VIEW_REV }, "zh-TW": { rev: view.VIEW_REV } }); return Promise.resolve(); });
      expect(r.words).toBe(true);
      expect(loads).toHaveLength(1);
      expect(loads[0]).toMatch(/^\.\/view-strings\.js\?rev=2-/);
      expect(view.healStalePage(p.document, (u: string) => { loads.push(u); return Promise.resolve(); }).words).toBe(false);
      expect(loads).toHaveLength(1);
    } finally { i18n.register("view", { en: { rev: view.VIEW_REV }, "zh-TW": { rev: view.VIEW_REV } }); }
  });
  it("current words: nothing imported", () => {
    const loads: string[] = [];
    expect(view.healStalePage(p.document, (u: string) => { loads.push(u); return Promise.resolve(); }).words).toBe(false);
    expect(loads).toEqual([]);
  });
});

describe("the View's words", () => {
  it("every word the View asks for is in both languages (never a raw key), and the marks agree with VIEW_REV", () => {
    const src = read("src", "ui", "shared", "panel-view.js");
    const keys = [...new Set([...src.matchAll(/\btn\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]))];
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toEqual(expect.arrayContaining(["earlierInLog", "logTabOff", "earlier", "jumpLatest", "newBelow", "noEarlier"]));
    for (const lang of ["en", "zh-TW"]) {
      const missing = keys.filter((k) => i18n.tIn(lang, `view.${k}`) === `view.${k}`);
      expect(missing, lang).toEqual([]);
    }
    // Translated, not English: the zh-TW words of the strip the user saw.
    expect(i18n.tIn("zh-TW", "view.earlierInLog")).toBe("較早的輸出在「紀錄」分頁");
    expect([i18n.tIn("en", "view.rev"), i18n.tIn("zh-TW", "view.rev")]).toEqual([view.VIEW_REV, view.VIEW_REV]);
    expect(read("src", "ui", "shared", "app.css")).toContain(`.v-term-box { --v-term-rev: ${view.VIEW_REV};`);
  });
});
