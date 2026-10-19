/**
 * #1722 (design: the comment on #1722): the sidebar can be dragged wider (a keyboard separator; this device's width, set
 * through the CSSOM), the ☆ has a slot of its own where the CLI dot was, the CLI is a letter on the avatar's corner
 * (named in full for a screen reader), and an instance shows both names — which one leads is a synced preference
 * ("names.primary", #1665) that every surface naming an instance follows: the sidebar, the chat header, Needs you.
 * The real Shell, chat and Needs panels, store and router in a mini DOM.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const appCss = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
let host: Record<string, unknown> = {}, rev = 1, posts: any[] = [];
const fetchFake = async (url: string, init: any = {}) => {
  if (url === "/ui/prefs" && init.method === "POST") { const b = JSON.parse(init.body); posts.push(b); Object.assign(host, b.set); rev++; }
  if (url === "/ui/prefs") return { ok: true, status: 200, json: async () => ({ values: { ...host }, rev }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

let chat: any, N: any, shell: any, nav: any, store: any, router: any, prefs: any, i18n: any;
const mounted: AppPage[] = [];
beforeAll(async () => {
  // A signed-in page (<html data-prefs>): the prefs module reads it once, on its first import in this file.
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  (globalThis as any).fetch = fetchFake;
  prefs = await import("/assets/app-prefs.js");
  store = await import("/assets/app-store.js");
  router = await import("/assets/app-nav.js");
  shell = await import("/assets/app-shell.js");
  nav = await import("/assets/instance-nav.js");
  i18n = await import("/assets/app-i18n.js");
  chat = await import("/ui/js/panel-chat.js");
  store.appStore.set({ chatOwner: chat.boot({ stream: { on() { return () => {}; } }, boot: null, deps: { fetch: fetchFake } }) });
  N = await import("/ui/js/panel-needs.js");
  pg.restore();
});
afterEach(async () => {
  // The host's prefs as a fresh fleet has them, and the page's copy of them (app-prefs is module-wide): nothing a test
  // chose leaks into the next.
  host = {}; rev += 10;
  if (mounted.length) { (globalThis as any).fetch = fetchFake; await prefs.refresh(); }
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  nav.namesStore.set({ primary: "nickname" });
  i18n.setLang("en");
});

const INSTANCES = [
  { name: "agend-reviewer-t1", display_name: "Alice", status: "running", backend: "codex", context_pct: 82, tags: [], execution_state: "idle" },
  { name: "web-dev", display_name: "web-dev", status: "running", backend: "claude-code", context_pct: 10, tags: [], execution_state: "idle" },
  { name: "plain", status: "running", backend: "kiro-cli", context_pct: 5, tags: [], execution_state: "idle" },
];
const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }, name) });
/** The app at `path`: the real Shell, the real chat and Needs panels; `storage` is this device's. */
async function app(path: string, opts: { storage?: Record<string, string>; narrow?: boolean; width?: number; media?: (q: string) => boolean } = {}) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1", ...(opts.storage ?? {}) }, matchNarrow: opts.narrow });
  if (opts.width) pg.window.innerWidth = opts.width;
  if (opts.media) { const m = opts.media; (globalThis as any).matchMedia = (q: string) => ({ matches: m(q), addEventListener() {}, removeEventListener() {} }); }
  mounted.push(pg);
  // Module-wide stores start as a fresh page load would: the rail as this device chose, no width shown yet.
  (await import("/assets/header-tools.js")).initUsageRail();
  shell.sidebarWidthStore.set({ width: null });
  (globalThis as any).fetch = fetchFake;
  pg.document.documentElement.style.removeProperty?.("--sidebar-w");
  delete (pg.document.documentElement.style as any)["--sidebar-w"];
  router.startRouter(pg.window);
  store.applyStatus({ instances: INSTANCES });
  store.appStore.set({ needs: [{ id: "instance:agend-reviewer-t1:crashed:1", type: "instance", instance: "agend-reviewer-t1", reason: "crashed", detail: "", since: Date.now() - 60_000 }] });
  nav.loadNavPrefs();
  const panels = new Map([["chat", { Component: chat.ChatPanel }], ["needs", { Component: N.NeedsPanel }], ["view", Stub("view")], ["fleet", Stub("fleet")], ["settings", Stub("settings")]]);
  await pg.mount(h(shell.Shell, { panels, onNewInstance() {} }));
  await settle(4);
  return pg;
}
const rowOf = (pg: AppPage, name: string) => pg.root.querySelectorAll("#instanceList a.inst").find((a: any) => a.getAttribute("href")?.endsWith(`/${name}`)) as any;
const names = (pg: AppPage, name: string) => { const r = rowOf(pg, name); return [r.querySelector(".inst-name").textContent, r.querySelector(".inst-alt")?.textContent ?? null]; };
const sep = (pg: AppPage) => pg.root.querySelector(".side-resize") as any;
const width = (pg: AppPage) => (pg.document.documentElement.style as any)["--sidebar-w"] ?? null;
const key = async (el: any, k: string) => { el.dispatchEvent(new (globalThis as any).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); await settle(); };

