/**
 * M-2542: Fleet's tab row. On a desktop (not the phone breakpoint, max-width: 899px) the six tabs are in the header —
 * PanelHeader's nav slot, `nav.fleet-tabs`, between the title and the header tools — and there is no row under it. On
 * a phone they are the `.seg` row under the header, as before, and not in the header. A viewport change moves them
 * across and back. The real Shell, router and Fleet panel in a mini DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const TABS = ["/ui/fleet", "/ui/fleet/schedules", "/ui/fleet/teams", "/ui/fleet/org", "/ui/fleet/cache", "/ui/fleet/usage"];
const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});

/** A matchMedia whose answer the test sets, and whose `change` listeners it can fire (mini-dom's never fire). */
function liveMedia(narrow: boolean) {
  const lists: Array<{ q: string; listeners: Set<() => void> }> = [];
  const media = { narrow };
  const mm = (q: string) => {
    const l = { q, listeners: new Set<() => void>() };
    lists.push(l);
    return { get matches() { return media.narrow && /max-width/.test(q); }, addEventListener: (_: string, f: () => void) => l.listeners.add(f),
      removeEventListener: (_: string, f: () => void) => l.listeners.delete(f) };
  };
  return { mm, set(n: boolean) { media.narrow = n; for (const l of lists) for (const f of l.listeners) f(); } };
}

async function shell(opts: { narrow?: boolean; media?: ReturnType<typeof liveMedia> } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/org", storage: { agend_tour_done: "1" }, matchNarrow: opts.narrow });
  mounted.push(pg);
  if (opts.media) Object.defineProperty(globalThis, "matchMedia", { value: opts.media.mm, configurable: true, writable: true });
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => ({ ok: true, status: 200,
    json: async () => (String(url).startsWith("/ui/org") ? { teams: [], general: null, instances: [] } : []) });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus, appStore } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  // @ts-expect-error — a JS module of the app, with no types
  const { FleetPanel } = await import("../src/ui/panel-fleet.js");
  appStore.set({ viewOnly: false });
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code", tags: [] }] });
  await pg.mount(h(Shell, { panels: new Map<string, unknown>([["fleet", { Component: FleetPanel }]]), onNewInstance() {} }));
  await settle(4);
  return pg;
}

const hrefs = (pg: AppPage, sel: string) => [...pg.root.querySelectorAll(sel)].map((a: any) => a.getAttribute("href"));
/** Where the tab row is: [in the header, under the header], each the tabs' hrefs. */
const placement = (pg: AppPage) => [hrefs(pg, ".p-fleet .panel-head nav.fleet-tabs > a"), hrefs(pg, ".p-fleet > nav.seg > a")];

describe("M-2542: Fleet's tab row", () => {
  it("on a desktop is in the header (the nav slot, before the tools), with no row under it", async () => {
    const pg = await shell();
    expect(placement(pg)).toEqual([TABS, []]);
    const head = pg.root.querySelector(".p-fleet .panel-head") as any;
    const kids = [...head.children].map((e: any) => e.className.split(" ")[0]);
    expect(kids.indexOf("fleet-tabs")).toBeLessThan(kids.indexOf("panel-actions"));
    expect(pg.root.querySelector(".p-fleet nav.fleet-tabs a.active")?.getAttribute("aria-current")).toBe("page");
  });

  it("on a phone is the .seg row under the header, as before, and not in the header", async () => {
    const pg = await shell({ narrow: true });
    expect(placement(pg)).toEqual([[], TABS]);
    expect(pg.root.querySelector(".p-fleet .panel-head nav")).toBeNull();
  });

  it("re-measures on every render: a host memory warning that no longer fits moves the row under the header, and back", async () => {
    // Fable #3266 r2: the warning does not resize the panel (no ResizeObserver/media/fonts event) — only the re-render
    // re-checks. A stubbed layout: the header is 1000 px; the warning's text is 2000 px; everything else 0 px.
    const pg = await shell();
    const proto = Object.getPrototypeOf(pg.root.querySelector(".p-fleet"));
    const realRect = proto.getBoundingClientRect, realCS = (globalThis as any).getComputedStyle;
    proto.getBoundingClientRect = function (this: any) {
      const width = this.className.split(/\s+/).includes("panel-head") ? 1000 : this.className.split(/\s+/).includes("panel-sub") ? 2000 : 0;
      return { top: 0, left: 0, right: width, bottom: 0, width, height: 0 };
    };
    (globalThis as any).getComputedStyle = () => ({});
    try {
      const { appStore } = await import("/assets/app-store.js");
      const seen = [placement(pg)];
      appStore.set({ hostMemory: "critical", hostMemoryTop: [] }); await settle(4); seen.push(placement(pg));
      appStore.set({ hostMemory: null, hostMemoryTop: [] }); await settle(4); seen.push(placement(pg));
      expect(seen).toEqual([[TABS, []], [[], TABS], [TABS, []]]);
    } finally { proto.getBoundingClientRect = realRect; (globalThis as any).getComputedStyle = realCS; }
  });

  it("follows the viewport: desktop → phone → desktop moves the row across and back", async () => {
    const media = liveMedia(false);
    const pg = await shell({ media });
    const seen = [placement(pg)];
    media.set(true); await settle(4); seen.push(placement(pg));
    media.set(false); await settle(4); seen.push(placement(pg));
    expect(seen).toEqual([[TABS, []], [[], TABS], [TABS, []]]);
  });
});

