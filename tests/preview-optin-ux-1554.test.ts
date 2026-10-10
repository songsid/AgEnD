/**
 * #1554 (baseline PV): the preview notices in the page's language, and the panel offering the same "Allow previews".
 * The #1306 model is unchanged and pinned by its own tests; here: the opt-in from the panel goes through the one path
 * (setPreviewOptIn: the app's confirm with chat.pvConfirm, then setOptIn), a refusal changes nothing, and allowing
 * starts nothing — Preview is enabled and still needs its click. The real modules run in the mini DOM.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";
import { EventEmitter } from "node:events";
import { PREVIEW_OFF_CODES } from "../src/web-preview.js";
import { serveAppShell } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const BOOT = "e".repeat(32);
const ORIGIN = "http://127.0.0.1:19280";
let PV: any, panel: any, pp: any, i18n: any, confirm: any;
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
  i18n = await import("/assets/app-i18n.js");
  confirm = await import("/assets/ui-confirm.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({
    stream: { on() {} },
    boot: { dashboardOrigin: ORIGIN, previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" },
    deps: { fetch: () => new Promise(() => {}) },
  });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await current?.unmount();
  PV.stopAll("test-end");
  pp.closePanel();
  for (const q of confirm.confirmStore.get().queue) confirm.answerConfirm(q.id, false);
  (globalThis as any).confirm = () => true;
  panel.store.state.msgs.w = [];
  i18n.setLang("en");
  current?.restore();
  current = null;
});

const agent = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: `2026-01-01T00:00:0${id}Z` });
const FENCE = "```html\n<title>T</title><h1>hi</h1>\n```";
/** The chat for "w" with one agent HTML block, opened in the panel; this device has NOT allowed previews. */
async function panelNotAllowed(lang = "en") {
  i18n.setLang(lang);
  current = page({ url: `${ORIGIN}/ui/chat/w`, storage: { agend_tour_done: "1" } });
  panel.store.state.msgs.w = [agent(1, FENCE), agent(2, FENCE.replace("hi", "two"))];
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  const doc = current.document as any;
  doc.querySelector(".chat-split").clientWidth = 1200;
  const open = doc.querySelector(".msg.agent .html-card .pv-open");
  if (typeof open.onclick === "function") open.onclick(); else open.click();
  await settle();
  return { doc, pg: current };
}
const note = (doc: any) => doc.querySelector(".pv-panel .pv-note")?.textContent ?? null;
const allowBtn = (doc: any) => doc.querySelector(".pv-panel .pv-panel-allow") ?? null;
const runDisabled = (doc: any) => doc.querySelector(".pv-panel-run")?.disabled ?? null;
/** The app's confirm, answered like confirm() (the harness bridge); every question asked: [message, its button]. */
let questions: Array<[string, string]> = [];
function answering(yes: boolean) {
  questions = [];
  const off = confirm.confirmStore.subscribe((st: { queue: Array<{ message: string; confirmLabel: string }> }) => {
    const q = st.queue[0];
    if (q && !questions.some(([m]) => m === q.message)) questions.push([q.message, q.confirmLabel]);
  });
  (globalThis as any).confirm = () => yes;
  return off;
}

describe("the panel offers the same Allow previews", () => {
  it("not allowed: the panel says so (this browser, this address) with Allow previews; Preview is off", async () => {
    const { doc } = await panelNotAllowed();
    expect([note(doc), allowBtn(doc)?.textContent ?? null, runDisabled(doc)])
      .toEqual(["HTML previews are off on this device (this browser, at this address). Allow previews", "Allow previews", true]);
  });

  it("Allow asks with the same confirm (chat.pvConfirm); confirmed: stored, Preview enabled — and nothing runs until it is clicked", async () => {
    const { doc, pg } = await panelNotAllowed();
    const off = answering(true);
    try { allowBtn(doc).click(); await settle(); await settle(); } finally { off(); }
    expect(questions).toEqual([[i18n.t("chat.pvConfirm"), "Allow previews"]]);
    expect([pg.storage.get("agend_html_preview"), runDisabled(doc), allowBtn(doc)?.textContent ?? null, PV.liveCount()]).toEqual(["on", false, null, 0]);
    expect(note(doc)).toBe("Click Preview to run it here.");
    doc.querySelector(".pv-panel-run").click(); await settle();
    expect(PV.liveCount(), "Preview, clicked, runs it").toBe(1);
  });

  it("Allow refused: nothing stored, still off, still offered", async () => {
    const { doc, pg } = await panelNotAllowed();
    const off = answering(false);
    try { allowBtn(doc).click(); await settle(); await settle(); } finally { off(); }
    expect(questions.map(([m]) => m)).toEqual([i18n.t("chat.pvConfirm")]);
    expect([pg.storage.get("agend_html_preview") ?? null, runDisabled(doc), allowBtn(doc)?.textContent ?? null, PV.liveCount()]).toEqual([null, true, "Allow previews", 0]);
  });

  it("the kill switch (Never preview, this session): no Allow offered in the panel — its own reason", async () => {
    const { doc } = await panelNotAllowed();
    PV.setNever(true); await settle();
    try {
      expect([allowBtn(doc)?.textContent ?? null, note(doc), runDisabled(doc)]).toEqual([null, "Previews are switched off on this device for this session.", true]);
    } finally { PV.setNever(false); }
  });
});

