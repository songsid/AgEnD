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
const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }, h("textarea", { id: "box" }), h("input", { id: "box2" })) });
const PANELS = new Map([["chat", Stub("chat")], ["view", Stub("view")], ["fleet", Stub("fleet")], ["settings", Stub("settings")], ["needs", Stub("needs")]]);

async function phone(o: { pointer?: "coarse" | "fine" } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1" }, matchNarrow: true });
  mounted.push(pg);
  const coarse = (o.pointer ?? "coarse") === "coarse";
  (globalThis as any).matchMedia = (q: string) => ({ matches: /max-width/.test(q) || (coarse && /pointer:\s*coarse/.test(q)), addEventListener() {}, removeEventListener() {} });
  const vv = fakeViewport(390, 844);
  pg.window.visualViewport = vv; pg.window.innerHeight = 844;
  // M-3327: the shell undoes a pan with scrollTo(0, 0); the browser then reports the view unpanned (a scroll event).
  const scrolls: number[][] = [];
  pg.window.scrollTo = (x: number, y: number) => { scrolls.push([x, y]); if (vv.offsetTop) { vv.offsetTop = 0; vv.emit("scroll"); } };
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
  const closing = () => (pg.root.querySelector(".shell") as any).hasAttribute("data-kb-closing");
  return { pg, vv, vars, kb, focus, blur, frames, scrolls, closing };
}

