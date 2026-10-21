/**
 * #2342: undo and redo in every text field — one history per field (the browser's is one stack for the whole page, and
 * any script write wipes it). The shared module (src/ui/shared/text-undo.js) on the mini DOM: typing grouped into steps,
 * each field its own history, a script's change a step only when recordEdit marked it (else the history resets — a sent
 * message is never undone back into the box), IME compositions, which keys are taken and where; and the typed-text hook
 * the trimming fields use, through the bot-token field and a number field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { MiniEvent, fire } from "./helpers/mini-dom.js";
// @ts-expect-error — a JS module of the app, with no types
import { UNDO, historyKey, historyOf, installTextUndo, isTextField, recordEdit, step } from "../src/ui/shared/text-undo.js";

const mounted: AppPage[] = [];
let uninstall: (() => void) | null = null;
let now = 1_000_000;
beforeEach(() => { now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (uninstall) { uninstall(); uninstall = null; }
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
});

const win = { Event: MiniEvent };
/** A page with the history installed and `n` fields (textareas unless `tag`/`type` say otherwise). */
function setup(fields: Array<{ tag?: string; type?: string }> = [{}]) {
  const pg = page(); mounted.push(pg);
  const els = fields.map(({ tag = "textarea", type }) => {
    const el = pg.document.createElement(tag) as any;
    if (type) el.setAttribute("type", type);
    el.selectionStart = 0; el.selectionEnd = 0;
    el.setSelectionRange = function (s: number, e: number) { this.selectionStart = s; this.selectionEnd = e; };
    pg.root.appendChild(el);
    return el;
  });
  uninstall = installTextUndo({ doc: pg.document, win, mac: false });
  return { pg, els };
}
/** Type `text` at the caret, as a person does: beforeinput, the edit, input — one key at a time. */
function type(el: any, text: string, gap = 50) {
  for (const ch of text) {
    fire(el, "beforeinput", { inputType: "insertText", data: ch, isComposing: false });
    const s = el.selectionStart, e = el.selectionEnd;
    el.value = el.value.slice(0, s) + ch + el.value.slice(e);
    el.selectionStart = el.selectionEnd = s + 1;
    fire(el, "input", { inputType: "insertText", data: ch });
    now += gap;
  }
}
function backspace(el: any, n = 1) {
  for (let i = 0; i < n; i++) {
    fire(el, "beforeinput", { inputType: "deleteContentBackward", isComposing: false });
    const s = el.selectionStart;
    el.value = el.value.slice(0, s - 1) + el.value.slice(s);
    el.selectionStart = el.selectionEnd = s - 1;
    fire(el, "input", { inputType: "deleteContentBackward" });
    now += 50;
  }
}
/** A script's write (a Preact re-render, a clear): no events, as a browser does not fire one. */
const write = (el: any, v: string) => { el.value = v; el.selectionStart = el.selectionEnd = v.length; };
const key = (el: any, k: string, mods: Record<string, boolean> = {}) => fire(el, "keydown", { key: k, cancelable: true, ...mods });
const undo = (el: any) => key(el, "z", { ctrlKey: true });
const redo = (el: any) => key(el, "z", { ctrlKey: true, shiftKey: true });