describe("the notices in the page's language", () => {
  it("zh-TW: the panel's notice and button, the card's notice and the running banner", async () => {
    const { doc, pg } = await panelNotAllowed("zh-TW");
    expect([note(doc), allowBtn(doc)?.textContent ?? null]).toEqual(["這台裝置（這個瀏覽器、這個網址）還沒允許 HTML 預覽。 允許預覽", "允許預覽"]);
    expect(doc.querySelectorAll(".msg.agent .html-card .pv-note")[1]?.textContent ?? null, "the card not in the panel").toBe("這台裝置（這個瀏覽器、這個網址）還沒允許 HTML 預覽。可從這張卡片的 ⋯ 選單或側欄允許。");
    pg.storage.set("agend_html_preview", "on"); PV.onStorage({ key: "agend_html_preview" }); await settle();
    doc.querySelector(".pv-panel-run").click(); await settle();
    expect(doc.querySelector(".pv-panel .pv-banner .pv-banner-text")?.textContent ?? null).toBe("預覽會在隔離的框架裡執行 agent 的 HTML。它無法使用你的登入，但可能把資料傳出去。只預覽你信任的內容。預覽可能讓這個分頁變慢或卡住。");
  });
});

// ── preview.js on its own: the dictionary is optional, and the server's reason travels as a code ──

function loadPreview(store: Record<string, string> = {}) {
  const src = readFileSync(join(process.cwd(), "src", "ui", "preview.js"), "utf8");
  const m = { exports: {} as any };
  const ls = new Map(Object.entries(store));
  const root: any = { location: { origin: ORIGIN }, localStorage: { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => ls.set(k, v), removeItem: (k: string) => ls.delete(k) },
    sessionStorage: { getItem: () => null }, addEventListener() {}, performance: { now: () => 0 } };
  vm.runInNewContext(src, { module: m, globalThis: root });
  return m.exports;
}
const ZH: Record<string, string> = {};
describe("preview.js's words", () => {
  beforeAll(async () => {
    const strings = await import("/assets/app-i18n.js");
    // @ts-expect-error — a JS module of the app, with no types
    await import("../src/ui/chat-strings.js");
    strings.setLang("zh-TW");
    for (const k of ["pvWhyOptin", "pvServer_needOrigin", "pvServer_notListed", "pvWhyOrigin"]) ZH[k] = strings.t(`chat.${k}`, "{0}", "{1}");
    strings.setLang("en");
  });
  const text = (key: string, ...v: string[]) => {
    const k = `chat.${key}`; i18n.setLang("zh-TW");
    try { const s = i18n.t(k, ...v); return s === k ? null : s; } finally { i18n.setLang("en"); }
  };

  it("without a dictionary: the English as before (the #1306 tests' strings)", () => {
    const P = loadPreview();
    P.init({ dashboardOrigin: ORIGIN, previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT });
    expect(P.availability().reason).toBe("Previews are off on this device. Allow them from the card's menu or the sidebar.");
    expect(P.banner()).toBe(P.BANNER);
  });
  it("with one: its words; a key it lacks keeps the English", () => {
    const P = loadPreview();
    P.init({ dashboardOrigin: ORIGIN, previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT }, { text: (k: string, ...v: string[]) => (k === "pvWhyOptin" ? "Z" : null) });
    expect([P.availability().reason, P.banner()]).toEqual(["Z", P.BANNER]);
  });
  it("the server's reason by code, with its address; an unknown code: the server's own text", () => {
    const P = loadPreview({ agend_html_preview: "on" });
    P.init({ dashboardOrigin: "https://x.example", previewOrigin: "", previewBoot: "", previewReason: "server words", previewReasonCode: "notListed" }, { text });
    expect(P.availability()).toMatchObject({ ok: false, why: "server", reason: ZH.pvServer_notListed.replace("{0}", "https://x.example") });
    P.init({ dashboardOrigin: "https://x.example", previewOrigin: "", previewBoot: "", previewReason: "server words", previewReasonCode: "somethingNew" }, { text });
    expect(P.availability().reason).toBe("server words");
    P.init({ dashboardOrigin: "https://x.example", previewOrigin: "", previewBoot: "", previewReason: "server words" }, { text });
    expect(P.availability().reason, "no code (an older server): its text").toBe("server words");
  });
  it("the origin mismatch, localized with both addresses", () => {
    // The page is at ORIGIN (127.0.0.1); the server believed localhost.
    const P = loadPreview({ agend_html_preview: "on" });
    P.init({ dashboardOrigin: "http://localhost:19280", previewOrigin: "http://localhost:19281", previewBoot: BOOT }, { text });
    expect(P.availability().reason).toBe(ZH.pvWhyOrigin.replace("{0}", ORIGIN).replace("{1}", "http://localhost:19280"));
  });
});