describe("M-3111: with the keyboard up the shell is the visible view", () => {
  // M-3327 (the user's iPhone recording, beta.11): following the pan with translateY(offsetTop) dropped the header to
  // mid-screen over a black band and pushed the box under the keyboard. The shell is the view's height at the top; a pan is
  // undone (scrollTo 0), never followed with a transform.
  it("up: the view's height at the top; a pan is undone (scrollTo 0), never followed; nothing set before the keyboard", async () => {
    const { vv, vars, kb, focus, scrolls } = await phone();
    expect(vars()).toEqual([null, null]);
    await focus();
    vv.height = 480; vv.offsetTop = 300; vv.emit("resize"); await settle();
    expect([kb(), ...vars(), vv.offsetTop]).toEqual([true, "480px", null, 0]);
    expect(scrolls).toEqual([[0, 0]]);
    vv.offsetTop = 312; vv.emit("scroll"); await settle();                 // Safari pans again: undone again
    expect([...vars(), vv.offsetTop, scrolls.length]).toEqual(["480px", null, 0, 2]);
  });

  // beta.4 (the user, iPhone): every keypress made the page re-align. While the field keeps focus the shell stays the view
  // even if the keyboard state dips for a moment: the height and pan are never handed back to the stylesheet mid-typing.
  it("typing: a keyboard state that dips for a moment leaves the shell as the view (no re-align on a keystroke)", async () => {
    const { vv, vars, focus, scrolls } = await phone();
    const { shellStore } = await import("/assets/app-shell.js");
    await focus();
    vv.height = 480; vv.offsetTop = 120; vv.emit("resize"); await settle();
    await new Promise((r) => setTimeout(r, 900));                         // past the focus follow window
    const seen: Array<Array<string | null>> = [];
    const before = scrolls.length;
    for (const top of [132, 120, 140, 120]) {
      shellStore.set({ keyboard: false });                                 // the state dips (one reading said "down")
      vv.offsetTop = top; vv.emit("scroll"); await settle();
      seen.push(vars());
    }
    // M-3206: a pan that comes and goes with a keystroke no longer moves the shell (it stays as the view, at its place);
    // M-3327: nor is it undone per key.
    expect(seen).toEqual([["480px", null], ["480px", null], ["480px", null], ["480px", null]]);
    expect(scrolls.length).toBe(before);
  });

  // M-3206 (the user, iPhone, beta.5): typing still flickered. Per key, iOS reported the view a little differently — the
  // suggestion bar (44 px) on and off, a few px of pan — and the shell followed every reading, so the box moved on every key
  // and back. Settled, a reading must hold before the shell takes it; a lasting one is taken then; a new width at once.
  it("typing, settled: per-key readings (the suggestion bar on and off, a pan) move nothing; one that holds is taken", async () => {
    const { vv, vars, kb, focus, scrolls } = await phone();
    await focus();
    vv.height = 480; vv.offsetTop = 0; vv.emit("resize"); await settle();
    await new Promise((r) => setTimeout(r, 900));                         // past the focus follow window
    const seen: Array<Array<string | boolean | null>> = [];
    for (const [hh, top] of [[436, 0], [480, 0], [480, 12], [480, 0], [436, 0], [480, 0]]) {
      vv.height = hh; vv.offsetTop = top; vv.emit("resize"); vv.emit("scroll"); await settle();
      await new Promise((r) => setTimeout(r, 60));                         // the next key comes ~60 ms later
      seen.push([kb(), ...vars()]);
    }
    expect(seen.every((s) => JSON.stringify(s) === JSON.stringify([true, "480px", null])), JSON.stringify(seen)).toBe(true);
    vv.height = 436; vv.offsetTop = 0; vv.emit("resize"); await settle();  // the bar stays: taken once it has held
    expect(vars(), "not yet").toEqual(["480px", null]);
    await new Promise((r) => setTimeout(r, 400));
    expect([kb(), ...vars()]).toEqual([true, "436px", null]);
    const before = scrolls.length;
    vv.offsetTop = 30; vv.emit("scroll"); await new Promise((r) => setTimeout(r, 400));   // a pan that stays: undone (M-3327)
    expect([...vars(), scrolls.length - before, vv.offsetTop]).toEqual(["436px", null, 1, 0]);
    vv.width = 844; vv.height = 300; vv.offsetTop = 0; vv.emit("resize"); await settle();   // turned: at once
    expect(vars()).toEqual(["300px", null]);
  });
  it("typing, settled with no keyboard (the field kept its focus): the keyboard coming up is followed at once", async () => {
    const { vv, vars, kb, focus } = await phone();
    await focus();
    await new Promise((r) => setTimeout(r, 900));                         // focused, no keyboard yet, past the follow window
    expect(vars()).toEqual(["844px", null]);
    vv.height = 480; vv.offsetTop = 0; vv.emit("resize"); await settle();
    expect([kb(), ...vars()]).toEqual([true, "480px", null]);
  });

  // M-3244 (the user, iPhone, beta.7, Zhuyin): while an IME composes the keyboard's state waits for compositionend — the
  // shell's height must not. A view that got shorter mid-composition (the keyboard coming up as the first key is typed, or the
  // candidate bar) is followed; the view growing back waits for compositionend.
  it("composing: the keyboard coming up mid-composition — the shell is the view at once, not the whole screen", async () => {
    const { pg, vv, vars, kb, focus } = await phone();
    await focus();
    const box = pg.root.querySelector("#box") as any;
    fire(box, "compositionstart", { data: "" });
    vv.height = 436; vv.emit("resize"); await settle();
    expect(vars(), "the box would sit under the keyboard at 844px").toEqual(["436px", null]);
    expect(kb(), "the keyboard's state still waits for compositionend").toBe(false);
    fire(box, "compositionend", { data: "你" }); await settle();
    expect([kb(), ...vars()]).toEqual([true, "436px", null]);
  });
  it("composing, settled: the candidate bar shortens the view — followed after the hold; it going away grows nothing until compositionend (and typing stopped)", async () => {
    const { pg, vv, vars, kb, focus } = await phone();
    await focus();
    vv.height = 480; vv.emit("resize"); await settle();
    await new Promise((r) => setTimeout(r, 900));                         // past the focus follow window
    const box = pg.root.querySelector("#box") as any;
    fire(box, "compositionstart", { data: "" });
    vv.height = 436; vv.emit("resize"); await new Promise((r) => setTimeout(r, 400));   // past the 300 ms hold
    expect([kb(), ...vars()]).toEqual([true, "436px", null]);
    vv.height = 480; vv.emit("resize"); await new Promise((r) => setTimeout(r, 400));
    expect(vars(), "growing waits for the IME").toEqual(["436px", null]);
    fire(box, "compositionend", { data: "你" }); await new Promise((r) => setTimeout(r, 400));
    // M-3265: grown back by a bar's height only once typing has stopped (2 s), not per character (web-typing-steady-m3265).
    expect([kb(), ...vars()], "the next character's bar may come: nothing yet").toEqual([true, "436px", null]);
    await new Promise((r) => setTimeout(r, 1700));
    expect([kb(), ...vars()]).toEqual([true, "480px", null]);
  });

  // #4011 review: one reading as tall as no keyboard, while the field keeps focus, is on hold — the shell keeps the height it
  // had until the hold says the keyboard really went (else the box drops under a keyboard that is still there).
  it("typing: a one-off full-height reading keeps the shell's height until the hold ends", async () => {
    const { vv, vars, kb, focus } = await phone();
    await focus();
    vv.height = 480; vv.offsetTop = 0; vv.emit("resize"); await settle();
    await new Promise((r) => setTimeout(r, 900));                         // past the focus follow window
    vv.height = 844; vv.emit("resize"); await settle();
    expect([kb(), ...vars()], "held").toEqual([true, "480px", null]);
    vv.height = 480; vv.emit("resize"); await settle();                    // the keyboard was there all along
    expect([kb(), ...vars()]).toEqual([true, "480px", null]);
  });

  // M-3327 (the user's recording): iOS reports the taller view only once the keyboard has gone (~350 ms). Following the view
  // held the box mid-air over a black band, then dropped it in one frame. Leaving the field, the shell takes its full height
  // (the tallest view) at once, easing down (data-kb-closing) as the keyboard slides away over it.
  it("down: leaving the field, the shell takes its full height at once (easing: data-kb-closing), then its stylesheet's", async () => {
    const { vv, vars, kb, focus, blur, frames, closing } = await phone();
    await focus();
    vv.height = 480; vv.offsetTop = 0; vv.emit("resize"); await settle();
    await new Promise((r) => setTimeout(r, 900));                         // settled
    expect(closing()).toBe(false);
    await blur();                                                          // the keyboard falls; the view still says 480
    expect([kb(), ...vars(), closing()]).toEqual([false, "844px", null, true]);
    vv.height = 660; await frames();                                       // the view grows late: nothing moves
    expect([...vars(), closing()]).toEqual(["844px", null, true]);
    vv.height = 844; vv.emit("resize"); await frames();
    expect([...vars(), closing()], "the ease runs its own time, whenever the reading comes").toEqual(["844px", null, true]);
    await new Promise((r) => setTimeout(r, 900));                         // settled: the stylesheet's height again
    expect([...vars(), closing()]).toEqual([null, null, false]);
  });
  it("M-3327: a tap on a box that already had the focus (no focus event): a keyboard-sized pan is undone at once, not held", async () => {
    const { vv, vars, focus, scrolls } = await phone();
    await focus();
    await new Promise((r) => setTimeout(r, 900));                         // focused, no keyboard, past the follow window
    vv.offsetTop = 380; vv.emit("scroll"); await settle();                 // iOS pans to show the box as its keyboard rises
    expect([scrolls.length, vv.offsetTop, ...vars()]).toEqual([1, 0, "844px", null]);
  });
  it("M-3327: focus going from the box to another text field is not the keyboard going away", async () => {
    const { pg, vv, vars, kb, focus, frames, closing } = await phone();
    await focus();
    vv.height = 480; vv.emit("resize"); await settle();
    const box = pg.root.querySelector("#box") as any, other = pg.root.querySelector("#box2") as any;
    box.blur(); fire(box, "focusout", { relatedTarget: other }); other.focus(); fire(other, "focusin"); await frames();
    expect([kb(), ...vars(), closing()]).toEqual([true, "480px", null, false]);
  });

  it("follows the keyboard as it rises: a view that changes with no resize event is picked up on the next frames", async () => {
    const { vv, vars, focus, frames } = await phone();
    await focus();
    vv.height = 700; await frames();                                       // mid-animation, before it counts as a keyboard: followed
    expect(vars()).toEqual(["700px", null]);
    vv.height = 520; vv.offsetTop = 260; await frames();                    // the keyboard's height reached: up, fitted, no event
    expect([...vars(), vv.offsetTop]).toEqual(["520px", null, 0]);          // M-3327: the pan undone, not followed
    vv.height = 480; vv.offsetTop = 300; await frames();
    expect([...vars(), vv.offsetTop]).toEqual(["480px", null, 0]);
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

// M-3327 (the user: "sometimes it stalls, sometimes it doesn't"): what iOS does first varies — the pan or the shorter view on
// the way up; the focusout or the late taller view on the way down. The result must not depend on that order: no transform
// ever, the pan undone, the full height at the focusout (eased only while the view still says keyboard), never held.
describe("M-3327: the keyboard's events in either order", () => {
  async function watched() {
    const t = await phone();
    const shell = t.pg.root.querySelector(".shell") as any, st = shell.style, set = st.setProperty.bind(st);
    const transforms: string[] = [];
    st.setProperty = (k: string, v: string) => { if (k === "transform") transforms.push(v); set(k, v); };
    const blurTo = async () => { const el = t.pg.root.querySelector("#box") as any; el.blur(); fire(el, "focusout", { relatedTarget: null }); };
    return { ...t, transforms, blurTo };
  }
  it.each([["the pan first, then the shorter view", true], ["the shorter view first, then the pan", false]])("open — %s: the view's height at the top, the pan undone, no transform", async (_n, panFirst) => {
    const t = await watched();
    await t.focus();
    const pan = () => { t.vv.offsetTop = 380; t.vv.emit("scroll"); }, shorter = () => { t.vv.height = 480; t.vv.emit("resize"); };
    if (panFirst) { pan(); await t.frames(1); shorter(); } else { shorter(); await t.frames(1); pan(); }
    await t.frames();
    expect([t.kb(), ...t.vars(), t.vv.offsetTop, t.scrolls.length, t.transforms]).toEqual([true, "480px", null, 0, 1, []]);
  });
  it.each([["focusout first, the taller view 350 ms later (iOS)", 350], ["focusout first, the taller view 100 ms later", 100]])("close — %s: the full height at the focusout, eased to the end", async (_n, late) => {
    const t = await watched();
    await t.focus();
    t.vv.height = 480; t.vv.emit("resize"); await new Promise((r) => setTimeout(r, 900));
    await t.blurTo(); await t.frames(1);
    expect([t.kb(), ...t.vars(), t.closing()], "at the focusout").toEqual([false, "844px", null, true]);
    await new Promise((r) => setTimeout(r, late));
    t.vv.height = 844; t.vv.emit("resize"); await t.frames(1);
    expect(t.vars()[0]).toBe("844px");
    if (late < 300) expect(t.closing(), "the ease is not cut short by an early reading").toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(t.closing()).toBe(false);
    expect(t.transforms).toEqual([]);
  });
  it("close — the taller view first, focusout 50 ms later: the full height at the focusout (not held 300 ms), not eased", async () => {
    const t = await watched();
    await t.focus();
    t.vv.height = 480; t.vv.emit("resize"); await new Promise((r) => setTimeout(r, 900));
    t.vv.height = 844; t.vv.emit("resize"); await t.frames(1);
    expect(t.vars()[0], "still focused: a full-height reading is held (beta.4: a key can say that)").toBe("480px");
    await new Promise((r) => setTimeout(r, 30));
    await t.blurTo(); await t.frames(1);
    expect([t.kb(), ...t.vars(), t.closing(), t.transforms]).toEqual([false, "844px", null, false, []]);
  });
});
