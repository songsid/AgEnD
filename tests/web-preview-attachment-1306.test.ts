/**
 * #1306 §6.1 (Q4), alpha.2 (user report): an agent's .html / .htm attachment gets the same preview card as a ```html
 * block. A card fetches nothing until a click; Preview (or Open in panel) reads /ui/file/<id> on this origin and hands
 * the text to the same preview frame a block uses — the file URL is never framed or opened on the dashboard's origin.
 * A person's upload never gets a card. The real modules run in the mini DOM (panel-chat.js mounts the thread and the
 * panel, preview.js makes the frames); fetch is the only stub.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const BOOT = "e".repeat(32);
const PREVIEW_ORIGIN = "http://127.0.0.1:19281";
let PV: any, panel: any, pp: any;
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
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({
    stream: { on(ev: string, fn: (m: unknown) => void) { stream[ev] = fn; } },
    boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: PREVIEW_ORIGIN, previewBoot: BOOT, previewReason: "" },
    deps: { fetch: () => new Promise(() => {}) },
  });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }, { name: "x", status: "running" }] });
  base.restore();
});

function fresh(storage: Record<string, string> = {}): AppPage {
  current = page({ storage: { agend_html_preview: "on", agend_tour_done: "1", ...storage } });
  return current;
}
afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  await current?.unmount();
  PV.stopAll("test-end");
  pp.closePanel();
  panel.store.state.msgs.w = []; panel.store.state.msgs.x = [];
  current?.restore();
  current = null;
});

const ID1 = "1".repeat(32), ID2 = "2".repeat(32), ID3 = "3".repeat(32);
const PAGE = (v: number) => `<title>Style switcher</title><h1>v${v}</h1>`;
const file = (id: string, name: string, size = 8400, kind = "document") => ({ id, kind, name, size, mime: "application/octet-stream" });
const ts = (id: number) => `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`;
const agent = (id: number, attachments: unknown[], text = "Here it is.") => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: ts(id), attachments });
const human = (id: number, attachments: unknown[]) => ({ boot: "b", id, instance: "w", sender: "web-user", role: "user", text: "mine", ts: ts(id), attachments });

/** /ui/file/<id> answered from `files` (id → HTML); anything else 404. `hold` keeps every answer until released. */
function serveFiles(files: Record<string, string>, opts: { hold?: boolean } = {}) {
  const calls: Array<{ url: string; init: any }> = [];
  const held: Array<() => void> = [];
  globalThis.fetch = vi.fn((url: string, init: any) => {
    // The reads these tests count are the file's; the page's other reads (#1939's /ui/authorization) are not file reads.
    if (/^\/ui\/file\//.test(url)) calls.push({ url, init });
    const id = /^\/ui\/file\/([0-9a-f]{32})$/.exec(url)?.[1];
    const body = id !== undefined ? files[id] : undefined;
    const res = body === undefined ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
      : { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    if (!opts.hold) return Promise.resolve(res);
    return new Promise(r => held.push(() => r(res)));
  }) as any;
  return { calls, release: async () => { for (const r of held.splice(0)) r(); await settle(); await settle(); } };
}

async function chat(msgs: unknown[], storage?: Record<string, string>) {
  const pg = fresh(storage);
  panel.store.state.msgs.w = msgs;
  await pg.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  const split = pg.document.querySelector(".chat-split") as any;
  split.clientWidth = 1200;
  return { pg, doc: pg.document as any };
}
const cards = (doc: any, sel = ".msg.agent") => [...doc.querySelectorAll(`${sel} .html-card[data-att]`)] as any[];
/** The agent file's card — asserted to be there, so a missing card fails as such and not on the next line. */
const card = (doc: any) => { const c = cards(doc)[0]; expect(c, "the file's card").toBeTruthy(); return c; };
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(); await settle(); };
function ready(frame: any) {
  frame.contentWindow = { posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); } };
  PV.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "ready", ch: null, boot: BOOT } });
  return frame;
}

