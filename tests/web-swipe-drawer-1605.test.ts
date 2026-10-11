/**
 * #1605 (baseline: the issue body): on a phone, a swipe right in the main area opens the drawer, a swipe left on it or
 * its scrim closes it. Never from the left edge (iOS "back"), never mostly-vertical (a scroll), never in something that
 * owns a sideways gesture (code, a table, the terminal, the composer or any input, a horizontally scrollable box),
 * never while a dialog, the lightbox or the preview panel is up, never at desktop width. The real installSwipe on the
 * mini DOM with synthetic touch sequences; the app wires it to the same open/close as ☰ (asserted on app.js).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installDom, MiniEvent, type MiniPage } from "./helpers/mini-dom.js";

let page: MiniPage | null = null;
let off: (() => void) | null = null;
afterEach(() => { off?.(); off = null; page?.restore(); page = null; });

async function world(opts: { narrow?: boolean } = {}) {
  page = installDom({ matchNarrow: opts.narrow ?? true });
  const doc = page.document as any;
  const el = (tag: string, attrs: Record<string, string> = {}, parent: any = doc.body) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === "class") e.className = v; else e.setAttribute(k, v); if (k === "id") e.id = v; }
    parent.appendChild(e); return e;
  };
  const sidebar = el("aside", { id: "sidebar" });
  const scrim = el("div", { class: "scrim" });
  const main = el("main", { id: "main" });
  const thread = el("div", { class: "thread" }, main);
  const bubble = el("div", { class: "msg" }, thread);
  const pre = el("pre", {}, el("div", { class: "codeblock" }, bubble));
  const table = el("td", {}, el("tr", {}, el("table", {}, bubble)));
  const xterm = el("div", { class: "xterm-screen" }, el("div", { class: "xterm" }, main));
  const composer = el("textarea", { id: "msgIn" }, el("div", { class: "composer" }, main));
  const wide = el("div", { class: "wide" }, main);
  const inWide = el("span", {}, wide);
  Object.assign(wide, { scrollWidth: 900, clientWidth: 300 });
  (globalThis as any).getComputedStyle = (e: any) => ({ overflowX: e === wide ? "auto" : "visible" });
  const state = { open: false, opens: 0, closes: 0 };
  const { installSwipe } = await import("../src/ui/shared/app-swipe.js") as any;
  off = installSwipe({ doc, win: globalThis, isDrawer: () => (globalThis as any).matchMedia("(max-width: 899px)").matches,
    isOpen: () => state.open, open: () => { state.open = true; state.opens++; }, close: () => { state.open = false; state.closes++; } });
  /** One finger from (x0,y0) to (x1,y1), starting on `target`. */
  const swipe = (target: any, x0: number, y0: number, x1: number, y1: number) => {
    target.dispatchEvent(new MiniEvent("touchstart", { bubbles: true, touches: [{ clientX: x0, clientY: y0 }] }));
    target.dispatchEvent(new MiniEvent("touchmove", { bubbles: true, touches: [{ clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 }] }));
    target.dispatchEvent(new MiniEvent("touchend", { bubbles: true, touches: [], changedTouches: [{ clientX: x1, clientY: y1 }] }));
  };
  return { doc, el, sidebar, scrim, main, bubble, pre, table, xterm, composer, inWide, state, swipe };
}

describe("phone: swipe the drawer open and shut", () => {
  it("a swipe right in the chat opens it; a swipe left on the drawer — or on the scrim — closes it", async () => {
    const w = await world();
    w.swipe(w.bubble, 60, 400, 160, 410);
    expect([w.state.open, w.state.opens]).toEqual([true, 1]);
    w.swipe(w.sidebar, 250, 300, 120, 310);
    expect([w.state.open, w.state.closes]).toEqual([false, 1]);
    w.swipe(w.bubble, 60, 400, 160, 410);
    w.swipe(w.scrim, 340, 300, 200, 300);
    expect([w.state.open, w.state.opens, w.state.closes]).toEqual([false, 2, 2]);
  });
  it("a short or mostly vertical swipe is a scroll: nothing happens", async () => {
    const w = await world();
    w.swipe(w.bubble, 60, 400, 110, 400);                       // 50 px: too short
    w.swipe(w.bubble, 60, 400, 160, 470);                       // dy 70 ≥ dx/2 (50): mostly vertical
    w.swipe(w.bubble, 100, 600, 110, 200);                      // a plain scroll
    expect(w.state.opens).toBe(0);
  });
  it("never from the left edge (iOS Safari's back gesture)", async () => {
    const w = await world();
    w.swipe(w.bubble, 10, 400, 200, 400);
    w.swipe(w.bubble, 23, 400, 200, 400);
    expect(w.state.opens).toBe(0);
    w.swipe(w.bubble, 24, 400, 200, 400);
    expect(w.state.opens).toBe(1);
  });
  it("never in what owns a sideways gesture: code, a table, the terminal, the composer, a horizontally scrollable box", async () => {
    const w = await world();
    for (const target of [w.pre, w.table, w.xterm, w.composer, w.inWide]) w.swipe(target, 60, 400, 200, 400);
    expect(w.state.opens).toBe(0);
  });
  it("never while a dialog, the image lightbox or the preview panel is up", async () => {
    const w = await world();
    const dlg = w.el("dialog", { open: "" });
    w.swipe(w.bubble, 60, 400, 200, 400);
    dlg.remove();
    w.doc.documentElement.classList.add("lb-open");
    w.swipe(w.bubble, 60, 400, 200, 400);
    w.doc.documentElement.classList.remove("lb-open");
    const pv = w.el("aside", { class: "pv-panel" });
    w.swipe(w.bubble, 60, 400, 200, 400);
    pv.remove();
    expect(w.state.opens).toBe(0);
    w.swipe(w.bubble, 60, 400, 200, 400);
    expect(w.state.opens, "and once they are gone, it works").toBe(1);
  });
  it("a second finger (a pinch) cancels it; outside the main area (the bottom tabs) it does not open", async () => {
    const w = await world();
    w.bubble.dispatchEvent(new MiniEvent("touchstart", { bubbles: true, touches: [{ clientX: 60, clientY: 400 }] }));
    w.bubble.dispatchEvent(new MiniEvent("touchmove", { bubbles: true, touches: [{ clientX: 80, clientY: 400 }, { clientX: 200, clientY: 300 }] }));
    w.bubble.dispatchEvent(new MiniEvent("touchend", { bubbles: true, touches: [], changedTouches: [{ clientX: 200, clientY: 400 }] }));
    const tabs = w.el("nav", { class: "tabs" });
    w.swipe(tabs, 60, 800, 200, 800);
    expect(w.state.opens).toBe(0);
  });
});

describe("desktop", () => {
  it("at desktop width nothing happens (the sidebar is not a drawer)", async () => {
    const w = await world({ narrow: false });
    w.swipe(w.bubble, 60, 400, 200, 400);
    expect(w.state.opens).toBe(0);
  });
});

describe("the app wires it to ☰'s own open and close, with passive listeners", () => {
  it("app.js installs it with openDrawer/closeDrawer and the drawer state; the listeners never prevent scrolling", () => {
    const app = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.js"), "utf8");
    expect(app).toMatch(/installSwipe\(\{[\s\S]*isOpen: \(\) => shellStore\.get\(\)\.drawer, open: openDrawer, close: closeDrawer,[\s\S]*\}\);/);
    const src = readFileSync(join(process.cwd(), "src", "ui", "shared", "app-swipe.js"), "utf8");
    expect([/preventDefault/.test(src), /const opts = \{ passive: true \};/.test(src)]).toEqual([false, true]);
  });
});