describe("typing is grouped into steps", () => {
  it("a word is one step; a space ends it: undo goes back word by word, redo forward", () => {
    const { els: [a] } = setup();
    type(a, "hello world");
    const values: string[] = [];
    undo(a); values.push(a.value); undo(a); values.push(a.value); undo(a); values.push(a.value);
    redo(a); values.push(a.value); redo(a); values.push(a.value);
    expect(values).toEqual(["hello ", "", "", "hello ", "hello world"]);
  });
  it("a pause of UNDO.PAUSE_MS starts a new step; a shorter one does not", () => {
    const { els: [a] } = setup();
    type(a, "ab"); now += UNDO.PAUSE_MS - 100; type(a, "cd"); now += UNDO.PAUSE_MS; type(a, "ef");
    undo(a); const one = a.value; undo(a);
    expect([one, a.value]).toEqual(["abcd", ""]);
  });
  it("typing and deleting are separate steps; so is a caret moved elsewhere", () => {
    const { els: [a] } = setup();
    type(a, "abcd"); backspace(a, 2);
    a.selectionStart = a.selectionEnd = 0; type(a, "X");
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) { undo(a); seen.push(a.value); }
    expect(seen).toEqual(["ab", "abcd", ""]);
  });
  it("typing somewhere else in the box (the caret moved, same kind of edit) is a new step", () => {
    const { els: [a] } = setup();
    type(a, "ab");
    a.selectionStart = a.selectionEnd = 0; type(a, "X");
    undo(a);
    expect(a.value).toBe("ab");
  });
  it("a paste is a step of its own", () => {
    const { els: [a] } = setup();
    type(a, "ab");
    fire(a, "beforeinput", { inputType: "insertFromPaste", isComposing: false });
    write(a, "ab pasted"); fire(a, "input", { inputType: "insertFromPaste" });
    undo(a);
    expect(a.value).toBe("ab");
  });
  it("at most UNDO.MAX_STEPS steps are kept (the oldest go)", () => {
    const { els: [a] } = setup();
    for (let i = 0; i < UNDO.MAX_STEPS + 5; i++) { type(a, "x"); now += UNDO.PAUSE_MS; }
    expect(historyOf(a).undo.length).toBe(UNDO.MAX_STEPS);
  });
});

describe("one history per field", () => {
  it("Ctrl+Z in A undoes A's typing, never B's (the browser's own stack is the page's)", () => {
    const { els: [a, b] } = setup([{}, { tag: "input" }]);
    type(a, "aaa"); type(b, "bbb");
    undo(a);
    expect([a.value, b.value]).toEqual(["", "bbb"]);
  });
  it("undo writes the value and the caret back and tells the page (input, historyUndo/historyRedo)", () => {
    const { els: [a] } = setup();
    const heard: string[] = [];
    a.addEventListener("input", (e: any) => heard.push(e.inputType ?? e.type));
    type(a, "ab");
    heard.length = 0;
    undo(a); const caret = [a.selectionStart, a.selectionEnd];
    redo(a);
    expect([caret, a.value, heard.length]).toEqual([[0, 0], "ab", 2]);
  });
});

describe("a script's change", () => {
  it("marked by recordEdit: a step — undo goes back to the text before it, redo brings it again", () => {
    const { els: [a] } = setup();
    type(a, "/he");
    recordEdit(a); write(a, "/help ");
    undo(a); const back = a.value; redo(a);
    expect([back, a.value]).toEqual(["/he", "/help "]);
  });
  it("marked, then typing on: the change and the typing are two steps", () => {
    const { els: [a] } = setup();
    type(a, "/he"); recordEdit(a); write(a, "/help "); now += 50; type(a, "me");
    undo(a); const one = a.value; undo(a);
    expect([one, a.value]).toEqual(["/help ", "/he"]);
  });
  it("not marked (a clear after send, a reload after save): the field's history is reset — nothing to undo", () => {
    const { els: [a] } = setup();
    type(a, "the message");
    write(a, "");
    const e = undo(a);
    expect([a.value, e.defaultPrevented, historyOf(a).undo]).toEqual(["", true, []]);
  });
  it("a mark with no change after it is dropped at the next edit (a later unmarked change still resets)", () => {
    const { els: [a] } = setup();
    type(a, "ab"); recordEdit(a); now += UNDO.PAUSE_MS; type(a, "c");
    write(a, "");
    undo(a);
    expect([a.value, historyOf(a).undo]).toEqual(["", []]);
  });
});