describe("which attachments get a card", () => {
  it("an agent's .html / .htm file (any case) gets one under its files; showing it fetches nothing", async () => {
    const f = serveFiles({});
    const { doc } = await chat([agent(1, [file(ID1, "style-switcher.html"), file(ID2, "notes.txt"), file(ID3, "OLD.HTM")])]);
    expect(cards(doc).map(c => c.dataset.att)).toEqual([ID1, ID3]);
    expect(cards(doc).map(c => c.querySelector(".pv-label").textContent)).toEqual(["HTML · style-switcher.html", "HTML · OLD.HTM"]);
    const c = cards(doc)[0];
    expect([!!c.querySelector(".pv-run"), !!c.querySelector(".pv-open"), !!c.querySelector(".pv-dl")], "Preview, Open in panel; the file link is the download").toEqual([true, true, false]);
    expect(doc.querySelectorAll(".msg.agent .att-file").length, "every file keeps its own link").toBe(3);
    expect([f.calls.length, PV.liveCount()], "a card is built from nodes: no read, no frame").toEqual([0, 0]);
  });

  it("a person's .html upload, an image named .html, and an id the fleet did not issue get no card", async () => {
    serveFiles({});
    const { doc } = await chat([
      human(1, [file(ID1, "mine.html")]),
      agent(2, [file(ID2, "shot.html", 10, "photo"), file("../etc/passwd", "x.html")]),
    ]);
    expect(doc.querySelectorAll(".html-card").length).toBe(0);
    expect(doc.querySelector(".msg.user .att-file").getAttribute("href"), "the person's file is a plain download").toBe(`/ui/file/${ID1}`);
  });
});

describe("Preview reads the file on the click and runs it in the preview frame", () => {
  it("one same-origin read of /ui/file/<id>; the frame is the preview origin's; it renders the file's HTML", async () => {
    const f = serveFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([agent(1, [file(ID1, "style-switcher.html")])]);
    await click(card(doc).querySelector(".pv-run"));
    expect(f.calls).toEqual([{ url: `/ui/file/${ID1}`, init: { credentials: "same-origin", cache: "no-store" } }]);
    const frame = PV.liveFrame(`b-1:a${ID1}`);
    expect(frame?.src).toBe(`${PREVIEW_ORIGIN}/frame`);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    ready(frame);
    expect(frame.contentWindow.posted.map((m: any) => [m.type, m.html])).toEqual([["render", PAGE(1)]]);
    expect(doc.querySelectorAll("iframe").length, "one frame; the file URL is never framed").toBe(1);
  });

  it("a second click while it reads does not read again; a later Preview uses what was read", async () => {
    const f = serveFiles({ [ID1]: PAGE(1) }, { hold: true });
    const { doc } = await chat([agent(1, [file(ID1, "style-switcher.html")])]);
    const c = card(doc);
    await click(c.querySelector(".pv-run"));
    expect(c.querySelector(".pv-note").textContent).toBe("Reading the file…");
    c.querySelector(".pv-run").onclick();
    await settle();
    expect(f.calls.length, "one read per card at a time").toBe(1);
    await f.release();
    expect(PV.running(`b-1:a${ID1}`)).toBe(true);
    await click(c.querySelector(".pv-stop"));
    await click(c.querySelector(".pv-run"));
    expect([f.calls.length, PV.running(`b-1:a${ID1}`)], "read once, run twice").toEqual([1, true]);
  });

  it("a device that has not allowed previews: no Preview, and a stray click reads nothing", async () => {
    const f = serveFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([agent(1, [file(ID1, "style-switcher.html")])], { agend_html_preview: "" });
    const c = card(doc);
    expect(c.querySelector(".pv-run").hidden).toBe(true);
    await click(c.querySelector(".pv-run"));
    expect([f.calls.length, PV.liveCount()]).toEqual([0, 0]);
  });
});

