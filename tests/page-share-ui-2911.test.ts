/**
 * #2911 item 8: page share links in the web chat — the preview panel's Share page (an admin's, where the fleet offers
 * it): a confirm dialog every time (what, "runs the page's own scripts", for how long), the link shown once to copy,
 * "Shared until …" with Stop sharing on that page, and Settings' list with Stop and Stop all. The page only names the
 * block ({ instance, boot, id, fence | att }): the server reads the page itself.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom, settle, fire } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

const BOOT = "e".repeat(32);
let PV: any, panel: any, pp: any, PS: any;
const stream: Record<string, (m: unknown) => void> = {};
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
  // @ts-expect-error — a JS module of the app, with no types
  PS = await import("../src/ui/page-share-dialog.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({
    stream: { on(ev: string, fn: (m: unknown) => void) { stream[ev] = fn; } },
    boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" },
    deps: { fetch: () => new Promise(() => {}) },
  });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});

const URL_ = `https://s1.trycloudflare.com/p/${"T".repeat(43)}`;
/** The host's /ui/page-share, recorded. */
function host(over: { enabled?: boolean; cdn?: boolean; post?: (b: any) => [number, unknown]; expiresInMs?: number } = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let shares: any[] = [];
  const fetchMock = vi.fn(async (path: string, o: { method?: string; body?: string } = {}): Promise<any> => {
    const method = o.method ?? "GET";
    calls.push({ method, path, ...(o.body ? { body: JSON.parse(o.body) } : {}) });
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (path.startsWith("/ui/file/")) {
      const bytes = new TextEncoder().encode("<title>Report</title><p>r</p>");
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer, json: async () => ({}) };
    }
    if (path !== "/ui/page-share" && !path.startsWith("/ui/page-share/")) return reply(404, {});
    if (method === "GET") { shares = shares.filter((x) => x.expiresAt > Date.now()); return reply(200, { enabled: over.enabled !== false, cdn: over.cdn === true, shares }); }
    if (method === "POST") {
      const b = JSON.parse(o.body!);
      const share = { id: "a1b2c3d4", instance: b.instance, title: "Counter", owner: "person:discord:1", from: { boot: b.boot, id: b.id, ...(b.att ? { att: b.att } : { fence: b.fence }) }, bytes: 10, createdAt: Date.now(), expiresAt: Date.now() + (over.expiresInMs ?? b.minutes * 60_000) };
      const [status, body] = over.post ? over.post(b) : [200, { share, url: URL_ }];
      if (status === 200) shares = [share];
      return reply(status, body);
    }
    if (method === "DELETE") { const n = shares.length; shares = []; return reply(n ? 200 : 404, n ? { revoked: n } : { error: "not_found" }); }
    return reply(404, {});
  });
  return { fetchMock, calls };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await current?.unmount();
  PV.stopAll("test-end");
  pp.closePanel();
  panel.store.state.msgs.w = [];
  current?.restore();
  current = null;
  delete (globalThis as any).AgendAuth;
});

const agent = (id: number, text: string, extra: object = {}) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: "2026-01-01T00:00:01Z", ...extra });
const FENCE = (body: string) => "```html\n" + body + "\n```";
const click = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(); };

async function chat(msgs: unknown[], opts: { admin?: boolean; enabled?: boolean; cdn?: boolean; post?: (b: any) => [number, unknown]; expiresInMs?: number } = {}) {
  const hst = host(opts);
  current = page({ storage: { agend_html_preview: "on", agend_tour_done: "1" } });
  (globalThis as any).fetch = hst.fetchMock;
  (globalThis as any).AgendAuth = { canWrite: async () => opts.admin !== false };
  await PS.refreshPageShares();
  panel.store.state.msgs.w = msgs;
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  const doc = current.document as any;
  (doc.querySelector(".chat-split") as any).clientWidth = 1200;
  const opens = doc.querySelectorAll(".msg.agent .html-card .pv-open");
  await click(opens[opens.length - 1]);                       // the last block: its number names it
  await settle(3);
  return { doc, hst };
}