describe("resizing the sidebar", () => {
  it("clamps: 200..480, and never leaves the main pane under 480", () => {
    const c = shell.clampSidebarWidth;
    expect([c(100, 1366), c(300, 1366), c(900, 1366), c(Infinity, 1366), c(400, 800), c(250, 600), c(333.4, 1366)]).toEqual([200, 300, 480, 480, 320, 200, 333]);
  });

  it("a keyboard separator: ← → by 16, Home / End, Enter resets — set through the CSSOM, kept on this device", async () => {
    const pg = await app("/ui");
    const s = sep(pg);
    expect([s.getAttribute("role"), s.getAttribute("aria-orientation"), s.getAttribute("tabindex"), s.getAttribute("aria-label"), s.getAttribute("aria-valuemin"), s.getAttribute("aria-valuemax"), s.getAttribute("aria-valuenow")])
      .toEqual(["separator", "vertical", "0", "Sidebar width", "200", "480", "260"]);
    await key(s, "ArrowRight");
    expect([width(pg), pg.storage.get("agend_sidebar_w"), sep(pg).getAttribute("aria-valuenow")]).toEqual(["276px", "276", "276"]);
    await key(sep(pg), "ArrowLeft"); await key(sep(pg), "ArrowLeft");
    expect(width(pg)).toBe("244px");
    await key(sep(pg), "End");
    expect([width(pg), pg.storage.get("agend_sidebar_w")]).toEqual(["480px", "480"]);
    await key(sep(pg), "Home");
    expect(width(pg)).toBe("200px");
    await key(sep(pg), "Enter");
    expect([width(pg) || null, pg.storage.get("agend_sidebar_w") ?? null, sep(pg).getAttribute("aria-valuenow")]).toEqual([null, null, "260"]);
  });

  it("a drag sets it as it moves and keeps it when let go; a double-click resets", async () => {
    const pg = await app("/ui");
    const s = sep(pg);
    const ev = (type: string, x: number) => { const e = new (globalThis as any).Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { button: 0, pointerId: 1, clientX: x }); s.dispatchEvent(e); };
    ev("pointerdown", 260); ev("pointermove", 350); await settle();
    expect([width(pg), pg.storage.get("agend_sidebar_w") ?? null], "moving: shown, not kept yet").toEqual(["350px", null]);
    ev("pointermove", 1000); ev("pointerup", 1000); await settle();
    expect([width(pg), pg.storage.get("agend_sidebar_w")]).toEqual(["480px", "480"]);
    s.dispatchEvent(new (globalThis as any).Event("dblclick", { bubbles: true })); await settle();
    expect([width(pg) || null, pg.storage.get("agend_sidebar_w") ?? null]).toEqual([null, null]);
  });

  it("this device's width comes back on a page load — clamped to this window; never sent to the host", async () => {
    posts = [];
    const seen: unknown[] = [];
    for (const [stored, vw] of [["300", undefined], ["999", undefined], ["450", 800]] as const) {
      const pg = await app("/ui", { storage: { agend_sidebar_w: stored }, width: vw });
      seen.push(width(pg));
      await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1);
    }
    expect(seen).toEqual(["300px", "480px", "320px"]);
    expect(posts.filter((p) => JSON.stringify(p).includes("sidebar")), "not a synced preference").toEqual([]);
    // (#1629 r4-4's widget.sidebar is a synced widget, not a width: the width is this device's agend_sidebar_w.)
    expect(Object.keys(prefs.SYNCED).some((k: string) => /width/.test(k)) || Object.values(prefs.SYNCED).some((v: any) => v.ls === "agend_sidebar_w")).toBe(false);
  });

  it("a phone (the drawer): no kept width applies", async () => {
    const pg = await app("/ui", { storage: { agend_sidebar_w: "400" }, narrow: true });
    expect(width(pg) || null).toBe(null);
    expect(appCss).toMatch(/@media \(max-width: 899px\) \{ \.side-resize \{ display: none; \} \}/);
  });
});

