/**
 * M-3356 (the user, beta.13, iPhone, 注音): typing Chinese flickers, English doesn't. Argon's frame-by-frame read of the
 * recording: the page never moves (0.00 px); what flickers is iOS's candidate bar, blanked on every composition key and
 * commit. A WebKit capture can't draw iOS's own bar, so this pins what the page does while an IME composes:
 * - the Fleet chat's real composer (panel-chat.js) with the app's document listeners (text-undo.js, chat-quote.js): from
 *   compositionstart to the last key before compositionend, nothing reads the box's selection (selectionStart/End,
 *   document.getSelection) and nothing writes its style;
 * - the shell's keyboard fit (app-shell.js, M-3327/#4171) under the recorded conditions (the view does not change while
 *   composing): no style write on the shell, no scrollTo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fire, settle } from "./helpers/mini-dom.js";
import type { AppPage } from "./helpers/app-harness.js";

function fakeStream() {
  const subs = new Map<string, Array<(d: any) => void>>();
  return { on(n: string, fn: (d: any) => void) { subs.set(n, [...(subs.get(n) ?? []), fn]); return () => {}; }, emit(n: string, d: any) { for (const fn of subs.get(n) ?? []) fn(d); } };
}
const pages: AppPage[] = [];
const offs: Array<() => void> = [];
afterEach(async () => { for (const f of offs.splice(0)) f(); for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } });

/** The Fleet chat on a phone, with the app's text-undo listener (app.js installs it) and the box instrumented. */
async function chat() {
  vi.resetModules();
  const harness = await import("./helpers/app-harness.js");
  const p = harness.page({ storage: { agend_tour_done: "1" } });
  pages.push(p);
  (globalThis as any).matchMedia = (q: string) => ({ matches: /pointer:\s*coarse/.test(q) && !/max-height/.test(q), addEventListener() {}, removeEventListener() {} });
  const app = await import("/assets/app-store.js" as string);
  const panel = await import("/ui/js/panel-chat.js" as string);
  const undo = await import("/assets/text-undo.js" as string);
  offs.push(undo.installTextUndo({ doc: (globalThis as any).document, mac: false }) || (() => {}));
  const fetch = async (path: string) => ({ ok: true, status: 200, json: async () => (path.startsWith("/ui/history") ? { messages: [] } : {}) });
  const stream = fakeStream();
  stream.on("status", app.applyStatus);
  panel.boot({ stream, boot: null, deps: { fetch, toast() {}, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) } });
  stream.emit("status", { uptime: 1, instances: [{ name: "fleet-lead", status: "running", state: "idle", backend: "claude-code" }] });
  await p.mount(harness.h("main", { id: "main" }, harness.h(panel.ChatPanel, { route: { panel: "chat", instance: "fleet-lead" }, navKey: "chat|w" })));
  await settle();
  const box = p.root.querySelector("#msgIn") as any;
  box.focus(); fire(box, "focusin");
  // Count what touches the box while a composition is open.
  let composing = false, committing = false;
  const touched: string[] = [], atCommit: string[] = [];
  let start = 0, end = 0;
  Object.defineProperty(box, "selectionStart", { configurable: true, get() { if (composing) touched.push("selectionStart"); return start; }, set(v) { start = v; } });
  Object.defineProperty(box, "selectionEnd", { configurable: true, get() { if (composing) touched.push("selectionEnd"); return end; }, set(v) { end = v; } });
  const doc = (globalThis as any).document;
  const realSel = doc.getSelection;
  doc.getSelection = (...a: unknown[]) => { if (composing) touched.push("getSelection"); return realSel ? realSel.apply(doc, a) : null; };
  offs.push(() => { doc.getSelection = realSel; });
  const st = box.style, setP = st.setProperty?.bind(st);
  if (setP) st.setProperty = (k: string, v: string) => { if (composing) touched.push(`style.${k}`); if (committing) atCommit.push(`style.${k}=${v}`); return setP(k, v); };
  const wrapStyle = (k: string) => { let val = st[k]; Object.defineProperty(st, k, { configurable: true, get: () => val, set: (v) => { if (composing) touched.push(`style.${k}`); if (committing) atCommit.push(`style.${k}=${v}`); val = v; } }); };
  wrapStyle("height");
  /** One 注音 character, as iOS sends it: compositionstart, then each key (input + keyup, a selectionchange), then the commit. */
  const character = async (keys: string[], chosen: string) => {
    const before = box.value;
    composing = true;
    fire(box, "compositionstart", { data: "" });
    for (const k of keys) {
      box.value = before + k; start = end = box.value.length;
      fire(box, "compositionupdate", { data: k });
      fire(box, "input", { isComposing: true, inputType: "insertCompositionText", data: k });
      fire(box, "keyup", { key: "Unidentified", keyCode: 229, isComposing: true });
      fire(doc, "selectionchange");
      await new Promise((r) => setTimeout(r, 140));                    // past chat-quote's 120 ms selectionchange timer
    }
    box.value = before + chosen; start = end = box.value.length;
    composing = false; committing = true;                               // the commit itself is where the box takes the text
    fire(box, "compositionend", { data: chosen });
    fire(box, "input", { isComposing: false, inputType: "insertFromComposition", data: chosen });
    await settle(4);
    committing = false;
  };
  return { box, touched, atCommit, character };
}

