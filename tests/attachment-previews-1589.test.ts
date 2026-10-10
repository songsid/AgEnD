/**
 * #1589: chat attachments preview inline — media plays with native controls from the fleet-issued id (one byte range at
 * a time, 206), text shows in a card, escaped, never run. The file route still serves every other type exactly as
 * before; the app shell's media-src is exactly <origin>/ui/file/ ('none' on the public link); the public link shows
 * downloads only. Server: the real ledger and the real route. Page: the real chat modules in the mini DOM.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MEDIA_RANGE_MAX, WebFileLedger } from "../src/web-upload.js";
import { handleWebRequest, serveAppShell } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { panelContentSecurityPolicy } from "../src/web-host-guard.js";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

// ── the file route ──

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function served(name: string, bytes: Buffer | string) {
  const d = mkdtempSync(join(tmpdir(), "agend-1589-")); dirs.push(d);
  const path = join(d, name);
  writeFileSync(path, bytes);
  const ledger = new WebFileLedger();
  const file = ledger.registerServed({ path, instance: "w" })!;
  return { ledger, file, path, dir: d };
}
function get(ledger: WebFileLedger, id: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve) => {
    const h: Record<string, string> = {};
    let status = 0;
    const res = {
      setHeader(k: string, v: string) { h[k.toLowerCase()] = String(v); },
      writeHead(c: number, more?: Record<string, string>) { status = c; for (const [k, v] of Object.entries(more ?? {})) h[k.toLowerCase()] = String(v); return res; },
      end(b?: Buffer | string) { resolve({ status, headers: h, body: Buffer.isBuffer(b) ? b : Buffer.from(b ?? "") }); },
    } as unknown as ServerResponse;
    const TOKEN = "u".repeat(48);
    const req = Object.assign(new EventEmitter(), { method: "GET", url: `/ui/file/${id}`, headers: { "x-agend-token": TOKEN, ...headers }, destroy() {}, resume() {} }) as unknown as IncomingMessage;
    const ctx = { webToken: TOKEN, sseClients: new Set(), fleetConfig: { instances: {} }, logger: { info() {}, debug() {}, error() {} }, getUiStatus: () => ({}), webFiles: ledger } as never;
    handleWebRequest(req, res, new URL(`http://127.0.0.1:19280/ui/file/${id}`), ctx);
  });
}
const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

describe("the file route plays media by id, one byte range at a time (#1589)", () => {
  it("a media file is typed by its extension and answered inline", () => {
    const kinds = ["a.mp4", "a.webm", "a.mov", "a.mp3", "a.m4a", "a.wav", "a.ogg"].map((n) => served(n, "x").file.mime);
    expect(kinds).toEqual(["video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"]);
  });
  it.each([
    ["bytes=0-9", 206, "bytes 0-9/1000", 0, 10],
    ["bytes=990-", 206, "bytes 990-999/1000", 990, 10],
    ["bytes=-4", 206, "bytes 996-999/1000", 996, 4],
    ["bytes=500-5000", 206, "bytes 500-999/1000", 500, 500],
  ])("Range %s → %i %s", async (range, status, contentRange, from, len) => {
    const { ledger, file } = served("clip.mp4", VIDEO);
    const r = await get(ledger, file.id, { range });
    expect([r.status, r.headers["content-range"], r.headers["accept-ranges"], r.headers["content-type"]]).toEqual([status, contentRange, "bytes", "video/mp4"]);
    expect(r.body.equals(VIDEO.subarray(from, from + len))).toBe(true);
    expect([r.headers["x-content-type-options"], r.headers["cache-control"], r.headers["content-security-policy"]?.includes("sandbox"), r.headers["content-disposition"]?.startsWith("inline")])
      .toEqual(["nosniff", "private, no-store", true, true]);
  });
  it("past the end: 416 with the size", async () => {
    const { ledger, file } = served("clip.mp4", VIDEO);
    const r = await get(ledger, file.id, { range: "bytes=1000-" });
    expect([r.status, r.headers["content-range"]]).toEqual([416, "bytes */1000"]);
  });
  it.each([["no Range", {}], ["several ranges", { range: "bytes=0-1,5-6" }], ["not bytes", { range: "items=0-1" }]])("%s: the whole file (200), as a Download gets it", async (_n, headers) => {
    const { ledger, file } = served("clip.mp4", VIDEO);
    const r = await get(ledger, file.id, headers as Record<string, string>);
    expect([r.status, r.body.length, r.headers["content-range"]]).toEqual([200, 1000, undefined]);
  });
  it("one answer carries at most MEDIA_RANGE_MAX bytes (a player asks for the rest)", async () => {
    const big = Buffer.alloc(MEDIA_RANGE_MAX + 1000, 7);
    const { ledger, file } = served("big.mp4", big);
    const r = await get(ledger, file.id, { range: "bytes=0-" });
    expect([r.status, r.body.length, r.headers["content-range"]]).toEqual([206, MEDIA_RANGE_MAX, `bytes 0-${MEDIA_RANGE_MAX - 1}/${big.length}`]);
  });
  it("still by id only, re-checked on every range: a file swapped for a symlink after registration is not served", async () => {
    const { ledger, file, path, dir } = served("clip.mp4", VIDEO);
    writeFileSync(join(dir, "other.mp4"), VIDEO);
    unlinkSync(path); symlinkSync(join(dir, "other.mp4"), path);
    expect((await get(ledger, file.id, { range: "bytes=0-9" })).status).toBe(404);
    expect((await get(ledger, "../etc/passwd")).status).toBe(404);
  });
  it("control: every other type is served exactly as before — a text file stays an attachment with no ranges", async () => {
    const { ledger, file } = served("notes.md", "# hi");
    const r = await get(ledger, file.id, { range: "bytes=0-1" });
    expect([r.status, r.headers["content-type"], r.headers["content-disposition"]?.startsWith("attachment"), r.headers["accept-ranges"], r.body.toString()])
      .toEqual([200, "text/plain; charset=utf-8", true, undefined, "# hi"]);
  });
  it("text types an agent sends are text/plain (never html or script); html and svg are never inline", () => {
    expect(["a.toml", "a.yaml", "a.ts", "a.py", "a.csv"].map((n) => served(n, "x").file.mime)).toEqual(Array(5).fill("text/plain; charset=utf-8"));
    expect(["a.html", "a.svg"].map((n) => served(n, "<svg/>").file.mime)).toEqual(["application/octet-stream", "application/octet-stream"]);
  });
});