describe("IME composition", () => {
  it("one step for the whole composition; nothing recorded or taken mid-composition", () => {
    const { els: [a] } = setup();
    type(a, "ab "); now += UNDO.PAUSE_MS;
    fire(a, "compositionstart", {});
    for (const v of ["ab n", "ab ni", "ab 你"]) {
      fire(a, "beforeinput", { inputType: "insertCompositionText", isComposing: true });
      write(a, v); fire(a, "input", { inputType: "insertCompositionText", isComposing: true });
    }
    const mid = key(a, "z", { ctrlKey: true, isComposing: true });
    fire(a, "compositionend", {});
    // WebKit commits after compositionend: its beforeinput is part of the composition's step.
    fire(a, "beforeinput", { inputType: "insertFromComposition", isComposing: false });
    fire(a, "input", { inputType: "insertFromComposition" });
    undo(a);
    expect([mid.defaultPrevented, a.value]).toEqual([false, "ab "]);
  });
});

describe("the browser's own Undo and Redo (Edit menu, context menu)", () => {
  const native = (el: any, redo: boolean, cancelable = true) => fire(el, "beforeinput", { inputType: redo ? "historyRedo" : "historyUndo", cancelable, isComposing: false });
  it("cancelled and done by the field's history, mixed freely with the keys", () => {
    const { els: [a] } = setup();
    type(a, "alpha one");
    const seen: string[] = [];
    const e1 = native(a, false); seen.push(a.value);
    undo(a); seen.push(a.value);
    const e2 = native(a, true); seen.push(a.value);
    key(a, "y", { ctrlKey: true }); seen.push(a.value);
    undo(a); seen.push(a.value);
    expect([e1.defaultPrevented, e2.defaultPrevented, seen]).toEqual([true, true, ["alpha ", "", "alpha ", "alpha one", "alpha "]]);
  });
  it("where the browser cannot cancel it, its own undo goes ahead and resets the history (never a step undoing the undo)", () => {
    const { els: [a] } = setup();
    type(a, "alpha one");
    const e = native(a, false, false);
    write(a, ""); fire(a, "input", { inputType: "historyUndo" });       // what the browser's undo did
    undo(a);
    expect([e.defaultPrevented, a.value, historyOf(a).undo]).toEqual([false, "", []]);
  });
});

describe("the browser's own undo with no beforeinput (a script's execCommand(\"undo\"))", () => {
  for (const kind of ["historyUndo", "historyRedo"]) it(`an input of ${kind} alone: the history starts afresh`, () => {
    const { els: [a] } = setup();
    type(a, "alpha one");
    write(a, kind === "historyUndo" ? "alpha " : "alpha one!"); fire(a, "input", { inputType: kind });
    const before = a.value;
    const e = undo(a);
    expect([e.defaultPrevented, a.value, historyOf(a).undo, historyOf(a).redo]).toEqual([true, before, [], []]);
  });
});

describe("the keys mid-composition", () => {
  it("a browser that does not flag its composition events: still one step, and the history is not reset", () => {
    const { els: [a] } = setup();
    type(a, "ab "); now += UNDO.PAUSE_MS;
    fire(a, "compositionstart", {});
    for (const v of ["ab n", "ab 你"]) {
      fire(a, "beforeinput", { inputType: "insertText", data: v.slice(-1), isComposing: false });
      write(a, v); fire(a, "input", { inputType: "insertText" });
    }
    fire(a, "compositionend", {});
    undo(a); const one = a.value; undo(a);
    expect([one, a.value]).toEqual(["ab ", ""]);
  });
  it("between compositionstart and compositionend the keys are the IME's, even on a keydown not flagged isComposing", () => {
    const { els: [a] } = setup();
    type(a, "ab");
    fire(a, "compositionstart", {});
    const e = undo(a);
    fire(a, "compositionend", {});
    expect([e.defaultPrevented, a.value]).toEqual([false, "ab"]);
  });
});

