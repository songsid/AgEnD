/**
 * M-3265 (the user, iPhone, beta.9: typing flickers again — "it keeps getting fixed and coming back"). The phone's typing
 * invariants (app-shell.js, "Typing on a phone", above the keyboard effect), counted per keystroke on the real Shell with
 * a fake visualViewport, with and without an IME composition:
 *   - #4026 (M-3206): a reading that comes and goes with a key (the suggestion bar, a pan, one full-height reading) changes
 *     neither the shell's height or place nor the keyboard state; a reading that holds 300 ms is followed.
 *   - #4057 (M-3244): mid-composition, a view that got shorter (the candidate bar) is followed — the box never under it.
 *   - this card: with 注音 each character opens a composition with its bar and closes it when chosen; #4057 grew the
 *     shell back 300 ms after each compositionend, so every character moved the box twice (up for the bar, down after
 *     it). Growing back by a bar's height after a composition now waits 2 s: the next character's bar comes first.
 * Counted: every change of the shell's inline height or transform, and every flip of the keyboard state (kb-open).
 */
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeViewport(width: number, height: number) {
  const subs = new Map<string, Set<() => void>>();
  const on = (n: string) => { if (!subs.has(n)) subs.set(n, new Set()); return subs.get(n)!; };
  return {
    width, height, offsetTop: 0, scale: 1,
    addEventListener(n: string, fn: () => void) { on(n).add(fn); }, removeEventListener(n: string, fn: () => void) { on(n).delete(fn); },
    emit(n: string) { for (const fn of [...on(n)]) fn(); },
  };
}
const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }, h("textarea", { id: "box" })) });
const PANELS = new Map([["chat", Stub("chat")], ["view", Stub("view")], ["fleet", Stub("fleet")], ["settings", Stub("settings")], ["needs", Stub("needs")]]);

/** A phone with the box focused and the keyboard up (480 of 844), past the focus follow window; `changes()` drains the log. */
async function typing() {
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1" }, matchNarrow: true });
  mounted.push(pg);
  (globalThis as any).matchMedia = (q: string) => ({ matches: /max-width/.test(q) || /pointer:\s*coarse/.test(q), addEventListener() {}, removeEventListener() {} });
  const vv = fakeViewport(390, 844);
  pg.window.visualViewport = vv; pg.window.innerHeight = 844;
  // M-3327: a pan is undone (scrollTo 0) — logged as a change; the browser then reports the view unpanned.
  const scrolled: string[] = [];
  pg.window.scrollTo = (x: number, y: number) => { scrolled.push(`scrollTo=${x},${y}`); if (vv.offsetTop) { vv.offsetTop = 0; vv.emit("scroll"); } };
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell, shellStore } = await import("/assets/app-shell.js");
  shellStore.set({ keyboard: false });
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code" }] });
  await pg.mount(h(Shell, { panels: PANELS, onNewInstance() {} }));
  await settle(3);
  const shell = pg.root.querySelector(".shell") as any, box = pg.root.querySelector("#box") as any;
  const log: string[] = [];
  const st = shell.style, set = st.setProperty.bind(st), remove = st.removeProperty.bind(st);
  st.setProperty = (k: string, v: string) => { if (st[k] !== v) log.push(`${k}=${v}`); set(k, v); };
  st.removeProperty = (k: string) => { if (st[k]) log.push(`${k}=∅`); return remove(k); };
  let kb = shellStore.get().keyboard;
  const off = shellStore.subscribe(() => { const now = shellStore.get().keyboard; if (now !== kb) { log.push(`kb=${now}`); kb = now; } });
  pg.window.addEventListener?.("unload", off);
  box.focus(); fire(box, "focusin"); await settle();
  vv.height = 480; vv.emit("resize"); await settle();
  await wait(900);                                                        // past the focus follow window: the keyboard settled
  const changes = () => { log.push(...scrolled.splice(0)); return log.splice(0); };
  changes();
  const read = (height: number, top = 0) => { const resized = vv.height !== height, panned = vv.offsetTop !== top; vv.height = height; vv.offsetTop = top; if (resized) vv.emit("resize"); if (panned) vv.emit("scroll"); };
  /** One 注音 character: its composition with the candidate bar (436), three keys 150 ms apart, chosen, the bar gone, then `pause` ms. */
  const character = async (pause: number, bar = true) => {
    fire(box, "compositionstart", { data: "" });
    if (bar) read(436);
    for (let k = 0; k < 3; k++) { fire(box, "input"); await wait(150); }   // past #4026's 300 ms: the bar is followed
    fire(box, "compositionend", { data: "你" });
    if (bar) read(480);
    await wait(pause);
  };
  /**
   * The user's case (iPhone, iOS 27.3, portrait, 注音): while the candidates show, each key changes the candidate row and the
   * view with it by a few px — its height, or where it is panned — through compositionupdate. One character, eight keys.
   */
  const keys = async (by: "height" | "pan") => {
    fire(box, "compositionstart", { data: "" }); read(436); await wait(150);
    for (const d of [0, 5, -2, 3, 0, 7, 1, 4]) {
      fire(box, "compositionupdate", { data: "ㄋ" });
      if (by === "height") read(436 - d); else read(436, Math.max(0, d));
      fire(box, "input"); await wait(150);
    }
    fire(box, "compositionend", { data: "你" }); read(480); await wait(450);
  };
  return { vv, shell, read, character, keys, changes, height: () => st.height || null };
}

