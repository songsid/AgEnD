/**
 * #1673: AI usage is a right rail beside the page on a wide screen (min-width 1200px), the dialog's own body (one read,
 * one view), on the pages whose header has ◔. ◔ shows or hides it; that choice is this device's (agend_usage_rail) and
 * survives a reload. A hidden rail reads nothing; an open one keeps one lease across navigation. A fleet with
 * web.usage_panel: false has neither rail nor ◔. On a narrower screen ◔ opens the dialog, as before — and crossing the
 * width switches at once.
 *
 * The app's real Shell, router and panels in the fake DOM; /api/ai-usage is a fake that counts its reads.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const USAGE = { providers: [{ id: "claude", name: "Claude", status: "ok", plan: "Max", metrics: [{ type: "percent", label: "5-hour", used: 42 }] }], fetchedAt: Date.now() };
let usageReads = 0;
async function fakeFetch(url: string) {
  if (url.startsWith("/api/ai-usage")) usageReads++;
  const body: unknown = url.startsWith("/ui/instance/") ? { name: "web-dev", status: "running", kind: "agent", working_directory: "/w", tags: [], binding: { channel_id: null, implicit: false, topic_id: null, general_topic: false }, statusline: {}, recent_activity: [] }
    : url === "/api/profiles" ? [{ instance_name: "web-dev", status: "running", backend: "claude-code", tags: [] }]
    : url.startsWith("/api/ai-usage") ? USAGE : url.startsWith("/ui/") ? [] : {};
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

let chat: any, details: any, fleet: any, view: any, log: any, tools: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  chat = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  details = await import("../src/ui/panel-details.js");
  // @ts-expect-error — a JS module of the app, with no types
  fleet = await import("../src/ui/panel-fleet.js");
  // @ts-expect-error — a JS module of the app, with no types
  log = await import("../src/ui/panel-log.js");
  view = await import("/assets/panel-view.js");
  tools = await import("/assets/header-tools.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
  base.restore();
});
// One page at a time, as a reload is: the rail's store is the page's module state, shared by every mounted page.
async function unmountAll() { for (const p of mounted.splice(0).reverse()) { await p.unmount(); p.restore(); } }
afterEach(async () => { await unmountAll(); usageReads = 0; });

/** A screen whose width the test sets; the page's matchMedia answers the rail's query from it and reports changes. */
function screen(wide: boolean) {
  const listeners = new Set<() => void>();
  const s = {
    wide,
    set(next: boolean) { s.wide = next; for (const fn of [...listeners]) fn(); },
    matchMedia: (q: string) => ({
      get matches() { return /min-width: 1200px/.test(q) ? s.wide : /max-width: 899px/.test(q) ? false : false; },
      addEventListener: (_t: string, fn: () => void) => listeners.add(fn), removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
    }),
  };
  return s;
}