describe("review r1: the room beside the usage rail; a drag's own lifecycle", () => {
  /** The media a wide window answers: the rail's ≥ 1200 px, never the phone's ≤ 899 px (unless `phone()` says so). */
  let phone = false;
  const wide = (q: string) => (/max-width:\s*899px/.test(q) ? phone : /min-width:\s*1200px/.test(q) ? !phone : false);
  afterEach(() => { phone = false; });
  const resize = async (pg: AppPage) => { pg.window._fire(new (globalThis as any).Event("resize"), false); await settle(); };
  const ptr = (s: any, type: string, x: number, id = 1) => { const e = new (globalThis as any).Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { button: 0, pointerId: id, clientX: x }); s.dispatchEvent(e); };

  it("at 1200 px with the rail open: End is 400 (main keeps 480); the rail closed, the kept choice (480) comes back; the separator's maximum follows", async () => {
    const pg = await app("/ui/chat/web-dev", { width: 1200, media: wide, storage: { agend_usage_rail: "1" } });   // #1854: shown by choice
    expect(pg.root.querySelector(".u-rail"), "the rail is on screen").not.toBeNull();
    await key(sep(pg), "End");
    const squeezed = [width(pg), sep(pg).getAttribute("aria-valuemax"), pg.storage.get("agend_sidebar_w")];
    const { setUsageRail } = await import("/assets/header-tools.js");
    setUsageRail(false); await settle(4); await new Promise((r) => setTimeout(r, 30)); await settle();
    const roomy = [width(pg), sep(pg).getAttribute("aria-valuemax")];
    setUsageRail(true); await settle(4); await new Promise((r) => setTimeout(r, 30)); await settle();
    expect([squeezed, roomy, width(pg)]).toEqual([["400px", "400", "480"], ["480px", "480"], "400px"]);
  });

  it("r2: a drag past the room beside the rail shows the squeeze (400) but keeps where it went (480) — it comes back when the rail closes", async () => {
    const pg = await app("/ui/chat/web-dev", { width: 1200, media: wide, storage: { agend_usage_rail: "1" } });   // #1854: shown by choice
    expect(pg.root.querySelector(".u-rail"), "the rail is on screen").not.toBeNull();
    ptr(sep(pg), "pointerdown", 260); ptr(sep(pg), "pointermove", 480); await settle();
    const during = width(pg);
    ptr(sep(pg), "pointerup", 480); await settle();
    const kept = [width(pg), pg.storage.get("agend_sidebar_w")];
    const { setUsageRail } = await import("/assets/header-tools.js");
    setUsageRail(false); await settle(4); await new Promise((r) => setTimeout(r, 30)); await settle();
    expect([during, kept, width(pg)]).toEqual(["400px", ["400px", "480"], "480px"]);
  });

  it("control: the same drag with the rail closed keeps 480; a press with no move keeps nothing", async () => {
    const pg = await app("/ui/chat/web-dev", { width: 1200, media: wide, storage: { agend_usage_rail: "0" } });
    expect(pg.root.querySelector(".u-rail"), "no rail").toBeNull();
    ptr(sep(pg), "pointerdown", 260); ptr(sep(pg), "pointerup", 260); await settle();
    const still = pg.storage.get("agend_sidebar_w") ?? null;
    ptr(sep(pg), "pointerdown", 260); ptr(sep(pg), "pointermove", 480); ptr(sep(pg), "pointerup", 480); await settle();
    expect([still, width(pg), pg.storage.get("agend_sidebar_w")]).toEqual([null, "480px", "480"]);
  });

  it("control: 1366 px with the rail, End is 480", async () => {
    const pg = await app("/ui/chat/web-dev", { width: 1366, media: wide });
    await key(sep(pg), "End");
    expect(width(pg)).toBe("480px");
  });

  it("a cancelled drag (pointercancel, a lost capture) keeps nothing and puts back what was shown; only a release keeps", async () => {
    const pg = await app("/ui", { storage: { agend_sidebar_w: "300" } });
    const out = [];
    for (const end of ["pointercancel", "lostpointercapture"]) {
      ptr(sep(pg), "pointerdown", 300); ptr(sep(pg), "pointermove", 350); await settle();
      const during = width(pg);
      ptr(sep(pg), end, 350); await settle();
      out.push([end, during, width(pg), pg.storage.get("agend_sidebar_w"), pg.document.body.classList.contains("side-resizing"), sep(pg).listenerCount("pointermove")]);
    }
    ptr(sep(pg), "pointerdown", 300); ptr(sep(pg), "pointermove", 350); ptr(sep(pg), "pointerup", 350); await settle();
    out.push(["pointerup", null, width(pg), pg.storage.get("agend_sidebar_w"), pg.document.body.classList.contains("side-resizing"), sep(pg).listenerCount("pointermove")]);
    expect(out).toEqual([
      ["pointercancel", "350px", "300px", "300", false, 0], ["lostpointercapture", "350px", "300px", "300", false, 0], ["pointerup", null, "350px", "350", false, 0]]);
  });

  it("the window turns into a phone mid-drag: the drag is cancelled — the desktop choice is kept, and later events of it write nothing", async () => {
    const pg = await app("/ui", { storage: { agend_sidebar_w: "300" }, media: wide });
    const s = sep(pg);
    ptr(s, "pointerdown", 300); ptr(s, "pointermove", 350); await settle();
    phone = true; await resize(pg);
    ptr(s, "pointermove", 210); ptr(s, "pointerup", 210); await settle();
    expect([width(pg) || null, pg.storage.get("agend_sidebar_w"), pg.document.body.classList.contains("side-resizing")]).toEqual([null, "300", false]);
  });

  it("unmounted mid-drag: the page is left clean (no resizing class), nothing kept, its old handle writes nothing", async () => {
    const pg = await app("/ui", { storage: { agend_sidebar_w: "300" } });
    const s = sep(pg);
    ptr(s, "pointerdown", 300); ptr(s, "pointermove", 360); await settle();
    await pg.unmount();
    ptr(s, "pointermove", 420); ptr(s, "pointerup", 420); await settle();
    const left = ["pointermove", "pointerup", "pointercancel", "lostpointercapture"].map((t) => s.listenerCount(t));
    expect([pg.document.body.classList.contains("side-resizing"), pg.storage.get("agend_sidebar_w"), left]).toEqual([false, "300", [0, 0, 0, 0]]);
  });
});

