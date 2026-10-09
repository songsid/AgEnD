/**
 * #1306 segment B: the card, the parent side of the preview, and the chat's keyed renderer around it.
 * Design: docs/design/1306-inline-html-preview.md §3.2 (page check), §4.2, §5.3, §6, §7, §8, §10.1 (items 5–9).
 * The page code (chat-render.js, preview.js) runs as written, in a vm or in the mini DOM; the chat's own modules
 * (chat-thread.js, panel-chat.js) run as the app imports them (#1408). What a browser enforces is §10.2 (the recorded run).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";
// @ts-expect-error — a JS module of the app, with no types (as app-harness.ts does for preact)
import { createThread } from "../src/ui/chat-thread.js";

const UI = join(process.cwd(), "src", "ui");
const RENDER = readFileSync(join(UI, "chat-render.js"), "utf8");
const PREVIEW = readFileSync(join(UI, "preview.js"), "utf8");
type Fence = { code: string; terminated: boolean };
const render = () => { const c = vm.createContext({}); vm.runInContext(RENDER, c); return (c as unknown as { AgendChatRender: { renderMarkdown(t: string, o?: object): string; htmlFences(t: string): Fence[] } }).AgendChatRender; };

// ── 5. Detection ──

describe("which fences get a card (§6.1)", () => {
  const T = "hi\n```html\n<b>one</b>\n```\n```HTML\n<i>two</i>\n```\n```html5\nno\n```\n```xhtml\nno\n```\n```htm\nno\n```\n```html\nopen to the end";
  it("```html exactly (any case), closed → a placeholder after its code block; html5/xhtml/htm → none; a cut fence → truncated", () => {
    const r = render();
    expect(r.htmlFences(T)).toEqual([{ code: "<b>one</b>", terminated: true }, { code: "<i>two</i>", terminated: true }, { code: "open to the end", terminated: false }]);
    const html = r.renderMarkdown(T, { htmlCards: true });
    expect(html.match(/<div class="html-card[^"]*" data-card="\d+"><\/div>/g)).toEqual([
      '<div class="html-card" data-card="0"></div>', '<div class="html-card" data-card="1"></div>', '<div class="html-card truncated" data-card="2"></div>']);
  });
  it("without the option (anything but a server-marked agent message) there is no card at all", () => {
    const r = render();
    expect(r.renderMarkdown(T)).not.toContain("html-card");
    expect(r.renderMarkdown(T, {})).toBe(r.renderMarkdown(T));
  });
  it("hostile language tags, bodies and closers stay text; no HTML text reaches an attribute", () => {
    const r = render();
    const t = '```html" onerror="alert(1)\n<img src=x onerror=alert(1)></pre><script>alert(2)</script>\n```\n```html\n"><svg onload=alert(3)>\n```';
    const out = r.renderMarkdown(t, { htmlCards: true });
    const tags = out.match(/<[a-z][^>]*>/gi) ?? [];                 // the real tags (escaped text is not one)
    expect(tags.filter(t => /^<(img|script|svg)|\son[a-z]+=/i.test(t))).toEqual([]);
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;&lt;/pre&gt;&lt;script&gt;");
    for (const tag of out.match(/<div class="html-card[^>]*>/g) ?? []) expect(tag).toMatch(/^<div class="html-card( truncated)?" data-card="\d+">$/);
    expect(r.htmlFences(t).map(f => f.code)).toEqual(['<img src=x onerror=alert(1)></pre><script>alert(2)</script>', '"><svg onload=alert(3)>']);
  });
  it("the chat asks for cards only for role \"agent\" — from the server, never sender or text", () => {
    const THREAD = readFileSync(join(UI, "chat-thread.js"), "utf8");
    expect(THREAD).toContain('R().renderMarkdown(x.text, x.role === "agent" ? { htmlCards: true } : undefined)');
    const code = (src: string) => src.split("\n").filter(l => !/^\s*(\*|\/\/)/.test(l));
    const sites = uiFiles().flatMap(f => code(readFileSync(f, "utf8")).filter(l => /htmlCards:\s*true/.test(l)).map(() => f.slice(UI.length + 1)));
    expect(sites, "one call site").toEqual(["chat-thread.js"]);
  });
});

// ── 6. mountPreview ──

function uiFiles(dir = UI): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "web-terminal" ? [] : uiFiles(p);   // the terminal's vendored xterm is its own page
    return /\.(html|js)$/.test(f) ? [p] : [];
  });
}

describe("mountPreview is the one frame (§5.3)", () => {
  it("nothing else in src/ui creates an iframe or writes sandbox", () => {
    const hits = uiFiles().flatMap(f => {
      // Code only: comments may name these words.
      // Strip until nothing changes, so a comment that removal joins up is stripped too.
      let src = readFileSync(f, "utf8"), before;
      do {
        before = src;
        src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/<!--[\s\S]*?-->/g, "");
      } while (src !== before);
      return [...src.matchAll(/createElement\(\s*["'`]iframe["'`]\s*\)|<iframe\b|["'`]sandbox["'`]|\.sandbox\b/gi)].map(m => `${f.slice(UI.length + 1)}: ${m[0]}`);
    });
    expect(hits).toEqual(['preview.js: createElement("iframe")', 'preview.js: "sandbox"']);
    expect(PREVIEW.indexOf('createElement("iframe")')).toBeGreaterThan(PREVIEW.indexOf("function mountPreview("));
  });

  it("its attributes are exactly these: allow-scripts only, no permissions, no referrer — and the URL carries no content", () => {
    const { P } = load({ optIn: true });
    const doc = fakeDoc();
    const f = P.mountPreview(doc);
    expect(f.attrs).toEqual({ sandbox: "allow-scripts", allow: "", referrerpolicy: "no-referrer", loading: "eager", title: "Untrusted HTML preview" });
    expect(f.src).toBe("http://127.0.0.1:19281/frame");
  });
});

// ── 7. The parent side, in a vm ──

interface FakeFrame { attrs: Record<string, string>; src: string; style: Record<string, string>; className: string; parentNode: FakeHolder | null; contentWindow: { posted: Array<[Record<string, unknown>, string]>; postMessage(m: unknown, t: string): void }; setAttribute(k: string, v: string): void }
interface FakeHolder { ownerDocument: ReturnType<typeof fakeDoc>; children: FakeFrame[]; appendChild(f: FakeFrame): void; removeChild(f: FakeFrame): void }
function fakeDoc() {
  const doc = {
    created: [] as FakeFrame[],
    createElement(tag: string): FakeFrame {
      if (tag !== "iframe") throw new Error(tag);
      const f: FakeFrame = {
        attrs: {}, src: "", style: {}, className: "", parentNode: null,
        contentWindow: { posted: [], postMessage(m: unknown, t: string) { f.contentWindow.posted.push([JSON.parse(JSON.stringify(m)), t]); } },
        setAttribute(k: string, v: string) { f.attrs[k] = v; },
      };
      doc.created.push(f);
      return f;
    },
  };
  return doc;
}
function holder(doc = fakeDoc()): FakeHolder {
  const h: FakeHolder = { ownerDocument: doc, children: [], appendChild(f) { h.children.push(f); f.parentNode = h; }, removeChild(f) { h.children = h.children.filter(x => x !== f); f.parentNode = null; } };
  return h;
}
type Preview = {
  init(d: object): void; availability(): { ok: boolean; why: string; reason: string }; optedIn(): boolean; setOptIn(on: boolean): void; never(): boolean; setNever(on: boolean): void;
  start(key: string, h: FakeHolder, html: string, ui: { state(n: string, r: string): void }): boolean; stop(key: string): boolean; stopAll(): string[]; stopIn(node: unknown): string[];
  running(key: string): boolean; mountPreview(doc: unknown): FakeFrame; onMessage(e: unknown): void; onChange(fn: () => void): void; BANNER: string;
};
function load(o: { optIn?: boolean; never?: boolean; at?: string; data?: Record<string, string>; local?: Map<string, string> } = {}) {
  // Two tabs of one dashboard share localStorage (pass the same map); each has its own sessionStorage.
  const local = o.local ?? new Map<string, string>(o.optIn ? [["agend_html_preview", "on"]] : []);
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const session = new Map<string, string>(o.never ? [["agend_html_preview_never", "1"]] : []);
  const timers: Array<{ at: number; f: () => void; id: number }> = [];
  let clock = 0, nextId = 1;
  const root: Record<string, unknown> = {
    location: { origin: o.at ?? "http://127.0.0.1:19280" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => { local.set(k, v); }, removeItem: (k: string) => { local.delete(k); } },
    sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); }, removeItem: (k: string) => { session.delete(k); } },
    crypto: { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a; } },
    TextEncoder,
    performance: { now: () => clock },
    setTimeout: (f: () => void, ms: number) => { const id = nextId++; timers.push({ at: clock + ms, f, id }); return id; },
    clearTimeout: (id: number) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    requestAnimationFrame: (f: () => void) => { f(); return 0; },
    addEventListener: (t: string, f: (e: unknown) => void) => { (listeners[t] ??= []).push(f); },
    document: { visibilityState: "visible" },
  };
  root.window = root;
  const c = vm.createContext(root);
  vm.runInContext(PREVIEW, c);
  const P = (c as unknown as { AgendPreview: Preview }).AgendPreview;
  P.init(o.data ?? { dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "http://127.0.0.1:19281", previewBoot: "e".repeat(32), previewReason: "" });
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift(); clock = t.at; t.f();
    }
    clock = end;
  };
  // What the browser does in every OTHER tab when localStorage changes.
  const storageEvent = (key: string | null) => { for (const f of listeners.storage ?? []) f({ key }); };
  return { P, local, session, advance, storageEvent, setClock: (t: number) => { clock = t; } };
}
function started(o: Parameters<typeof load>[0] = { optIn: true }) {
  const env = load(o);
  const h = holder();
  const states: Array<[string, string]> = [];
  const ok = env.P.start("k1", h, "<p>hi</p>", { state: (n, r) => states.push([n, r]) });
  const frame = h.children[0];
  const from = (data: unknown, opts: { source?: unknown; origin?: string } = {}) =>
    env.P.onMessage({ source: "source" in opts ? opts.source : frame?.contentWindow, origin: opts.origin ?? "null", data });
  const ready = (boot = "e".repeat(32)) => from({ v: 1, type: "ready", ch: null, boot });
  const ch = () => (frame!.contentWindow.posted[0]?.[0] as { ch?: string } | undefined)?.ch;
  return { ...env, h, ok, frame, states, from, ready, ch };
}

describe("the parent: opt-in and availability (§3.2, §7)", () => {
  it("off by default: no frame is made, and the card is told how to turn previews on", () => {
    const s = started({ optIn: false });
    expect([s.ok, s.h.children.length, s.h.ownerDocument.created.length]).toEqual([false, 0, 0]);
    expect(s.states).toEqual([["unavailable", expect.stringMatching(/off on this device/)]]);
  });
  it("the Host-rewriting proxy: the server believed 127.0.0.1:19280, the page is at https://fleet.example.net → no frame, with the reason", () => {
    const s = started({ optIn: true, at: "https://fleet.example.net" });
    expect(s.ok).toBe(false);
    expect(s.h.ownerDocument.created).toHaveLength(0);
    expect(s.states[0]![1]).toMatch(/https:\/\/fleet\.example\.net.*127\.0\.0\.1:19280/);
  });
  it("no preview origin from the server (a tunnel without preview_origin): the server's reason", () => {
    const s = started({ optIn: true, data: { dashboardOrigin: "https://fleet.example.net", previewOrigin: "", previewBoot: "", previewReason: "Previews need web.preview_origin…" } });
    expect([s.ok, s.states[0]![1]]).toEqual([false, "Previews need web.preview_origin…"]);
  });
  it("the per-session kill switch hides it even after opting in", () => {
    expect(started({ optIn: true, never: true }).ok).toBe(false);
  });
  it("over 1 MiB of UTF-8 is never started", () => {
    const env = load({ optIn: true });
    const h = holder();
    expect(env.P.start("k", h, "é".repeat(512 * 1024 + 1), { state() {} })).toBe(false);
    expect(h.children).toHaveLength(0);
  });
});

describe("the parent: the frame's messages (§4.2)", () => {
  it("render goes once, only after a valid ready, with only {v, type, ch, html}, to * (the opaque frame)", () => {
    const s = started();
    expect(s.ok).toBe(true);
    expect(s.frame!.contentWindow.posted).toEqual([]);
    s.ready(); s.ready();
    expect(s.frame!.contentWindow.posted).toEqual([[{ v: 1, type: "render", ch: expect.stringMatching(/^[0-9a-f]{32}$/), html: "<p>hi</p>" }, "*"]]);
    expect(s.states.map(x => x[0])).toEqual(["starting", "running"]);
  });

  it.each([
    ["from another window", (s: ReturnType<typeof started>) => s.from({ v: 1, type: "ready", ch: null, boot: "e".repeat(32) }, { source: {} })],
    ["from a real origin (not the opaque sandbox)", (s: ReturnType<typeof started>) => s.from({ v: 1, type: "ready", ch: null, boot: "e".repeat(32) }, { origin: "http://127.0.0.1:19281" })],
    ["with an extra key", (s: ReturnType<typeof started>) => s.from({ v: 1, type: "ready", ch: null, boot: "e".repeat(32), html: "x" })],
    ["with an unknown type", (s: ReturnType<typeof started>) => s.from({ v: 1, type: "render", ch: null, boot: "e".repeat(32) })],
    ["as a string", (s: ReturnType<typeof started>) => s.from(JSON.stringify({ v: 1, type: "ready", ch: null, boot: "e".repeat(32) }))],
    ["with v: 2", (s: ReturnType<typeof started>) => s.from({ v: 2, type: "ready", ch: null, boot: "e".repeat(32) })],
  ])("a ready %s is ignored: nothing is sent", (_why, act) => {
    const s = started();
    act(s);
    expect(s.frame!.contentWindow.posted).toEqual([]);
    expect(s.P.running("k1")).toBe(true);
  });

  it("a ready with another boot id (something else answered on the port): stopped, nothing sent", () => {
    const s = started();
    s.ready("f".repeat(32));
    expect(s.frame!.contentWindow.posted).toEqual([]);
    expect(s.P.running("k1")).toBe(false);
    expect(s.states.at(-1)).toEqual(["unavailable", expect.stringMatching(/something else answered/)]);
  });

  it("opted out between Preview and ready: nothing is sent", () => {
    const s = started();
    s.local.delete("agend_html_preview");
    s.ready();
    expect(s.frame!.contentWindow.posted).toEqual([]);
    expect(s.P.running("k1")).toBe(false);
  });

  it("no ready within 3 s: unavailable, the frame is gone", () => {
    const s = started();
    s.advance(2999);
    expect(s.P.running("k1")).toBe(true);
    s.advance(2);
    expect([s.P.running("k1"), s.h.children.length]).toEqual([false, 0]);
    expect(s.states.at(-1)![1]).toMatch(/did not answer/);
  });

  it("heights: clamped to [40, 4000]; non-integer, string, wrong ch, before render → ignored; Δ < 2 px ignored", () => {
    const s = started();
    const resize = (height: unknown, ch = s.ch()) => s.from({ v: 1, type: "resize", ch, height });
    resize(500);
    expect(s.frame!.style.height).toBe("40px");                     // before render: ignored
    s.ready();
    resize(500); expect(s.frame!.style.height).toBe("500px");
    s.advance(200); resize(501); expect(s.frame!.style.height).toBe("500px");
    s.advance(200); resize(-50); expect(s.frame!.style.height).toBe("40px");
    s.advance(200); resize(99999); expect(s.frame!.style.height).toBe("4000px");
    s.advance(200); resize(300.5); resize("300"); resize(Infinity); resize(NaN); resize(300, "0".repeat(32));
    expect(s.frame!.style.height).toBe("4000px");
  });

  it("at most 10 height changes a second, and 5 growths within 2 s freeze it (the frame scrolls instead)", () => {
    const s = started(); s.ready();
    const resize = (height: number) => s.from({ v: 1, type: "resize", ch: s.ch(), height });
    for (let i = 0; i < 15; i++) resize(i % 2 ? 100 : 200);   // alternating: no growth run, but the rate limit
    const applied = Number(s.frame!.style.height.replace("px", ""));
    expect([100, 200]).toContain(applied);
    s.advance(1100);
    const s2 = started(); s2.ready();
    const grow = (h: number) => { s2.advance(50); s2.from({ v: 1, type: "resize", ch: s2.ch(), height: h }); };
    grow(100); grow(200); grow(300); grow(400); grow(500);
    expect(s2.frame!.style.height).toBe("500px");
    grow(600);
    expect(s2.frame!.style.height, "the sixth growth inside 2 s froze it").toBe("500px");
    s2.advance(5000); grow(900);
    expect(s2.frame!.style.height, "frozen for good").toBe("500px");
  });

  it("watchdog: 10 s without a heartbeat while visible → closed; a heartbeat keeps it alive", () => {
    const s = started(); s.ready();
    s.advance(9000); s.from({ v: 1, type: "heartbeat", ch: s.ch() });
    s.advance(9000);
    expect(s.P.running("k1")).toBe(true);
    s.advance(1001);
    expect(s.P.running("k1")).toBe(false);
    expect(s.states.at(-1)![1]).toMatch(/stopped answering/);
  });

  it("one preview at a time; turning the opt-in off stops every running preview", () => {
    const env = load({ optIn: true });
    const h1 = holder(), h2 = holder();
    env.P.start("a", h1, "<p>a</p>", { state() {} });
    env.P.start("b", h2, "<p>b</p>", { state() {} });
    expect([env.P.running("a"), env.P.running("b"), h1.children.length]).toEqual([false, true, 0]);
    env.P.setOptIn(false);
    expect([env.P.running("b"), h2.children.length]).toEqual([false, 0]);
    expect(env.P.availability().why).toBe("optin");
  });

  it("the listener reaches nothing but its frames: no API, send, approve, composer, navigation or network in it", () => {
    const fn = PREVIEW.slice(PREVIEW.indexOf("  function onMessage(event) {"), PREVIEW.indexOf("  /** Height rules"));
    expect(fn.length).toBeGreaterThan(200);
    for (const banned of ["api(", "fetch", "XMLHttpRequest", "sendMsg", "answerPrompt", "cancelReply", "msgIn", "location.href", "location.assign", "location =", "window.open", "localStorage", "sessionStorage", "document.cookie"]) {
      expect(fn, banned).not.toContain(banned);
    }
    expect(PREVIEW).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
    // The HTML leaves only by postMessage: never in a URL.
    expect(PREVIEW).toMatch(/f\.src = cfg\.previewOrigin \+ "\/frame";/);
    expect(PREVIEW).not.toMatch(/encodeURIComponent|\?html|#html|\.src = [^;]*html/);
  });
});

describe("the opt-in is per device: another tab turning it off stops the previews here (#1332 review)", () => {
  function twoTabs() {
    const local = new Map<string, string>([["agend_html_preview", "on"]]);
    const a = load({ local }), b = load({ local });
    const h = holder();
    a.P.start("k", h, "<p>a</p>", { state() {} });
    const frame = h.children[0]!;
    a.P.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "ready", ch: null, boot: "e".repeat(32) } });
    const ch = (frame.contentWindow.posted[0]![0] as { ch: string }).ch;
    const changes: string[] = [];
    a.P.onChange(() => changes.push(a.P.optedIn() ? "on" : "off"));
    return { a, b, local, h, frame, ch, changes };
  }
  it("tab B opts out: tab A's running preview stops at once, and A's checkbox/cards are told", () => {
    const t = twoTabs();
    expect(t.a.P.running("k")).toBe(true);
    t.b.P.setOptIn(false);
    t.a.storageEvent("agend_html_preview");
    expect([t.a.P.running("k"), t.h.children.length]).toEqual([false, 0]);
    expect(t.changes).toEqual(["off"]);
  });
  it("storage cleared in another tab (key null): the same", () => {
    const t = twoTabs();
    t.local.clear();
    t.a.storageEvent(null);
    expect(t.a.P.running("k")).toBe(false);
  });
  it("another key changing stops nothing; opting in elsewhere starts nothing here", () => {
    const t = twoTabs();
    t.a.storageEvent("agend_theme");
    expect(t.a.P.running("k")).toBe(true);
    expect(t.changes, "another key is not this device's choice").toEqual([]);
    const local = new Map<string, string>(), c = load({ local });
    const h = holder(), seen: boolean[] = [];
    c.P.onChange(() => seen.push(c.P.optedIn()));
    local.set("agend_html_preview", "on");                            // tab B opted in
    c.storageEvent("agend_html_preview");
    expect(seen).toEqual([true]);                                     // the checkbox follows…
    expect([c.P.running("k"), h.children.length]).toEqual([false, 0]); // …but nothing starts by itself
  });
  it("a missed storage event: the next heartbeat ends it — a preview never outlives the permission", () => {
    const t = twoTabs();
    t.b.P.setOptIn(false);                                            // …and tab A never hears about it
    t.a.P.onMessage({ source: t.frame.contentWindow, origin: "null", data: { v: 1, type: "heartbeat", ch: t.ch } });
    expect(t.a.P.running("k")).toBe(false);
  });
});

// ── 8. The keyed renderer keeps a live preview — or stops it first (§6.2, #1408 §4) ──
// The real modules run here: chat-thread.js builds the messages and their cards in the mini DOM, preview.js starts the
// frames, and <ChatPanel> (panel-chat.js) mounts the thread the way the app does. What a browser does with a frame is
// the smoke in the PR (§10.2).

const BOOT = "e".repeat(32);
const DASHBOARD_ORIGIN = "http://127.0.0.1:19280";
let PV: any, panel: any;
let current: AppPage | null = null;

beforeAll(async () => {
  // Side-effect imports: each file sets its browser global (AgendChatRender, AgendPreview) as the page does.
  // @ts-expect-error — a JS module of the app, with no types (as app-harness.ts does for preact)
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types (as app-harness.ts does for preact)
  await import("../src/ui/preview.js");
  PV = (globalThis as any).AgendPreview;
  expect(typeof PV.liveCount, "preview.js loaded as the page's global").toBe("function");
  // boot() runs once per page: the store, the preview's server data, the tour (already seen on this device).
  const base = installDom({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types (as app-harness.ts does for preact)
  panel = await import("../src/ui/panel-chat.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({
    stream: { on() {} },
    boot: { dashboardOrigin: DASHBOARD_ORIGIN, previewOrigin: "http://127.0.0.1:19281", previewBoot: BOOT, previewReason: "" },
    deps: { fetch: () => new Promise(() => {}) },   // no history to read: the thread holds what the test puts in
  });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }, { name: "x", status: "running" }] });
  base.restore();
});

/** A fresh page on a device that has opted in to previews. */
function fresh(): AppPage {
  current = page({ storage: { agend_html_preview: "on", agend_tour_done: "1" } });
  return current;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await current?.unmount();
  PV.stopAll("test-end");
  if (panel) { panel.store.state.msgs.w = []; panel.store.state.msgs.x = []; }
  current?.restore();
  current = null;
});