const PANELS = () => new Map([
  ["chat", { load: async () => chat.ChatPanel }], ["details", { load: async () => details.DetailsPanel }],
  ["fleet", { load: async () => fleet.FleetPanel }], ["view", { load: async () => view.ViewPanel }], ["log", { load: async () => log.LogPanel }],
  ["settings", { Component: () => h("div", { class: "stub-settings" }, "settings") }], ["needs", { Component: () => h("div", { class: "stub-needs" }, "needs") }],
]);
async function app(path: string, opts: { wide?: boolean; storage?: Record<string, string>; usagePanel?: string; scr?: ReturnType<typeof screen> } = {}) {
  await unmountAll();
  usageReads = 0;
  // #1854: an unset choice is hidden now; these tests are about a device that shows the rail ("1") unless they say otherwise.
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1", agend_usage_rail: "1", ...(opts.storage ?? {}) } });
  for (const [k, v] of Object.entries(opts.storage ?? {})) if (v === UNSET) pg.storage.delete(k);
  mounted.push(pg);
  const scr = opts.scr ?? screen(opts.wide ?? true);
  (globalThis as any).matchMedia = scr.matchMedia;
  (globalThis as any).fetch = fakeFetch;
  pg.document.body.dataset.usagePanel = opts.usagePanel ?? "1";
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { viewStore } = await import("/assets/view-roster-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code", model: "opus", context_pct: 10, tags: [], execution_state: "idle" }] });
  viewStore.set({ loaded: true, error: null, roster: [{ instance_name: "web-dev", status: "running", backend: "claude-code", tags: [] }] });
  tools.initTextSize(); tools.initUsageRail();          // what app.js does on a page load
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return { pg, scr };
}
/** A storage value that means "never chosen": the key is removed before the page loads. */
const UNSET = "\u0000unset";
const go = async (path: string) => { const { navigate } = await import("/assets/app-nav.js"); navigate(path); await settle(8); };
const rail = (pg: AppPage) => pg.root.querySelector("aside.u-rail") !== null;
const hasDialog = (pg: AppPage) => pg.root.querySelector("dialog") !== null;
const railRows = (pg: AppPage) => (pg.root.querySelectorAll("aside.u-rail .u-provider") as any[]).map(s => s.textContent);
const dialogRows = (pg: AppPage) => (pg.root.querySelectorAll("dialog .u-provider") as any[]).map(s => s.textContent);
const usageBtn = (pg: AppPage) => pg.root.querySelector(".panel-head .hd-usage");

