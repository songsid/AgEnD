/**
 * #2911 (7), M-2216: a CDN library the preview blocked (web.preview_cdn off). The prologue reports it as a "blocked"
 * error (origin + path, BLOCKED_PROLOGUE); the parent records it like any error (same validation, caps, \p{Cf} strip,
 * one line); the chip quotes it with a prefix; and the panel says where the library could be allowed — only for the
 * CDNs the setting allows.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";
import { PREVIEW_CDN_SOURCES } from "../src/web-preview.js";

const BOOT = "e".repeat(32);
let PV: any, panel: any, pp: any, pa: any;
const stream: Record<string, (m: unknown) => void> = {};
let current: AppPage | null = null;
const posts: unknown[] = [];

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
  pa = await import("../src/ui/preview-panel-actions.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({
    stream: { on(ev: string, fn: (m: unknown) => void) { stream[ev] = fn; } },
    boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" },
    deps: { fetch: (...a: unknown[]) => { posts.push(a); return new Promise(() => {}); } },
  });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await current?.unmount();
  PV.stopAll("test-end");
  pp.closePanel();
  const s = panel.store.state;
  s.msgs.w = []; s.drafts.w = ""; delete s.replies.w;
  current?.restore();
  current = null;
});

const agent = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: `2026-01-01T00:00:0${id}Z` });
const FENCE = (body: string) => "```html\n" + body + "\n```";
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The chat with one page, opened in the panel and running (the frame answered ready); returns the frame and its ch. */
async function running(body = "<title>Counter</title><h1>v1</h1>") {
  current = page({ storage: { agend_html_preview: "on", agend_tour_done: "1" } });
  panel.store.state.msgs.w = [agent(1, FENCE(body))];
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  const doc = current.document as any;
  (doc.querySelector(".chat-split") as any).clientWidth = 1200;
  await click(doc.querySelector(".msg.agent .html-card .pv-open"));
  const key = pp.frameKey("b-1:f0");
  const frame = PV.liveFrame(key);
  frame.contentWindow = { posted: [] as any[], postMessage(m: unknown) { this.posted.push(m); } };
  PV.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "ready", ch: null, boot: BOOT } });
  const ch = frame.contentWindow.posted[0].ch;
  const send = (data: object, from: any = frame.contentWindow, origin = "null") => PV.onMessage({ source: from, origin, data });
  const err = (o: object = {}) => send({ v: 1, type: "error", ch, kind: "error", message: "TypeError: x is undefined", line: 12, col: 5, ...o });
  return { doc, key, frame, ch, send, err };
}


const JSD = "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.js";

describe("the parent records a blocked library like any error", () => {
  it("kind blocked is accepted, one line, format characters gone; the chip quotes it with its prefix", async () => {
    const { key, err } = await running();
    err({ kind: "blocked", message: `${JSD}\u202e\u200b`, line: 0, col: 0 });
    await wait(250);
    const log = PV.errors(key);
    expect(log).toEqual({ count: 1, items: [{ kind: "blocked", message: JSD, line: 0, col: 0 }] });
    expect(pa.errorLines(log)).toEqual(["The preview reported 1 error (text from the page):", `> Blocked by the preview: ${JSD}`]);
  });
  it("an unknown kind is still dropped (the set is exact)", async () => {
    const { key, err } = await running();
    err({ kind: "cdn", message: JSD, line: 0, col: 0 });
    await wait(250);
    expect(PV.errors(key)).toBeNull();
  });
});

describe("the panel's note", () => {
  it("names the CDN the setting would allow; not for another host or an off-prefix path", () => {
    expect([...pp.CDN_PREFIXES], "the UI's list is the server's").toEqual([...PREVIEW_CDN_SOURCES]);
    const log = (...m: string[]) => ({ count: m.length, items: m.map(message => ({ kind: "blocked", message, line: 0, col: 0 })) });
    expect(pp.blockedCdnHost(log(JSD))).toBe("cdn.jsdelivr.net");
    expect(pp.blockedCdnHost(log("https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"))).toBe("cdnjs.cloudflare.com");
    expect(pp.blockedCdnHost(log("https://unpkg.com/chart.js", "https://cdn.jsdelivr.net/gh/x/y.js"))).toBeNull();
    expect(pp.blockedCdnHost({ count: 1, items: [{ kind: "error", message: JSD, line: 1, col: 1 }] }), "only a blocked one").toBeNull();
    expect(pp.blockedCdnHost(null)).toBeNull();
  });
  it("shown in the panel when the running page's library was blocked, in words", async () => {
    const { doc, err } = await running();
    expect(doc.querySelector(".pv-cdn-note")).toBeNull();
    err({ kind: "blocked", message: JSD, line: 0, col: 0 });
    await wait(250); await settle();
    expect(doc.querySelector(".pv-cdn-note")?.textContent).toBe("This page loads a library from cdn.jsdelivr.net, which previews block unless Settings → Web dashboard → “HTML previews may load libraries from cdnjs / jsDelivr” is on.");
  });
});