describe("#2863: up to 8 MB at once, asked above it, a download only past 50 MB; a file that is gone", () => {
  const MB = 1024 * 1024;
  it("a listed size over 8 MB: asked before anything is read; Preview anyway reads it and runs it in the card", async () => {
    const f = serveFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([agent(1, [file(ID1, "report.html", 12 * MB + 300 * 1024)])]);
    const c = card(doc);
    await click(c.querySelector(".pv-run"));
    expect([f.calls.length, PV.liveCount(), c.querySelector(".pv-note").textContent]).toEqual([0, 0, "This file is large (12 MB). Preview anyway?"]);
    expect([c.querySelector(".pv-run").hidden, c.querySelector(".pv-anyway").hidden], "the question replaces Preview").toEqual([true, false]);
    await click(c.querySelector(".pv-anyway"));
    expect([f.calls.length, PV.running(`b-1:a${ID1}`), c.querySelector(".pv-anyway").hidden]).toEqual([1, true, true]);
  });
  it("Open in panel on a large file: the card asks; Preview anyway opens it in the panel and runs it there (not asked again)", async () => {
    const f = serveFiles({ [ID1]: "<p>" + "x".repeat(9 * MB) });
    const { doc } = await chat([agent(1, [file(ID1, "report.html", 9 * MB)])]);
    const c = card(doc);
    await click(c.querySelector(".pv-open"));
    expect([f.calls.length, pp.panelStore.get().open, c.querySelector(".pv-note").textContent]).toEqual([0, null, "This file is large (9 MB). Preview anyway?"]);
    await click(c.querySelector(".pv-anyway"));
    expect([f.calls.length, pp.panelStore.get().open?.key, PV.running(pp.frameKey(`b-1:a${ID1}`)), PV.running(`b-1:a${ID1}`)]).toEqual([1, `b-1:a${ID1}`, true, false]);
  });
  it("bytes over 8 MB though the listed size was small: asked after the read, no frame until Preview anyway", async () => {
    const big = "<p>" + "x".repeat(8 * MB);
    const f = serveFiles({ [ID1]: big });
    const { doc } = await chat([agent(1, [file(ID1, "grew.html", 100)])]);
    const c = card(doc);
    await click(c.querySelector(".pv-run"));
    expect([PV.liveCount(), c.querySelector(".pv-note").textContent]).toEqual([0, "This file is large (8 MB). Preview anyway?"]);
    await click(c.querySelector(".pv-anyway"));
    expect([f.calls.length, PV.running(`b-1:a${ID1}`)]).toEqual([2, true]);
  });
  it("exactly 8 MB of UTF-8 runs at once", async () => {
    serveFiles({ [ID1]: "é".repeat(4 * MB) });
    const { doc } = await chat([agent(1, [file(ID1, "edge.html", 8 * MB)])]);
    await click(card(doc).querySelector(".pv-run"));
    expect(PV.running(`b-1:a${ID1}`)).toBe(true);
  });
  it("a listed size over 50 MB: the card says so from the start — no Preview, no panel, no question, nothing read", async () => {
    const f = serveFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([agent(1, [file(ID1, "huge.html", 50 * MB + 1)])]);
    const c = card(doc);
    expect([c.querySelector(".pv-run").hidden, c.querySelector(".pv-open").hidden, c.querySelector(".pv-anyway").hidden, c.querySelector(".pv-note").textContent])
      .toEqual([true, true, true, "This file is over 50 MB; it is not previewed. Download it to open it."]);
    c.querySelector(".pv-run").onclick(); await settle();
    expect([f.calls.length, PV.liveCount()], "a stray click reads nothing").toEqual([0, 0]);
  });
  it("bytes over 50 MB though the listed size was small: the read checks them too, then the download only", async () => {
    const { doc } = await chat([agent(1, [file(ID1, "grew.html", 100)])]);
    serveFiles({ [ID1]: "<p>" + "x".repeat(50 * MB) });
    const c = card(doc);
    await click(c.querySelector(".pv-run"));
    expect([PV.liveCount(), c.querySelector(".pv-run").hidden, c.querySelector(".pv-open").hidden, c.querySelector(".pv-note").textContent])
      .toEqual([0, true, true, "This file is over 50 MB; it is not previewed. Download it to open it."]);
  });
  it("the fleet no longer serves it (404): the card says so and runs nothing", async () => {
    serveFiles({});
    const { doc } = await chat([agent(1, [file(ID1, "style-switcher.html")])]);
    const c = card(doc);
    await click(c.querySelector(".pv-run"));
    expect([PV.liveCount(), c.querySelector(".pv-note").textContent]).toEqual([0, "This file is no longer available here (it changed, or the fleet restarted). Ask the agent to send it again."]);
  });
});