describe("the keys", () => {
  it("which key is undo and which redo, on a Mac and elsewhere", () => {
    const k = (mods: Record<string, unknown>, mac: boolean) => historyKey({ key: "z", ...mods }, mac);
    expect([
      k({ ctrlKey: true }, false), k({ ctrlKey: true, shiftKey: true }, false), historyKey({ key: "y", ctrlKey: true }, false), historyKey({ key: "Z", ctrlKey: true, shiftKey: true }, false),
      k({ metaKey: true }, false), k({ ctrlKey: true, altKey: true }, false), k({ ctrlKey: true, metaKey: true }, false), k({ ctrlKey: true, isComposing: true }, false),
      k({ ctrlKey: true, keyCode: 229 }, false), historyKey({ key: "y", ctrlKey: true, shiftKey: true }, false), historyKey({ key: "x", ctrlKey: true }, false),
      k({ metaKey: true }, true), k({ metaKey: true, shiftKey: true }, true), k({ ctrlKey: true }, true), historyKey({ key: "y", metaKey: true }, true), historyKey({ key: "y", ctrlKey: true }, true),
    ]).toEqual(["undo", "redo", "redo", "redo", null, null, null, null, null, null, null, "undo", "redo", null, null, null]);
  });
  it("Ctrl+Y redoes off a Mac; on a Mac ⌘Z and ⌘⇧Z", () => {
    const { pg, els: [a] } = setup();
    type(a, "ab"); undo(a); key(a, "y", { ctrlKey: true });
    const off = a.value;
    uninstall!(); uninstall = installTextUndo({ doc: pg.document, win, mac: true });
    key(a, "z", { metaKey: true }); const macUndo = a.value; key(a, "z", { metaKey: true, shiftKey: true });
    expect([off, macUndo, a.value]).toEqual(["ab", "", "ab"]);
  });
  it("taken only in a text field: not on a button, a select or a password field (the browser's own there)", () => {
    const { els: [btn, sel, pw, ro] } = setup([{ tag: "button" }, { tag: "select" }, { tag: "input", type: "password" }, { tag: "input" }]);
    ro.readOnly = true;
    expect([undo(btn).defaultPrevented, undo(sel).defaultPrevented, undo(pw).defaultPrevented, undo(ro).defaultPrevented]).toEqual([false, false, false, false]);
    expect([isTextField(pw), isTextField(ro), recordEdit(pw), historyOf(pw)]).toEqual([false, false, undefined, null]);
  });
  it("in a field with nothing to undo the key is still taken (never the page-wide stack's step from another box)", () => {
    const { els: [a, b] } = setup([{}, {}]);
    type(b, "bbb");
    const e = undo(a);
    expect([e.defaultPrevented, step(a, false, win), b.value]).toEqual([true, false, "bbb"]);
  });
  it("text-like inputs count, a number one too (no caret there)", () => {
    const { els } = setup([{ tag: "input" }, { tag: "input", type: "search" }, { tag: "input", type: "url" }, { tag: "input", type: "number" }, { tag: "input", type: "checkbox" }]);
    expect(els.map((e: any) => isTextField(e))).toEqual([true, true, true, true, false]);
    const n = els[3];
    n.setSelectionRange = () => { throw new Error("not on a number input"); };
    delete n.selectionStart; delete n.selectionEnd;
    for (const ch of "12") { fire(n, "beforeinput", { inputType: "insertText", data: ch, isComposing: false }); n.value += ch; fire(n, "input", {}); now += 50; }
    undo(n);
    expect(n.value).toBe("");
  });
  it("uninstalled: nothing is taken", () => {
    const { els: [a] } = setup();
    type(a, "ab");
    uninstall!(); uninstall = null;
    expect([undo(a).defaultPrevented, a.value]).toEqual([false, "ab"]);
  });
});