describe("#1673: a wide screen shows usage as a rail beside the page", () => {
  it("on Chat, View, Log, Details and Fleet — the dialog's rows — and not on Settings or Needs you", async () => {
    const { pg } = await app("/ui/chat/web-dev");
    for (const path of ["/ui/chat/web-dev", "/view/web-dev", "/ui/log/web-dev", "/ui/fleet/agent/web-dev", "/ui/fleet/org"]) {
      if (path !== "/ui/chat/web-dev") await go(path);
      expect(rail(pg), path).toBe(true);
      expect(railRows(pg), path).toHaveLength(1);
      expect(railRows(pg)[0], path).toContain("Claude");
      expect(railRows(pg)[0], path).toContain("42");
      expect(pg.root.querySelector("main#main aside.u-rail") === null, "beside the page, not inside it").toBe(true);
      expect(usageBtn(pg)?.getAttribute("aria-pressed"), path).toBe("true");
    }
    for (const path of ["/settings", "/ui/needs"]) { await go(path); expect(rail(pg), path).toBe(false); }
  });

  // The user's report (beta.11): the rail was missing on Log, so the page jumped, and ◔ there turned off a rail that
  // was not shown — back on Chat it was gone.
  it("one frame on every tab: switching Chat → View → Log → Details → Chat keeps the rail as this device chose it; ◔ on Log hides the rail it shows", async () => {
    const TABS = ["/ui/chat/web-dev", "/view/web-dev", "/ui/log/web-dev", "/ui/fleet/agent/web-dev", "/ui/chat/web-dev"];
    for (const stored of ["1", "0", UNSET]) {
      const { pg } = await app("/ui/chat/web-dev", { storage: { agend_usage_rail: stored } });
      for (const path of TABS) {
        if (path !== TABS[0] || pg.window.location.pathname !== path) await go(path);
        expect([rail(pg), usageBtn(pg)?.getAttribute("aria-pressed"), pg.storage.get("agend_usage_rail") ?? null], `${stored} ${path}`)
          .toEqual([stored === "1", stored === "1" ? "true" : "false", stored === UNSET ? null : stored]);
      }
    }
    const { pg } = await app("/ui/log/web-dev");
    usageBtn(pg).click(); await settle(4);
    expect([rail(pg), pg.storage.get("agend_usage_rail")]).toEqual([false, "0"]);
    await go("/ui/chat/web-dev");
    expect([rail(pg), usageBtn(pg).getAttribute("aria-pressed")]).toEqual([false, "false"]);
    await go("/ui/log/web-dev");
    usageBtn(pg).click(); await settle(4);
    expect([rail(pg), pg.storage.get("agend_usage_rail")]).toEqual([true, "1"]);
  });

  it("the header's controls have one shape on every tab: Aa (every size's name in one cell, the current one shown), ◔, then one 36 px control — Log keeps that room empty", async () => {
    const { pg } = await app("/ui/chat/web-dev");
    const shapes: string[] = [];
    for (const path of ["/ui/chat/web-dev", "/view/web-dev", "/ui/log/web-dev", "/ui/fleet/agent/web-dev"]) {
      if (path !== "/ui/chat/web-dev") await go(path);
      const kids = [...pg.root.querySelector(".panel-head .panel-actions").children] as any[];
      const kind = (e: any) => e.classList.contains("hd-text") ? "Aa" : e.classList.contains("hd-usage") ? "usage"
        : e.classList.contains("menu") || e.classList.contains("icon-btn") ? "36" : e.tagName;
      shapes.push(kids.map(kind).join(" "));
      const names = [...pg.root.querySelectorAll(".panel-head .hd-text .hd-text-names > span")] as any[];
      expect(names.map(n => n.textContent), path).toEqual(["Fit", "S", "M", "L"]);
      expect(names.filter(n => n.classList.contains("on")).map(n => n.textContent), path).toEqual([path.startsWith("/view/") ? "Fit" : "M"]);
      const tabs = [...pg.root.querySelectorAll(".panel-head .inst-switch .seg-item")] as any[];
      expect(tabs.map(a => a.getAttribute("data-label") === a.textContent), path).toEqual([true, true, true, true]);
      const slot = pg.root.querySelector(".panel-head .hd-slot");
      expect(slot ? [slot.getAttribute("aria-hidden"), slot.tagName, slot.textContent, slot.classList.contains("icon-btn")] : null, path)
        .toEqual(path.startsWith("/ui/log/") ? ["true", "SPAN", "", true] : null);
    }
    expect(shapes).toEqual(Array(4).fill("Aa usage 36"));
  });

  it("what keeps those sizes in the stylesheet: the names share one cell; each tab reserves its label in the current tab's weight; one gap on every page; the slot is unseen", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
    const rule = (sel: string) => { const i = css.indexOf(`${sel} {`); return i < 0 ? null : css.slice(i + sel.length + 2, css.indexOf("}", i)).trim(); };
    expect(rule(".hd-text-names")).toBe("display: inline-grid;");
    expect(rule(".hd-text-names > span")).toBe("grid-area: 1 / 1; visibility: hidden;");
    expect(rule(".hd-text-names > .on")).toBe("visibility: visible;");
    expect(rule(".inst-switch .seg-item")).toContain("flex-direction: column;");
    expect(rule(".inst-switch .seg-item")).toContain("gap: 0;");
    for (const d of ["content: attr(data-label);", "font-weight: var(--fw-semibold);", "height: 0;", "visibility: hidden;"]) expect(rule(".inst-switch .seg-item::after"), d).toContain(d);
    expect(rule(".seg-item.active")).toContain("font-weight: var(--fw-semibold);");
    expect([rule(".panel-actions .btn"), rule(".p-view .panel-actions .btn")]).toEqual(["gap: var(--s-1);", null]);
    expect(rule(".hd-slot")).toContain("visibility: hidden;");
  });

  it("the rail's rows are the dialog's rows (one body)", async () => {
    const wide = await app("/ui/chat/web-dev");
    const inRail = railRows(wide.pg);
    const narrow = await app("/ui/chat/web-dev", { wide: false });
    usageBtn(narrow.pg).click(); await settle(8);
    expect(dialogRows(narrow.pg)).toEqual(inRail);
  });

  it("◔ hides it and shows it again; the choice is this device's, kept across a reload; the rail's own button hides it", async () => {
    const { pg } = await app("/ui/chat/web-dev");
    usageBtn(pg).click(); await settle(4);
    expect([rail(pg), pg.storage.get("agend_usage_rail"), usageBtn(pg).getAttribute("aria-pressed"), hasDialog(pg)]).toEqual([false, "0", "false", false]);
    const again = await app("/ui/fleet/org", { storage: Object.fromEntries(pg.storage) });
    expect(rail(again.pg), "a reload keeps it hidden").toBe(false);
    usageBtn(again.pg).click(); await settle(8);
    expect([rail(again.pg), again.pg.storage.get("agend_usage_rail")]).toEqual([true, "1"]);
    again.pg.root.querySelector("aside.u-rail .u-rail-head button").click(); await settle(4);
    expect([rail(again.pg), again.pg.storage.get("agend_usage_rail")]).toEqual([false, "0"]);
  });

  it("a hidden rail reads nothing; an open one keeps its one read across navigation", async () => {
    await app("/ui/chat/web-dev", { storage: { agend_usage_rail: "0" } });
    expect(usageReads, "hidden: no /api/ai-usage read").toBe(0);
    const { pg } = await app("/ui/chat/web-dev");
    expect(usageReads).toBe(1);
    await go("/view/web-dev"); await go("/ui/fleet/org"); await go("/ui/chat/web-dev");
    expect([usageReads, rail(pg)], "the same rail, the same lease: no read per navigation").toEqual([1, true]);
  });
});