describe("every word has both languages", () => {
  it("each key preview.js says and each server code has an en and a zh-TW string", async () => {
    const src = readFileSync(join(process.cwd(), "src", "ui", "preview.js"), "utf8");
    const keys = [...src.matchAll(/say\("([A-Za-z_]+)"/g)].map(m => m[1]!).filter(k => !k.endsWith("_"));   // "pvServer_" + code: the codes below
    // The server's one list (#1556 review): a code added there without its words fails here.
    const codes = PREVIEW_OFF_CODES.map(c => `pvServer_${c}`);
    expect(codes.length, "the server's codes").toBeGreaterThanOrEqual(9);
    const missing: string[] = [];
    for (const lang of ["en", "zh-TW"]) {
      i18n.setLang(lang);
      for (const k of [...new Set([...keys, ...codes, "pvWhyOptinPanel"])]) if (i18n.t(`chat.${k}`) === `chat.${k}`) missing.push(`${lang}:${k}`);
    }
    i18n.setLang("en");
    expect(keys.length).toBeGreaterThanOrEqual(12);
    expect(missing).toEqual([]);
  });
});

// ── #1556 review: the chat's own adapter, and the pages that never ask for availability ──

describe("the chat's dictionary adapter (panel-chat boot), for real", () => {
  const BOOTED = { dashboardOrigin: ORIGIN, previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" };
  afterEach(() => { PV.init(BOOTED); });   // init without opts keeps the chat's adapter
  it("a code the page's dictionary does not have (a newer server): the server's own text, never the key", () => {
    i18n.setLang("zh-TW");
    PV.init({ dashboardOrigin: ORIGIN, previewOrigin: "", previewBoot: "", previewReason: "server words", previewReasonCode: "somethingNewer" });
    expect(PV.availability().reason).toBe("server words");
  });
  it("a known one: in the page's language", () => {
    i18n.setLang("zh-TW");
    PV.init({ dashboardOrigin: ORIGIN, previewOrigin: "", previewBoot: "", previewReason: "Previews are not available on this fleet.", previewReasonCode: "publicLink" });
    expect(PV.availability().reason).toBe("公開連結不提供預覽。要預覽，請在執行 AgEnD 的那台機器上開啟儀表板。");
  });
});

describe("the public link and other pages still say why, by code", () => {
  function shellBody(gateway: boolean, mode: "full" | "view-only") {
    const req: any = Object.assign(new EventEmitter(), { method: "GET", url: "/ui", headers: { host: "x.trycloudflare.com" } });
    if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e1", expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
    let body = "";
    const res: any = { setHeader() {}, writeHead() {}, end(t: string) { body = t; } };
    serveAppShell(req, res, { previewForUi: () => { throw new Error("not asked on these pages"); } } as never, mode);
    const tag = /<body[^>]*>/.exec(body)?.[0] ?? "";
    return { code: /data-preview-reason-code="([^"]*)"/.exec(tag)?.[1] ?? null, reason: /data-preview-reason="([^"]*)"/.exec(tag)?.[1] ?? null };
  }
  it("the public link: publicLink; a page that is not the full app: notOffered — the server's English kept beside it", () => {
    expect(shellBody(true, "full")).toEqual({ code: "publicLink", reason: "Previews are not available on this fleet." });
    expect(shellBody(false, "view-only")).toEqual({ code: "notOffered", reason: "Previews are not available on this fleet." });
  });
});
