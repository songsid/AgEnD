/**
 * #2053 review (Prism P2-1): a kept thread is shown again later, its cards with it. An attachment's HTML (or text) read
 * still waiting when the chat left is dropped then: whenever its answer comes — while the chat is away, or after it is
 * shown again — it starts no preview and opens no panel without a new click, and the card is not left Loading (Preview
 * and Open in panel offered again). A new click reads again and runs. Through the retained-thread path: the real
 * panel-chat.js (keeping the thread), chat-thread.js and preview.js in the mini DOM.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const BOOT = "e".repeat(32);
const ORIGIN = "http://127.0.0.1:19280";
const ON = { dashboardOrigin: ORIGIN, previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" };
let PV: any, panel: any, pp: any;
let current: AppPage | null = null;

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
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({ stream: { on() {} }, boot: ON, deps: { fetch: () => new Promise(() => {}) } });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }, { name: "x", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await current?.unmount();
  panel.forgetKeptThreads();
  PV.stopAll("test-end");
  pp.closePanel();
  PV.init(ON);
  panel.store.state.msgs.w = [];
  panel.store.state.msgs.x = [];
  current?.restore();
  current = null;
});

const ID1 = "1".repeat(32), ID2 = "2".repeat(32);
const agentWith = (attachments: unknown[]) => ({ boot: "b", id: 1, instance: "w", sender: "w", role: "agent", text: "Here it is.", ts: "2026-01-01T00:00:01Z", attachments });
const file = (id: string, name: string) => ({ id, kind: "document", name, size: 840, mime: "application/octet-stream" });
const PAGE = "<title>Counter</title><h1>v1</h1>";
/** /ui/file answers `body` for every read, each held until release(); `reads` counts them. */
function heldFiles(body: string) {
  const held: Array<() => void> = [];
  const fetch = vi.fn((url: string) => /^\/ui\/file\//.test(url)
    ? new Promise(r => held.push(() => r({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer })))
    : new Promise(() => {}));
  globalThis.fetch = fetch as any;
  return { reads: () => fetch.mock.calls.filter(([url]) => /^\/ui\/file\//.test(url)).length, release: async () => { for (const r of held.splice(0)) r(); await settle(); await settle(); await settle(); } };
}
const show = (name: string, navKey: string) => current!.mount(h(panel.ChatPanel, { route: { instance: name }, navKey })).then(() => settle());
async function chat(attachments: unknown[]) {
  current = page({ url: `${ORIGIN}/ui/chat/w`, storage: { agend_tour_done: "1", agend_html_preview: "on" } });
  panel.store.state.msgs.w = [agentWith(attachments)];
  panel.store.state.msgs.x = [];
  await show("w", "one");
  const doc = current.document as any;
  doc.querySelector(".chat-split").clientWidth = 1200;
  return doc;
}
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(); };
const htmlCard = (doc: any) => doc.querySelector(".msg.agent .html-card");
/** What the card offers, and what runs. */
const state = (doc: any, card: any) => ({
  note: card.querySelector(".pv-note").textContent, preview: !card.querySelector(".pv-run").hidden, openIn: !card.querySelector(".pv-open").hidden,
  live: PV.liveCount(), panel: pp.panelStore.get().open?.key ?? null,
});
const KEY = `b-1:a${ID1}`;
const IDLE = { note: "", preview: true, openIn: true, live: 0, panel: null };

describe("#2053: a read held when the chat left starts nothing when it is shown again", () => {
  for (const side of ["Preview", "Open in panel"] as const) for (const when of ["after it is shown again", "while it is away"] as const) {
    it(`${side}, the read answering ${when}: nothing runs, the card is not left Loading; a new click reads again and runs`, async () => {
      const f = heldFiles(PAGE);
      const doc = await chat([file(ID1, "a.html")]);
      const card = htmlCard(doc);
      const button = (c: any) => c.querySelector(side === "Preview" ? ".pv-run" : ".pv-open");
      await click(button(card));
      expect(card.querySelector(".pv-note").textContent, "reading").toBe("Reading the file…");
      await show("x", "two");
      if (when === "while it is away") await f.release();
      await show("w", "three");
      expect(htmlCard(doc), "the kept card, shown again").toBe(card);
      if (when === "after it is shown again") await f.release();
      expect(state(doc, card), "nothing ran; Preview and Open in panel offered again").toEqual(IDLE);
      await click(button(card));
      expect(f.reads(), "the new click reads again").toBe(2);
      await f.release();
      if (side === "Preview") expect([PV.running(KEY), PV.liveCount()]).toEqual([true, 1]);
      else expect([pp.panelStore.get().open?.key, PV.running(pp.frameKey(KEY)), PV.liveCount()]).toEqual([KEY, true, 1]);
    });
  }
  it("a text attachment's Show, the read answering while away or after: not left Loading, nothing shown until a new click", async () => {
    for (const when of ["while it is away", "after it is shown again"]) {
      const f = heldFiles("# Notes\n\nhello");
      const doc = await chat([file(ID2, "notes.md")]);
      const card = doc.querySelector(".text-card");
      await click(card.querySelector(".tc-show"));
      expect(card.querySelector(".pv-note").textContent).toBe("Reading the file…");
      await show("x", "two");
      if (when === "while it is away") await f.release();
      await show("w", "three");
      expect(doc.querySelector(".text-card"), when).toBe(card);
      if (when === "after it is shown again") await f.release();
      expect([card.querySelector(".pv-note").textContent, card.querySelector(".tc-body").hidden], when).toEqual(["", true]);
      await click(card.querySelector(".tc-show"));
      await f.release();
      expect([f.reads(), card.querySelector(".tc-body").hidden, card.querySelector(".tc-body").textContent.includes("hello")], when).toEqual([2, false, true]);
      await current!.unmount(); panel.forgetKeptThreads(); current!.restore(); current = null;
    }
  });
});
