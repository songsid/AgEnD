/**
 * /view is desktop- and phone-friendly: the page fills the viewport, the terminal's font is fitted to the pane's own
 * cell grid (not to the captured text), it refits when its box changes, the font density is a persisted control, and
 * the profile card stays one line unless it is opened. Ported from view.html (#1408 step 2): the fit, density and card
 * are behaviour of ViewPanel, mounted here in the fake DOM with a fake pane; the layout rules are read from app.css.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { MiniEvent } from "./helpers/mini-dom.js";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf-8");
const appHtml = read("src", "ui", "app.html");
const appCss = read("src", "ui", "shared", "app.css");
const tokens = read("src", "ui", "shared", "tokens.css");
const panelSource = read("src", "ui", "shared", "panel-view.js");
// Comments stripped: they mention the properties they explain.
const css = appCss.replace(/\/\*[\s\S]*?\*\//g, "");

const ROSTER = [
  { instance_name: "alpha", display_name: "Alpha", status: "running", context_pct: 40, model: "m1", backend: "codex", tags: ["core"], has_avatar: false, role: "dev", description: "The first agent." },
];

// Cell grid and captured text are the fake pane's, changed per test.
let paneCols = 100, paneRows = 30, paneText = "PANE";
let resizeCallbacks: Array<() => void> = [];
let observed: unknown[] = [];

let p: AppPage;
let view: typeof import("/assets/panel-view.js");
const g = globalThis as any;

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/view/alpha", storage: { agend_tour_done: "1" } });
  g.fetch = async (u: string) => {
    if (u === "/api/profiles") return { ok: true, status: 200, json: async () => ROSTER };
    if (u.startsWith("/api/pane/")) return {
      ok: true, status: 200,
      headers: { get: (k: string) => (k === "X-Pane-Cols" ? String(paneCols) : k === "X-Pane-Rows" ? String(paneRows) : null) },
      text: async () => paneText,
    };
    if (u.startsWith("/api/ai-usage")) return { ok: true, status: 200, json: async () => ({ providers: [], fetchedAt: Date.now() }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // The metrics the Terminal reads: 6 px padding each side, 5 px top and bottom, a 1.2 line-height, 1px base size.
  g.getComputedStyle = () => ({ paddingLeft: "6px", paddingRight: "6px", paddingTop: "5px", paddingBottom: "5px", fontFamily: "monospace", fontSize: "1px", lineHeight: "1.2" });
  g.ResizeObserver = class { constructor(cb: () => void) { resizeCallbacks.push(cb); } observe(el: unknown) { observed.push(el); } disconnect() { /* none */ } };
  view = await import("/assets/panel-view.js");
});
afterAll(async () => { await p.unmount(); p.restore(); for (const k of ["fetch", "getComputedStyle", "ResizeObserver"]) delete g[k]; });
afterEach(async () => {
  await p.unmount();
  paneCols = 100; paneRows = 30; paneText = "PANE";
  resizeCallbacks = []; observed = [];
  p.storage.clear();
  p.document.body.innerHTML = "";
  p.root = p.document.createElement("div"); p.root.id = "app"; p.document.body.appendChild(p.root);
});

const mount = () => p.mount(h(view.ViewPanel, { route: { panel: "view", instance: "alpha" }, navKey: "view:alpha|1|en" }));
const term = () => p.root.querySelector(".v-term")!;
const pre = () => p.root.querySelector(".v-pre")!;
const fontPx = () => pre().style.fontSize;
const wait = (ms = 120) => new Promise(r => setTimeout(r, ms));
/** The terminal's box changes, then the window or the container reports it (80 ms debounce). */
async function resizeBox(width: number, height: number, via: "window" | "container" = "window") {
  term().clientWidth = width; term().clientHeight = height;
  if (via === "window") (p.window as any)._fire(new MiniEvent("resize"), false);
  else resizeCallbacks.at(-1)!();
  await wait();
}