describe("#1673: no rail where there is no usage, and the dialog on a narrower screen", () => {
  it("web.usage_panel: false — no rail and no ◔, wide or narrow; no read", async () => {
    for (const wide of [true, false]) {
      const { pg } = await app("/ui/chat/web-dev", { wide, usagePanel: "0" });
      expect([rail(pg), usageBtn(pg) === null, usageReads], String(wide)).toEqual([false, true, 0]);
    }
  });

  it("narrow: no rail; ◔ opens the dialog", async () => {
    const { pg } = await app("/ui/chat/web-dev", { wide: false });
    expect([rail(pg), usageBtn(pg).getAttribute("aria-pressed")]).toEqual([false, null]);
    usageBtn(pg).click(); await settle(8);
    expect([hasDialog(pg), dialogRows(pg)]).toEqual([true, [expect.stringContaining("Claude")]]);
  });

  it("crossing the width switches at once: wide → the rail; narrower → gone, ◔ opens the dialog; wide again → the rail", async () => {
    const { pg, scr } = await app("/ui/chat/web-dev");
    expect(rail(pg)).toBe(true);
    scr.set(false); await settle(6);
    expect(rail(pg)).toBe(false);
    usageBtn(pg).click(); await settle(8);
    expect(hasDialog(pg)).toBe(true);
    pg.root.querySelector("dialog .dlg-x").click(); await settle(4);
    scr.set(true); await settle(8);
    expect([rail(pg), hasDialog(pg), pg.storage.get("agend_usage_rail") ?? null]).toEqual([true, false, "1"]);
  });

  it("a dialog opened on a narrower screen gives way to the rail when the screen widens (never both)", async () => {
    const { pg, scr } = await app("/ui/chat/web-dev", { wide: false });
    usageBtn(pg).click(); await settle(8);
    expect([hasDialog(pg), rail(pg)]).toEqual([true, false]);
    scr.set(true); await settle(8);
    expect([hasDialog(pg), rail(pg), usageReads], "the dialog's read, then the rail's — the closing dialog reads nothing more").toEqual([false, true, 2]);
  });

  // #1679 review (P2): widening closes the dialog for good — hiding the rail and narrowing again never brings it back.
  it.each([["the rail's ✕", "close"], ["◔", "button"]])("dialog → wide → hidden with %s → narrow again: nothing reopens, no third read", async (_n, how) => {
    const { pg, scr } = await app("/ui/chat/web-dev", { wide: false });
    usageBtn(pg).click(); await settle(8);
    scr.set(true); await settle(8);
    if (how === "close") pg.root.querySelector("aside.u-rail .u-rail-head button").click(); else usageBtn(pg).click();
    await settle(4);
    expect([hasDialog(pg), rail(pg)]).toEqual([false, false]);
    scr.set(false); await settle(8);
    expect([hasDialog(pg), rail(pg), usageReads]).toEqual([false, false, 2]);
  });

  it("#1854: a device that never chose starts hidden on every page (a quiet first page); ◔ shows it and remembers \"1\"", async () => {
    const { pg } = await app("/ui/chat/web-dev", { storage: { agend_usage_rail: UNSET } });
    expect([rail(pg), usageBtn(pg)?.getAttribute("aria-pressed"), pg.storage.get("agend_usage_rail") ?? null, usageReads]).toEqual([false, "false", null, 0]);
    usageBtn(pg).click(); await settle(8);
    expect([rail(pg), pg.storage.get("agend_usage_rail")]).toEqual([true, "1"]);
  });

  it("this device's hidden choice is kept: dialog → wide shows neither, and the choice stays \"0\"", async () => {
    const { pg, scr } = await app("/ui/chat/web-dev", { wide: false, storage: { agend_usage_rail: "0" } });
    usageBtn(pg).click(); await settle(8);
    scr.set(true); await settle(8);
    expect([hasDialog(pg), rail(pg), pg.storage.get("agend_usage_rail")]).toEqual([false, false, "0"]);
    scr.set(false); await settle(8);
    expect([hasDialog(pg), rail(pg)]).toEqual([false, false]);
  });
});

