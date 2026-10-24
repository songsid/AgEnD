/**
 * #2585 (the user): settings-like editors docked on the right. On a wide screen (the usage rail's, min-width 1200px) a
 * SidePanel opens in the rail's place beside the page — a non-modal dialog, the owner's state live in it; the rail steps
 * aside and comes back as it was; ×, Esc and the owner's own buttons close it (never while busy); focus goes into it
 * and back to what opened it; the owner going (a navigation) takes it along. Narrower, the same editor is the shared
 * Dialog (modal, centred). Edit offices is the first editor there (fleet-office-editor.js).
 *
 * The app's real Shell and router in the fake DOM; the Fleet page is a stub owning one SidePanel.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
async function fakeFetch(url: string) {
  const body: unknown = url.startsWith("/api/ai-usage") ? { providers: [], fetchedAt: Date.now() } : url.startsWith("/ui/") ? [] : {};
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}
let SP: any, hooks: any, tools: any, LE: any, SK: any, conf: any, shell: any;
let closes = 0;
/** What the stub page's SidePanel is this time: a fallback instead of the Dialog, not docking, holding changes; or Edit layout itself. */
let mode: { fallback?: boolean; dock?: boolean; dirty?: boolean; layout?: boolean } = {};
beforeAll(async () => {
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  SP = await import("/assets/side-panel.js");
  hooks = await import("/assets/app-html.js");
  tools = await import("/assets/header-tools.js");
  LE = await import("/ui/js/fleet-office-layout.js");
  SK = await import("/ui/js/fleet-office-skin.js");
  conf = await import("/assets/ui-confirm.js");
  shell = await import("/assets/app-shell.js");
  base.restore();
});
async function unmountAll() { for (const p of mounted.splice(0).reverse()) { await p.unmount(); p.restore(); } }
afterEach(async () => { shell.closeDialog(); await unmountAll(); closes = 0; mode = {}; for (const q of conf.confirmStore.get().queue) conf.answerConfirm(q.id, false); });

