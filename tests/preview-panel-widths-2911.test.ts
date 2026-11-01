/**
 * #2911 (2), M-2216: the preview panel's page widths (full, tablet 768, phone 390 — this device's choice) and full screen
 * (the Fullscreen API on the panel, else the panel over the window). Chrome only: the frame, its sandbox and CSP are
 * #1306's. The mini DOM has no Fullscreen API, so the fallback runs here; the API itself is the browser smoke's.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fire, installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const BOOT = "e".repeat(32);
let PV: any, panel: any, pp: any, pv: any;
const stream: Record<string, (m: unknown) => void> = {};
let current: AppPage | null = null;
const realFetch = globalThis.fetch;

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
  // @ts-expect-error — a JS module of the app, with no types
  pv = await import("../src/ui/preview-versions.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({
    stream: { on(ev: string, fn: (m: unknown) => void) { stream[ev] = fn; } },
    boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" },
    deps: { fetch: () => new Promise(() => {}) },
  });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  await current?.unmount();
  PV.stopAll("test-end");
  pp.closePanel();
  panel.store.state.msgs.w = [];
  current?.restore();
  current = null;
});

const ts = (id: number) => `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`;
const agent = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: ts(id) });
const human = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "web-user", role: "user", text, ts: ts(id) });
const FENCE = (body: string) => "```html\n" + body + "\n```";
const PAGE = (v: number, title = "Counter") => `<title>${title}</title>\n<h1>v${v}</h1>\n<p>same</p>`;
const k = (x: any) => `${x.boot}-${x.id}`;
const withFile = (id: number, fileId: string, name: string) => ({ ...agent(id, "Here it is."), attachments: [{ id: fileId, kind: "document", name, size: 80, mime: "application/octet-stream" }] });
const ID1 = "1".repeat(32), ID2 = "2".repeat(32);

async function chat(msgs: unknown[]) {
  current = page({ storage: { agend_html_preview: "on", agend_tour_done: "1" } });
  panel.store.state.msgs.w = msgs;
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  (current.document.querySelector(".chat-split") as any).clientWidth = 1200;
  return current.document as any;
}
const cards = (doc: any) => [...doc.querySelectorAll(".msg.agent .html-card")] as any[];
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(); };
const at = (doc: any) => doc.querySelector(".pv-ver-at")?.textContent ?? null;
const shown = () => pp.panelStore.get().open?.key ?? null;


const bodyClass = (doc: any) => doc.querySelector(".pv-panel-body").className;
async function opened(storage: Record<string, string> = {}) {
  current = page({ storage: { agend_html_preview: "on", agend_tour_done: "1", ...storage } });
  panel.store.state.msgs.w = [agent(1, FENCE(PAGE(1)))];
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  (current.document.querySelector(".chat-split") as any).clientWidth = 1200;
  const doc = current.document as any;
  await click(cards(doc)[0].querySelector(".pv-open"));
  return doc;
}
const choose = async (doc: any, v: string) => { const s = doc.querySelector(".pv-width"); s.value = v; fire(s, "change", { bubbles: true }); await settle(); };

describe("the page's width", () => {
  it("full by default; Phone and Tablet set the body's width class; kept for this device; the frame is the same one", async () => {
    const doc = await opened();
    const f = PV.liveFrame(pp.frameKey("b-1:f0"));
    expect([bodyClass(doc), doc.querySelector(".pv-width").value]).toEqual(["pv-panel-body w-full", "full"]);
    await choose(doc, "phone");
    expect([bodyClass(doc), (globalThis as any).localStorage.getItem("agend_preview_panel_device"), PV.liveFrame(pp.frameKey("b-1:f0")) === f])
      .toEqual(["pv-panel-body w-phone", "phone", true]);
    await choose(doc, "tablet");
    expect(bodyClass(doc)).toBe("pv-panel-body w-tablet");
  });
  it("a stored choice is used on the next open; an unknown or unreadable one is full", async () => {
    expect(bodyClass(await opened({ agend_preview_panel_device: "phone" }))).toBe("pv-panel-body w-phone");
    await current!.unmount(); PV.stopAll("x"); pp.closePanel(); current!.restore(); current = null;
    expect(bodyClass(await opened({ agend_preview_panel_device: "watch" }))).toBe("pv-panel-body w-full");
  });
  it("only the page view has it: Code shows the source at the panel's width, without the control", async () => {
    const doc = await opened({ agend_preview_panel_device: "phone" });
    await click([...doc.querySelectorAll(".pv-panel-bar .seg-inline .btn")].find((b: any) => /Code/.test(b.textContent)));
    expect([doc.querySelector(".pv-width"), bodyClass(doc)]).toEqual([null, "pv-panel-body show-code"]);
  });
});

describe("full screen", () => {
  it("without the Fullscreen API: the panel goes over the window (immersive); Esc leaves full screen first, then closes", async () => {
    const doc = await opened();
    const fsBtn = () => doc.querySelector(".pv-panel-fs");
    await click(fsBtn());
    expect([doc.querySelector(".pv-panel").className, fsBtn().getAttribute("aria-pressed"), fsBtn().getAttribute("title")])
      .toEqual(["pv-panel pv-fs pv-fs-immersive", "true", "Leave full screen (Esc)"]);
    const esc = () => doc.querySelector(".pv-panel").dispatchEvent(new (globalThis as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    esc(); await settle();
    expect([doc.querySelector(".pv-panel").className, shown()]).toEqual(["pv-panel", "b-1:f0"]);
    esc(); await settle();
    expect(shown()).toBeNull();
  });
  it("with the API: it is asked on the panel element (not the frame); the browser leaving it is followed", async () => {
    const doc = await opened();
    const el = doc.querySelector(".pv-panel");
    let asked: any = null;
    el.requestFullscreen = function () { asked = this; doc.fullscreenElement = this; return Promise.resolve(); };
    doc.fullscreenEnabled = true;
    doc.exitFullscreen = () => { doc.fullscreenElement = null; return Promise.resolve(); };
    await click(doc.querySelector(".pv-panel-fs")); await settle();
    expect([asked === el, doc.querySelector(".pv-panel").className]).toEqual([true, "pv-panel pv-fs pv-fs-native"]);
    doc.fullscreenElement = null;
    fire(doc, "fullscreenchange"); await settle();
    expect(doc.querySelector(".pv-panel").className).toBe("pv-panel");
  });
  it("closing the panel in full screen leaves it", async () => {
    const doc = await opened();
    const el = doc.querySelector(".pv-panel");
    el.requestFullscreen = function () { doc.fullscreenElement = this; return Promise.resolve(); };
    doc.fullscreenEnabled = true;
    let exited = 0;
    doc.exitFullscreen = () => { exited++; doc.fullscreenElement = null; return Promise.resolve(); };
    await click(doc.querySelector(".pv-panel-fs")); await settle();
    pp.closePanel(); await settle();
    expect([exited, shown()]).toEqual([1, null]);
  });
});
