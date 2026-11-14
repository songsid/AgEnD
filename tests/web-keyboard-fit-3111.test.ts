/**
 * M-3111 (the user, iPhone Safari, 2.4.0-alpha.4): with the keyboard open a black band sat between the composer and the
 * keyboard, and the box jumped as the keyboard rose ("破圖感"). iOS Safari keeps the page at its tallest (100dvh) and pans
 * the page short of the view (under interactive-widget=resizes-content): the page's background showed under the box, and
 * on the way down the page stayed short, then snapped. With the keyboard up — and for a moment after a field gains or
 * loses focus, every frame — the shell is now the visible view itself: its height and where it was panned, set on the
 * shell (inline) only then; the rest of the time it has its stylesheet height and no transform.
 * The real Shell (tests/helpers/app-harness.ts), a fake visualViewport with offsetTop/scale and its scroll event.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } });

function fakeViewport(width: number, height: number) {
  const subs = new Map<string, Set<() => void>>();
  const on = (n: string) => { if (!subs.has(n)) subs.set(n, new Set()); return subs.get(n)!; };
  return {
    width, height, offsetTop: 0, scale: 1,
    addEventListener(n: string, fn: () => void) { on(n).add(fn); }, removeEventListener(n: string, fn: () => void) { on(n).delete(fn); },
    listeners(n: string) { return on(n).size; },
    emit(n: string) { for (const fn of [...on(n)]) fn(); },
  };
}
const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }, h("textarea", { id: "box" })) });
const PANELS = new Map([["chat", Stub("chat")], ["view", Stub("view")], ["fleet", Stub("fleet")], ["settings", Stub("settings")], ["needs", Stub("needs")]]);

async function phone(o: { pointer?: "coarse" | "fine" } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1" }, matchNarrow: true });
  mounted.push(pg);
  const coarse = (o.pointer ?? "coarse") === "coarse";
  (globalThis as any).matchMedia = (q: string) => ({ matches: /max-width/.test(q) || (coarse && /pointer:\s*coarse/.test(q)), addEventListener() {}, removeEventListener() {} });
  const vv = fakeViewport(390, 844);
  pg.window.visualViewport = vv; pg.window.innerHeight = 844;
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell, shellStore } = await import("/assets/app-shell.js");
  shellStore.set({ keyboard: false });
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code" }] });
  await pg.mount(h(Shell, { panels: PANELS, onNewInstance() {} }));
  await settle(3);
  const vars = () => { const el = pg.root.querySelector(".shell") as any; return [el.style.height || null, el.style.transform || null]; };   // the mini DOM's style: setProperty writes the key
  const kb = () => (pg.root.querySelector(".shell") as any).classList.contains("kb-open");
  const focus = async () => { const el = pg.root.querySelector("#box") as any; el.focus(); fire(el, "focusin"); await settle(); };
  const blur = async () => { const el = pg.root.querySelector("#box") as any; el.blur(); fire(el, "focusout"); await settle(); };
  const frames = (n = 3) => new Promise((r) => setTimeout(r, 20 * n));
  return { pg, vv, vars, kb, focus, blur, frames };
}

describe("M-3111: with the keyboard up the shell is the visible view", () => {
  it("up: the view's height and where it was panned; panning again moves it; nothing set before the keyboard", async () => {
    const { vv, vars, kb, focus } = await phone();
    expect(vars()).toEqual([null, null]);
    await focus();
    vv.height = 480; vv.offsetTop = 300; vv.emit("resize"); await settle();
    expect([kb(), ...vars()]).toEqual([true, "480px", "translateY(300px)"]);
    vv.offsetTop = 312; vv.emit("scroll"); await settle();                 // Safari pans while typing: the shell goes with it
    expect(vars()).toEqual(["480px", "translateY(312px)"]);
    vv.offsetTop = 0; vv.emit("scroll"); await settle();                   // not panned: no transform at all
    expect(vars()).toEqual(["480px", null]);
  });

  it("down: the shell follows the view back up every frame (no snap at the end), then gives the height back to its stylesheet", async () => {
    const { vv, vars, kb, focus, blur, frames } = await phone();
    await focus();
    vv.height = 480; vv.offsetTop = 0; vv.emit("resize"); await settle();
    await blur();                                                          // the keyboard falls; the view grows with no event yet
    expect(kb()).toBe(false);
    expect(vars()).toEqual(["480px", null]);                               // not the stylesheet's (still short) height: the view's
    vv.height = 660; await frames();
    expect(vars()).toEqual(["660px", null]);
    vv.height = 844; await frames();
    expect(vars()).toEqual(["844px", null]);
    await new Promise((r) => setTimeout(r, 900));                         // settled: the stylesheet's height again
    expect(vars()).toEqual([null, null]);
  });

  it("follows the keyboard as it rises: a view that changes with no resize event is picked up on the next frames", async () => {
    const { vv, vars, focus, frames } = await phone();
    await focus();
    vv.height = 700; await frames();                                       // mid-animation, before it counts as a keyboard: followed
    expect(vars()).toEqual(["700px", null]);
    vv.height = 520; vv.offsetTop = 260; await frames();                    // the keyboard's height reached: up, fitted, no event
    expect(vars()).toEqual(["520px", "translateY(260px)"]);
    vv.height = 480; vv.offsetTop = 300; await frames();
    expect(vars()).toEqual(["480px", "translateY(300px)"]);
  });

  it("pinch-zoomed, the view is not the screen: nothing is fitted; a desk's fine pointer never fits", async () => {
    const zoomed = await phone();
    await zoomed.focus();
    zoomed.vv.scale = 2; zoomed.vv.height = 422; zoomed.vv.emit("resize"); await settle();
    expect(zoomed.vars()).toEqual([null, null]);
    for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
    const desk = await phone({ pointer: "fine" });
    await desk.focus();
    desk.vv.height = 480; desk.vv.emit("resize"); await settle();
    expect([desk.kb(), ...desk.vars()]).toEqual([false, null, null]);
  });

  it("unmounted: the listeners go, and a queued frame does nothing", async () => {
    const { pg, vv, vars, focus } = await phone();
    await focus();
    vv.height = 480; vv.emit("resize"); await settle();
    expect(vars()[0]).toBe("480px");
    await pg.unmount();
    expect([vv.listeners("resize"), vv.listeners("scroll")]).toEqual([0, 0]);
    vv.height = 300; vv.emit("resize"); await new Promise((r) => setTimeout(r, 60));   // a frame still queued finds nothing to fit
    mounted.splice(mounted.indexOf(pg), 1); pg.restore();
  });

  it("the stylesheet keeps the page's own height (100vh, then 100dvh) and no transform on the shell", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
    expect(css).toContain(".shell { display: flex; height: 100vh; height: 100dvh; overflow: hidden; position: relative; }");
    expect(css).not.toMatch(/\.shell[^{]*\{[^}]*transform/);
  });
});
