/**
 * #1408 step 2: View in the app shell.
 * - Served: /view and /view/<name> are the app shell. Signed in: "full", with the same preview data and frame-src as
 *   /ui. Anonymous under `web.view_access: open`: "view-only", with no previews. `view_access: session` closes it.
 * - Module admission over real HTTP: everything a View-only page loads comes from /assets/ with no session — the
 *   entry's static closure and View's — and nothing under /ui/ is part of it.
 * - The View-only page itself (the real entry in a fake DOM): its nav is View and Sign in, nothing else; no stream;
 *   its reads are View's passive ones only.
 * - The panel: its pollers run only while it is mounted (and the tab is visible), through its lease; a late pane
 *   answer for the instance left behind never lands; 50 mounts leave nothing; the sidebar gets its roster while it is
 *   mounted and the instance list back after.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { settle, fire } from "./helpers/mini-dom.js";
import { page, h, type AppPage } from "./helpers/app-harness.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { setUsageFetcherForTests, type UsagePayload } from "../src/usage/usage-api.js";

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
async function listener(viewAccess?: "open" | "session") {
  const dir = mkdtempSync(join(tmpdir(), "agend-view-1408-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "fleet.yaml"), `${viewAccess ? `web:\n  view_access: ${viewAccess}\n` : ""}instances: {}\n`);
  const fm = new FleetManager(dir);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  (fm as unknown as { loadConfig(p: string): void }).loadConfig(join(dir, "fleet.yaml"));
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const server = (fm as unknown as { healthServer: Server }).healthServer;
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const login = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin }, JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  return { fm, port, cookie, stop: () => new Promise<void>(r => server.close(() => r())) };
}
const bodyTag = (html: string) => /<body[^>]*>/.exec(html)![0];
const maskNonce = (s: string) => s.replace(/nonce-[A-Za-z0-9+/=_-]+/g, "nonce-X").replace(/nonce="[^"]*"/g, 'nonce="X"');

describe("served (#1408 step 2)", () => {
  it("anonymous, view_access open (the default): the View-only shell for /view and /view/<name>; no previews", async () => {
    const h = await listener();
    const preview = vi.spyOn(h.fm as unknown as { previewForUi: (...a: unknown[]) => unknown }, "previewForUi");
    try {
      for (const p of ["/view", "/view/web-dev", "/view/%E4%B8%AD", "/view/nobody"]) {
        const r = await raw(h.port, "GET", p, { accept: "text/html" });
        expect(r.status, p).toBe(200);
        expect(r.body, p).toContain('<script type="module" src="/assets/app.js"></script>');
        const tag = bodyTag(r.body);
        expect(tag, p).toContain('data-mode="view-only"');
        expect(tag, p).toContain('data-preview-origin=""');
        expect(tag, p).not.toContain("data-web-transport");
        expect(String(r.headers["content-security-policy"]), p).not.toContain("frame-src");
      }
      expect(preview).not.toHaveBeenCalled();
      // Known and unknown names: the same bytes (nonce masked) — the page never tells which names exist.
      const a = await raw(h.port, "GET", "/view/web-dev"), b = await raw(h.port, "GET", "/view/nobody");
      expect(maskNonce(a.body)).toBe(maskNonce(b.body));
      // A malformed name is a 400, anonymous or not; deeper paths are not pages.
      expect((await raw(h.port, "GET", "/view/a%2Fb", { accept: "text/html" })).status).toBe(400);
      const deep = await raw(h.port, "GET", "/view/a/b", { accept: "text/html" });
      expect(deep.status).not.toBe(200);
      expect(deep.body).not.toContain("<html");
      expect((await raw(h.port, "POST", "/view", { origin: `http://127.0.0.1:${h.port}` })).status).not.toBe(200);
    } finally { await h.stop(); }
  }, 30_000);

  it("signed in: the full shell on /view, with the same preview data and frame-src as /ui", async () => {
    const h = await listener();
    vi.spyOn(h.fm as unknown as { previewForUi: (...a: unknown[]) => unknown }, "previewForUi").mockReturnValue({
      dashboardOrigin: `http://127.0.0.1:${h.port}`, previewOrigin: "http://127.0.0.1:4999", reason: null, boot: "b".repeat(16) });
    try {
      const ui = await raw(h.port, "GET", "/ui", { cookie: h.cookie, accept: "text/html" });
      for (const p of ["/view", "/view/web-dev"]) {
        const r = await raw(h.port, "GET", p, { cookie: h.cookie, accept: "text/html" });
        expect(r.status, p).toBe(200);
        expect(bodyTag(r.body), p).toBe(bodyTag(ui.body));
        expect(bodyTag(r.body), p).toContain('data-mode="full"');
        expect(maskNonce(String(r.headers["content-security-policy"])), p).toBe(maskNonce(String(ui.headers["content-security-policy"])));
        expect(String(r.headers["content-security-policy"]), p).toContain("frame-src http://127.0.0.1:4999/frame");
      }
    } finally { await h.stop(); }
  }, 30_000);

  it("view_access: session — a signed-out browser gets the sign-in page; its reads are closed too", async () => {
    const h = await listener("session");
    try {
      for (const p of ["/view", "/view/web-dev"]) {
        const r = await raw(h.port, "GET", p, { accept: "text/html" });
        expect(r.status, p).toBe(401);
        expect(r.body, p).toContain('src="/assets/signin.js"');
      }
      expect((await raw(h.port, "GET", "/api/profiles")).status).toBe(401);
      expect(bodyTag((await raw(h.port, "GET", "/view", { cookie: h.cookie, accept: "text/html" })).body)).toContain('data-mode="full"');
    } finally { await h.stop(); }
  }, 30_000);
});

/** Static import specifiers of an ES module (import … from "x", import "x", export … from "x"); not import(). */
function staticImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/(?:import|export)\{[^}]*\}from"([^"]+)"/g)) out.push(m[1]!);
  for (const m of src.matchAll(/import\s*\w+\s*from"([^"]+)"/g)) out.push(m[1]!);
  return [...new Set(out)];
}

