/**
 * M-3814 (the user's decision, 2026-11-26): the public link's preview failed on Cloudflare's limit on new temporary links
 * (429). The notice keeps saying why and that Download still opens the file, and adds a blue text link to Settings →
 * Access at the fixed address, where the fixed preview address is set up. Only for that reason, and never on a guest's
 * page. The real modules (panel-chat.js, chat-thread.js, preview-panel.js, preview.js) run here in the mini DOM.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const DASH = "https://agend.example.net";
const FAILED = { dashboardOrigin: DASH, previewOrigin: "", previewBoot: "", previewReason: "", previewReasonCode: "publicLinkPreviewFailed", previewDetail: "rate-limited" };
let PV: any, panel: any, pp: any, i18n: any;
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
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({ stream: { on() {} }, boot: FAILED, deps: { fetch: () => new Promise(() => {}) } });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await current?.unmount();
  pp.closePanel();
  panel.store.state.msgs.w = [];
  current?.restore();
  current = null;
  i18n.setLang("en");
});

const agent = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: `2026-01-01T00:00:0${id}Z` });
const FENCE = "```html\n<h1>hi</h1>\n```";
async function chat(opts: { guest?: boolean; detail?: string } = {}) {
  current = page({ url: `${DASH}/ui/chat/w`, storage: { agend_html_preview: "on", agend_tour_done: "1" } });
  if (opts.guest) current.document.body.setAttribute("data-tier", "guest");
  PV.init({ ...FAILED, previewDetail: opts.detail ?? "rate-limited" }, { text: (k: string, ...v: unknown[]) => { const key = `chat.${k}`, s = i18n.t(key, ...v); return s === key ? null : s; } });
  panel.store.state.msgs.w = [agent(1, FENCE)];
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  await settle(4);
  const doc = current.document as any;
  const card = doc.querySelector(".msg.agent .html-card");
  return { doc, card, note: card.querySelector(".pv-note"), link: card.querySelector(".pv-note a.pv-fix") };
}

describe("M-3814: the 429 notice links to the fixed preview address", () => {
  it("the chat card: why, Download kept, and the link to Settings → Access at the fixed address (en)", async () => {
    const { card, note, link } = await chat();
    expect(note.textContent).toContain("Cloudflare is limiting new temporary links from this machine — try again in a while, or download the file to open it");
    expect(link?.textContent).toBe("Set up a fixed preview address");
    expect(link?.getAttribute("href")).toBe("/settings/access#publicFixedAddress");
    expect(card.querySelector(".pv-dl"), "Download stays the other action").not.toBeNull();
    expect(card.querySelector(".pv-run").hidden, "no Preview to press").toBe(true);
  });
  it("zh-TW", async () => {
    i18n.setLang("zh-TW");
    const { note, link } = await chat();
    expect(note.textContent).toContain("Cloudflare 正在限制這台機器建立新的臨時連結 — 請過一陣子再試，或下載檔案來開啟");
    expect(link?.textContent).toBe("設定固定的預覽網址");
  });
  it("only for that reason: another preview failure has no link", async () => {
    const { note, link } = await chat({ detail: "exited" });
    expect(note.textContent).toContain("its address closed unexpectedly");
    expect(link).toBeNull();
  });
  it("never on a guest's page (Settings is not theirs)", async () => {
    const { note, link } = await chat({ guest: true });
    expect(note.textContent).toContain("Cloudflare is limiting new temporary links");
    expect(link).toBeNull();
  });
  it("the side panel (Open in panel): the same link beside the same words, Download in its toolbar", async () => {
    const { doc, card } = await chat();
    const open = card.querySelector(".pv-open");
    if (typeof open.onclick === "function") open.onclick(); else open.click();
    await settle(8);
    const note = [...doc.querySelectorAll(".pv-panel .pv-note")].find((n: any) => /Cloudflare is limiting/.test(n.textContent)) as any;
    expect(note, "the panel says why").toBeTruthy();
    expect(note.querySelector("a.pv-fix")?.getAttribute("href")).toBe("/settings/access#publicFixedAddress");
    expect(doc.querySelector(".pv-panel .pv-panel-dl")).not.toBeNull();
  });
});

describe("M-3814: preview.js's availability() names the fix only for the 429", () => {
  const load = (cfg: Record<string, string>, guest = false) => {
    const sandbox: any = { location: { origin: DASH }, localStorage: { getItem: () => "on", setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { body: { getAttribute: (k: string) => (k === "data-tier" && guest ? "guest" : null) } }, performance: { now: () => 0 }, addEventListener() {}, module: { exports: {} as any } };
    vm.runInNewContext(readFileSync(join(process.cwd(), "src", "ui", "shared", "preview.js"), "utf8"), sandbox);
    const P = sandbox.module.exports; P.init(cfg); return P.availability();
  };
  it("rate-limited → { href, label }; other reasons, guests and a working preview → none", () => {
    expect(load(FAILED).fix).toEqual({ href: "/settings/access#publicFixedAddress", label: "Set up a fixed preview address" });
    expect(load({ ...FAILED, previewDetail: "unreachable" }).fix).toBeUndefined();
    expect(load({ ...FAILED, previewReasonCode: "publicLinkStarting", previewDetail: "" }).fix).toBeUndefined();
    expect(load(FAILED, true).fix).toBeUndefined();
    expect(load({ dashboardOrigin: DASH, previewOrigin: "https://preview.example.net", previewBoot: "c".repeat(32), previewReason: "", previewReasonCode: "", previewDetail: "" }).fix).toBeUndefined();
  });
});
