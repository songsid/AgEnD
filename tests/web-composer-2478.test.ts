/**
 * #2478 (the user's report, beta.26 on iOS Safari) — the chat composer on a phone.
 * 1. The placeholder names the agent by its display name (its id when it has none), on one line: empty, the box is never
 *    sized by its placeholder (a long id wrapped it to two lines).
 * 3. On a touch screen (a coarse pointer) Return is a new line and only the Send button sends; enterkeyhint is "enter".
 *    A desk is unchanged: Enter sends, Shift+Enter is a new line.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fire, settle } from "./helpers/mini-dom.js";
import type { AppPage } from "./helpers/app-harness.js";

function fakeStream() {
  const subs = new Map<string, Array<(d: any) => void>>();
  return { on(n: string, fn: (d: any) => void) { subs.set(n, [...(subs.get(n) ?? []), fn]); return () => {}; }, emit(n: string, d: any) { for (const fn of subs.get(n) ?? []) fn(d); } };
}
const inst = (name: string, over: Record<string, unknown> = {}) => ({ name, status: "running", state: "idle", backend: "claude-code", ...over });

describe("#2478: the chat composer (the real page modules)", () => {
  const pages: AppPage[] = [];
  afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } });

  async function chatPage(o: { touch?: boolean; over?: Record<string, unknown>; lang?: string } = {}) {
    for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); }          // one page at a time
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    const p = harness.page({ storage: { agend_tour_done: "1", ...(o.lang ? { agend_lang: o.lang } : {}) } });
    pages.push(p);
    // A phone's pointer is coarse; a desk's is fine. Set before the page renders (the hint and enterkeyhint read it).
    (globalThis as any).matchMedia = (q: string) => ({ matches: !!o.touch && /pointer:\s*coarse/.test(q), addEventListener() {}, removeEventListener() {} });
    if (o.lang) (await import("/assets/app-i18n.js" as string)).setLang(o.lang);
    const app = await import("/assets/app-store.js" as string);
    const panel = await import("/ui/js/panel-chat.js" as string);
    const calls: Array<{ path: string; body?: any }> = [];
    const fetch = async (path: string, init: { body?: unknown } = {}) => {
      calls.push({ path, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
      return { ok: true, status: 200, json: async () => (path.startsWith("/ui/history") ? { messages: [] } : {}) };
    };
    const stream = fakeStream();
    stream.on("status", app.applyStatus);
    panel.boot({ stream, boot: null, deps: { fetch, toast() {}, setTimeout: () => 0 } });
    stream.emit("status", { uptime: 1, instances: [inst("agend-leader-t1503382358143799511", o.over)] });
    await p.mount(harness.h("main", { id: "main" }, harness.h(panel.ChatPanel, { route: { panel: "chat", instance: "agend-leader-t1503382358143799511" }, navKey: "chat|w" })));
    await settle();
    const box = () => p.root.querySelector("#msgIn");
    const type = async (text: string) => { box().value = text; fire(box(), "input"); await settle(); };
    const key = async (k: string, init: Record<string, unknown> = {}) => { const e = fire(box(), "keydown", { key: k, ...init }); await settle(); return e; };
    const sends = () => calls.filter((c) => c.path === "/ui/send");
    return { p, box, type, key, sends };
  }

  const ph = (c: { p: AppPage }) => c.p.root.querySelector(".composer-field .composer-ph") as any;
  it("1: the placeholder names the display name — its id when there is none (or only spaces)", async () => {
    const named = await chatPage({ over: { display_name: "Release captain" } });
    // Drawn beside the box (a textarea's own placeholder is clipped, never ellipsized); the box keeps the words as its name.
    expect([ph(named)?.textContent, ph(named)?.getAttribute("aria-hidden"), named.box().getAttribute("aria-label"), named.box().getAttribute("placeholder")])
      .toEqual(["Message Release captain…", "true", "Message Release captain…", null]);
    for (const over of [{}, { display_name: "   " }]) {
      const c = await chatPage({ over });
      expect([ph(c)?.textContent, c.box().getAttribute("aria-label")], JSON.stringify(over)).toEqual(["Message agend-leader-t1503382358143799511…", "Message agend-leader-t1503382358143799511…"]);
    }
  });

  it("1: the drawn placeholder is there only while the box is empty", async () => {
    const c = await chatPage();
    expect(!!ph(c)).toBe(true);
    await c.type("hi");
    expect(ph(c), "typed: gone").toBeNull();
    await c.type("");
    expect(!!ph(c), "empty again: back").toBe(true);
  });

  it("1: empty, the box is one line — its placeholder never sizes it; typed text still grows it", async () => {
    const c = await chatPage();
    expect(c.box().style.height, "empty: no height from the placeholder").toBe("auto");
    await c.type("x");
    expect(c.box().style.height).toMatch(/^\d+px$/);
    await c.type("");
    expect(c.box().style.height).toBe("auto");
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.split(",").map((x) => x.trim()).includes(sel)).map((m) => m[2]).join(";");
    for (const d of [/white-space:\s*nowrap/, /text-overflow:\s*ellipsis/, /overflow:\s*hidden/, /pointer-events:\s*none/, /position:\s*absolute/]) expect(rule(".composer-ph")).toMatch(d);
    expect(rule(".composer-field")).toMatch(/position:\s*relative/);
    // On a phone it is the box's 16 px too: its own rule beside #1611's (which stays exactly as it was).
    const tokens = readFileSync(join(process.cwd(), "src", "ui", "shared", "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(tokens).toMatch(/@media \(pointer: coarse\), \(max-width: 899px\) \{\s*\.composer-ph \{\s*--fs-md:\s*16px;\s*\}\s*\}/);
    expect(tokens).toMatch(/@media \(pointer: coarse\), \(max-width: 899px\) \{\s*input, select, textarea \{[^}]*\}\s*\}/);
  });

  it("3: a touch screen — Return is a new line, nothing is sent; enterkeyhint is \"enter\"; the Send button sends", async () => {
    const c = await chatPage({ touch: true });
    expect(c.box().getAttribute("enterkeyhint")).toBe("enter");
    expect(c.p.root.querySelector(".composer-row .hint").textContent).toBe("Return adds a line · tap Send to send");
    await c.type("first line");
    const e = await c.key("Enter");
    expect([e.defaultPrevented, c.sends().length], "Return keeps its own job: a new line").toEqual([false, 0]);
    await c.type("first line\nsecond line");
    (c.p.root.querySelector("#sendBtn") as any).click(); await settle();
    expect(c.sends().map((s) => s.body?.message)).toEqual(["first line\nsecond line"]);
  });

  it("3: a desk is unchanged — Enter sends, Shift+Enter is a new line, no enterkeyhint", async () => {
    const c = await chatPage();
    expect(c.box().getAttribute("enterkeyhint")).toBeNull();
    expect(c.p.root.querySelector(".composer-row .hint").textContent).toBe("Enter to send · Shift+Enter for a new line");
    await c.type("hello");
    const shift = await c.key("Enter", { shiftKey: true });
    expect([shift.defaultPrevented, c.sends().length]).toEqual([false, 0]);
    const enter = await c.key("Enter");
    expect([enter.defaultPrevented, c.sends().map((s) => s.body?.message)]).toEqual([true, ["hello"]]);
  });

  it("3: zh-TW — the touch hint in the page's language", async () => {
    const c = await chatPage({ touch: true, lang: "zh-TW" });
    expect(c.p.root.querySelector(".composer-row .hint").textContent).toBe("Return 換行 · 按「送出」傳送");
  });
});