describe("module admission for a View-only page (#1408 §4)", () => {
  it("everything it loads comes from /assets/ with no session — the entry's closure and View's — and none of it is under /ui/", async () => {
    // /api/ai-usage below must never reach a provider: no host credential read, no vendor call, no auth refresh. The
    // fetcher seam answers instead, and any outbound fetch from this process fails the test.
    const usage = vi.fn(async (): Promise<UsagePayload> => ({ providers: [], fetchedAt: "2026-10-09T00:00:00Z" }));
    setUsageFetcherForTests(usage);
    const realFetch = globalThis.fetch;
    const outbound: string[] = [];
    globalThis.fetch = (async (u: unknown) => { outbound.push(String(u)); throw new Error("no network in this test"); }) as typeof fetch;
    const h = await listener();
    try {
      const page = await raw(h.port, "GET", "/view", { accept: "text/html" });
      expect(bodyTag(page.body)).toContain('data-mode="view-only"');
      const seen = new Map<string, number>();
      // The entry, and View — the one module the View-only entry imports on demand.
      const queue = ["/assets/app.js", "/assets/panel-view.js"];
      while (queue.length) {
        const path = queue.shift()!;
        if (seen.has(path)) continue;
        const r = await raw(h.port, "GET", path);
        seen.set(path, r.status);
        expect(String(r.headers["content-type"]), path).toContain("javascript");
        if (r.status === 200) for (const spec of staticImports(r.body)) queue.push(new URL(spec, `http://x${path}`).pathname);
      }
      for (const [path, status] of seen) {
        expect(path, path).toMatch(/^\/assets\/[a-z0-9._-]+\.js$/);
        expect(status, path).toBe(200);
      }
      for (const p of ["/assets/panel-view.js", "/assets/view-strings.js", "/assets/app-shell.js", "/assets/preact.module.js"]) expect(seen.has(p), p).toBe(true);
      // The View-only page's own reads, anonymous: open. The session-only ones: not.
      for (const p of ["/api/profiles", "/api/ai-usage"]) expect((await raw(h.port, "GET", p)).status, p).not.toBe(401);
      for (const p of ["/ui/js/panel-chat.js", "/ui/events", "/ui/poll", "/ui/instances", "/auth/sessions"]) expect((await raw(h.port, "GET", p)).status, p).toBe(401);
      expect(usage).toHaveBeenCalledTimes(1);
      expect(outbound).toEqual([]);
    } finally { await h.stop(); globalThis.fetch = realFetch; setUsageFetcherForTests(null); }
  }, 30_000);
});

