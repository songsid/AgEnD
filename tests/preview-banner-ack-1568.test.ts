/**
 * #1568 (baseline: issue comment 6098680724): the preview banner's "I understand" hides it until the next sign-in.
 * Scope: the sign-in's session handle (localStorage on the dashboard origin) — a new sign-in has a new handle, so the
 * banner shows again; with no sign-in session, this tab only (sessionStorage); storage blocked, this page only; not
 * known yet, shown. The parent-drawn frame border stays on every preview, banner shown or hidden. The #1306 model is
 * otherwise unchanged (off by default, opt-in confirm, click-to-run) and pinned by its own tests.
 *
 * preview.js runs in a fresh vm realm per "page" for the scope rules; the real chat (panel-chat.js, chat-thread.js,
 * preview-panel.js, preview.js) runs in the mini DOM for the card and the panel.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const SRC = (p: string) => readFileSync(join(process.cwd(), "src", "ui", p), "utf8");
const KEY = "agend_html_preview_banner_ack";
const A = "a".repeat(16), B = "b".repeat(16);

/** A browser's storage: kept across pages of one browser (local) or one tab (session); `blocked` throws like private mode. */
function storage(blocked = false) {
  const m = new Map<string, string>();
  const fail = () => { throw new Error("SecurityError: storage blocked"); };
  return {
    m,
    api: {
      getItem: (k: string) => (blocked ? fail() : m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => (blocked ? fail() : void m.set(k, String(v))),
      removeItem: (k: string) => (blocked ? fail() : void m.delete(k)),
    },
  };
}
/** One page load of preview.js, in its own realm, on this browser's storage. */
function pageLoad(local: ReturnType<typeof storage>, session: ReturnType<typeof storage>) {
  const ctx: any = { localStorage: local.api, sessionStorage: session.api, performance, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC("preview.js"), ctx);
  return ctx.AgendPreview;
}

describe("the scope: until the next sign-in", () => {
  it("not known yet, or nothing pressed: shown", () => {
    const P = pageLoad(storage(), storage());
    expect(P.bannerAcked()).toBe(false);
    P.setBannerScope(A);
    expect(P.bannerAcked()).toBe(false);
  });
  it("pressed under a sign-in: hidden on every later page of that sign-in; a new sign-in (a new handle) shows it again", () => {
    const local = storage(), tab = storage();
    const p1 = pageLoad(local, tab);
    p1.setBannerScope(A);
    p1.ackBanner();
    expect([p1.bannerAcked(), local.m.get(KEY), tab.m.has(KEY)]).toEqual([true, A, false]);
    const p2 = pageLoad(local, storage());            // another tab, the same sign-in
    p2.setBannerScope(A);
    expect(p2.bannerAcked()).toBe(true);
    const p3 = pageLoad(local, storage());            // signed in again: a new session, a new handle
    p3.setBannerScope(B);
    expect(p3.bannerAcked()).toBe(false);
  });
  it("no sign-in session: this tab only (sessionStorage), never the device; a sign-in later shows it again", () => {
    const local = storage(), tab = storage();
    const p1 = pageLoad(local, tab);
    p1.setBannerScope(null);
    p1.ackBanner();
    expect([p1.bannerAcked(), tab.m.get(KEY), local.m.has(KEY)]).toEqual([true, "1", false]);
    const sameTab = pageLoad(local, tab);
    sameTab.setBannerScope(null);
    const otherTab = pageLoad(local, storage());
    otherTab.setBannerScope(null);
    const signedIn = pageLoad(local, tab);
    signedIn.setBannerScope(A);
    expect([sameTab.bannerAcked(), otherTab.bannerAcked(), signedIn.bannerAcked()]).toEqual([true, false, false]);
  });
  it("a handle not ours in shape is no sign-in: this tab only", () => {
    const local = storage(), tab = storage();
    const p = pageLoad(local, tab);
    p.setBannerScope("../x");
    p.ackBanner();
    expect([local.m.has(KEY), tab.m.get(KEY)]).toEqual([false, "1"]);
  });
  it("storage blocked: this page only", () => {
    const local = storage(true), tab = storage(true);
    const p1 = pageLoad(local, tab);
    p1.setBannerScope(A);
    p1.ackBanner();
    const p2 = pageLoad(local, tab);
    p2.setBannerScope(A);
    expect([p1.bannerAcked(), p2.bannerAcked()]).toEqual([true, false]);
  });
  it("pressed before the page knew its sign-in: holds here, and is recorded for that sign-in once known", () => {
    const local = storage();
    const p = pageLoad(local, storage());
    p.ackBanner();
    expect([p.bannerAcked(), local.m.has(KEY)]).toEqual([true, false]);
    p.setBannerScope(A);
    expect([p.bannerAcked(), local.m.get(KEY)]).toEqual([true, A]);
  });
  it("pressed under one sign-in, then the page is another's: shown", () => {
    const p = pageLoad(storage(), storage());
    p.setBannerScope(A);
    p.ackBanner();
    p.setBannerScope(B);
    expect(p.bannerAcked()).toBe(false);
  });
  it("another tab of this sign-in pressing it is heard here (the storage event); it starts and stops nothing", () => {
    const local = storage();
    const p = pageLoad(local, storage());
    p.setBannerScope(A);
    const heard = vi.fn();
    p.onChange(heard);
    local.m.set(KEY, A);
    p.onStorage({ key: KEY });
    expect([heard.mock.calls.length, p.bannerAcked()]).toEqual([1, true]);
  });
});

describe("the page reads its sign-in once (agend-auth.js)", () => {
  function auth(fetchImpl: (url: string) => Promise<unknown>) {
    const native = vi.fn(fetchImpl);
    const win: any = { fetch: native, location: { href: "http://127.0.0.1:1/ui", origin: "http://127.0.0.1:1", pathname: "/ui", search: "", hash: "" }, history: { replaceState() {} }, localStorage: storage().api };
    const ctx: any = { window: win, URL, Headers: class {}, document: {}, navigator: {}, location: win.location, history: win.history, sessionStorage: storage().api };
    vm.createContext(ctx);
    vm.runInContext(SRC("shared/agend-auth.js"), ctx);
    return { A: win.AgendAuth, fetch: native };          // the network (agend-auth.js wraps window.fetch)
  }
  const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  it("the handle and the CSRF value come from one GET /auth/session", async () => {
    const { A: auth1, fetch } = auth(() => ok({ ok: true, csrf: "c1", handle: A }));
    expect([await auth1.sessionHandle(), await auth1.csrf(), fetch.mock.calls.length, fetch.mock.calls[0][0]]).toEqual([A, "c1", 1, "/auth/session"]);
  });
  it("no session (401) or a failed read: null — and asked again next time", async () => {
    let n = 0;
    const { A: auth1, fetch } = auth(() => (++n === 1 ? Promise.resolve({ ok: false, json: () => Promise.resolve({}) }) : ok({ csrf: "c2", handle: B })));
    expect(await auth1.sessionHandle()).toBe(null);
    expect([await auth1.sessionHandle(), fetch.mock.calls.length]).toEqual([B, 2]);
  });
});

// ── The card and the panel, in the real chat ────────

const BOOT = "e".repeat(32);
let PV: any, panel: any, pp: any, i18n: any;
let current: AppPage | null = null;
let handles = 0;
/** A sign-in of its own for each test (a handle never pressed before). */
const signIn = () => { const hd = (++handles).toString(16).padStart(16, "c"); PV.setBannerScope(hd); return hd; };

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  PV = (globalThis as any).AgendPreview;
  const base = installDom({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types
  panel = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  pp = await import("../src/ui/preview-panel.js");
  i18n = await import("/assets/app-i18n.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({
    stream: { on() {} },
    boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" },
    deps: { fetch: () => new Promise(() => {}) },
  });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  await current?.unmount();
  PV.stopAll("test-end");
  pp.closePanel();
  panel.store.state.msgs.w = [];
  i18n.setLang("en");
  current?.restore();
  current = null;
});