const ts = (id: number) => `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`;
const agent = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: ts(id) });
const user = (id: number, delivery: string) => ({ boot: "b", id, instance: "w", sender: "web-user", role: "user", text: `you ${id}`, ts: ts(id), messageId: `web-${id}`, delivery });
const FENCE = (body: string) => "```html\n" + body + "\n```";
const keyOf = (id: number) => `b-${id}:f0`;

/** A thread bound the way the chat binds it (chat-thread.js createThread), in the page's body. */
function threadAt(doc: any) {
  const scroller = doc.createElement("div"); scroller.className = "scroller";
  const list = doc.createElement("div"); list.className = "thread";
  scroller.append(list); doc.body.append(scroller);
  const thread = createThread(list, scroller, {
    t: (k: string) => k, tf: (k: string) => k, isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
  });
  return { list, scroller, thread };
}

/** Press the card's Preview button, as a person does, then let the frame answer ready (its boot id is the server's). */
function runPreview(node: any, id: number) {
  (node.querySelector(".pv-run") as any).onclick();
  const frame = PV.liveFrame(keyOf(id));
  frame.contentWindow = { posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); } };
  PV.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "ready", ch: null, boot: BOOT } });
  return frame;
}

type Stop = { fn: "stop" | "stopIn" | "stopAll"; node: any; keys: unknown; attached: boolean; live: number };
/**
 * Every call the chat makes into the preview module's stop functions, in call order, for every message — nothing is
 * filtered by agent or key. `attached`: the node was still in its list when the call came; `live`: frames running then.
 */
