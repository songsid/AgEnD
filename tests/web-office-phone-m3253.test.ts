/**
 * M-3253 (Argon's phone review of the Office): on a phone — upright, or turned sideways (a coarse pointer in a short
 * window: OFFICE_PHONE_Q) —
 * - the Office's own bar is gone: its tools (and Live) are one ⋯ sheet at the end of the org chart's bar (Find, the view
 *   switch, ⋯: one row); a desktop keeps the bar and has no ⋯;
 * - zone pills (one office on a zones style) jump to an area at 100 %, or back to the whole office;
 * - a finger's tap near a person (within TAP_R CSS px) picks them when nobody is under it; a mouse click there does not;
 * - the person's card is a bottom sheet flush with the window's foot, its close and actions 44 px;
 * - a sideways drag on the Office's canvas or stage never opens the drawer: web-swipe-office-m3253.test.ts.
 * The real layout is measured in Chromium by scripts/manual/smoke/smoke-office-phone-argon.mts (440 × 956 and 956 × 440).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";

const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
  { name: "sage", status: "paused", backend: "grok" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill", "sage"] }], instances: {} };
const STORE = { ready: true, instances: INSTANCES, exec: { quill: "working" }, awaiting: {}, needs: [] };
const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");

function fakeCtx() {
  const t: any = { measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }),
    getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(w * hh * 4) }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
}

let p: AppPage, fleet: any, FO: any, V: any, CV: any, Z: any, K: any, app: any, nav: any;
let realMM: any;
/** What this browser's media queries answer: "phone" (a phone's width), "sideways" (only the coarse short window), "desk". */
let screen: "phone" | "sideways" | "desk" = "phone";
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200,
    json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? { rev: 0, offices: [] } : url === "/ui/office-skins" ? { rev: "", packs: [] } : {}) });
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  FO = await import("/ui/js/fleet-office.js");
  V = await import("/ui/js/fleet-office-view.js");
  CV = await import("/ui/js/fleet-canvas-view.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  realMM = (globalThis as any).matchMedia;
  (globalThis as any).matchMedia = (q: string) => ({
    matches: screen === "phone" ? /max-width: 899px/.test(q) : screen === "sideways" ? q === FO.OFFICE_PHONE_Q : false,
    addEventListener() {}, removeEventListener() {} });
});
afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; (globalThis as any).matchMedia = realMM; });
const proto = MiniElement.prototype as any;
beforeEach(async () => {
  await p.unmount();
  p.storage.clear();
  screen = "phone";
  proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
  localStorage.setItem("agend_org_mode", "office");
  localStorage.setItem("agend_org_office_skin", "studio");
  nav.navigate("/ui/fleet/org");
  app.appStore.set(STORE);
});
afterEach(() => { delete proto.getContext; });
const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(8); };
const $ = (sel: string) => p.root.querySelector(sel);
const shown = () => { const r = $(".oo-mini-view"); const [k, x, y] = ["data-k", "data-x", "data-y"].map((a) => Number(r.getAttribute(a))); return { k, x, y }; };

describe("M-3253: the Office's tools in one ⋯ sheet on a phone", () => {
  it("a phone: no Office bar and no Live in the org bar; Find, the view switch and ⋯; the sheet holds them all", async () => {
    await mount();
    expect($(".oo.phone")).toBeTruthy();
    expect($(".oo > .oo-bar")).toBeNull();
    expect($(".oc-tools .oc-live")).toBeNull();
    expect([...$(".oc-tools").children].map((n: any) => n.className.split(" ").find((c: string) => /^(oc-find|seg-inline|oo-more-btn)$/.test(c)))).toEqual(["oc-find", "seg-inline", "oo-more-btn"]);
    expect($("dialog.oo-sheet")).toBeNull();
    $(".oo-more-btn").click(); await settle(4);
    const sheet = $("dialog.oo-sheet");
    expect(sheet).toBeTruthy();
    for (const sel of [".oo-sheet-fit", ".oo-sheet-fill", ".oo-sheet-fs", ".oo-sheet-live input", ".oo-sheet-bar .oo-office", ".oo-sheet-bar .oo-hide-asleep", ".oo-sheet-bar .oo-dialogue"])
      expect(sheet.querySelector(sel), sel).toBeTruthy();
    // Live moved here: unticking it is the org chart's Live (kept per device).
    fire(sheet.querySelector(".oo-sheet-live input"), "change"); await settle(4);
    expect(localStorage.getItem("agend_org_live")).toBe("0");
    expect($("dialog.oo-sheet .oo-sheet-live input").checked).toBe(false);
    // Fit closes the sheet (and fits); the × too.
    $(".oo-sheet-fit").click(); await settle(4);
    expect($("dialog.oo-sheet")).toBeNull();
    $(".oo-more-btn").click(); await settle(4);
    $("dialog.oo-sheet .dlg-x").click(); await settle(4);
    expect($("dialog.oo-sheet")).toBeNull();
  });
  it("a phone turned sideways (only the coarse short window matches) is a phone here too", async () => {
    screen = "sideways"; await mount();
    expect([!!$(".oo.phone"), !!$(".oo-more-btn"), !!$(".oo > .oo-bar"), !!$(".oc-tools .oc-live")]).toEqual([true, true, false, false]);
  });
  it("a desktop keeps the Office bar and Live; no ⋯, no zone pills, the card a popover", async () => {
    screen = "desk"; await mount();
    expect([!!$(".oo.phone"), !!$(".oo-more-btn"), !!$(".oo > .oo-bar"), !!$(".oc-tools .oc-live"), !!$(".oo-zone-pills")]).toEqual([false, false, true, true, false]);
  });
  it("the media query is one string: the module's, the stylesheet's phone block", () => {
    expect(FO.OFFICE_PHONE_Q).toBe("(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)");
    // M-3254: every phone block now has this query; the Office's is the one holding the ⋯.
    const blocks = css.split(`@media ${FO.OFFICE_PHONE_Q} {`).slice(1).map((b) => b.slice(0, b.indexOf("\n}\n")));
    const block = blocks.find((b) => b.includes(".oo-more-btn"))!;
    expect(block).toBeTruthy();
    expect(block).toContain(".oc-tools .oo-more-btn { flex: none; width: var(--tap); height: var(--tap); }");
    expect(block).toContain(".oo.phone .oo-zoom .icon-btn { width: var(--tap); height: var(--tap); }");
    expect(block).toMatch(/\.oo\.phone:not\(\.fs\) \.oo-zoom :is\(\.oo-fit, \.oo-fill\) \{ display: none; \}/);
  });
});