describe("the page layout", () => {
  it("declares a device-width viewport and a full-viewport shell", () => {
    expect(appHtml).toContain('name="viewport" content="width=device-width, initial-scale=1');
    // The shell is the app's, full height (100vh with a dvh fallback). The old view.html also pinned width: 100vw; the
    // app's flex shell fills the width without it.
    expect(css).toMatch(/\.shell \{ display: flex; height: 100vh; height: 100dvh;/);
  });

  it("keeps the sidebar at the shell's fixed width token (was 240px in view.html; now 260px app-wide)", () => {
    expect(tokens).toContain("--sidebar-w: 260px;");
    expect(css).toMatch(/\.sidebar \{\s*width: var\(--sidebar-w\); flex-shrink: 0;/);
  });

  it("has no mobile drawer of its own: the shell's drawer covers phones, and a roster link closes it", () => {
    expect(panelSource).not.toMatch(/menuBtn|setDrawer/);
    // alpha.2 (N1): the roster is the shell's one list (instance-nav.js); a row's click is the shell's closeDrawer.
    expect(read("src", "ui", "shared", "instance-nav.js")).toContain("onClick=${onPick}");
    expect(read("src", "ui", "shared", "app-shell.js").match(/onPick=\$\{closeDrawer\}/g)?.length, "both lists: full and view-only").toBe(2);
  });
});

describe("the terminal's font fits the pane's cell grid", () => {
  it("sizes from the pane's columns and rows (X-Pane-Cols/Rows) and the box, the smaller fit wins", async () => {
    paneText = "x";                                   // the captured text is one short line: it must not decide the size
    await mount();
    await resizeBox(1012, 610);                          // inner 1000 x 600
    // width fit 1000 / (100 * 0.6) = 16.667, height fit 600 / (30 * 1.2) = 16.667; both * 0.995 = 16.58
    expect(fontPx()).toBe("16.58px");
  });

  it("the width is the limit when the grid is wide: 120 columns in 1000 px", async () => {
    paneCols = 120;
    await mount();
    await resizeBox(1012, 610);
    // 1000 / (120 * 0.6) = 13.889, * 0.995 = 13.82
    expect(fontPx()).toBe("13.82px");
  });

  it("refits when the window resizes, and again on the next change (no one-shot latch)", async () => {
    await mount();
    await resizeBox(1012, 610, "window");
    expect(fontPx()).toBe("16.58px");
    await resizeBox(1012, 1010, "window");              // inner 1000 x 1000: the width still limits
    expect(fontPx()).toBe("16.58px");
    await resizeBox(612, 610, "window");                // inner 600 x 600: 600 / 60 * 0.995 = 9.95, clamped up to 12
    expect(fontPx()).toBe("12.00px");
  });

  it("refits when the terminal's own box changes (ResizeObserver), not only on window resize", async () => {
    await mount();
    expect(observed.includes(term())).toBe(true);
    await resizeBox(1012, 610, "container");
    expect(fontPx()).toBe("16.58px");
  });

  it("clamps to one desktop range: 12 px at the least, 22 px at the most", async () => {
    await mount();
    paneCols = 200;                                      // a very wide grid in a small box: the floor
    await resizeBox(212, 610, "window");
    expect(fontPx()).toBe("12.00px");
    paneCols = 10; paneRows = 5;                         // a tiny grid in a big box: the ceiling
    await resizeBox(2012, 1010, "window");
    expect(fontPx()).toBe("22.00px");
  });
});

describe("the text size control (#1523 N3, Q2 = A: S / M / L shared; View keeps Fit)", () => {
  const densityButton = () => p.root.querySelectorAll("button").find((b: any) => (b.getAttribute("title") ?? "").startsWith("Text size"))!;
  const pageLoad = async () => (await import("/assets/header-tools.js")).initTextSize();

  it("cycles Fit -> S -> M -> L -> Fit and scales the fitted size; S / M / L are the shared size", async () => {
    await pageLoad();
    await mount();
    await resizeBox(1012, 610);
    expect(densityButton().getAttribute("title")).toBe("Text size: Fit");
    densityButton().click(); await settle(); await wait(20);
    expect([p.storage.get("agend_text_size"), p.storage.get("agend_view_fit"), densityButton().getAttribute("title")]).toEqual(["s", "0", "Text size: S"]);
    expect(fontPx()).toBe("13.27px");                    // 16.58 * 0.8 (View's old compact)
    densityButton().click(); await settle(); await wait(20);
    expect([p.storage.get("agend_text_size"), fontPx()]).toEqual(["m", "16.58px"]);
    densityButton().click(); await settle(); await wait(20);
    expect([p.storage.get("agend_text_size"), fontPx()]).toEqual(["l", "20.73px"]);   // 16.58 * 1.25 (View's old comfortable)
    densityButton().click(); await settle(); await wait(20);
    expect([p.storage.get("agend_view_fit"), densityButton().getAttribute("title"), fontPx()]).toEqual(["1", "Text size: Fit", "16.58px"]);
  });

  it("a page load reads this browser's choice; View's old agend_view_density is taken over once (compact → S)", async () => {
    p.storage.set("agend_view_density", "compact");
    p.storage.delete("agend_text_size"); p.storage.delete("agend_view_fit");
    await pageLoad();
    await mount();
    expect([densityButton().getAttribute("title"), p.storage.get("agend_text_size"), p.storage.get("agend_view_fit")]).toEqual(["Text size: S", "s", "0"]);
  });
});

describe("the profile card gives the terminal its height", () => {
  it("the terminal keeps its small padding", () => {
    expect(css).toMatch(/\.v-term \{[^}]*padding: 5px 6px;/);
  });

  it("the card is one line by default: no description; opening it shows the whole profile, and that is remembered", async () => {
    await mount();
    const card = () => p.root.querySelector(".v-card")!;
    const toggle = () => card().querySelector("button")!;
    expect(card().classList.contains("open")).toBe(false);
    expect(card().querySelector(".v-card-desc")).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    toggle().click(); await settle();
    expect(card().classList.contains("open")).toBe(true);
    expect(card().querySelector(".v-card-desc")!.textContent).toBe("The first agent.");
    expect(p.storage.get("agend_view_card_expanded")).toBe("1");
  });
});