describe("#1749: the plan badge is one short line; the full plan stays on it for hover and a screen reader", () => {
  it("planBadge: \"Name [Tier] (N×)\" → \"Name ×N\"; any other label as it is", async () => {
    const { planBadge } = await import("/assets/usage-dialog.js");
    expect(["Team Premium (6.25x)", "Team Standard (1.25x)", "Max (20x)", "Max (5x)", "Max", "Pro", "Plus", "Enterprise Plan", "", null]
      .map((p) => planBadge(p))).toEqual(["Team ×6.25", "Team ×1.25", "Max ×20", "Max ×5", "Max", "Pro", "Plus", "Enterprise Plan", "", ""]);
  });

  it("each row: the short badge on screen, the full plan as its title and for a screen reader; the name keeps its own title", async () => {
    const saved = USAGE.providers;
    USAGE.providers = [
      { id: "claude", name: "Claude", status: "ok", plan: "Team Premium (6.25x)", metrics: [] },
      { id: "claude:work", name: "Claude · work", status: "ok", plan: "Max (20x)", metrics: [] },
      { id: "codex", name: "Codex", status: "ok", plan: "Pro", metrics: [] },
    ] as never;
    try {
      const { pg } = await app("/ui/chat/web-dev");
      const rows = (pg.root.querySelectorAll("aside.u-rail .u-head") as any[]).map((hd) => {
        const pill = hd.querySelector(".pill.u-plan");
        return [hd.querySelector("strong").getAttribute("title"), pill.querySelector("[aria-hidden]").textContent, pill.getAttribute("title"), pill.querySelector(".sr-only").textContent];
      });
      expect(rows).toEqual([
        ["Claude", "Team ×6.25", "Team Premium (6.25x)", "Team Premium (6.25x)"],
        ["Claude · work", "Max ×20", "Max (20x)", "Max (20x)"],
        ["Codex", "Pro", "Pro", "Pro"]]);
    } finally { USAGE.providers = saved; }
  });

  it("the head stays one line: the badge and the name never wrap (each ends in an ellipsis; the name gives way first), ↑↓ never shrink", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/ui/shared/app.css", "utf8");
    const rule = (sel: string) => new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[2] ?? "";
    const has = (sel: string, ...decls: string[]) => decls.every((d) => rule(sel).includes(d));
    expect([has(".u-plan", "white-space: nowrap", "text-overflow: ellipsis", "overflow: hidden", "flex: none", "max-width: 55%"),
      has(".u-head strong", "white-space: nowrap", "text-overflow: ellipsis", "overflow: hidden", "min-width: 0"),
      has(".u-order", "flex: none")]).toEqual([true, true, true]);
  });
});