const ROSTER = [
  { instance_name: "alpha", display_name: "Alpha", status: "running", context_pct: 40, model: "m1", backend: "codex", tags: ["core"], has_avatar: false, role: "dev", description: "" },
  { instance_name: "beta", display_name: null, status: "stopped", context_pct: null, model: "", backend: "kiro-cli", tags: [], has_avatar: false, role: null, description: "" },
];

// ── The panel: pollers, leases, leaks, the sidebar slot ──

describe("the View panel's work belongs to its lease", () => {
  async function setup() {
    const p: AppPage = page({ url: "http://127.0.0.1:19280/view/alpha" });
    const reads: string[] = [];
    const holds: Record<string, () => void> = {};
    let observers = 0;
    (globalThis as any).ResizeObserver = class { observe() { observers++; } disconnect() { observers--; } };
    (globalThis as any).fetch = async (u: string) => {
      reads.push(u);
      if (u === "/api/profiles") return { ok: true, status: 200, json: async () => ROSTER };
      if (u.startsWith("/api/pane/")) {
        const name = decodeURIComponent(u.slice("/api/pane/".length));
        let stale = false;
        if (holds[name] === undefined && (globalThis as any).__holdPane === name) { stale = true; await new Promise<void>(r => { holds[name] = r; }); }
        // The held answer says so: if it ever lands, the terminal shows it.
        return { ok: true, status: 200, headers: { get: (k: string) => (k === "X-Pane-Cols" ? "80" : "24") }, text: async () => (stale ? `STALE:${name}` : `PANE:${name}`) };
      }
      if (u.startsWith("/api/ai-usage")) return { ok: true, status: 200, json: async () => ({ providers: [], fetchedAt: Date.now() }) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const view = await import("/assets/panel-view.js");
    view.viewStore.set({ loaded: false, error: null, roster: [], filter: "", current: null });
    const shell = await import("/assets/app-shell.js");
    const ctx = await import("/assets/app-ctx.js");
    // Every test ends with nothing mounted: a panel left running would keep its timers and react to the shared store.
    const done = async () => { vi.useRealTimers(); await p.unmount(); p.restore(); delete (globalThis as any).fetch; delete (globalThis as any).ResizeObserver; delete (globalThis as any).__holdPane; };
    return { p, reads, holds, observers: () => observers, view, shell, ctx, done };
  }
  const mount = (s: Awaited<ReturnType<typeof setup>>, name: string | null, key: string) =>
    s.p.mount(h(s.view.ViewPanel, { route: { panel: "view", instance: name }, navKey: key }));

  it("pane every 800 ms and roster every 5 s while mounted; nothing after it goes; nothing while the tab is hidden", async () => {
    const s = await setup();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
      const mounted = mount(s, "alpha", "view:alpha|1|en");
      await vi.advanceTimersByTimeAsync(50); await mounted;
      s.reads.length = 0;
      await vi.advanceTimersByTimeAsync(5_000);
      const pane = s.reads.filter(r => r === "/api/pane/alpha").length, roster = s.reads.filter(r => r === "/api/profiles").length;
      expect(pane).toBeGreaterThanOrEqual(6);
      expect(roster).toBe(1);
      // Hidden tab: no reads.
      Object.defineProperty(s.p.document, "hidden", { value: true, configurable: true });
      s.reads.length = 0;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(s.reads).toEqual([]);
      Object.defineProperty(s.p.document, "hidden", { value: false, configurable: true });
      // Gone: nothing at all afterwards.
      const gone = s.p.unmount(); await vi.advanceTimersByTimeAsync(50); await gone;
      s.reads.length = 0;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(s.reads).toEqual([]);
    } finally { await s.done(); }
  });

  it("A → B → A: a late pane answer for the first A never lands; the terminal shows the current one", async () => {
    const s = await setup();
    try {
      (globalThis as any).__holdPane = "alpha";
      await mount(s, "alpha", "view:alpha|1|en");
      await vi.waitFor(() => expect(s.holds.alpha).toBeDefined());
      await mount(s, "beta", "view:beta|2|en");
      await vi.waitFor(() => expect(s.p.root.querySelector(".v-pre")?.textContent).toBe("PANE:beta"));
      (globalThis as any).__holdPane = null;
      await mount(s, "alpha", "view:alpha|3|en");
      await vi.waitFor(() => expect(s.p.root.querySelector(".v-pre")?.textContent).toBe("PANE:alpha"));
      s.holds.alpha!();                                  // the first A's answer arrives now
      await settle(6);
      expect(s.p.root.querySelector(".v-pre")?.textContent).toBe("PANE:alpha");
    } finally { await s.done(); }
  });

  it("same instance, new page (re-navigation, language): the terminal stays, and the old lease's late answer still never lands", async () => {
    const s = await setup();
    try {
      (globalThis as any).__holdPane = "alpha";
      await mount(s, "alpha", "view:alpha|1|en");
      await vi.waitFor(() => expect(s.holds.alpha).toBeDefined());
      const pre = s.p.root.querySelector(".v-pre");
      await mount(s, "alpha", "view:alpha|2|zh-TW");
      await vi.waitFor(() => expect(s.p.root.querySelector(".v-pre")?.textContent).toBe("PANE:alpha"));
      expect(s.p.root.querySelector(".v-pre")).toBe(pre);  // the same element: only the lease tells the old answer apart
      s.holds.alpha!();
      await settle(6);
      expect(s.p.root.querySelector(".v-pre")?.textContent).toBe("PANE:alpha");
    } finally { await s.done(); }
  });

  it("the sidebar gets View's roster while it is mounted, and the instance list back after; 50 mounts leave nothing", async () => {
    const s = await setup();
    try {
      await settle();
      const base = { leases: s.ctx.leaseCount(), doc: s.p.document.listenerCount(), win: (s.p.window as any).listenerCount() };
      await mount(s, "alpha", "view:alpha|1|en");
      expect(s.shell.shellStore.get().side).not.toBeNull();
      await s.p.unmount();
      expect(s.shell.shellStore.get().side).toBeNull();
      for (let i = 0; i < 50; i++) { await mount(s, i % 2 ? "alpha" : "beta", `view:${i}`); await s.p.unmount(); }
      expect(s.ctx.leaseCount()).toBe(base.leases);
      expect(s.p.document.listenerCount()).toBe(base.doc);
      expect((s.p.window as any).listenerCount()).toBe(base.win);
      expect(s.observers()).toBe(0);
      expect(s.shell.shellStore.get().side).toBeNull();
    } finally { await s.done(); }
  });

  it("alpha.2: clicking another instance keeps the roster section — it is not taken away and set again (its list would jump to the top)", async () => {
    const s = await setup();
    try {
      await mount(s, "alpha", "view:alpha|1|en");
      const entry = s.shell.shellStore.get().side;
      expect(entry).not.toBeNull();
      const sides: unknown[] = [];
      const off = s.shell.shellStore.subscribe((st: any) => sides.push(st.side));
      await mount(s, "beta", "view:beta|2|en");                  // another instance: a new navigation, a new lease
      await mount(s, "gamma", "view:gamma|3|en");
      off();
      expect(s.shell.shellStore.get().side, "the same section entry").toBe(entry);
      expect(sides.filter(x => x !== entry), "never removed in between").toEqual([]);
    } finally { await s.done(); }
  });

  it("the usage dialog refreshes every 60 s only while it is open", async () => {
    const s = await setup();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
      const mounted = mount(s, "alpha", "view:alpha|1|en");
      await vi.advanceTimersByTimeAsync(50); await mounted;
      const usageBtn = s.p.root.querySelectorAll(".panel-actions .btn").find((b: any) => b.textContent.includes("Usage"));
      expect(usageBtn).toBeDefined();
      usageBtn.click(); await vi.advanceTimersByTimeAsync(10);
      s.reads.length = 0;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(s.reads.filter(r => r.startsWith("/api/ai-usage"))).toHaveLength(2);
      fire(s.p.root.querySelector("dialog")!, "cancel");     // Esc closes it
      await vi.advanceTimersByTimeAsync(10);
      s.reads.length = 0;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(s.reads.filter(r => r.startsWith("/api/ai-usage"))).toEqual([]);
    } finally { await s.done(); }
  });

  it("'/' focuses the filter while View is mounted, never while typing, and does nothing after it goes", async () => {
    const s = await setup();
    try {
      // The shell renders the sidebar slot; here the roster component is rendered next to the panel.
      const { useStore } = await import("/assets/app-store.js");
      const Slot = () => { const { side } = useStore(s.shell.shellStore); return side ? h(side.Component, {}) : null; };
      await s.p.mount(h("div", {}, h(s.view.ViewPanel, { route: { panel: "view", instance: "alpha" }, navKey: "k1" }), h(Slot, {})));
      await settle(4);
      const main = s.p.document.createElement("main"); main.id = "main"; s.p.document.body.appendChild(main);
      const key = (target: any) => { const e = fire(target, "keydown", { key: "/" }); s.shell.handleKey(e); return e; };
      const e1 = key(s.p.document.body);
      expect(e1.defaultPrevented).toBe(true);
      expect(s.p.document.activeElement.id).toBe("filterInput");
      const input = s.p.document.createElement("input"); main.appendChild(input); input.focus();
      const e2 = key(input);
      expect(e2.defaultPrevented).toBe(false);
      await s.p.unmount();
      s.p.document.activeElement = s.p.document.body;
      expect(key(s.p.document.body).defaultPrevented).toBe(false);
    } finally { await s.done(); }
  });
});

