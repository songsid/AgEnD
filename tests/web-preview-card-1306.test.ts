/**
 * #1306 segment B: the card, the parent side of the preview, and the chat's keyed renderer around it.
 * Design: docs/design/1306-inline-html-preview.md §3.2 (page check), §4.2, §5.3, §6, §7, §8, §10.1 (items 5–9).
 * The page code runs as written, in a vm with a minimal DOM. What a browser enforces is §10.2 (the recorded run).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";

const UI = join(process.cwd(), "src", "ui");
const RENDER = readFileSync(join(UI, "chat-render.js"), "utf8");
const PREVIEW = readFileSync(join(UI, "preview.js"), "utf8");
const DASHBOARD = readFileSync(join(UI, "dashboard.html"), "utf8");
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
  it("the page asks for cards only for role \"agent\" — from the server, never sender or text", () => {
    expect(DASHBOARD).toContain('AgendChatRender.renderMarkdown(x.text, x.role === "agent" ? { htmlCards: true } : undefined)');
    expect((DASHBOARD.match(/htmlCards/g) ?? []).length, "one call site").toBe(1);
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
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/<!--[\s\S]*?-->/g, "");
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

// ── 8. The keyed renderer keeps a live preview — or stops it first (§6.2) ──

describe("the chat's renderer and a live preview (§6.2)", () => {
  const PAGE = DASHBOARD.match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  function page() {
    const log: string[] = [];
    const kids: any[] = [];
    const node = (html: string): any => {
      const n: any = {
        html,
        get parentNode() { return kids.includes(n) ? list : null; },
        get nextSibling() { return kids[kids.indexOf(n) + 1] ?? null; },
        querySelectorAll: () => [],
        remove() { log.push(`remove ${tag(n)}`); const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1); },
        replaceWith(m: any) { log.push(`replace ${tag(n)}`); const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1, m); },
      };
      return n;
    };
    const tag = (n: any) => /\b([A-Z]{3,}(?: v2)?)\b/.exec(n.html)?.[1] ?? "?";
    const list: any = {
      get firstChild() { return kids[0] ?? null; },
      insertBefore(n: any, ref: any) { if (kids.includes(n)) log.push(`move ${tag(n)}`); const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1); const j = ref ? kids.indexOf(ref) : -1; if (j < 0) kids.push(n); else kids.splice(j, 0, n); },
      set textContent(_v: string) { log.push("start over"); kids.length = 0; },
      set innerHTML(v: string) { kids.length = 0; kids.push(node(v)); },
    };
    const box = { checked: true, addEventListener() {} };
    const nodes: Record<string, any> = { messages: list, uptime: { textContent: "" }, mainArea: { innerHTML: "" }, previewOptIn: box };
    const pv = { optIn: true, changed: [] as Array<() => void>, cards: [] as unknown[] };
    const c = vm.createContext({
      localStorage: { getItem: () => null }, navigator: { language: "en" },
      document: { addEventListener() {}, querySelectorAll: () => pv.cards, getElementById: (n: string) => nodes[n] ?? null, createElement: (t: string) => t === "template" ? { set innerHTML(v: string) { (this as any).content = { firstElementChild: node(v) }; } } : {}, body: { appendChild() {} } },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      EventSource: class { addEventListener() {} },
      // The preview module, as the renderer sees it: it records which message nodes were stopped, and when.
      AgendPreview: { init() {}, optedIn: () => pv.optIn, onChange: (f: () => void) => pv.changed.push(f), stopAll: () => { log.push("stopAll"); return []; }, stopIn: (n: any) => { log.push(`stop ${tag(n)}`); return []; }, availability: () => ({ ok: false }), BANNER: "" },
    });
    vm.runInContext(RENDER, c);
    vm.runInContext(PAGE, c);
    vm.runInContext('toast=()=>{};renderList=()=>{};renderActions=()=>{};mode="instance";cur="w";curTab="chat";', c);
    const msg = (id: number, text: string, role = "agent", sender = "w") => ({ boot: "b", id, instance: "w", sender, role, text, ts: "2026-01-01T00:00:00Z" });
    const set = (list: unknown[]) => { (c as any).next = list; vm.runInContext("msgs.w = next; renderMsgs()", c); };
    return { log, set, msg, c, kids, nodes, box, pv };
  }

  it("new messages, another message's ticks: the agent's node — and its live frame — stays; nothing is stopped", () => {
    const p = page();
    p.set([p.msg(1, "AGENT"), p.msg(2, "YOU", "user", "web-user")]);
    const agent = p.kids[0];
    p.log.length = 0;
    p.set([p.msg(1, "AGENT"), { ...p.msg(2, "YOU", "user", "web-user"), messageId: "web-2", delivery: "delivered" }, p.msg(3, "NEW")]);
    expect(p.kids[0]).toBe(agent);
    expect(p.log.filter(l => l.includes("AGENT"))).toEqual([]);
  });

  it("its own message changed: stopped first, then replaced", () => {
    const p = page();
    p.set([p.msg(1, "AGENT")]);
    p.log.length = 0;
    p.set([p.msg(1, "AGENT v2")]);
    expect(p.log).toEqual(["stop AGENT", "replace AGENT"]);
  });

  it("the list reordered under it: stopped first, then moved (moving reloads a frame, so never alive)", () => {
    const p = page();
    p.set([p.msg(2, "TWO"), p.msg(3, "THREE")]);
    p.log.length = 0;
    p.set([p.msg(1, "ONE"), p.msg(3, "THREE"), p.msg(2, "TWO")]);
    const moves = p.log.filter(l => l.startsWith("move"));
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) {
      const name = m.slice(5);
      expect(p.log.indexOf(`stop ${name}`), m).toBeGreaterThanOrEqual(0);
      expect(p.log.indexOf(`stop ${name}`), m).toBeLessThan(p.log.indexOf(m));
    }
  });

  it("trimmed by the cap: stopped first, then removed", () => {
    const p = page();
    p.set([p.msg(1, "OLD"), p.msg(2, "KEEP")]);
    p.log.length = 0;
    p.set([p.msg(2, "KEEP")]);
    expect(p.log).toEqual(["stop OLD", "remove OLD"]);
  });

  it("another instance (the list starts over), or the view rebuilt: every preview stopped first", () => {
    const p = page();
    p.set([p.msg(1, "AGENT")]);
    p.log.length = 0;
    vm.runInContext('mode = "none"; renderMain()', p.c);
    expect(p.log[0], "the view is rebuilt").toBe("stopAll");
    // Another instance's chat: a new #messages element — every node of the old one is stopped before it starts over.
    const p2 = page();
    p2.set([p2.msg(1, "AGENT"), p2.msg(2, "MORE")]);
    p2.log.length = 0;
    vm.runInContext('document.getElementById = (n) => n === "messages" ? { set textContent(v) {}, get firstChild() { return null; }, insertBefore() {} } : null; msgs.w = []; renderMsgs()', p2.c);
    expect(p2.log.slice(0, 2).sort()).toEqual(["stop AGENT", "stop MORE"]);
  });

  it("the instance deleted: its previews stop before the view is overwritten (#1332 review)", async () => {
    const p = page();
    Object.defineProperty(p.nodes.mainArea, "innerHTML", { set: () => p.log.push("mainArea overwritten") });
    vm.runInContext('prompt = () => "delete w"; api = async () => ({}); renderTopbar = () => {}', p.c);
    p.log.length = 0;
    await vm.runInContext('doAction("delete")', p.c);
    expect(p.log).toEqual(["stopAll", "mainArea overwritten"]);
  });

  it("changed in another tab: this tab's checkbox and every card on the page follow (#1332 review)", () => {
    const p = page();
    let reads = 0;
    vm.runInContext('AgendPreview.never = () => false; document.createElement = () => ({ classList: { contains: () => false }, dataset: {}, append() {}, setAttribute() {} })', p.c);
    (p.c as any).reads = () => reads++;
    vm.runInContext('AgendPreview.availability = () => { reads(); return { ok: false, reason: "off" }; }', p.c);
    const card: any = { dataset: { card: "0" }, classList: { contains: () => false }, append() {}, set textContent(_v: string) {} };
    (p.c as any).host = { querySelectorAll: () => [card] };
    (p.c as any).x = p.msg(1, "```html\n<p>hi</p>\n```");
    vm.runInContext("decorateHtmlCards(host, x, [])", p.c);
    p.pv.cards = [card];
    reads = 0;
    p.pv.optIn = false;                                               // tab B opted out; the storage event reached this tab
    for (const f of p.pv.changed) f();
    expect([p.box.checked, reads]).toEqual([false, 1]);
  });

  it("a card that left the page is not kept alive by the card registry — without any refreshCards call (#1332 review)", async () => {
    const p = page();
    vm.runInContext('AgendPreview.optedIn = () => false; AgendPreview.never = () => false; AgendPreview.availability = () => ({ ok: false, reason: "off" })', p.c);
    const el = (): any => ({ classList: { contains: () => false }, dataset: {}, append() {}, setAttribute() {} });
    vm.runInContext('document.createElement = () => (' + el.toString() + ')()', p.c);
    let decorated = 0;
    // Built in its own scope so nothing in this test holds the card afterwards.
    const build = () => {
      const card: any = { dataset: { card: "0" }, classList: { contains: () => false }, append() { decorated++; }, set textContent(_v: string) {} };
      (p.c as any).host = { querySelectorAll: () => [card] };
      (p.c as any).x = p.msg(1, "```html\n<p>hi</p>\n```");
      vm.runInContext("decorateHtmlCards(host, x, []); host = null; x = null", p.c);
      return new WeakRef(card);
    };
    const ref = build();
    expect(decorated, "the card was really built and registered").toBe(1);
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    for (let i = 0; i < 5 && ref.deref(); i++) { await new Promise(r => setImmediate(r)); gc(); }
    expect(ref.deref(), "the retired card was collected").toBeUndefined();
  });
});