describe("review r1: the avatar's initial follows the leading name", () => {
  it("no picture (and the server's own initial): R for Riley, A for agend-reviewer-t1 when the real name leads; an emoji stays", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    const items = [
      { name: "agend-reviewer-t1", display_name: "Riley" },
      { name: "agend-reviewer-t2", display_name: "Riley", avatar: { kind: "initial", text: "R" } },
      { name: "agend-reviewer-t3", display_name: "Riley", avatar: { kind: "emoji", text: "🦊" } },
    ];
    const initials = async () => {
      await pg.mount(h("div", null, items.map((it) => h(nav.InstanceAvatar, { key: it.name, it, state: "idle" })))); await settle();
      return pg.root.querySelectorAll(".av").map((a: any) => a.querySelector(".av-text")?.textContent ?? null);
    };
    const nick = await initials();
    nav.namesStore.set({ primary: "instance" });
    const real = await initials();
    expect([nick, real]).toEqual([["R", "R", "🦊"], ["A", "A", "🦊"]]);
  });
});

describe("the row: a star slot, the CLI on the avatar", () => {
  it("the ☆ is its own slot after the row link — never inside it, never placed over it", async () => {
    const pg = await app("/ui");
    const li = rowOf(pg, "agend-reviewer-t1").parentNode;
    expect(li.children.map((c: any) => c.className.split(" ").find((k: string) => k === "inst" || k === "inst-star"))).toEqual(["inst", "inst-star"]);
    expect(rowOf(pg, "agend-reviewer-t1").querySelector(".inst-star")).toBeNull();
    expect(appCss).toMatch(/\.v-li \{ display: flex;/);
    const starRules = [...appCss.matchAll(/([^{}]*\.inst-star[^{}]*)\{([^}]*)\}/g)].map((m) => m[2]);
    expect(starRules.some((r) => /position:\s*(absolute|fixed)/.test(r)), "no rule lifts the star out of the row").toBe(false);
    // Hidden until hover or focus by visibility (its width stays reserved), not display — on a desktop.
    expect(appCss).toMatch(/\.inst-nav:not\(\.fav-editing\) \.inst-star:not\(\.on\) \{ visibility: hidden; \}/);
    // #2179 (B5): the context figure ends the name's line (the reply time ends the second); nothing after the row's text.
    expect(rowOf(pg, "agend-reviewer-t1").children.map((c: any) => c.className.split(" ")[0]).at(-1), "nothing after the row's text").toBe("inst-text");
    expect(rowOf(pg, "agend-reviewer-t1").querySelector(".inst-line").children.map((c: any) => c.className.split(" ")[0]).at(-1), "nothing after the context figure").toBe("v-meta");
  });

  it("the CLI is announced: in the row's text for a screen reader (en and zh-TW), a letter on the avatar for the eye", async () => {
    const pg = await app("/ui");
    const r = rowOf(pg, "agend-reviewer-t1");
    expect([r.querySelector(".inst-text .sr-only").textContent, r.querySelector(".av-cli").textContent, r.querySelector(".av-cli").getAttribute("aria-hidden")])
      .toEqual(["Backend: Codex", "X", "true"]);
    expect(r.textContent).toContain("Backend: Codex");
    i18n.setLang("zh-TW"); await settle(3);
    expect(rowOf(pg, "agend-reviewer-t1").querySelector(".inst-text .sr-only").textContent).toBe("後端：Codex");
  });
});

