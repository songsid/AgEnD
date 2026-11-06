/**
 * M-2448: a Markdown file opens in the chat's side panel (#1481) as well as in its card — rendered by the chat's own
 * safe Markdown renderer (escaped first: no script, no element from the file), with Formatted / Source and Download,
 * the same 1 MiB read limit as the card, and the HTML preview's frame (a full-screen sheet on a phone is its CSS).
 * The real modules (panel-chat.js mounting the thread and the panel) in the mini DOM.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

let panel: any, pp: any, i18n: any;
let current: AppPage | null = null;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types
  panel = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  pp = await import("../src/ui/preview-panel.js");
  i18n = await import("/assets/app-i18n.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({ stream: { on() {} }, boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "", previewBoot: "", previewReason: "" }, deps: { fetch: () => new Promise(() => {}) } });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  pp.closePanel();
  await current?.unmount();
  panel.store.state.msgs.w = [];
  i18n.setLang("en", { store: false });
  current?.restore();
  current = null;
});
const ID = (n: number) => String(n).repeat(32).slice(0, 32);
const att = (n: number, name: string, size = 100) => ({ id: ID(n), kind: "document", name, size, mime: "application/octet-stream" });
const agent = (attachments: unknown[]) => ({ boot: "b", id: 1, instance: "w", sender: "w", role: "agent", text: "Here.", ts: "2026-01-01T00:00:01Z", attachments });
let reads = 0;
function serve(files: Record<string, string>) {
  reads = 0;
  globalThis.fetch = vi.fn(async (url: string) => {
    reads++;
    const id = /^\/ui\/file\/([0-9a-f]{32})$/.exec(url)?.[1];
    const body = id !== undefined ? files[id] : undefined;
    return body === undefined ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } : { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  }) as any;
}
async function chat(attachments: unknown[]) {
  current = page({ url: "http://127.0.0.1:19280/ui/chat/w", storage: { agend_tour_done: "1" } });
  panel.store.state.msgs.w = [agent(attachments)];
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  const doc = current.document as any;
  const split = doc.querySelector(".chat-split"); if (split) split.clientWidth = 1200;
  return doc;
}
const settleAll = async () => { for (let i = 0; i < 6; i++) await settle(); };
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settleAll(); };

describe("a Markdown file in the side panel (M-2448)", () => {
  it("Open in panel on a Markdown card: the file rendered safely — no script, no element from the file", async () => {
    serve({ [ID(3)]: "# Title\n\n<script>alert(1)</script> <img src=x onerror=alert(2)> [ok](https://example.com) [bad](javascript:alert(3))\n\n- one\n- two" });
    const doc = await chat([att(3, "notes.md")]);
    const open = doc.querySelector(".text-card .tc-panel");
    expect(open?.textContent).toBe("Open in panel");
    await click(open);
    const p = doc.querySelector(".pv-panel.pv-md-panel");
    expect(p).not.toBeNull();
    expect(p.querySelector(".pv-panel-title strong").textContent).toBe("notes.md");
    const body = p.querySelector(".pv-md");
    expect([body.querySelector("script"), body.querySelector("img"), body.querySelector("h1,h2,h3,h4")?.textContent, body.querySelectorAll("li").length]).toEqual([null, null, "Title", 2]);
    expect(body.textContent).toContain("<script>alert(1)</script>");
    expect([...body.querySelectorAll("a")].map((x: any) => x.getAttribute("href"))).toEqual(["https://example.com"]);
    // Nothing runs: no frame anywhere in the panel.
    expect(p.querySelector("iframe")).toBeNull();
    expect(p.querySelector(".pv-panel-dl").getAttribute("href")).toBe(`/ui/file/${ID(3)}`);
  });

  it("Source shows the text as written; Formatted draws it again; a card already read is not read twice", async () => {
    serve({ [ID(3)]: "# Title\n\n**bold**" });
    const doc = await chat([att(3, "notes.md")]);
    await click(doc.querySelector(".text-card .tc-show"));
    expect(reads).toBe(1);
    await click(doc.querySelector(".text-card .tc-panel"));
    expect(reads).toBe(1);                                    // the card's text came along
    const p = doc.querySelector(".pv-md-panel");
    const [formatted, source] = [...p.querySelectorAll(".seg-inline button")] as any[];
    expect(formatted.getAttribute("aria-pressed")).toBe("true");
    source.click(); await settleAll();
    expect(p.querySelector("pre.pv-code code").textContent).toBe("# Title\n\n**bold**");
    expect(p.querySelector(".pv-md")).toBeNull();
    formatted.click(); await settleAll();
    expect(p.querySelector(".pv-md strong")?.textContent).toBe("bold");
  });

  it("over 1 MiB: not read — the card's own note says to download it", async () => {
    serve({});
    const doc = await chat([att(3, "big.md", 2 * 1024 * 1024)]);
    await click(doc.querySelector(".text-card .tc-panel"));
    expect(reads).toBe(0);
    expect(doc.querySelector(".pv-md-panel .pv-note").textContent).toBe("This file is over 1 MiB; download it to read it.");
    expect(doc.querySelector(".pv-md-panel .pv-md")).toBeNull();
  });

  it("Close and Esc close it; another file replaces it; a non-Markdown text card has no Open in panel", async () => {
    serve({ [ID(3)]: "# A", [ID(4)]: "# B", [ID(5)]: "a,b" });
    const doc = await chat([att(3, "a.md"), att(4, "b.markdown"), att(5, "data.csv")]);
    const cards = [...doc.querySelectorAll(".text-card")] as any[];
    expect(cards.map((c) => !!c.querySelector(".tc-panel"))).toEqual([true, true, false]);
    await click(cards[0].querySelector(".tc-panel"));
    await click(cards[1].querySelector(".tc-panel"));
    expect(doc.querySelector(".pv-md-panel .pv-panel-title strong").textContent).toBe("b.markdown");
    expect(doc.querySelector(".pv-md-panel .pv-md h1, .pv-md-panel .pv-md h2, .pv-md-panel .pv-md h3")?.textContent).toBe("B");
    doc.querySelector(".pv-md-panel .pv-panel-close.only-wide").click(); await settleAll();
    expect(doc.querySelector(".pv-md-panel")).toBeNull();
    await click(cards[0].querySelector(".tc-panel"));
    const esc = new (globalThis as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    doc.querySelector(".pv-md-panel").dispatchEvent(esc); await settleAll();
    expect(doc.querySelector(".pv-md-panel")).toBeNull();
  });

  it("zh-TW", async () => {
    serve({ [ID(3)]: "# 標題" });
    i18n.setLang("zh-TW", { store: false });
    const doc = await chat([att(3, "notes.md")]);
    expect(doc.querySelector(".text-card .tc-panel").textContent).toBe("在面板中開啟");
    await click(doc.querySelector(".text-card .tc-panel"));
    expect([...doc.querySelectorAll(".pv-md-panel .seg-inline button")].map((b: any) => b.textContent)).toEqual(["排版", "原始內容"]);
  });

  it("the panel writes no HTML itself: rendered Markdown comes only through chat-thread's drawMarkdown", () => {
    const src = readFileSync("src/ui/preview-panel.js", "utf8");
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/);
    expect(src).toContain('import { drawMarkdown, TEXT_CARD_MAX } from "./chat-thread.js";');
  });
});