describe("useTypedText: the trimming fields keep what was typed", () => {
  it("the bot-token field: a space stays in the box (no rewrite), the parent gets the token trimmed; a clear empties the box", async () => {
    const pg = page(); mounted.push(pg);
    const { TokenField } = await import("/ui/js/settings-token.js");
    const { useState } = await import("/assets/app-html.js");
    let setOuter: (v: string) => void = () => {};
    const got: string[] = [];
    function Parent() {
      const [v, setV] = useState("");
      setOuter = setV;
      return h(TokenField, { id: "tok", platform: "telegram", value: v, onInput: (x: string) => { got.push(x); setV(x); }, identity: null, busy: false, onVerify() {} });
    }
    await pg.mount(h(Parent, {}));
    const input = () => pg.root.querySelector("#tok") as any;
    const seen: string[] = [];
    for (const v of ["1", "12", "12 ", "12 3"]) { input().value = v; fire(input(), "input", {}); await settle(); seen.push(input().value); }
    setOuter(""); await settle();
    expect([got, seen, input().value]).toEqual([["1", "12", "12", "12 3"], ["1", "12", "12 ", "12 3"], ""]);
  });
  it("a number field: \"1.50\" and \"01\" stay as typed, the owner gets the number; the owner's own change shows", async () => {
    const pg = page(); mounted.push(pg);
    const { useTypedText } = await import("/assets/text-undo.js");
    const { useState } = await import("/assets/app-html.js");
    let setOuter: (v: number | null) => void = () => {};
    const got: Array<number | null> = [];
    function Field() {
      const [hours, setHours] = useState(4 as number | null);
      setOuter = setHours;
      const [text, onText] = useTypedText(hours, (v: string) => (v.trim() === "" ? null : Number(v)));
      return h("input", { id: "n", value: text, onInput: (e: any) => { const n = onText(e.target.value); got.push(n); setHours(n); } });
    }
    await pg.mount(h(Field, {}));
    const input = () => pg.root.querySelector("#n") as any;
    const shown0 = input().value;
    const seen: string[] = [];
    for (const v of ["1", "1.", "1.5", "1.50", "01", ""]) { input().value = v; fire(input(), "input", {}); await settle(); seen.push(input().value); }
    setOuter(12); await settle();
    expect([shown0, seen, got, input().value]).toEqual(["4", ["1", "1.", "1.5", "1.50", "01", ""], [1, 1, 1.5, 1.5, 1, null], "12"]);
  });
});

