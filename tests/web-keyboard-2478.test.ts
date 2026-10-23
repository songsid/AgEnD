/**
 * #2478 item 4 (the user's report, beta.26 on iOS Safari): with the on-screen keyboard up, the bottom tabs and the line
 * under the composer stayed between the box and the keyboard (~210 px). The shell now knows the keyboard is up when a
 * text field has focus and the visual viewport is well short of the tallest it has been at this width — not from
 * innerHeight, which shrinks with it under interactive-widget=resizes-content. Back on blur.
 * Mounted with the real Shell (tests/helpers/app-harness.ts), a fake visualViewport, stub panels.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } });

function fakeViewport(width: number, height: number) {
  const subs = new Set<() => void>();
  return {
    width, height,
    addEventListener(_n: string, fn: () => void) { subs.add(fn); }, removeEventListener(_n: string, fn: () => void) { subs.delete(fn); },
    resize(o: { width?: number; height: number }) { if (o.width) this.width = o.width; this.height = o.height; for (const fn of [...subs]) fn(); },
  };
}
const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }, h("textarea", { id: "box" }), h("input", { type: "checkbox", id: "tick" })) });
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
  const shell = () => pg.root.querySelector(".shell") as any;
  const kb = () => shell().classList.contains("kb-open");
  const focus = async (sel: string) => { const el = pg.root.querySelector(sel) as any; el.focus(); fire(el, "focusin"); await settle(); };
  const blur = async (sel: string) => { const el = pg.root.querySelector(sel) as any; el.blur(); fire(el, "focusout"); await settle(); };
  const resize = async (o: { width?: number; height: number; inner?: number }) => { if (o.inner) pg.window.innerHeight = o.inner; vv.resize(o); await settle(); };
  return { pg, vv, kb, focus, blur, resize };
}

describe("#2478: the keyboard is up (pure)", () => {
  it("keyboardUp: typing, and the view more than 150 px short of its tallest", async () => {
    const { keyboardUp, KEYBOARD_MIN_PX } = await import("/assets/app-shell.js");
    expect(KEYBOARD_MIN_PX).toBe(150);
    expect([keyboardUp(500, 844, true), keyboardUp(700, 844, true), keyboardUp(500, 844, false), keyboardUp(844, 844, true)]).toEqual([true, false, false, false]);
  });
  it("isTextEntry: a textarea or a text-like input that can be typed into, or an editable region", async () => {
    const { isTextEntry } = await import("/assets/app-shell.js");
    const el = (tagName: string, o: Record<string, unknown> = {}) => ({ tagName, ...o });
    expect([el("TEXTAREA"), el("INPUT"), el("INPUT", { type: "search" }), el("INPUT", { type: "email" }), el("DIV", { isContentEditable: true })].map(isTextEntry)).toEqual([true, true, true, true, true]);
    expect([el("INPUT", { type: "checkbox" }), el("INPUT", { type: "button" }), el("TEXTAREA", { readOnly: true }), el("INPUT", { disabled: true }), el("BUTTON"), el("DIV"), null].map(isTextEntry)).toEqual([false, false, false, false, false, false, false]);
  });
});

describe("#2478: the shell on a phone (real Shell, fake visualViewport)", () => {
  it("innerHeight stays, the visual viewport shrinks — kb-open while typing; back at once on blur", async () => {
    const p = await phone();
    expect(p.kb()).toBe(false);
    await p.focus("#box");
    await p.resize({ height: 480 });
    expect(p.kb(), "typing, the view 364 px short").toBe(true);
    await p.blur("#box");
    expect(p.kb(), "blurred: back at once, before the view grows").toBe(false);
    await p.resize({ height: 844 });
    expect(p.kb()).toBe(false);
  });

  it("innerHeight shrinks with the view (iOS Safari; Android under resizes-content) — still the keyboard: the old innerHeight − height test saw 0, the strips stayed", async () => {
    const p = await phone();
    await p.focus("#box");
    await p.resize({ height: 480, inner: 480 });
    expect(p.kb()).toBe(true);
    await p.blur("#box");
    await p.resize({ height: 844, inner: 844 });
    expect(p.kb()).toBe(false);
  });

  it("not the keyboard: a browser bar (64 px), the view shrinking with nothing typed in, a checkbox focused", async () => {
    const p = await phone();
    await p.focus("#box");
    await p.resize({ height: 780 });
    expect(p.kb(), "a browser bar").toBe(false);
    await p.blur("#box");
    await p.resize({ height: 480 });
    expect(p.kb(), "nothing typed in").toBe(false);
    await p.focus("#tick");
    expect(p.kb(), "a checkbox has no keyboard").toBe(false);
  });

  it("turned: a new width is measured again — landscape's shorter view is not a keyboard", async () => {
    const p = await phone();
    await p.resize({ width: 844, height: 390, inner: 390 });
    await p.focus("#box");
    expect(p.kb()).toBe(false);
    await p.resize({ height: 200, inner: 390 });
    expect(p.kb(), "the keyboard, in landscape").toBe(true);
  });

  it("Prism r1: turned with the keyboard up and the box still focused — the keyboard stays up (no tabs over the box)", async () => {
    const p = await phone();
    await p.focus("#box");
    await p.resize({ height: 508, inner: 508 });
    expect(p.kb()).toBe(true);
    await p.resize({ width: 844, height: 200, inner: 200 });                     // turned, the keyboard still up
    expect(p.kb(), "the new width has no height without the keyboard yet: held").toBe(true);
    await p.resize({ width: 390, height: 508, inner: 508 });                     // back, still typing
    expect(p.kb()).toBe(true);
    await p.blur("#box");
    expect(p.kb(), "left: back").toBe(false);
  });

  it("Prism r1: turned with the keyboard up, then the keyboard put away while still focused — the tabs come back", async () => {
    const p = await phone();
    await p.focus("#box");
    await p.resize({ height: 508, inner: 508 });
    await p.resize({ width: 844, height: 200, inner: 200 });
    expect(p.kb()).toBe(true);
    await p.resize({ height: 390, inner: 390 });                                 // grew by 190: the keyboard went
    expect(p.kb()).toBe(false);
    await p.resize({ height: 200, inner: 200 });                                 // and up again, measured from 390
    expect(p.kb()).toBe(true);
  });

  it("Prism r1: a desk (a fine pointer) has no on-screen keyboard — a narrow window made shorter while typing hides nothing", async () => {
    const p = await phone({ pointer: "fine" });
    await p.focus("#box");
    await p.resize({ height: 508, inner: 508 });
    expect(p.kb()).toBe(false);
    await p.resize({ height: 508 });
    expect(p.kb(), "visual viewport only (a pinch or a panel)").toBe(false);
  });

  it("the CSS: with the keyboard up the tabs and the line under the composer go (phone widths)", () => {
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const phoneBlock = css.slice(css.indexOf("@media (max-width: 899px)"));
    expect(phoneBlock).toMatch(/\.kb-open \.tabs\s*\{\s*display:\s*none/);
    expect(phoneBlock).toMatch(/\.kb-open \.composer-row\s*\{\s*display:\s*none/);
  });
});

// The user's report (beta.27, iOS Safari, Zhuyin): the IME's candidate bar moves the view by tens of px on every
// keystroke. The keyboard state is hysteretic — up once, it stays up while the field keeps focus, unless the view grows
// back by more than a keyboard — and nothing changes while an IME composes (applied at compositionend).
describe("IME: a candidate bar never takes the tabs out and back", () => {
  it("a compact keyboard (120 px) whose candidate bar (44 px) crosses the threshold: up once, it stays up on every keystroke; blur takes it down", async () => {
    const c = await phone();
    await c.focus("#box");
    await c.resize({ height: 844 - 120 });
    expect(c.kb(), "120 px: no keyboard yet").toBe(false);
    await c.resize({ height: 844 - 164 });
    expect(c.kb(), "the bar: past the threshold").toBe(true);
    for (const h of [844 - 120, 844 - 164, 844 - 120, 844 - 164]) { await c.resize({ height: h }); expect(c.kb(), `at ${h}`).toBe(true); }
    await c.blur("#box");
    expect(c.kb()).toBe(false);
  });
  it("put away while focused (the view back by more than a keyboard from its lowest): down", async () => {
    const c = await phone();
    await c.focus("#box");
    await c.resize({ height: 500 });
    expect(c.kb()).toBe(true);
    await c.resize({ height: 844 });
    expect(c.kb()).toBe(false);
  });
  it("while an IME composes nothing changes; compositionend applies what the view says", async () => {
    const c = await phone();
    await c.focus("#box");
    const box = c.pg.root.querySelector("#box") as any;
    fire(box, "compositionstart", { data: "" });
    await c.resize({ height: 500 });
    expect(c.kb(), "composing: held").toBe(false);
    fire(box, "compositionend", { data: "寶" }); await settle();
    expect(c.kb(), "after compositionend").toBe(true);
  });
  it("#2517 review: a composition that ends without compositionend (the field left) holds nothing after — focus and the view are heard again", async () => {
    const c = await phone();
    await c.focus("#box");
    const box = c.pg.root.querySelector("#box") as any;
    await c.resize({ height: 500 });
    expect(c.kb()).toBe(true);
    fire(box, "compositionstart", { data: "" });
    await c.blur("#box");                                                          // no compositionend
    await c.resize({ height: 844 });
    expect(c.kb(), "left the field: down").toBe(false);
    await c.focus("#box");
    await c.resize({ height: 500 });
    expect(c.kb(), "back in it: up again").toBe(true);
  });
  it("#2517 review: the composing field removed from the page holds nothing after", async () => {
    const c = await phone();
    await c.focus("#box");
    const box = c.pg.root.querySelector("#box") as any;
    fire(box, "compositionstart", { data: "" });
    box.remove();
    await c.focus("#tick");
    await c.resize({ height: 500 });
    expect(c.kb(), "a checkbox focused, the composing box gone: not typing").toBe(false);
  });
});
