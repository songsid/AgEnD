/**
 * #2911 (6), M-2216: the preview panel's page list — every page in the thread (one per <title>, untitled blocks
 * together, or per attached file name), newest first; a click opens its newest version, waiting for Preview.
 * Chrome only: the frame, its sandbox and CSP are #1306's.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
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
  pv = await import("../src/ui/preview-pages.js");
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


describe("pagesOf", () => {
  it("one row per page, newest first; versions counted; the newest version is what opens; a person's or a cut block is none", () => {
    const msgs = [agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(1, "Other"))), human(3, FENCE(PAGE(9, "Mine"))), agent(4, FENCE(PAGE(2))),
      agent(5, "```html\n" + PAGE(3, "Cut")), withFile(6, ID1, "Report.html"), agent(7, FENCE("<h1>untitled</h1>"))];
    const ps = pv.pagesOf(msgs, k, "w");
    expect(ps.map((p: any) => [p.id, p.label, p.kind, p.versions, p.latest.key])).toEqual([
      ["t:", "", "html", 1, "b-7:f0"],
      ["a:report.html", "Report.html", "file", 1, `b-6:a${ID1}`],
      ["t:Counter", "Counter", "html", 2, "b-4:f0"],
      ["t:Other", "Other", "html", 1, "b-2:f0"],
    ]);
  });
  it("pageIdOf: the shown block's page", () => {
    expect([pv.pageIdOf({ code: PAGE(1) }), pv.pageIdOf({ att: { name: " A.HTML " } }), pv.pageIdOf(null)]).toEqual(["t:Counter", "a:a.html", null]);
  });
});

describe("the panel's page list", () => {
  it("offered when the thread has more than one page; lists them; the shown one is marked; a click opens that page's newest version, waiting for Preview", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(1, "Other"))), agent(3, FENCE(PAGE(2)))]);
    await click(cards(doc)[2].querySelector(".pv-open"));
    const f = PV.liveFrame(pp.frameKey("b-3:f0"));
    expect(doc.querySelector(".pv-pages-toggle").textContent).toBe("Pages (2)");
    await click(doc.querySelector(".pv-pages-toggle"));
    const rows = () => [...doc.querySelectorAll(".pv-page")].map((b: any) => [b.querySelector(".pv-page-name").textContent, b.getAttribute("aria-current")]);
    expect(rows()).toEqual([["Counter", "true"], ["Other", null]]);
    expect([doc.querySelector(".pv-panel-body").className, PV.liveFrame(pp.frameKey("b-3:f0")) === f], "the frame stays while listing").toEqual(["pv-panel-body show-code", true]);
    await click(doc.querySelectorAll(".pv-page")[1]);
    expect([shown(), PV.liveCount(), !!doc.querySelector(".pv-panel-run"), doc.querySelector(".pv-pages")]).toEqual(["b-2:f0", 0, true, null]);
  });
  it("the shown page's row just closes the list (nothing reopened); one page only: no list", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(1, "Other")))]);
    await click(cards(doc)[0].querySelector(".pv-open"));
    const f = PV.liveFrame(pp.frameKey("b-1:f0"));
    await click(doc.querySelector(".pv-pages-toggle"));
    await click(doc.querySelectorAll(".pv-page")[1]);
    expect([shown(), PV.liveFrame(pp.frameKey("b-1:f0")) === f, doc.querySelector(".pv-pages")]).toEqual(["b-1:f0", true, null]);
    await current!.unmount(); PV.stopAll("x"); pp.closePanel(); current!.restore(); current = null;
    const one = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(2)))]);
    await click(cards(one)[0].querySelector(".pv-open"));
    expect(one.querySelector(".pv-pages-toggle")).toBeNull();
  });
  it("#2920 review: a view button leaves the list (Code shows the code); a new open never starts behind an old list", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(1, "Other")))]);
    await click(cards(doc)[0].querySelector(".pv-open"));
    await click(doc.querySelector(".pv-pages-toggle"));
    await click([...doc.querySelectorAll(".pv-panel-bar .seg-inline .btn")].find((b: any) => /Code/.test(b.textContent)));
    expect([doc.querySelector(".pv-pages"), doc.querySelector(".pv-code code")?.textContent]).toEqual([null, PAGE(1)]);
    await click(doc.querySelector(".pv-pages-toggle"));
    pp.closePanel(); await settle();
    await click(cards(doc)[1].querySelector(".pv-open"));
    expect([shown(), doc.querySelector(".pv-pages"), doc.querySelector(".pv-panel-body").className.includes("show-code")]).toEqual(["b-2:f0", null, false]);
  });
  it("#2920 review: a newer pick supersedes a file still being read — the file's late answer is dropped", async () => {
    let release = () => {};
    globalThis.fetch = vi.fn(() => new Promise(r => { release = () => r({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(PAGE(1, "File")).buffer }); })) as any;
    const doc = await chat([agent(1, FENCE(PAGE(1, "Other"))), withFile(2, ID1, "file.html"), agent(3, FENCE(PAGE(1)))]);
    await click(cards(doc).at(-1).querySelector(".pv-open"));
    await click(doc.querySelector(".pv-pages-toggle"));
    const row = (name: string) => [...doc.querySelectorAll(".pv-page")].find((b: any) => b.querySelector(".pv-page-name").textContent === name);
    await click(row("file.html"));                       // held
    await click(doc.querySelector(".pv-pages-toggle"));
    await click(row("Other"));                           // a newer choice, inline
    expect(shown()).toBe("b-1:f0");
    release(); await settle(); await settle();
    expect(shown(), "the file's late answer does not replace Other").toBe("b-1:f0");
  });
  it("control: a sole file pick opens the file when it answers", async () => {
    let release = () => {};
    globalThis.fetch = vi.fn(() => new Promise(r => { release = () => r({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(PAGE(1, "File")).buffer }); })) as any;
    const doc = await chat([withFile(1, ID1, "file.html"), agent(2, FENCE(PAGE(1)))]);
    await click(cards(doc).at(-1).querySelector(".pv-open"));
    await click(doc.querySelector(".pv-pages-toggle"));
    await click([...doc.querySelectorAll(".pv-page")].find((b: any) => b.querySelector(".pv-page-name").textContent === "file.html"));
    release(); await settle(); await settle();
    expect([shown(), pp.panelStore.get().open.code]).toEqual([`b-1:a${ID1}`, PAGE(1, "File")]);
  });
  it("a page's label is drawn as text (a title with markup stays text)", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1, "<img src=x onerror=1>"))), agent(2, FENCE(PAGE(1)))]);
    await click(cards(doc)[1].querySelector(".pv-open"));
    await click(doc.querySelector(".pv-pages-toggle"));
    const list = doc.querySelector(".pv-pages");
    expect([list.querySelectorAll("img").length, list.textContent]).toEqual([0, expect.stringContaining("<img src=x onerror=1>")]);
  });
  it("a new page arriving updates the count", async () => {
    const doc = await chat([agent(1, FENCE(PAGE(1))), agent(2, FENCE(PAGE(1, "Other")))]);
    await click(cards(doc)[0].querySelector(".pv-open"));
    stream.message(agent(3, FENCE(PAGE(1, "Third"))));
    await settle();
    expect(doc.querySelector(".pv-pages-toggle").textContent).toBe("Pages (3)");
  });
});