describe("M-3265: typing on a phone moves nothing per keystroke, with or without an IME", () => {
  it("English: per-key readings (the bar on and off, a pan, one full-height reading) — no change on any key", async () => {
    const t = await typing();
    const perKey: string[][] = [];
    for (const [hh, top] of [[436, 0], [480, 0], [480, 12], [480, 0], [844, 0], [480, 0], [436, 0], [480, 0]] as const) {
      t.read(hh, top); await wait(60); perKey.push(t.changes());
    }
    await wait(400); perKey.push(t.changes());
    expect(perKey.flat(), "no height, transform or keyboard change while typing").toEqual([]);
    expect(t.height()).toBe("480px");
  });

  it("注音, a person's pace (each character chosen after a pause): the first bar is followed once, then nothing per character", async () => {
    const t = await typing();
    const perChar: string[][] = [];
    for (let i = 0; i < 4; i++) { await t.character(450); perChar.push(t.changes()); }
    expect(perChar[0], "the first character's bar: followed (M-3244, the box above it)").toEqual(["height=436px"]);
    expect(perChar.slice(1).flat(), "the next characters: no change").toEqual([]);
    await wait(2100);
    expect([t.changes(), t.height()], "typing stopped: the shell is the view again, once").toEqual([["height=480px"], "480px"]);
  });

  it("注音, fast: the same", async () => {
    const t = await typing();
    const perChar: string[][] = [];
    for (let i = 0; i < 4; i++) { await t.character(120); perChar.push(t.changes()); }
    expect([perChar[0], perChar.slice(1).flat()]).toEqual([["height=436px"], []]);
  });

  it("注音 with the candidate row up all along: nothing per character, nothing after", async () => {
    const t = await typing();
    t.read(436); await wait(400); t.changes();                            // the row came up and held: followed (#4026)
    const perChar: string[][] = [];
    for (let i = 0; i < 4; i++) { await t.character(450, false); perChar.push(t.changes()); }
    await wait(2100); perChar.push(t.changes());
    expect(perChar.flat()).toEqual([]);
    expect(t.height()).toBe("436px");
  });

  it("the user's case: each 注音 key while the candidates show nudges the view's height — after the first bar, no change per key", async () => {
    const t = await typing();
    await t.keys("height");
    const first = t.changes();
    expect(first.length, `the first bar, followed once (${first.join(" ")})`).toBeLessThanOrEqual(1);
    for (let c = 0; c < 2; c++) { await t.keys("height"); expect(t.changes(), `character ${c + 2}`).toEqual([]); }
  });

  it("the same with the view panned a few px per key: no change per key, nor when the pan goes with the bar", async () => {
    const t = await typing();
    await t.keys("pan");
    t.changes();
    await wait(1600);                                                      // typing stopped: back to the view, in one move
    expect(t.changes()).toEqual(["height=480px"]);
    await t.keys("pan");
    const again = t.changes();                                             // the bar again from the full view: one move, nothing after
    expect([again.filter((c) => c.startsWith("height")), again.filter((c) => c.startsWith("transform")).length <= 1],
      `the bar's follow only — not the pan back to 0 when it went (${again.join(" ")})`).toEqual([["height=436px"], true]);
    for (let c = 0; c < 2; c++) { await t.keys("pan"); expect(t.changes(), `character ${c + 2}`).toEqual([]); }
  });

  it("a nudge that stays (a few px) is no move while typing; a bar's height is", async () => {
    const t = await typing();
    t.read(475); await wait(500);
    t.read(480, 6); await wait(500);
    expect(t.changes(), "5 px of height, 6 px of pan, each held 500 ms: nothing").toEqual([]);
    t.read(436, 0); await wait(400);
    expect(t.changes()).toEqual(["height=436px"]);
  });

  it("#4026's hold is a reading's own: readings that change every key (more than a nudge) never hold; one that stays is taken", async () => {
    const t = await typing();
    for (let k = 0; k < 8; k++) { t.read(k % 2 ? 400 : 436); await wait(150); }
    expect(t.changes(), "1.2 s of readings, none held 300 ms").toEqual([]);
    t.read(400); await wait(400);
    expect(t.changes()).toEqual(["height=400px"]);
  });

  it("after a composition, the keyboard put away (the field kept focus) is followed after #4026's 300 ms, not the bar's 2 s", async () => {
    const t = await typing();
    await t.character(0);
    t.changes();
    t.read(844); await wait(500);
    expect(t.changes(), "the view grew by more than a keyboard: down").toEqual(expect.arrayContaining(["height=844px"]));
  });

  it("after a composition, a pan that holds is still followed after #4026's 300 ms (not held back to the grow's 2 s)", async () => {
    const t = await typing();
    await t.character(0);
    t.changes();
    t.read(480, 30); await wait(400);
    expect(t.changes(), "the pan, undone (M-3327); the height still waits for the next character").toEqual(["scrollTo=0,0"]);
    await wait(1900);
    expect(t.changes(), "typing stopped: the height too").toEqual(["height=480px"]);
  });
});