describe("the app shell's media-src is the file route only (#1589)", () => {
  it("exactly <origin>/ui/file/ when asked, nothing else changed; absent otherwise (as before)", () => {
    const withMedia = panelContentSecurityPolicy("n", { mediaSrc: "http://127.0.0.1:19280/ui/file/" });
    const without = panelContentSecurityPolicy("n");
    expect(withMedia).toBe(`${without}; media-src http://127.0.0.1:19280/ui/file/`);
    expect(without).not.toContain("media-src");
  });
});

describe("the app shell: media-src and the public-link marker (#1589)", () => {
  function shell(gateway: boolean, mode: "full" | "view-only" = "full", withPreview = true) {
    const req: any = Object.assign(new EventEmitter(), { method: "GET", url: "/ui", headers: { host: gateway ? "x.trycloudflare.com" : "127.0.0.1:19280" } });
    if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e1", expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
    let body = "", csp = "";
    const res: any = { setHeader(k: string, v: string) { if (k === "Content-Security-Policy") csp = v; }, writeHead() {}, end(t: string) { body = t; } };
    const ctx = (withPreview ? { previewForUi: () => ({ dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: null, reason: "off", code: "fleetOff" }) } : {}) as never;
    serveAppShell(req, res, ctx, mode);
    return { media: /media-src ([^;]+)/.exec(csp)?.[1] ?? null, marker: /<body[^>]*data-public-link="1"/.test(body) };
  }
  it("this computer's listener: media-src exactly <origin>/ui/file/, no public-link marker", () => {
    expect(shell(false)).toEqual({ media: "http://127.0.0.1:19280/ui/file/", marker: false });
  });
  it("the public link: media-src 'none' and the marker (downloads only), whatever the preview settings say", () => {
    expect(shell(true)).toEqual({ media: "'none'", marker: true });
    expect(shell(true, "full", false)).toEqual({ media: "'none'", marker: true });
  });
  it("from the page's own address, not from the preview settings: media plays with previews unconfigured", () => {
    expect(shell(false, "full", false)).toEqual({ media: "http://127.0.0.1:19280/ui/file/", marker: false });
  });
  it("the view-only page shows no chat: media-src 'none'", () => {
    expect(shell(false, "view-only").media).toBe("'none'");
  });
});

// ── the page ──

