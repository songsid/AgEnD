/**
 * M-3364 (prototype, not for merge): a browser that honours interactive-widget=resizes-content (Safari 27.3 beta, Chrome on
 * Android) shrinks the page with the keyboard itself — the stylesheet's 100dvh is the view, at the top. Seen once with the
 * keyboard up (a 100dvh probe as tall as visualViewport.height, offsetTop 0), the shell leaves its height to the stylesheet:
 * no inline height or transform, no scrollTo, no per-key hold. kb-open (the tabs out of the way) still follows the keyboard.
 * A browser that does not (the probe stays the whole screen, or the page is panned) keeps today's fit, unchanged.
 * The real Shell with a fake visualViewport; the probe's measured height is what the test says the browser does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fire, settle } from "./helpers/mini-dom.js";
import type { AppPage } from "./helpers/app-harness.js";

const pages: AppPage[] = [];
afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } });

/** `dvh`: what the browser makes 100dvh while the keyboard is up — the view (native) or the whole screen (no support). */
async function phone(dvh: "view" | "screen") {
  vi.resetModules();
  const { h, page } = await import("./helpers/app-harness.js");
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1" }, matchNarrow: true });
  pages.push(pg);
  (globalThis as any).matchMedia = (q: string) => ({ matches: /max-width/.test(q) || /pointer:\s*coarse/.test(q), addEventListener() {}, removeEventListener() {} });
  const subs = new Map<string, Set<() => void>>();
  const vv: any = { width: 390, height: 844, offsetTop: 0, scale: 1,
    addEventListener(n: string, fn: () => void) { (subs.get(n) ?? subs.set(n, new Set()).get(n)!).add(fn); },
    removeEventListener(n: string, fn: () => void) { subs.get(n)?.delete(fn); }, emit(n: string) { for (const fn of [...(subs.get(n) ?? [])]) fn(); } };
  pg.window.visualViewport = vv; pg.window.innerHeight = 844;
  const scrolls: number[][] = []; pg.window.scrollTo = (x: number, y: number) => { scrolls.push([x, y]); };
  // The probe the shell measures: 100dvh, as this browser lays it out.
  const body = pg.document.body as any, append = body.appendChild.bind(body);
  body.appendChild = (el: any) => {
    if (el?.hasAttribute?.("data-kb-probe")) el.getBoundingClientRect = () => ({ top: 0, height: dvh === "view" ? vv.height : 844 });
    return append(el);
  };
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
  const shell = () => pg.root.querySelector(".shell") as any, box = pg.root.querySelector("#box") as any;
  const read = async (height: number, offsetTop = 0) => { vv.height = height; vv.offsetTop = offsetTop; vv.emit("resize"); await new Promise((r) => setTimeout(r, 20)); await settle(); };
  return { pg, vv, shell, box, scrolls, read, wait: (ms: number) => new Promise((r) => setTimeout(r, ms)) };
}

describe("M-3364: interactive-widget=resizes-content honoured — the shell leaves the keyboard to the browser", () => {
  it("keyboard up: no inline height or transform, no scrollTo; kb-open still on; the page marked data-kb-native", async () => {
    const p = await phone("view");
    p.box.focus(); fire(p.box, "focusin"); await settle();
    await p.read(480);
    await p.wait(900);
    expect([p.shell().style.height || "", p.shell().style.transform || "", p.scrolls.length]).toEqual(["", "", 0]);
    expect(p.shell().classList.contains("kb-open")).toBe(true);
    expect(p.pg.document.documentElement.hasAttribute("data-kb-native")).toBe(true);
  });
  it("typing: per-key readings write nothing on the shell (the browser's resize is the layout)", async () => {
    const p = await phone("view");
    p.box.focus(); fire(p.box, "focusin"); await settle();
    await p.read(480); await p.wait(900);
    const writes: string[] = [], st = p.shell().style, setP = st.setProperty.bind(st);
    st.setProperty = (k: string, v: string) => { writes.push(`${k}=${v}`); setP(k, v); };
    for (const h of [436, 480, 436, 478, 480]) await p.read(h);
    await p.wait(400);
    expect([writes, p.scrolls.length]).toEqual([[], 0]);
  });
});

describe("M-3364: not honoured (iOS before 27.3, a home-screen app that ignores it) — today's fit, unchanged", () => {
  it("keyboard up: the shell is the view (inline height), a pan is undone, no data-kb-native", async () => {
    const p = await phone("screen");
    p.box.focus(); fire(p.box, "focusin"); await settle();
    await p.read(480, 300);
    await p.wait(900);
    expect(p.shell().style.height).toBe("480px");
    expect(p.scrolls.length).toBeGreaterThan(0);
    expect(p.pg.document.documentElement.hasAttribute("data-kb-native")).toBe(false);
  });
  it("the probe as tall as the view but the page panned: not taken as native", async () => {
    const p = await phone("view");
    p.box.focus(); fire(p.box, "focusin"); await settle();
    await p.read(480, 300);
    await p.wait(900);
    expect(p.shell().style.height).toBe("480px");
    expect(p.pg.document.documentElement.hasAttribute("data-kb-native")).toBe(false);
  });
});