// ── The composer (the real chat page) ──
describe("the composer's insert paths", () => {
  const pages: AppPage[] = [];
  let off: (() => void) | null = null;
  afterEach(async () => { if (off) { off(); off = null; } for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } });
  async function chat() {
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    const p = harness.page({ storage: { agend_tour_done: "1" } });
    pages.push(p);
    const app = await import("/assets/app-store.js" as string);
    const panel = await import("/ui/js/panel-chat.js" as string);
    const undoMod = await import("/assets/text-undo.js" as string);
    const sends: unknown[] = [];
    const fetch = async (path: string, o: { body?: string } = {}) => {
      if (path === "/ui/send") sends.push(JSON.parse(o.body ?? "{}"));
      return { ok: true, status: 200, json: async () => (path.startsWith("/ui/history") ? { messages: [] } : {}) };
    };
    const subs = new Map<string, Array<(d: any) => void>>();
    const stream = { on(n: string, fn: (d: any) => void) { subs.set(n, [...(subs.get(n) ?? []), fn]); return () => {}; } };
    stream.on("status", app.applyStatus);
    panel.boot({ stream, boot: null, deps: { fetch, toast() {}, setTimeout: () => 0 } });
    for (const fn of subs.get("status") ?? []) fn({ uptime: 1, instances: [{ name: "w", status: "running", state: "idle", backend: "claude-code" }] });
    off = undoMod.installTextUndo({ doc: p.document, win: { Event: MiniEvent }, mac: false });
    await p.mount(harness.h("main", { id: "main" }, harness.h(panel.ChatPanel, { route: { panel: "chat", instance: "w" }, navKey: "chat|w" })));
    await settle();
    const box = () => p.root.querySelector("#msgIn") as any;
    const typeIn = async (text: string) => { for (const ch of text) { fire(box(), "beforeinput", { inputType: "insertText", data: ch, isComposing: false }); box().value += ch; fire(box(), "input", {}); now += 50; } await settle(); };
    const press = async (k: string, init: Record<string, unknown> = {}) => { const e = fire(box(), "keydown", { key: k, cancelable: true, ...init }); await settle(); return e; };
    return { box, typeIn, press, sends };
  }
  it("Tab completes a command: Ctrl+Z goes back to what was typed, Ctrl+Shift+Z (and Ctrl+Y) to the completion", async () => {
    const c = await chat();
    await c.typeIn("/co");
    await c.press("Tab");
    const done = c.box().value;
    await c.press("z", { ctrlKey: true }); const back = c.box().value;
    await c.press("z", { ctrlKey: true, shiftKey: true }); const again = c.box().value;
    await c.press("z", { ctrlKey: true }); await c.press("y", { ctrlKey: true });
    expect([done, back, again, c.box().value]).toEqual(["/compact ", "/co", "/compact ", "/compact "]);
  });
  it("a command that needs its argument fills '/btw ': undoable back to '/btw'", async () => {
    const c = await chat();
    await c.typeIn("/btw"); now += UNDO.PAUSE_MS;
    await c.press("Escape");                                    // close the palette: Enter is the command line's
    await c.press("Enter");
    const filled = c.box().value;
    await c.press("z", { ctrlKey: true });
    expect([filled, c.box().value]).toEqual(["/btw ", "/btw"]);
  });
  it("a sent message is not undone back into the composer", async () => {
    const c = await chat();
    await c.typeIn("hello there");
    await c.press("Enter");
    const after = c.box().value;
    const e = await c.press("z", { ctrlKey: true });
    expect([c.sends.length, after, c.box().value, e.defaultPrevented]).toEqual([1, "", "", true]);
  });
});