let panel: any;
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
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({ stream: { on() {} }, boot: { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "", previewBoot: "", previewReason: "" }, deps: { fetch: () => new Promise(() => {}) } });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await current?.unmount();
  panel.store.state.msgs.w = [];
  current?.restore();
  current = null;
});
const ID = (n: number) => String(n).repeat(32).slice(0, 32);
const att = (n: number, name: string, size = 100) => ({ id: ID(n), kind: "document", name, size, mime: "application/octet-stream" });
const agent = (attachments: unknown[]) => ({ boot: "b", id: 1, instance: "w", sender: "w", role: "agent", text: "Here.", ts: "2026-01-01T00:00:01Z", attachments });
function serve(files: Record<string, string>) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const id = /^\/ui\/file\/([0-9a-f]{32})$/.exec(url)?.[1];
    const body = id !== undefined ? files[id] : undefined;
    return body === undefined ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } : { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  }) as any;
}
async function chat(attachments: unknown[], publicLink = false) {
  current = page({ storage: { agend_tour_done: "1" } });
  if (publicLink) current.document.body.dataset.publicLink = "1";
  panel.store.state.msgs.w = [agent(attachments)];
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  return current.document as any;
}
const click = async (el: any) => { el.onclick(); await settle(); await settle(); await settle(); };