describe("both names, and which one leads", () => {
  it("nickname first by default: the nickname, the instance name under it; one line when they are the same or there is no nickname", async () => {
    const pg = await app("/ui");
    expect([names(pg, "agend-reviewer-t1"), names(pg, "web-dev"), names(pg, "plain")]).toEqual([["Alice", "agend-reviewer-t1"], ["web-dev", null], ["plain", null]]);
    expect([rowOf(pg, "agend-reviewer-t1").querySelector(".inst-name").getAttribute("title"), rowOf(pg, "agend-reviewer-t1").querySelector(".inst-alt").getAttribute("title")]).toEqual(["Alice", "agend-reviewer-t1"]);
  });

  it("the preference switches every surface — the sidebar, the chat header, Needs you — and back; it is kept on the host", async () => {
    const pg = await app("/ui/chat/agend-reviewer-t1");
    const header = () => pg.root.querySelector(".panel-title h1");
    const before = [names(pg, "agend-reviewer-t1"), header().textContent, header().querySelector("span")?.getAttribute("title") ?? null];
    posts = [];
    nav.setNamesPrimary("instance"); await settle(4);
    const after = [names(pg, "agend-reviewer-t1"), header().textContent, header().querySelector("span")?.getAttribute("title") ?? null];
    await new Promise((r) => setTimeout(r, 500));                      // the write (a 400 ms burst) goes out
    const kept = posts.map((p) => p.set);
    router.navigate("/ui/needs"); await settle(6);
    const needsHead = pg.root.querySelector(".n-group-head a").textContent;
    nav.setNamesPrimary("nickname"); await settle(4);
    const needsBack = pg.root.querySelector(".n-group-head a").textContent;
    expect([before, after, needsHead, needsBack]).toEqual([
      [["Alice", "agend-reviewer-t1"], "Alice", "agend-reviewer-t1"],
      [["agend-reviewer-t1", "Alice"], "agend-reviewer-t1", "Alice"],
      "agend-reviewer-t1", "Alice",
    ]);
    expect(kept).toContainEqual({ "names.primary": "instance" });
  });

  it("another device's choice arrives: every surface here follows", async () => {
    await new Promise((r) => setTimeout(r, 600));   // a write of this page's still out holds its key (#1665): let it land
    const pg = await app("/ui/chat/agend-reviewer-t1");
    host = { "names.primary": "instance" }; rev += 10;
    await prefs.refresh(); await settle(4);
    expect([names(pg, "agend-reviewer-t1")[0], pg.root.querySelector(".panel-title h1").textContent]).toEqual(["agend-reviewer-t1", "agend-reviewer-t1"]);
    host = {}; rev += 10;
    await prefs.refresh(); await settle(4);
    expect(names(pg, "agend-reviewer-t1")[0]).toBe("Alice");
  });

  it("the chat header of an instance whose names are the same: one name, no hover twin", async () => {
    const pg = await app("/ui/chat/web-dev");
    const h1 = pg.root.querySelector(".panel-title h1");
    expect([h1.textContent, h1.querySelector("span")]).toEqual(["web-dev", null]);
  });

  it("Settings' device preferences offer it (en / zh-TW labels), and choosing sets it", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    await pg.mount(h(shell.DevicePrefs, { labels: true }));
    const sel = pg.root.querySelectorAll("select").find((s: any) => s.getAttribute("aria-label") === "Names");
    expect(sel.querySelectorAll("option").map((o: any) => [o.value, o.textContent])).toEqual([["nickname", "Nickname first"], ["instance", "Real name first"]]);
    sel.value = "instance"; fire(sel, "change"); await settle();
    await new Promise((r) => setTimeout(r, 600));   // the prefs burst (400 ms) posts before the next test's page
    expect([nav.namesStore.get().primary, host["names.primary"]]).toEqual(["instance", "instance"]);
  });
});