const agent = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: `2026-01-01T00:00:0${id}Z` });
const FENCE = (v: number) => "```html\n<title>T</title><h1>v" + v + "</h1>\n```";
async function chat(n = 2) {
  current = page({ storage: { agend_html_preview: "on", agend_tour_done: "1" } });
  panel.store.state.msgs.w = Array.from({ length: n }, (_, i) => agent(i + 1, FENCE(i + 1)));
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  const doc = current.document as any;
  doc.querySelector(".chat-split").clientWidth = 1200;
  return doc;
}
const cards = (doc: any) => [...doc.querySelectorAll(".msg.agent .html-card")] as any[];
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(); };
/** What a card shows of the warning: the banner's visibility, and the running frame's class (its border is CSS). */
const cardState = (card: any) => {
  const f = card.querySelector(".pv-holder iframe");
  return { banner: !card.querySelector(".pv-banner").hidden, frame: f ? f.className : null };
};

describe("the card's banner", () => {
  it("a running preview's banner has \"I understand\"; pressed, the banner hides — the frame keeps its bordered class", async () => {
    signIn();
    const doc = await chat(1);
    const card = cards(doc)[0];
    await click(card.querySelector(".pv-run"));
    const ack = card.querySelector(".pv-banner .pv-ack");
    expect([cardState(card), ack.textContent, ack.title]).toEqual([{ banner: true, frame: "preview-frame" }, "I understand", "Hide this notice until you sign in again"]);
    expect(card.querySelector(".pv-banner .pv-banner-text").textContent).toBe(PV.BANNER);
    await click(ack);
    expect(cardState(card)).toEqual({ banner: false, frame: "preview-frame" });
  });
  it("pressed once, every card of this sign-in runs without it; a new sign-in shows it again", async () => {
    signIn();
    const doc = await chat(2);
    const [c1, c2] = cards(doc);
    await click(c1.querySelector(".pv-run"));
    await click(c1.querySelector(".pv-ack"));
    await click(c2.querySelector(".pv-run"));                 // one running preview per page: the second card runs
    expect(cardState(c2)).toEqual({ banner: false, frame: "preview-frame" });
    signIn();
    await settle();
    expect(cardState(c2)).toEqual({ banner: true, frame: "preview-frame" });
  });
  it("in the page's language: 我知道了", async () => {
    signIn();
    i18n.setLang("zh-TW");
    const doc = await chat(1);
    const card = cards(doc)[0];
    await click(card.querySelector(".pv-run"));
    expect([card.querySelector(".pv-ack").textContent, card.querySelector(".pv-ack").title]).toEqual(["我知道了", "隱藏這則提醒，直到下次登入"]);
  });
  it("an idle card shows no banner either way (it goes with a running preview)", async () => {
    signIn();
    const doc = await chat(1);
    expect(cardState(cards(doc)[0])).toEqual({ banner: false, frame: null });
  });
});