function recordStops(): Stop[] {
  const log: Stop[] = [];
  for (const fn of ["stop", "stopIn", "stopAll"] as const) {
    const orig = PV[fn];
    vi.spyOn(PV, fn).mockImplementation((...args: any[]) => {
      const node = fn === "stopIn" ? args[0] : null;
      const attached = !!(node && node.parentNode);
      const live = PV.liveCount();
      const keys = orig(...args);
      log.push({ fn, node, keys, attached, live });
      return keys;
    });
  }
  return log;
}

/** Timers scheduled and not yet fired or cleared: what a leaked preview timer would leave behind. */
function trackTimers() {
  const g = globalThis as any;
  const real = { set: g.setTimeout, clear: g.clearTimeout };
  const pending = new Set<unknown>();
  g.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id = real.set(() => { pending.delete(id); fn(...args); }, ms);
    pending.add(id);
    return id;
  };
  g.clearTimeout = (id: unknown) => { pending.delete(id); real.clear(id as any); };
  return { count: () => pending.size, restore() { g.setTimeout = real.set; g.clearTimeout = real.clear; } };
}

describe("the chat's renderer and a live preview (§6.2, #1408 §4)", () => {
  // The design allows one running preview per page (start() stops another first), so these tests run one live frame
  // and check what happens to it — and that the frame elsewhere, or the chat's other nodes, are left alone.

  it("another message's tick and a new message: the agent's node and its live frame stay; no stop is asked of the preview", async () => {
    const pg = fresh();
    panel.store.state.msgs.w = [agent(1, FENCE("<p>a</p>")), user(2, "queued")];
    await pg.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
    const list = pg.document.querySelector(".thread") as any;
    const node = list.children[0], userBefore = list.children[1];
    const frame = runPreview(node, 1);
    const log = recordStops();

    panel.store.applyDeliveries([{ instance: "w", messageId: "web-2", delivery: "delivered" }]);
    panel.store.ingest(agent(3, "NEW"));

    expect(list.children.length, "the new message is there").toBe(3);
    expect(list.children[1], "the tick redrew the user's message").not.toBe(userBefore);
    expect(list.children[0], "the agent's node is the same element").toBe(node);
    expect(PV.liveFrame(keyOf(1))).toBe(frame);
    expect([PV.running(keyOf(1)), frame.isConnected]).toEqual([true, true]);
    expect(PV.stopAll, "stopAll not called").not.toHaveBeenCalled();
    expect(log.some(e => e.node === node), "the agent's node was never asked").toBe(false);
    expect(log.some(e => e.node === userBefore), "the redrawn node was asked before it went").toBe(true);
    expect(log.flatMap(e => e.keys as string[]), "nothing was stopped").toEqual([]);
  });

  it("its own message changed: its frame is stopped first, then the node is replaced", () => {
    const { list, thread } = threadAt(fresh().document);
    thread.render([agent(1, FENCE("<p>a</p>")), agent(2, FENCE("<p>b</p>"))]);
    const [a, b] = list.children;
    const fa = runPreview(a, 1);
    const log = recordStops();

    thread.render([agent(1, FENCE("<p>a changed</p>")), agent(2, FENCE("<p>b</p>"))]);

    expect(log.map(e => [e.fn, e.keys])).toEqual([["stopIn", ["b-1:f0"]]]);
    expect(log[0]!.node).toBe(a);
    expect([log[0]!.attached, log[0]!.live], "stopped while still in the list, and live").toEqual([true, 1]);
    expect(a.parentNode, "the old node is gone after the stop").toBeNull();
    expect(fa.parentNode).toBeNull();
    expect(list.children[1], "the other node is the same element").toBe(b);
  });

  it("a node changes while the live frame is in another node: nothing is stopped; the frame stays", () => {
    const { list, thread } = threadAt(fresh().document);
    thread.render([agent(1, FENCE("<p>a</p>")), agent(2, FENCE("<p>b</p>"))]);
    const [a, b] = list.children;
    const fb = runPreview(b, 2);
    const log = recordStops();

    thread.render([agent(1, FENCE("<p>a changed</p>")), agent(2, FENCE("<p>b</p>"))]);

    expect(log.map(e => e.keys), "the changed node had no frame").toEqual([[]]);
    expect(log[0]!.node).toBe(a);
    expect(list.children[1], "the frame's node is the same element").toBe(b);
    expect(PV.liveFrame(keyOf(2))).toBe(fb);
    expect([PV.running(keyOf(2)), fb.parentNode]).toEqual([true, b.querySelector(".pv-holder")]);
  });

  it("the list reordered: the moved node's frame is stopped before the move; the node that did not move stays live", () => {
    const { list, thread } = threadAt(fresh().document);
    thread.render([agent(1, FENCE("<p>a</p>")), agent(2, FENCE("<p>b</p>"))]);
    const [a, b] = list.children;
    const fb = runPreview(b, 2);
    const log = recordStops();

    thread.render([agent(2, FENCE("<p>b</p>")), agent(1, FENCE("<p>a</p>"))]);

    expect(log.map(e => [e.fn, e.keys, e.attached])).toEqual([["stopIn", ["b-2:f0"], true]]);
    expect(list.children[0]).toBe(b);
    expect(list.children[1]).toBe(a);
    expect(PV.running(keyOf(2)), "a moved frame reloads, so it never stays live").toBe(false);
    expect(fb.parentNode).toBeNull();
  });

  it("trimmed by the cap: the removed node's frame is stopped first, then the node is removed; the rest stays", () => {
    const { list, thread } = threadAt(fresh().document);
    thread.render([agent(1, FENCE("<p>a</p>")), agent(2, FENCE("<p>b</p>"))]);
    const [a, b] = list.children;
    runPreview(a, 1);
    const log = recordStops();

    thread.render([agent(2, FENCE("<p>b</p>"))]);

    expect(log.map(e => [e.fn, e.keys, e.attached])).toEqual([["stopIn", ["b-1:f0"], true]]);
    expect(a.parentNode).toBeNull();
    expect(list.children[0]).toBe(b);
    expect(PV.running(keyOf(1))).toBe(false);
  });

  it("an empty thread (none, or another instance's messages): every node is stopped first, the frame included", () => {
    const { list, thread } = threadAt(fresh().document);
    thread.render([agent(1, FENCE("<p>a</p>")), agent(2, FENCE("<p>b</p>"))]);
    const fa = runPreview(list.children[0], 1);
    const log = recordStops();

    thread.render([]);

    expect(log.map(e => [e.fn, e.keys, e.attached])).toEqual([["stopIn", ["b-1:f0"], true], ["stopIn", [], true]]);
    expect([PV.liveCount(), list.children.length, fa.parentNode]).toEqual([0, 0, null]);
  });

  it("the thread goes (dispose): stopAll('leave'), and zero live frames", () => {
    const { list, thread } = threadAt(fresh().document);
    thread.render([agent(1, FENCE("<p>a</p>")), agent(2, FENCE("<p>b</p>"))]);
    const fa = runPreview(list.children[0], 1);
    const stopAll = vi.spyOn(PV, "stopAll");

    thread.dispose();

    expect(stopAll.mock.calls).toEqual([["leave"]]);
    expect(stopAll.mock.results[0]!.value).toEqual(["b-1:f0"]);
    expect([PV.liveCount(), fa.parentNode]).toEqual([0, null]);
  });

  it("the chat unmounts (ChatPanel): stopAll('leave') and zero live frames", async () => {
    const pg = fresh();
    panel.store.state.msgs.w = [agent(1, FENCE("<p>a</p>"))];
    await pg.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
    const frame = runPreview((pg.document.querySelector(".thread") as any).children[0], 1);
    const stopAll = vi.spyOn(PV, "stopAll");

    await pg.unmount();

    expect(stopAll.mock.calls).toEqual([["leave"]]);
    expect([PV.liveCount(), frame.parentNode]).toEqual([0, null]);
  });

  it("another instance opened (the route changes): the old chat's frames stop before the new chat's thread renders", async () => {
    const pg = fresh();
    panel.store.state.msgs.w = [agent(1, FENCE("<p>a</p>"))];
    await pg.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
    const frame = runPreview((pg.document.querySelector(".thread") as any).children[0], 1);
    const stopAll = vi.spyOn(PV, "stopAll");

    await pg.mount(h(panel.ChatPanel, { route: { instance: "x" }, navKey: "two" }));

    expect(stopAll.mock.calls).toEqual([["leave"]]);
    expect([PV.running(keyOf(1)), frame.parentNode]).toEqual([false, null]);
    expect(pg.document.querySelector(".thread")!.children.length).toBe(0);
  });

  it("a frame's late ready or resize after the chat unmounted is ignored, and no timer is left", async () => {
    const tracker = trackTimers();
    try {
      const pg = fresh();
      panel.store.state.msgs.w = [agent(1, FENCE("<p>a</p>"))];
      await pg.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
      const timers = tracker.count();
      const frame = runPreview((pg.document.querySelector(".thread") as any).children[0], 1);
      const ch = frame.contentWindow.posted[0].ch;
      PV.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "resize", ch, height: 300 } });
      await settle();                          // the height is applied on the next frame
      expect(frame.style.height).toBe("300px");
      expect(tracker.count(), "the watchdog is armed while the chat is open").toBeGreaterThan(timers);

      await pg.unmount();
      const posted = frame.contentWindow.posted.length;
      expect(tracker.count(), "unmounting leaves no preview timer").toBe(timers);
      PV.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "ready", ch: null, boot: BOOT } });
      PV.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "resize", ch, height: 900 } });
      PV.onMessage({ source: frame.contentWindow, origin: "null", data: { v: 1, type: "heartbeat", ch } });
      await settle();

      expect(frame.contentWindow.posted.length, "no render sent to the gone frame").toBe(posted);
      expect(frame.style.height, "no height applied").toBe("300px");
      expect([PV.running(keyOf(1)), tracker.count()]).toEqual([false, timers]);
    } finally { tracker.restore(); }
  });

  it("50 mounts and unmounts of the chat, a preview started each time: no live frame, no listener, no timer left", async () => {
    const pg = fresh();
    panel.store.state.msgs.w = [agent(1, FENCE("<p>a</p>"))];
    const cycle = async (i: number) => {
      await pg.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: `n${i}` }));
      runPreview((pg.document.querySelector(".thread") as any).children[0], 1);
      await pg.unmount();
    };
    await cycle(-1);                           // warm up: the first mount sets up what every later one reuses
    const tracker = trackTimers();
    try {
      const listeners = PV.listeners(), timers = tracker.count();
      for (let i = 0; i < 50; i++) {
        await cycle(i);
        expect(PV.liveCount(), `live frames after visit ${i}`).toBe(0);
      }
      expect(PV.listeners(), "onChange listeners back to the baseline").toBe(listeners);
      expect(tracker.count(), "no timer left behind").toBe(timers);
    } finally { tracker.restore(); }
  });

  it("the device's opt-out in another tab: the running preview stops, and its card follows", async () => {
    const pg = fresh();
    panel.store.state.msgs.w = [agent(1, FENCE("<p>a</p>"))];
    await pg.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
    const node = (pg.document.querySelector(".thread") as any).children[0];
    const frame = runPreview(node, 1);

    pg.storage.delete("agend_html_preview");
    PV.onStorage({ key: "agend_html_preview" });           // the storage event another tab sends this one

    expect([PV.running(keyOf(1)), frame.parentNode]).toEqual([false, null]);
    expect(node.querySelector(".pv-run").hidden, "Preview is not offered while the device is opted out").toBe(true);
    expect(node.querySelector(".pv-note").textContent).toMatch(/off on this device/);
  });

  it("a card that left the page is not kept alive by the card registry (#1332 review)", async () => {
    const { thread, list } = threadAt(fresh().document);
    // Built in its own scope so nothing in this test holds the card afterwards.
    const build = () => {
      thread.render([agent(1, FENCE("<p>a</p>"))]);
      const card = list.querySelector(".html-card");
      expect(card?.querySelector(".pv-run"), "the card was really built").not.toBeNull();
      thread.render([]);
      return new WeakRef(card);
    };
    const ref = build();
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    for (let i = 0; i < 5 && ref.deref(); i++) { await new Promise(r => setImmediate(r)); gc(); }
    expect(ref.deref(), "the retired card was collected").toBeUndefined();
  });
});