describe("M-3253: zone pills", () => {
  it("the areas with people (and the whole office): a pill zooms to 100 % centred on its area; Whole office fits again", async () => {
    await mount();
    const pills = [...p.root.querySelectorAll(".oo-zone-pills button")];
    expect(pills.map((b: any) => b.getAttribute("data-area") ?? "all")).toEqual(["all", "desks", "lounge", "nap"]);
    const fitK = shown().k;
    expect(fitK).toBeLessThan(1);
    const lounge = pills.find((b: any) => b.getAttribute("data-area") === "lounge");
    lounge.click(); await settle(4);
    const v = shown();
    expect(v.k).toBe(FO.ZONE_K);
    expect($(".oo-zoom-pct").textContent).toBe("100%");
    const r = K.STUDIO_PACK.areas.lounge.rect;
    const centre = CV.toScreen(v, r.x + r.w / 2, r.y + r.h / 2), clamped = V.clampPan(CV.centreOn(v, { w: 960, h: 600 }, r.x + r.w / 2, r.y + r.h / 2), 1280, 720, { w: 960, h: 600 });
    expect([v.x, v.y]).toEqual([clamped.x, clamped.y]);
    expect(centre.x).toBeGreaterThan(0);
    pills[0].click(); await settle(4);
    expect(shown().k).toBeCloseTo(fitK, 9);
  });
});

describe("M-3253: a finger's tap near a person", () => {
  it("nearestPerson: the closest within the radius, else null", () => {
    const list = [{ key: "a", x: 0, y: 0 }, { key: "b", x: 10, y: 0 }];
    expect(FO.nearestPerson(list, 6, 0, 5)?.key).toBe("b");
    expect(FO.nearestPerson(list, 4, 0, 5)?.key).toBe("a");
    expect(FO.nearestPerson(list, 30, 0, 5)).toBeNull();
    expect(FO.TAP_R).toBe(22);
  });
  it("20 CSS px beside a person (off their sprite): a touch opens their card, a mouse click does not; 30 px: nobody", async () => {
    await mount();
    const cv = $(".oo-canvas"), v = shown();
    const nodes = [{ name: "atlas", state: "idle" }, { name: "quill", state: "working" }, { name: "sage", state: "paused" }].map((n) => ({ ...n, i: { name: n.name } }));
    const seat = Z.zonesLayout(K.STUDIO_PACK, nodes).seats.get("quill");
    const c = CV.toScreen(v, seat.x, seat.y - 32);
    const tap = async (dx: number, type: string) => {
      fire(cv, "pointerdown", { pointerId: 3, pointerType: type, button: 0, clientX: c.x + dx, clientY: c.y });
      fire(cv, "pointerup", { pointerId: 3, pointerType: type, clientX: c.x + dx, clientY: c.y });
      fire(cv, "click", { clientX: c.x + dx, clientY: c.y, pointerType: type }); await settle(3);
    };
    await tap(20, "mouse");
    expect($(".oo-card")).toBeNull();                                  // nobody is drawn there
    await tap(30, "touch");
    expect($(".oo-card")).toBeNull();                                  // past a fingertip
    await tap(20, "touch");
    expect($(".oo-card .oo-card-instance")?.textContent).toBe("quill");
    expect($(".oo-card").classList.contains("sheet")).toBe(true);      // a phone: the bottom sheet
  });
});

describe("M-3253: the card's sheet", () => {
  it("sits on the window's foot (no 56 px lift for a tab bar that is gone); its close and actions 44 px", () => {
    expect(css).not.toMatch(/\.oo-card\.sheet \{[^}]*bottom: calc\(56px/);
    expect(css).toContain(".oo-card.sheet .oo-card-close { width: var(--tap); height: var(--tap);");
    expect(css).toContain(".oo-card.sheet .oo-card-actions .btn { flex: 1; min-height: var(--tap);");
    const base = css.match(/\.oo-card\.sheet \{ position: fixed;[^}]*\}/)![0];
    expect(base).toContain("bottom: 0;");
  });
});