// ── Inside one lease: overlapping reads, and the profile editor's target (#1448 review) ──

describe("within one navigation, an older answer never lands over a newer one; a profile draft keeps its target", () => {
  const ROSTER_B = [
    { ...ROSTER[0], display_name: "Alpha", role: "alpha-role", description: "a" },
    { ...ROSTER[1], display_name: "Beta", role: "beta-role", description: "b" },
  ];
  type Responder = (url: string, init: any, n: number) => Promise<any> | any;
  function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
  const pane = (text: string) => ({ ok: true, status: 200, headers: { get: (k: string) => (k === "X-Pane-Cols" ? "80" : "24") }, text: async () => text });
  const json = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  async function setup(responders: Record<string, Responder> = {}) {
    const p: AppPage = page({ url: "http://127.0.0.1:19280/view/alpha" });
    const calls: { url: string; init: any }[] = [];
    const counts: Record<string, number> = {};
    (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
    (globalThis as any).fetch = async (u: string, init: any = {}) => {
      calls.push({ url: u, init });
      const kind = u.startsWith("/api/pane/") ? "pane" : u.startsWith("/api/ai-usage") ? "usage" : u === "/api/profiles" ? "profiles"
        : u.startsWith("/api/profile/") ? "profile" : u.startsWith("/api/avatar/") ? "avatar" : "other";
      const n = (counts[kind] = (counts[kind] ?? -1) + 1);
      if (responders[kind]) return responders[kind]!(u, init, n);
      if (kind === "pane") return pane(`PANE:${decodeURIComponent(u.slice(10))}`);
      if (kind === "profiles") return json(ROSTER_B);
      if (kind === "usage") return json({ providers: [], fetchedAt: 1 });
      return json({ ok: true });
    };
    const view = await import("/assets/panel-view.js");
    view.viewStore.set({ loaded: false, error: null, roster: [], filter: "", current: null });
    const done = async () => { vi.useRealTimers(); await p.unmount(); p.restore(); delete (globalThis as any).fetch; delete (globalThis as any).ResizeObserver; };
    const mount = (name: string, key: string) => p.mount(h(view.ViewPanel, { route: { panel: "view", instance: name }, navKey: key }));
    return { p, calls, view, done, mount };
  }
  const pre = (s: { p: AppPage }) => s.p.root.querySelector(".v-pre")?.textContent;

  it("the pane: one read at a time; a newer read that lands is not overwritten by an older one released later", async () => {
    const held = deferred<any>();
    const s = await setup({ pane: (_u, _i, n) => (n === 0 ? held.promise : pane(`NEW${n}`)) });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
      const m = s.mount("alpha", "view:alpha|1|en"); await vi.advanceTimersByTimeAsync(50); await m;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.calls.filter(c => c.url.startsWith("/api/pane/"))).toHaveLength(1);       // the ticks wait for it
      await vi.advanceTimersByTimeAsync(6_000);                                         // past STUCK_MS: a new read starts
      await vi.waitFor(() => expect(pre(s)).toMatch(/^NEW/));
      const shown = pre(s);
      held.resolve(pane("OLD"));
      await vi.advanceTimersByTimeAsync(10);
      expect(pre(s)).not.toBe("OLD");
      expect(pre(s)!.startsWith("NEW")).toBe(true);
      expect(shown).toMatch(/^NEW/);
    } finally { await s.done(); }
  });

  it("the roster: an older answer released after a newer one does not replace it", async () => {
    const held = deferred<any>();
    const fresh = ROSTER_B.map(r => ({ ...r, display_name: `${r.display_name} NEW` }));
    const s = await setup({ profiles: (_u, _i, n) => (n === 0 ? held.promise : json(fresh)) });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
      const m = s.mount("alpha", "view:alpha|1|en"); await vi.advanceTimersByTimeAsync(50); await m;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.calls.filter(c => c.url === "/api/profiles")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.waitFor(() => expect(s.view.viewStore.get().roster[0]?.display_name).toBe("Alpha NEW"));
      held.resolve(json(ROSTER_B.map(r => ({ ...r, display_name: `${r.display_name} OLD` }))));
      await vi.advanceTimersByTimeAsync(10);
      expect(s.view.viewStore.get().roster[0]?.display_name).toBe("Alpha NEW");
    } finally { await s.done(); }
  });

  it("usage: Refresh supersedes the minute's read on its way; that read's late answer is dropped", async () => {
    const held = deferred<any>();
    const provider = (name: string) => ({ providers: [{ id: "p", name, status: "ok", metrics: [] }], fetchedAt: 1 });
    // 0: the panel's availability check; 1: the dialog's first read; 2: the minute's tick (held); 3: Refresh.
    const s = await setup({ usage: (_u, _i, n) => (n === 2 ? held.promise : json(provider(n === 3 ? "NEW" : "FIRST"))) });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
      const m = s.mount("alpha", "view:alpha|1|en"); await vi.advanceTimersByTimeAsync(50); await m;
      s.p.root.querySelectorAll(".panel-actions .btn").find((b: any) => b.textContent.includes("Usage")).click();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(s.calls.filter(c => c.url.startsWith("/api/ai-usage"))).toHaveLength(3);
      s.p.root.querySelectorAll("dialog .btn").find((b: any) => b.textContent.includes("Refresh")).click();
      await vi.advanceTimersByTimeAsync(10);
      const names = () => s.p.root.querySelectorAll(".u-provider strong").map((e: any) => e.textContent);
      expect(names()).toEqual(["NEW"]);
      held.resolve(json(provider("OLD")));
      await vi.advanceTimersByTimeAsync(10);
      expect(names()).toEqual(["NEW"]);
    } finally { await s.done(); }
  });

  const openEditor = async (s: Awaited<ReturnType<typeof setup>>) => {
    s.p.root.querySelectorAll(".v-card .btn").find((b: any) => b.textContent.includes("Edit")).click();
    await settle(4);
    return s.p.root.querySelector("dialog");
  };

  it("A's open profile editor is gone when the page moves to B; B's editor is B's, and saves to B", async () => {
    const s = await setup();
    try {
      await s.mount("alpha", "view:alpha|1|en"); await settle(6);
      const dlg = await openEditor(s);
      expect(dlg).not.toBeNull();
      const display = dlg.querySelectorAll("input")[0];
      expect(display.value).toBe("Alpha");
      await s.mount("beta", "view:beta|2|en"); await settle(6);
      expect(s.p.root.querySelector("dialog")).toBeNull();
      const dlgB = await openEditor(s);
      expect(dlgB.querySelectorAll("input")[0].value).toBe("Beta");
      dlgB.querySelectorAll(".btn").find((b: any) => b.textContent.includes("Save")).click();
      await settle(6);
      const post = s.calls.find(c => c.url.startsWith("/api/profile/"));
      expect(post?.url).toBe("/api/profile/beta");
      expect(JSON.parse(post!.init.body)).toMatchObject({ display_name: "Beta", role: "beta-role" });
    } finally { await s.done(); }
  });

  for (const [label, moves] of [
    ["A → B", [["beta", "view:beta|2|en"]]],
    ["the same agent again (re-navigation)", [["alpha", "view:alpha|2|en"]]],
    ["A → B → A", [["beta", "view:beta|2|en"], ["alpha", "view:alpha|3|en"]]],
  ] as const) {
    it(`a save in flight when the page moves (${label}) never sends its second write`, async () => {
      const held = deferred<any>();
      const s = await setup({ profile: () => held.promise });
      try {
        await s.mount("alpha", "view:alpha|1|en"); await settle(6);
        const dlg = await openEditor(s);
        const fileInput = dlg.querySelectorAll("input").find((i: any) => i.getAttribute("type") === "file");
        expect(fileInput).toBeDefined();
        fileInput.files = [{ type: "image/png", name: "alpha.png" }];
        dlg.querySelectorAll(".btn").find((b: any) => b.textContent.includes("Save")).click();
        await settle(2);
        expect(s.calls.filter(c => c.url.startsWith("/api/profile/")).map(c => c.url)).toEqual(["/api/profile/alpha"]);
        for (const [name, key] of moves) { await s.mount(name, key); await settle(4); }
        held.resolve(json({ ok: true }));
        await settle(6);
        expect(s.calls.filter(c => c.url.startsWith("/api/avatar/"))).toEqual([]);
      } finally { await s.done(); }
    });
  }

  it("the save is decided when Save is pressed: a file swapped while its first write is on its way is not the one sent", async () => {
    const held = deferred<any>();
    const s = await setup({ profile: () => held.promise });
    try {
      await s.mount("alpha", "view:alpha|1|en"); await settle(6);
      const dlg = await openEditor(s);
      const fileInput = dlg.querySelectorAll("input").find((i: any) => i.getAttribute("type") === "file");
      const picked = { type: "image/png", name: "alpha.png" };
      fileInput.files = [picked];
      dlg.querySelectorAll(".btn").find((b: any) => b.textContent.includes("Save")).click();
      await settle(2);
      fileInput.files = [{ type: "image/png", name: "other.png" }];
      held.resolve(json({ ok: true }));
      await settle(6);
      const avatar = s.calls.filter(c => c.url.startsWith("/api/avatar/"));
      expect(avatar.map(c => c.url)).toEqual(["/api/avatar/alpha"]);
      expect(avatar[0]!.init.body).toBe(picked);
    } finally { await s.done(); }
  });

  it("control: a save with no navigation sends both writes, the avatar to the same agent with the picked file", async () => {
    const s = await setup();
    try {
      await s.mount("alpha", "view:alpha|1|en"); await settle(6);
      const dlg = await openEditor(s);
      const fileInput = dlg.querySelectorAll("input").find((i: any) => i.getAttribute("type") === "file");
      const picked = { type: "image/png", name: "alpha.png" };
      fileInput.files = [picked];
      dlg.querySelectorAll(".btn").find((b: any) => b.textContent.includes("Save")).click();
      await settle(6);
      const avatar = s.calls.filter(c => c.url.startsWith("/api/avatar/"));
      expect(avatar.map(c => c.url)).toEqual(["/api/avatar/alpha"]);
      expect(avatar[0]!.init.body).toBe(picked);
    } finally { await s.done(); }
  });
});