describe("a read the card moved on from is dropped", () => {
  it("Stop while it reads: nothing runs when the answer comes", async () => {
    const f = serveFiles({ [ID1]: PAGE(1) }, { hold: true });
    const { doc } = await chat([agent(1, [file(ID1, "style-switcher.html")])]);
    const c = card(doc);
    await click(c.querySelector(".pv-run"));
    expect(c.querySelector(".pv-stop").hidden, "Stop is offered while it reads").toBe(false);
    await click(c.querySelector(".pv-stop"));
    await f.release();
    expect([PV.liveCount(), c.querySelector(".pv-run").hidden]).toEqual([0, false]);
  });
  it("the chat left while it reads (another instance): no frame, no panel", async () => {
    const f = serveFiles({ [ID1]: PAGE(1) }, { hold: true });
    const { pg, doc } = await chat([agent(1, [file(ID1, "style-switcher.html")])]);
    await click(card(doc).querySelector(".pv-open"));
    await pg.mount(h(panel.ChatPanel, { route: { instance: "x" }, navKey: "two" }));
    await f.release();
    expect([PV.liveCount(), pp.panelStore.get().open]).toEqual([0, null]);
  });
});

describe("Open in panel", () => {
  it("reads the file, opens the panel and runs it there (#1704: one click); Code shows the file; Download keeps the file's name", async () => {
    serveFiles({ [ID1]: PAGE(1) });
    const { doc } = await chat([agent(1, [file(ID1, "style-switcher.html")])]);
    await click(card(doc).querySelector(".pv-open"));
    const open = pp.panelStore.get().open;
    expect([open.key, open.code, open.att.name, PV.liveCount(), PV.running(pp.frameKey(`b-1:a${ID1}`))]).toEqual([`b-1:a${ID1}`, PAGE(1), "style-switcher.html", 1, true]);
    const saved: string[] = [];
    vi.spyOn(globalThis.URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(globalThis.URL, "revokeObjectURL").mockImplementation(() => {});
    const made = doc.createElement.bind(doc);
    vi.spyOn(doc, "createElement").mockImplementation((tag: any) => { const e = made(tag); if (tag === "a") e.click = () => saved.push(e.download); return e; });
    await click(doc.querySelector(".pv-panel-dl"));
    expect(saved).toEqual(["style-switcher.html"]);
  });
});

describe("a newer version of the file", () => {
  it("a later agent reply attaching the same name is offered; Show it reads that file and shows it, not running", async () => {
    const f = serveFiles({ [ID1]: PAGE(1), [ID2]: PAGE(2) });
    const { doc } = await chat([agent(1, [file(ID1, "style-switcher.html")])]);
    await click(card(doc).querySelector(".pv-open"));
    stream.message(agent(2, [file(ID2, "Style-Switcher.html")], "v2"));
    await settle();
    expect(doc.querySelector(".pv-newer")?.textContent ?? "", "offered").toMatch(/A newer version is in the reply from/);
    await click(doc.querySelector(".pv-newer-show"));
    const open = pp.panelStore.get().open;
    expect([open.key, open.code, PV.liveCount()]).toEqual([`b-2:a${ID2}`, PAGE(2), 0]);
    expect(f.calls.map(c => c.url)).toEqual([`/ui/file/${ID1}`, `/ui/file/${ID2}`]);
  });
  it("#2863: a newer version over 8 MB: Show it reads it; the panel's Preview asks, and its Preview anyway runs it there", async () => {
    const big = "<p>" + "x".repeat(8 * 1024 * 1024);
    serveFiles({ [ID1]: PAGE(1), [ID2]: big });
    const { doc } = await chat([agent(1, [file(ID1, "style-switcher.html")])]);
    await click(card(doc).querySelector(".pv-open"));
    stream.message(agent(2, [file(ID2, "Style-Switcher.html", 9 * 1024 * 1024)], "v2"));
    await settle();
    await click(doc.querySelector(".pv-newer-show"));
    expect(pp.panelStore.get().open.key).toBe(`b-2:a${ID2}`);
    await click(doc.querySelector(".pv-panel-run"));
    expect([PV.running(pp.frameKey(`b-2:a${ID2}`)), doc.querySelector(".pv-panel .pv-note")?.textContent, !!doc.querySelector(".pv-panel-anyway")])
      .toEqual([false, "This file is large (8 MB). Preview anyway?", true]);
    await click(doc.querySelector(".pv-panel-anyway"));
    expect(PV.running(pp.frameKey(`b-2:a${ID2}`))).toBe(true);
  });
  it("which file counts", () => {
    const k = (x: any) => `${x.boot}-${x.id}`;
    const open = { key: `b-1:a${ID1}`, msgKey: "b-1", instance: "w", att: { id: ID1, name: "a.html", size: 1 }, code: PAGE(1) };
    const at = (msgs: any[]) => pp.newerVersion(open, msgs, k)?.key ?? null;
    expect(at([agent(1, [file(ID1, "a.html")]), agent(2, [file(ID2, "b.html")])]), "another name is another page").toBeNull();
    expect(at([agent(1, [file(ID1, "a.html")]), human(2, [file(ID2, "a.html")])]), "a person's file is not the agent's version").toBeNull();
    expect(at([agent(1, [file(ID1, "a.html")]), agent(2, [file(ID2, "a.html", 1, "photo")])]), "an image is not").toBeNull();
    expect(at([agent(1, [file(ID1, "a.html")]), agent(2, [file(ID2, "a.html")]), agent(3, [file(ID3, "a.html")])]), "the newest").toBe(`b-3:a${ID3}`);
    expect(at([agent(1, [file(ID1, "a.html")]), agent(2, [], "```html\n" + PAGE(2) + "\n```")]), "a block is not a file's version").toBeNull();
  });
});

describe("#2863: loadHtmlAttachment and sizeLabel", () => {
  const read = async (body: string, size: number | undefined, o?: Record<string, unknown>) => {
    // @ts-expect-error — a JS module of the app, with no types
    const { loadHtmlAttachment } = await import("../src/ui/html-attachment.js");
    const calls: string[] = [];
    const r = await loadHtmlAttachment({ id: ID1, name: "a.html", ...(size === undefined ? {} : { size }) },
      (async (url: string) => { calls.push(url); return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer }; }) as never, o);
    return { r, calls: calls.length };
  };
  it("the two sizes, listed and read: over max is a download; over ask is a question (with its size) until anyway", async () => {
    const lim = { ask: 10, max: 20 };
    expect(await read("x".repeat(5), 21, lim)).toEqual({ r: { ok: false, reason: "over" }, calls: 0 });
    expect(await read("x".repeat(5), 15, lim)).toEqual({ r: { ok: false, reason: "large", size: 15 }, calls: 0 });
    expect(await read("x".repeat(21), 5, lim)).toEqual({ r: { ok: false, reason: "over" }, calls: 1 });
    expect(await read("x".repeat(15), undefined, lim)).toEqual({ r: { ok: false, reason: "large", size: 15 }, calls: 1 });
    expect(await read("x".repeat(15), 15, { ...lim, anyway: true })).toEqual({ r: { ok: true, code: "x".repeat(15) }, calls: 1 });
    expect(await read("x".repeat(21), 15, { ...lim, anyway: true }), "anyway never passes max").toEqual({ r: { ok: false, reason: "over" }, calls: 1 });
    expect(await read("x".repeat(10), 10, lim), "at ask: at once").toEqual({ r: { ok: true, code: "x".repeat(10) }, calls: 1 });
  });
  it("sizeLabel: one decimal under 10 MB, whole above", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const { sizeLabel, HTML_PREVIEW_ASK, HTML_PREVIEW_MAX } = await import("../src/ui/html-attachment.js");
    expect([sizeLabel(8 * 1024 * 1024), sizeLabel(8.44 * 1024 * 1024), sizeLabel(12.3 * 1024 * 1024), sizeLabel(9.96 * 1024 * 1024)]).toEqual(["8 MB", "8.4 MB", "12 MB", "10 MB"]);
    expect([HTML_PREVIEW_ASK, HTML_PREVIEW_MAX]).toEqual([8 * 1024 * 1024, 50 * 1024 * 1024]);
    expect([PV.LIMITS.askBytes, PV.LIMITS.maxBytes], "the block's limits are the file's").toEqual([HTML_PREVIEW_ASK, HTML_PREVIEW_MAX]);
    const { PREVIEW_HTML_MAX_BYTES } = await import("../src/web-preview.js");
    expect(PREVIEW_HTML_MAX_BYTES, "the frame's own ceiling is the page's").toBe(HTML_PREVIEW_MAX);
  });
});