/** A fake laid-out header: widths in px; `scroll` is an element's natural width when its box is narrower (ellipsis). */
function fakeRoot(m: { head: number; pad?: number; gap?: number; title: Array<[number, number?]>; tabs: number[]; tools: number[]; seg?: boolean }) {
  const el = (width: number, kids: any[] = [], extra: any = {}) => ({ getBoundingClientRect: () => ({ width }), scrollWidth: extra.scroll ?? width, children: kids, ...extra });
  const title = el(0, m.title.map(([w, sw]) => el(w, [], { scroll: sw ?? w })), { cls: "title" });
  const nav = el(0, m.tabs.map(w => el(w)), { cls: "nav" });
  const tools = m.tools.map(w => el(w));
  const head = el(m.head, [title, ...(m.seg ? [] : [nav]), ...tools], { cls: "head" });
  const style = new Map<any, any>([[head, { paddingLeft: `${m.pad ?? 16}px`, paddingRight: `${m.pad ?? 16}px`, columnGap: `${m.gap ?? 12}px` }],
    [title, { columnGap: "12px" }], [nav, { columnGap: "4px" }]]);
  const root = { querySelector: (q: string) => q === ".panel-head" ? head : q.startsWith("nav") ? nav : null };
  (head as any).querySelector = (q: string) => (q === ".panel-title" ? title : null);
  return { root, style };
}

describe("M-2542: the header holds the tabs only when everything fits (Prism #3267 r1)", () => {
  const realCS = (globalThis as any).getComputedStyle;
  afterEach(() => { (globalThis as any).getComputedStyle = realCS; });
  const measure = async (m: Parameters<typeof fakeRoot>[0]) => {
    const { root, style } = fakeRoot(m);
    (globalThis as any).getComputedStyle = (e: any) => style.get(e) ?? {};
    // @ts-expect-error — a JS module of the app, with no types
    const { measureTabsFit } = await import("../src/ui/panel-fleet.js");
    return measureTabsFit(root);
  };
  // 6 tabs × 100 + 5 × 4 = 620; title 60; tools 3 × 80 = 240; 4 gaps between the 5 items × 12 = 48 → 968, plus 2 × 16 padding = 1000 px.
  const base = { title: [[60]] as Array<[number, number?]>, tabs: [100, 100, 100, 100, 100, 100], tools: [80, 80, 80] };
  it("fits at exactly the sum, not a pixel less; the row under the header measures the same", async () => {
    expect([await measure({ ...base, head: 1000 }), await measure({ ...base, head: 999 }), await measure({ ...base, head: 1000, seg: true }),
      await measure({ ...base, head: 999, seg: true })]).toEqual([true, false, true, false]);
  });
  it("counts the title's whole text (a host memory warning), not its squeezed box", async () => {
    expect([await measure({ ...base, head: 1300, title: [[60], [20, 500]] }), await measure({ ...base, head: 1300, title: [[60], [20, 200]] })])
      .toEqual([false, true]);
  });
  it("counts every visible header tool, and not hidden ones (0 px)", async () => {
    expect([await measure({ ...base, head: 1000, tools: [80, 80, 80, 40] }), await measure({ ...base, head: 1000, tools: [80, 80, 80, 0] })])
      .toEqual([false, true]);
  });
});