describe("the panel's banner", () => {
  it("pressed in the panel: gone there and on the cards; the panel's frame keeps its bordered class", async () => {
    signIn();
    const doc = await chat(1);
    const card = cards(doc)[0];
    await click(card.querySelector(".pv-open"));
    await click(doc.querySelector(".pv-panel-run"));
    const f = PV.liveFrame(pp.frameKey("b-1:f0"));
    expect([!!doc.querySelector(".pv-panel .pv-banner"), doc.querySelector(".pv-panel .pv-banner .pv-ack")?.textContent ?? null, f.className])
      .toEqual([true, "I understand", "preview-frame fill"]);
    await click(doc.querySelector(".pv-panel .pv-ack"));
    expect([!!doc.querySelector(".pv-panel .pv-banner"), f.className, PV.running(pp.frameKey("b-1:f0"))]).toEqual([false, "preview-frame fill", true]);
    expect(PV.bannerAcked()).toBe(true);
  });
  it("pressed on a card: the panel opened later shows none; a new sign-in brings it back there too", async () => {
    signIn();
    const doc = await chat(1);
    const card = cards(doc)[0];
    await click(card.querySelector(".pv-run"));
    await click(card.querySelector(".pv-ack"));
    await click(card.querySelector(".pv-open"));             // the running preview moves to the panel
    expect(!!doc.querySelector(".pv-panel .pv-banner")).toBe(false);
    signIn();
    await settle();
    expect(!!doc.querySelector(".pv-panel .pv-banner")).toBe(true);
  });
});

describe("the frame's border never depends on the banner (#1306 §405)", () => {
  const css = SRC("shared/app.css");
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1]!.trim(), body: m[2]! }));
  it("every preview frame is drawn with the 2px warning border", () => {
    expect(rules.filter(r => r.sel === ".preview-frame").map(r => /(^|;)\s*border:\s*2px solid var\(--warn-line\)/.test(r.body))).toEqual([true]);
  });
  it("no rule takes the border (or the frame) away", () => {
    const touching = rules.filter(r => /preview-frame/.test(r.sel) && /\bborder(-width|-style|-color)?\s*:|\boutline\s*:|\bdisplay\s*:\s*none|\bvisibility\s*:/.test(r.body));
    expect(touching.map(r => r.sel)).toEqual([".preview-frame"]);
  });
});