describe("M-3356: while an IME composes, the page leaves the box alone (the candidate bar's cause, Argon)", () => {
  it("three 注音 characters: no selection read, no getSelection, no style write on the box between compositionstart and the commit", async () => {
    const c = await chat();
    await c.character(["ㄐ", "ㄐㄧ", "ㄐㄧㄢ", "ㄐㄧㄢˋ"], "鍵");
    await c.character(["ㄆ", "ㄆㄢ", "ㄆㄢˊ"], "盤");
    await c.character(["ㄏ", "ㄏㄠ", "ㄏㄠˇ"], "好");
    expect(c.touched, c.touched.join(" ")).toEqual([]);
    expect(c.box.value).toBe("鍵盤好");
    // Argon's third suspect (the first commit collapsing the box's height): the text fits one line, so no write at all.
    expect(c.atCommit, "a commit that fits writes no height").toEqual([]);
  });
});

describe("M-3356: the shell's keyboard fit under the recorded conditions (the view does not change while composing)", () => {
  it("composing on a settled keyboard: no style write on the shell and no scrollTo — the pan logic is inert", async () => {
    vi.resetModules();
    const { h, page } = await import("./helpers/app-harness.js");
    const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1" }, matchNarrow: true });
    pages.push(pg);
    (globalThis as any).matchMedia = (q: string) => ({ matches: /max-width/.test(q) || /pointer:\s*coarse/.test(q), addEventListener() {}, removeEventListener() {} });
    const subs = new Map<string, Set<() => void>>();
    const vv: any = { width: 390, height: 844, offsetTop: 0, scale: 1, addEventListener(n: string, fn: () => void) { (subs.get(n) ?? subs.set(n, new Set()).get(n)!).add(fn); },
      removeEventListener(n: string, fn: () => void) { subs.get(n)?.delete(fn); }, emit(n: string) { for (const fn of [...(subs.get(n) ?? [])]) fn(); } };
    pg.window.visualViewport = vv; pg.window.innerHeight = 844;
    const scrolls: number[][] = []; pg.window.scrollTo = (x: number, y: number) => { scrolls.push([x, y]); };
    (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const { startRouter } = await import("/assets/app-nav.js" as string);
    const { applyStatus } = await import("/assets/app-store.js" as string);
    const { Shell, shellStore } = await import("/assets/app-shell.js" as string);
    shellStore.set({ keyboard: false });
    startRouter(pg.window);
    applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code" }] });
    const Stub = { Component: () => h("div", null, h("textarea", { id: "box" })) };
    await pg.mount(h(Shell, { panels: new Map([["chat", Stub], ["view", Stub], ["fleet", Stub], ["settings", Stub], ["needs", Stub]]), onNewInstance() {} }));
    await settle(3);
    const box = pg.root.querySelector("#box") as any, shell = pg.root.querySelector(".shell") as any;
    box.focus(); fire(box, "focusin"); await settle();
    vv.height = 480; vv.emit("resize"); await new Promise((r) => setTimeout(r, 900));   // the keyboard up, past the open
    const writes: string[] = [];
    const st = shell.style, setP = st.setProperty.bind(st), rmP = st.removeProperty.bind(st);
    st.setProperty = (k: string, v: string) => { if (st[k] !== v) writes.push(`${k}=${v}`); setP(k, v); };
    st.removeProperty = (k: string) => { if (st[k]) writes.push(`${k}=∅`); return rmP(k); };
    const before = scrolls.length;
    for (const keys of [["ㄐ", "ㄐㄧ", "ㄐㄧㄢˋ"], ["ㄆ", "ㄆㄢˊ"]]) {
      fire(box, "compositionstart", { data: "" });
      for (const k of keys) { box.value = k; fire(box, "input", { isComposing: true, data: k }); await new Promise((r) => setTimeout(r, 120)); }
      fire(box, "compositionend", { data: "字" }); await new Promise((r) => setTimeout(r, 120));
    }
    expect([writes, scrolls.length - before]).toEqual([[], 0]);
  });
});