describe("#2911 Share page in the preview panel", () => {
  it("an admin: Share page → the confirm dialog (what, runs the page's own scripts, never \"safe\") → Share → the link once → Shared until · Stop sharing", async () => {
    const { doc, hst } = await chat([agent(1, "Two\n" + FENCE("<title>Old</title>") + "\n" + FENCE("<title>Counter</title><h1>v1</h1>"))]);
    const btn = doc.querySelector(".pv-panel .pv-fb-share");
    expect(btn, "Share page").toBeTruthy();
    expect(btn.textContent).toBe("Share page");
    await click(btn); await settle(2);
    const dlg = doc.querySelector(".ps");
    expect(dlg.querySelector(".ps-what").textContent).toContain("“Counter”");
    expect(dlg.querySelector(".ps-runs").textContent).toContain("runs the page's own scripts");
    expect(doc.querySelector(".dlg-box")?.textContent ?? dlg.textContent).not.toMatch(/\bsafe/i);
    expect(hst.calls.filter(c => c.method === "POST"), "nothing shared before the click").toEqual([]);
    const how = dlg.querySelector(".ps-how");
    how.value = "480"; fire(how, "change"); await settle(1);
    await click(doc.querySelector(".ps-create")); await settle(4);
    expect(hst.calls.find(c => c.method === "POST")?.body).toEqual({ instance: "w", boot: "b", id: 1, fence: 1, minutes: 480 });
    expect(doc.querySelector(".ps-url").value).toBe(URL_);
    expect(doc.querySelector(".ps-copy")).toBeTruthy();
    // Closed and reopened: the link is not shown again; the bar says until when, and Stop sharing ends it.
    doc.querySelectorAll(".dlg-actions button").at(-1).click(); await settle(3);
    const shared = doc.querySelector(".pv-panel .pv-fb-shared");
    expect(shared, "Shared until …").toBeTruthy();
    expect(shared.textContent).toMatch(/^Shared until /);
    await click(shared); await settle(2);
    expect(doc.querySelector(".ps-url"), "the link is shown only once").toBe(null);
    expect(doc.querySelector(".ps-now").textContent).toContain("Stop sharing ends the link at once");
    await click(doc.querySelector(".ps-stop")); await settle(4);
    expect(hst.calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual(["/ui/page-share/a1b2c3d4"]);
    expect(doc.querySelector(".pv-panel .pv-fb-share"), "Share page again").toBeTruthy();
  });

  it("an attached .html file is named by its id; a refusal is said in words, nothing to copy", async () => {
    const att = { id: "f".repeat(32), kind: "document", name: "report.html", size: 40, mime: "text/html" };
    const { doc, hst } = await chat([agent(2, "A report.", { attachments: [att] })], { post: () => [413, { error: "too_large" }] });
    const btn = doc.querySelector(".pv-panel .pv-fb-share");
    expect(btn, "Share page for an attached page").toBeTruthy();
    await click(btn); await settle(2);
    await click(doc.querySelector(".ps-create")); await settle(4);
    expect(hst.calls.find(c => c.method === "POST")?.body).toMatchObject({ instance: "w", boot: "b", id: 2, att: att.id });
    expect(doc.querySelector(".ps-err").textContent).toContain("too large to share");
    expect(doc.querySelector(".ps-url")).toBe(null);
  });

  it("no Share page for a session that is not an admin's (and nothing asked), or where the fleet turned it off", async () => {
    const a = await chat([agent(1, FENCE("<title>X</title>"))], { admin: false });
    expect(a.doc.querySelector(".pv-panel .pv-fb-reply"), "the panel is open").toBeTruthy();
    expect(a.doc.querySelector(".pv-fb-share")).toBe(null);
    expect(a.hst.calls).toEqual([]);
    await current?.unmount(); current?.restore(); current = null; pp.closePanel();
    const b = await chat([agent(1, FENCE("<title>X</title>"))], { enabled: false });
    expect(b.doc.querySelector(".pv-fb-share")).toBe(null);
  });

  it("#2924 review: when the share ends, the open shares are read again by themselves — the bar goes back to Share page without a reload", async () => {
    const { doc, hst } = await chat([agent(1, FENCE("<title>Counter</title>"))], { expiresInMs: 200 });
    await click(doc.querySelector(".pv-panel .pv-fb-share")); await settle(2);
    await click(doc.querySelector(".ps-create")); await settle(4);
    doc.querySelectorAll(".dlg-actions button").at(-1).click(); await settle(3);
    expect(doc.querySelector(".pv-panel .pv-fb-shared"), "shared").toBeTruthy();
    const gets = () => hst.calls.filter(c => c.method === "GET").length;
    const before = gets();
    await new Promise((r) => setTimeout(r, 1600));             // its end + the 1 s margin (never sooner than 1 s)
    await settle(4);
    expect(gets(), "read again at its end").toBe(before + 1);
    expect(doc.querySelector(".pv-panel .pv-fb-shared")).toBe(null);
    expect(doc.querySelector(".pv-panel .pv-fb-share"), "Share page again").toBeTruthy();
  });

  it("#2924 review: with web.preview_cdn on, the confirm dialog says viewers' browsers will request cdnjs / jsDelivr; off, it does not", async () => {
    const on = await chat([agent(1, FENCE("<title>Chart</title>"))], { cdn: true });
    await click(on.doc.querySelector(".pv-panel .pv-fb-share")); await settle(2);
    expect(on.doc.querySelector(".ps-cdn")?.textContent).toBe("This page may load libraries from cdnjs / jsDelivr; viewers' browsers will request them.");
    await current?.unmount(); current?.restore(); current = null; pp.closePanel();
    const off = await chat([agent(1, FENCE("<title>Chart</title>"))]);
    await click(off.doc.querySelector(".pv-panel .pv-fb-share")); await settle(2);
    expect(off.doc.querySelector(".ps"), "the dialog").toBeTruthy();
    expect(off.doc.querySelector(".ps-cdn")).toBe(null);
  });

  it("refusal words", () => {
    expect(PS.refusalText({ error: "tunnel", reason: "rate-limited" })).toContain("Try again in a few minutes");
    expect(PS.refusalText({ error: "disabled" })).toContain("web.page_share.enabled: false");
    expect(PS.refusalText({ error: "page_gone" })).toContain("no longer in the chat");
    expect(PS.refusalText({ error: "weird" })).toBe("The link could not be made.");
  });

  it("shareOf matches a share to its block (fence or attachment) and instance", () => {
    const shares = [{ id: "1", instance: "w", from: { boot: "b", id: 1, fence: 0 } }, { id: "2", instance: "w", from: { boot: "b", id: 2, att: "f".repeat(32) } }];
    expect(PS.shareOf(shares, "w", { boot: "b", id: 1, fence: 0 })?.id).toBe("1");
    expect(PS.shareOf(shares, "w", { boot: "b", id: 1, fence: 1 })).toBe(null);
    expect(PS.shareOf(shares, "x", { boot: "b", id: 1, fence: 0 })).toBe(null);
    expect(PS.shareOf(shares, "w", { boot: "b", id: 2, att: "f".repeat(32) })?.id).toBe("2");
  });
});

describe("#2911 Settings → Shared pages", () => {
  it("lists the open ones with Stop and Stop all; hidden from a session that is not an admin's", async () => {
    const hst = host();
    (globalThis as any).fetch = hst.fetchMock;
    (globalThis as any).AgendAuth = { canWrite: async () => true };
    await hst.fetchMock("/ui/page-share", { method: "POST", body: JSON.stringify({ instance: "w", boot: "b", id: 1, fence: 0, minutes: 60 }) });
    await PS.refreshPageShares();
    current = page({});
    await current.mount(h(PS.PageSharesCard, {}));
    await settle(3);
    const doc = current.document as any;
    expect(doc.querySelectorAll(".ps-card .os-row")).toHaveLength(1);
    expect(doc.querySelector(".ps-card .os-row").textContent).toContain("Counter");
    expect(doc.querySelector(".ps-card .os-row").textContent).toContain("from w");
    await click(doc.querySelector(".ps-card .os-row button")); await settle(4);
    expect(hst.calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual(["/ui/page-share/a1b2c3d4"]);
    expect(doc.querySelector(".ps-card .os-none")).toBeTruthy();
    await current.unmount(); current.restore(); current = null;
    (globalThis as any).AgendAuth = { canWrite: async () => false };
    await PS.refreshPageShares();
    current = page({});
    await current.mount(h(PS.PageSharesCard, {}));
    await settle(2);
    expect((current.document as any).querySelector(".ps-card")).toBe(null);
  });
});