/** The Fleet page: an opener, and a SidePanel whose body carries the page's own state (a count, a busy switch). */
function StubFleet() {
  const [open, setOpen] = hooks.useState(false), [n, setN] = hooks.useState(0), [busy, setBusy] = hooks.useState(false);
  const close = () => { closes++; setOpen(false); };
  if (mode.layout) {
    return h("div", { class: "panel stub-fleet" }, h("button", { type: "button", id: "opener", onClick: () => setOpen(true) }, "Edit layout"),
      open ? h("div", { class: "oo-stage" }, h(LE.LayoutEditor, { base: SK.STUDIO_PACK, start: SK.STUDIO_PACK, dock: mode.dock !== false, onChange() {}, onSave: async () => ({ ok: true }), onClose: close })) : null);
  }
  return h("div", { class: "panel stub-fleet" },
    h("button", { type: "button", id: "opener", onClick: () => setOpen(true) }, "Edit things"),
    open ? h(SP.SidePanel, { title: "Edit things", busy, onClose: close, dirty: !!mode.dirty, ...(mode.dock === false ? { dock: false } : {}),
      ...(mode.fallback ? { fallback: h("div", { class: "stub-inline" }, "inline controls") } : {}),
      actions: h("button", { type: "button", id: "spSave", onClick: () => setOpen(false) }, "Save") },
    h("button", { type: "button", id: "spInc", onClick: () => setN(n + 1) }, `count ${n}`),
    h("button", { type: "button", id: "spBusy", onClick: () => setBusy(!busy) }, busy ? "busy" : "idle")) : null);
}
const PANELS = () => new Map([
  ["fleet", { Component: StubFleet }], ["settings", { Component: () => h("div", { class: "stub-settings" }, "settings") }],
  ["needs", { Component: () => h("div", { class: "stub-needs" }, "needs") }],
]);
async function app(wide: boolean) {
  await unmountAll();
  const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/org", storage: { agend_tour_done: "1", agend_usage_rail: "1" } });
  mounted.push(pg);
  (globalThis as any).matchMedia = (q: string) => ({ matches: /min-width: 1200px/.test(q) ? wide : false, addEventListener() {}, removeEventListener() {} });
  (globalThis as any).fetch = fakeFetch;
  pg.document.body.dataset.usagePanel = "1";
  const { startRouter } = await import("/assets/app-nav.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  tools.initUsageRail();
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return pg;
}
const q = (pg: AppPage, sel: string) => pg.root.querySelector(sel);
const docked = (pg: AppPage) => q(pg, ".shell > dialog.side-panel");
const open = async (pg: AppPage) => { const b = q(pg, "#opener"); b.focus(); b.click(); await settle(4); };

describe("#2585: a docked side panel in the usage rail's place (wide screen)", () => {
  it("opens beside the page, not modal, in the rail's place; the owner's state is live in it; × closes it, the rail back as it was, focus back", async () => {
    const pg = await app(true);
    expect([!!q(pg, ".shell > aside.u-rail"), docked(pg)]).toEqual([true, null]);
    await open(pg);
    const d = docked(pg);
    expect(d, "docked").not.toBe(null);
    expect([d.open, d.getAttribute("data-trust"), d.getAttribute("aria-label"), q(pg, ".side-panel .dlg-title").textContent]).toEqual([true, "dialog", "Edit things", "Edit things"]);
    expect([q(pg, ".shell > aside.u-rail"), q(pg, "main#main dialog"), pg.root.querySelectorAll("dialog").length], "the rail steps aside; no modal dialog").toEqual([null, null, 1]);
    expect(pg.document.activeElement, "focus moves into the panel").toBe(q(pg, ".side-panel .dlg-box"));
    q(pg, "#spInc").click(); await settle(4);
    q(pg, "#spInc").click(); await settle(4);
    expect(q(pg, ".side-panel #spInc").textContent, "the owner's state, live").toBe("count 2");
    expect(!!q(pg, ".side-panel .dlg-actions #spSave")).toBe(true);
    q(pg, ".side-panel .dlg-x").click(); await settle(6);
    expect([docked(pg), !!q(pg, ".shell > aside.u-rail"), pg.storage.get("agend_usage_rail"), closes]).toEqual([null, true, "1", 1]);
    expect(pg.document.activeElement, "focus back to the opener").toBe(q(pg, "#opener"));
  });
  it("Esc in the panel closes it; busy, neither Esc nor × does; the owner's own button closes it too", async () => {
    const pg = await app(true);
    await open(pg);
    q(pg, "#spBusy").click(); await settle(4);
    fire(q(pg, ".side-panel .dlg-box"), "keydown", { key: "Escape", bubbles: true }); await settle(4);
    q(pg, ".side-panel .dlg-x").click(); await settle(4);
    expect([!!docked(pg), closes], "busy: still open").toEqual([true, 0]);
    q(pg, "#spBusy").click(); await settle(4);
    fire(q(pg, ".side-panel .dlg-box"), "keydown", { key: "Escape", bubbles: true }); await settle(6);
    expect([docked(pg), closes]).toEqual([null, 1]);
    await open(pg);
    q(pg, "#spSave").click(); await settle(6);
    expect([docked(pg), !!q(pg, ".shell > aside.u-rail")]).toEqual([null, true]);
  });
  it("a navigation away takes it along (the owner goes), and the rail comes back", async () => {
    const pg = await app(true);
    await open(pg);
    expect(!!docked(pg)).toBe(true);
    const { navigate } = await import("/assets/app-nav.js");
    navigate("/ui/needs"); await settle(8);
    expect([docked(pg), SP.sidePanelStore.get().panel]).toEqual([null, null]);
  });
  it("a narrower screen: the same editor is the shared Dialog (modal, wide), nothing docked, the rail's place untouched", async () => {
    const pg = await app(false);
    await open(pg);
    const d = q(pg, "dialog.dlg");
    expect([docked(pg), !!d, d.getAttribute("class"), d.open, !!q(pg, "dialog.dlg #spInc")]).toEqual([null, true, "dlg dlg-wide", true, true]);
    expect(SP.sidePanelStore.get().panel).toBe(null);
  });
  it("Edit offices is a SidePanel; the docked panel is drawn only at the rail's width (CSS)", () => {
    const editor = readFileSync(new URL("../src/ui/fleet-office-editor.js", import.meta.url), "utf8");
    expect(editor).toContain('return html`<${SidePanel} title=${te("title")}');
    expect(editor).not.toMatch(/<\$\{Dialog\}/);
    const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
    expect(css).toContain("@media (max-width: 1199px) { .dlg.side-panel { display: none; } }");
    expect(css).toMatch(/\.dlg\.side-panel \{ position: static;[^}]*width: 400px;/);
    // A toast beside a docked panel, not over its actions.
    expect(css).toContain("@media (min-width: 1200px) { .shell:has(> .side-panel) .toasts { right: calc(400px + var(--s-6)); } }");
  });
  it("`fallback`: below the rail's width it is that, not the Dialog; `dock` false keeps a wide screen from docking (the Office in fullscreen)", async () => {
    mode = { fallback: true };
    let pg = await app(false);
    await open(pg);
    expect([docked(pg), pg.root.querySelector("dialog"), !!q(pg, "main#main .stub-inline"), SP.sidePanelStore.get().panel]).toEqual([null, null, true, null]);
    mode = { fallback: true, dock: false };
    pg = await app(true);
    await open(pg);
    expect([docked(pg), !!q(pg, ".shell > aside.u-rail"), !!q(pg, "main#main .stub-inline"), SP.sidePanelStore.get().panel]).toEqual([null, true, true, null]);
  });
  it("holding changes, leaving the page asks first: No stays (panel open, same page); Yes closes it as Cancel does and goes on", async () => {
    mode = { dirty: true };
    const pg = await app(true);
    (globalThis as any).confirm = undefined;                 // the harness answers nothing: this test does (app-harness.ts)
    await open(pg);
    const { navigate, navStore } = await import("/assets/app-nav.js");
    navigate("/ui/needs"); await settle(6);
    const asked = conf.confirmStore.get().queue;
    expect([asked.length, asked[0]?.message, asked[0]?.confirmLabel, asked[0]?.danger]).toEqual([1, "Leave Edit things without saving? Your changes there will be lost.", "Discard changes", true]);
    navigate("/ui/needs"); await settle(4);
    expect(conf.confirmStore.get().queue.length, "asked once, not again while asking").toBe(1);
    conf.answerConfirm(asked[0].id, false); await settle(6);
    expect([navStore.get().route.panel, !!docked(pg), closes]).toEqual(["fleet", true, 0]);
    navigate("/ui/needs"); await settle(6);
    conf.answerConfirm(conf.confirmStore.get().queue[0].id, true); await settle(8);
    expect([navStore.get().route.panel, docked(pg), closes, SP.sidePanelStore.get().panel]).toEqual(["needs", null, 1, null]);
  });
  it("no changes: leaving the page asks nothing and takes the panel along", async () => {
    const pg = await app(true);
    await open(pg);
    const { navigate, navStore } = await import("/assets/app-nav.js");
    navigate("/ui/needs"); await settle(8);
    expect([conf.confirmStore.get().queue.length, navStore.get().route.panel, docked(pg)]).toEqual([0, "needs", null]);
  });
  it("Ctrl+K: search opens beside a docked panel (the page is in use), never over a modal dialog", async () => {
    const ev = () => ({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, prevented: 0, preventDefault() { this.prevented++; } });
    let pg = await app(true);
    await open(pg);
    expect(!!docked(pg)).toBe(true);
    // A browser reflects the open property as the attribute (the fake DOM does not): as the page has it, so `dialog[open]` matches it.
    docked(pg).setAttribute("open", "");
    expect(pg.document.querySelectorAll("dialog[open]").length).toBe(1);
    const k = ev(); shell.handleSearchKey(k);
    expect(k.prevented, "search opens").toBe(1);
    await vi.waitFor(() => expect(shell.shellStore.get().dialog?.props?.preset).toEqual({}));   // loaded, then shown
    expect(!!docked(pg), "the panel stays docked under it").toBe(true);
    shell.closeDialog(); await settle(4);
    pg = await app(false);
    await open(pg);
    expect(!!q(pg, "dialog.dlg")).toBe(true);
    const blocked = ev(); shell.handleSearchKey(blocked);
    expect(blocked.prevented, "over the modal Dialog: no").toBe(0);
  });
  it("Edit layout docked: its controls in the panel (Reset, Cancel, Save its actions), the handles still on the canvas; Esc on a handle cancels", async () => {
    mode = { layout: true };
    const pg = await app(true);
    await open(pg);
    expect(!!docked(pg)).toBe(true);
    expect([q(pg, ".side-panel .dlg-title").textContent, !!q(pg, ".side-panel .ol-side .ol-add"), !!q(pg, ".side-panel .ol-side .ol-coords"),
      [...pg.root.querySelectorAll(".side-panel .dlg-actions button")].map((b: any) => b.className.split(" ").pop())]).toEqual(["Edit layout", true, true, ["ol-reset", "ol-cancel", "ol-save"]]);
    expect([!!q(pg, "main#main .oo-stage .ol-svg"), q(pg, ".ol-bar"), q(pg, ".side-panel .ol-svg")]).toEqual([true, null, null]);
    q(pg, ".side-panel .ol-add").click(); await settle(4);
    expect(q(pg, ".side-panel .ol-sel").textContent, "the selection, read in the panel").toMatch(/,/);
    fire(q(pg, "main#main [data-handle]"), "keydown", { key: "Escape", bubbles: true }); await settle(8);
    expect(conf.confirmStore.get().queue.length, "Esc is Cancel: it asks nothing").toBe(0);
    expect([docked(pg), closes, q(pg, ".ol")]).toEqual([null, 1, null]);
  });
  it("Edit layout below the rail's width, or not docking: the bar over the canvas as before", async () => {
    for (const [wide, dock] of [[false, true], [true, false]] as const) {
      mode = { layout: true, dock };
      const pg = await app(wide);
      await open(pg);
      expect([docked(pg), pg.root.querySelector("dialog"), !!q(pg, "main#main .oo-stage .ol-bar .ol-save"), !!q(pg, "main#main .ol-bar .ol-add")], `wide ${wide}, dock ${dock}`)
        .toEqual([null, null, true, true]);
      fire(q(pg, ".ol-bar .ol-add"), "keydown", { key: "Escape", bubbles: true }); await settle(6);
      expect(q(pg, ".ol"), "Esc cancels here too").toBe(null);
    }
  });
});