// ── The other insert paths (the real modules) ──
describe("other text the page puts in a box is a step", () => {
  const pages: AppPage[] = [];
  let off: (() => void) | null = null;
  const g = globalThis as any;
  const realFetch = g.fetch;
  afterEach(async () => { if (off) { off(); off = null; } g.fetch = realFetch; for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } });
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  let H: typeof h = h;                                          // the harness's h, from the same Preact as the modules
  let posts: Array<{ url: string; body: any }> = [];
  async function at(url: string) {
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    const pg = harness.page({ url, storage: { agend_tour_done: "1" } }); pages.push(pg);
    H = harness.h;
    posts = [];
    g.fetch = async (u: string, init: any = {}) => {
      if (init.method === "POST") posts.push({ url: u, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
      return ok(u.startsWith("/api/profile/") && init.method !== "POST" ? { instance_name: "alpha", color: "#112233", color_show: null } : u === "/ui/prefs" ? { values: {}, rev: 1 } : { ok: true });
    };
    const undoMod = await import("/assets/text-undo.js" as string);
    off = undoMod.installTextUndo({ doc: pg.document, win: { Event: MiniEvent }, mac: false });
    return pg;
  }
  async function colourDialog() {
    const pg = await at("http://127.0.0.1:19280/ui/chat/alpha");
    const C = await import("/assets/identity-color.js" as string);
    await pg.mount(H(C.ColorDialogHost, {}));
    C.openColorDialog("alpha", { name: "alpha", status: "running", backend: "codex", tags: [], color: { auto: "auto:sea" }, color_show: {} });
    await settle(3);
    const d = () => pg.root.querySelector("dialog") as any;
    const hex = () => d().querySelector(".idc-hex");
    const press = async (k: string, mods: Record<string, boolean>) => { fire(hex(), "keydown", { key: k, cancelable: true, ...mods }); await settle(); };
    const button = (text: string) => [...d().querySelectorAll("button")].find((b: any) => b.textContent.trim() === text) as any;
    const save = async () => { button("Save").click(); await settle(3); return posts.filter((p) => p.url === "/api/profile/alpha").map((p) => p.body.color); };
    return { d, hex, press, button, save };
  }
  it("the colour dialog: a swatch is a choice, not text — Ctrl+Z / Ctrl+Y leave it chosen, and Save sends it", async () => {
    const c = await colourDialog();
    const loaded = c.hex().value;
    c.d().querySelector('.idc-swatch[aria-label="Blue"]').click(); await settle();
    await c.press("z", { ctrlKey: true }); await c.press("y", { ctrlKey: true });
    const blue = c.d().querySelector('.idc-swatch[aria-label="Blue"]');
    expect([loaded, c.hex().value, blue.getAttribute("aria-pressed"), await c.save()]).toEqual(["#112233", "", "true", ["preset:blue"]]);
  });
  it("the colour dialog: Not chosen, then Ctrl+Z: still not chosen — Save sends no colour", async () => {
    const c = await colourDialog();
    c.button("Not chosen").click(); await settle();
    await c.press("z", { ctrlKey: true });
    expect([c.hex().value, await c.save()]).toEqual(["", [null]]);
  });
  it("the colour dialog: a typed colour undone back to the loaded one — the colour follows the text, and Save sends it", async () => {
    const c = await colourDialog();
    fire(c.hex(), "beforeinput", { inputType: "insertFromPaste", isComposing: false });
    c.hex().value = "#aabbcc"; fire(c.hex(), "input", {}); await settle();
    await c.press("z", { ctrlKey: true });
    expect([c.hex().value, await c.save()]).toEqual(["#112233", ["#112233"]]);
  });
  it("the colour dialog: a typed hex keeps a space (the colour still taken from it)", async () => {
    const pg = await at("http://127.0.0.1:19280/ui/chat/alpha");
    const C = await import("/assets/identity-color.js" as string);
    await pg.mount(H(C.ColorDialogHost, {}));
    C.openColorDialog("alpha", { name: "alpha", status: "running", backend: "codex", tags: [], color: { auto: "auto:sea" }, color_show: {} });
    await settle(3);
    const hex = () => pg.root.querySelector("dialog .idc-hex") as any;
    hex().value = " #aabbcc"; fire(hex(), "input", {}); await settle();
    expect([hex().value, (pg.root.querySelector('dialog input[type="color"]') as any).value]).toEqual([" #aabbcc", "#aabbcc"]);
  });
  it("the sidebar filter: Esc and × clear it — each undoable back to the text", async () => {
    const pg = await at("http://127.0.0.1:19280/ui/chat/alpha");
    const nav = await import("/assets/instance-nav.js" as string);
    const items = ["alpha", "beta"].map((name) => ({ name, status: "running", backend: "codex", tags: [] }));
    await pg.mount(H(nav.InstanceNav, { route: { panel: "chat", instance: "alpha" }, items, loaded: true }));
    await settle(2);
    const box = () => pg.root.querySelector("#filterInput") as any;
    const typeIn = async (t: string) => { for (const ch of t) { fire(box(), "beforeinput", { inputType: "insertText", data: ch, isComposing: false }); box().value += ch; fire(box(), "input", {}); now += 50; } await settle(); };
    const undoKey = async () => { fire(box(), "keydown", { key: "z", ctrlKey: true, cancelable: true }); await settle(); };
    await typeIn("be");
    fire(box(), "keydown", { key: "Escape", cancelable: true }); await settle();
    const esc = box().value;
    await undoKey();
    const afterEsc = box().value;
    (pg.root.querySelector(".v-filter-clear") as any).click(); await settle();
    const cleared = box().value;
    await undoKey();
    expect([esc, afterEsc, cleared, box().value]).toEqual(["", "be", "", "be"]);
  });
});