describe("media and text show inline in the chat (#1589)", () => {
  it("a video and an audio file play from their id with native controls; the download link stays", async () => {
    const doc = await chat([att(1, "clip.mp4"), att(2, "song.mp3")]);
    const v = doc.querySelector(".msg.agent video.att-video"), a = doc.querySelector(".msg.agent audio.att-audio");
    expect([v?.getAttribute("src"), v?.hasAttribute("controls"), a?.getAttribute("src"), a?.getAttribute("preload")]).toEqual([`/ui/file/${ID(1)}`, true, `/ui/file/${ID(2)}`, "metadata"]);
    expect(doc.querySelectorAll(".msg.agent a.att-file").length).toBe(2);
  });
  it("Markdown is rendered by the safe renderer: no script, no element from the file", async () => {
    serve({ [ID(3)]: "# Title\n\n<script>alert(1)</script> <img src=x onerror=alert(2)> [ok](https://example.com) [bad](javascript:alert(3))" });
    const doc = await chat([att(3, "notes.md")]);
    await click(doc.querySelector(".text-card .tc-show"));
    const body = doc.querySelector(".text-card .tc-body");
    expect([body.querySelector("script"), body.querySelector("img"), body.querySelector("h3,h2,h1,h4")?.textContent]).toEqual([null, null, "Title"]);
    expect(body.textContent).toContain("<script>alert(1)</script>");
    expect([...body.querySelectorAll("a")].map((x: any) => x.getAttribute("href"))).toEqual(["https://example.com"]);
  });
  it("csv is a table of text cells, quoted fields kept whole", async () => {
    serve({ [ID(4)]: 'name,note\nAda,"likes, commas"\n<b>x</b>,"say ""hi"""' });
    const doc = await chat([att(4, "data.csv")]);
    await click(doc.querySelector(".text-card .tc-show"));
    const rows = [...doc.querySelectorAll(".text-card tr")].map((r: any) => [...r.children].map((c: any) => c.textContent));
    expect(rows).toEqual([["name", "note"], ["Ada", "likes, commas"], ["<b>x</b>", 'say "hi"']]);
    expect(doc.querySelector(".text-card b")).toBe(null);
  });
  it("json is shown pretty and highlighted (escaped); code by its language; toml as plain text", async () => {
    serve({ [ID(5)]: '{"a":1,"b":"<i>"}', [ID(6)]: "const x = '<i>';", [ID(7)]: 'key = "<i>"' });
    const doc = await chat([att(5, "x.json"), att(6, "app.ts"), att(7, "conf.toml")]);
    for (const b of doc.querySelectorAll(".text-card .tc-show")) await click(b);
    const codes = [...doc.querySelectorAll(".text-card code")].map((c: any) => c.textContent);
    expect(codes).toEqual(['{\n  "a": 1,\n  "b": "<i>"\n}', "const x = '<i>';", 'key = "<i>"']);
    expect(doc.querySelector(".text-card i")).toBe(null);
  });
  it("the first 200 lines, then Show all; over 1 MiB is a download; a gone file says so", async () => {
    serve({ [ID(8)]: Array.from({ length: 450 }, (_, i) => `line ${i}`).join("\n") });
    const doc = await chat([att(8, "big.log"), att(9, "huge.txt", 2 * 1024 * 1024), att(1, "missing.txt")]);
    const [big, huge, missing] = [...doc.querySelectorAll(".text-card")] as any[];
    await click(big.querySelector(".tc-show"));
    expect(big.querySelector("code").textContent.split("\n").length).toBe(200);
    expect(big.querySelector(".tc-more").textContent).toBe("Show all 450 lines");
    await click(big.querySelector(".tc-more"));
    expect(big.querySelector("code").textContent.split("\n").length).toBe(450);
    await click(huge.querySelector(".tc-show"));
    expect(huge.querySelector(".pv-note").textContent).toBe("This file is over 1 MiB; download it to read it.");
    await click(missing.querySelector(".tc-show"));
    expect(missing.querySelector(".pv-note").textContent).toMatch(/no longer available/);
  });
  it("formatting has a budget the lines and 1 MiB do not give: one wide csv line or a dense code line becomes plain text", async () => {
    const wide = Array(100000).fill("x").join(","), dense = "0 ".repeat(10000), ticks = "`a` ".repeat(5000);
    const cols = `${Array(60).fill("h").join(",")}\n${Array(60).fill("v").join(",")}`;   // 120 cells, but 60 columns
    serve({ [ID(4)]: wide, [ID(6)]: dense, [ID(3)]: ticks, [ID(5)]: cols });
    const doc = await chat([att(4, "wide.csv"), att(6, "values.js"), att(3, "ticks.md"), att(5, "cols.csv")]);
    const cards = [...doc.querySelectorAll(".text-card")] as any[];
    for (const c of cards) await click(c.querySelector(".tc-show"));
    for (const c of cards) {
      expect(c.querySelectorAll("*").length).toBeLessThan(20);   // a handful of elements, not 100,000 cells or spans
      expect(c.querySelector(".tc-body .pv-note").textContent).toBe("Too large to format here: shown as plain text.");
    }
    expect(cards.map(c => c.querySelector(".tc-body code").textContent.length)).toEqual([wide.length, dense.length, ticks.length, cols.length]);
  });
  it("Show all does not lift the budget: a long csv is a table at 200 lines and text when all of it would pass the budget", async () => {
    serve({ [ID(4)]: Array.from({ length: 450 }, (_, i) => Array(10).fill(i).join(",")).join("\n") });
    const doc = await chat([att(4, "long.csv")]);
    const card = doc.querySelector(".text-card");
    await click(card.querySelector(".tc-show"));
    expect(card.querySelectorAll("tr").length).toBe(200);
    await click(card.querySelector(".tc-more"));
    expect([card.querySelector("table"), card.querySelector(".tc-body code").textContent.split("\n").length]).toEqual([null, 450]);
  });
  it("short ordinary files are still formatted (the control)", async () => {
    serve({ [ID(4)]: "a,b\n1,2", [ID(6)]: "const x = 1;", [ID(3)]: "- one\n- `two`" });
    const doc = await chat([att(4, "data.csv"), att(6, "app.js"), att(3, "notes.md")]);
    for (const b of doc.querySelectorAll(".text-card .tc-show")) await click(b);
    expect([doc.querySelectorAll(".text-card td").length, doc.querySelectorAll(".text-card .tc-pre span").length > 0, doc.querySelectorAll(".text-card li").length]).toEqual([2, true, 2]);
    expect(doc.querySelector(".text-card .tc-body .pv-note")).toBe(null);
  });
  it("a read that ends after the card left the page draws nothing", async () => {
    let release!: () => void;
    globalThis.fetch = vi.fn(() => new Promise(r => { release = () => r({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("const OLD = 1;").buffer }); })) as any;
    const doc = await chat([att(6, "old.js")]);
    const card = doc.querySelector(".text-card");
    card.querySelector(".tc-show").onclick();
    await settle();
    await current!.unmount(); current!.restore(); current = null;
    expect(card.isConnected).toBe(false);
    release(); await settle(); await settle(); await settle();
    expect(card.querySelector("code") === null).toBe(true);
  });
  it("the public link shows downloads only: no media, no text card", async () => {
    const doc = await chat([att(1, "clip.mp4"), att(3, "notes.md")], true);
    expect([doc.querySelector("video"), doc.querySelector(".text-card"), doc.querySelectorAll("a.att-file").length]).toEqual([null, null, 2]);
  });
  it("a gone attachment (#1565), an image, an .html file and a PDF get no inline preview", async () => {
    const doc = await chat([{ gone: true, kind: "document", name: "old.mp4", size: 1, mime: "video/mp4" }, att(2, "page.html"), att(3, "doc.pdf"), { ...att(4, "pic.png"), kind: "photo" }]);
    expect([doc.querySelector("video"), doc.querySelector(".text-card")]).toEqual([null, null]);
    // A gone entry that still carries its id is never a preview either, wherever the type is asked.
    const R = (globalThis as { AgendChatRender?: { attachmentPreviewType(a: unknown): string | null } }).AgendChatRender!;
    expect([R.attachmentPreviewType({ ...att(5, "old.mp4"), gone: true }), R.attachmentPreviewType(att(5, "old.mp4"))]).toEqual([null, "video"]);
  });
  it("nothing it builds carries a style attribute (#1300)", async () => {
    serve({ [ID(4)]: "a,b\n1,2" });
    const doc = await chat([att(1, "clip.mp4"), att(4, "data.csv")]);
    await click(doc.querySelector(".text-card .tc-show"));
    expect([...doc.querySelectorAll(".msg [style]")]).toEqual([]);
  });
});
