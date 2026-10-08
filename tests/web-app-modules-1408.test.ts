/**
 * #1408 §3–§5, the runtime contracts of the app shell:
 * - module admission: the entry and everything it imports statically come from /assets/ with no session, and none of
 *   it names /ui/; the panels that need a session stay behind the gate and are reached only by dynamic imports;
 * - the sign-in page carries an old /ui#instance=<name> link through both of its return paths;
 * - leases: work from a navigation that was left can never land (A→B→A), and a lease releases what it holds;
 * - the stream's modes: local = one EventSource (polling only while it is down), public link = no EventSource and
 *   polling at once, and it opens only once its listeners are attached.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { FleetManager } from "../src/fleet-manager.js";

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers(); });

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: text }));
    });
    r.on("error", reject); r.end();
  });
}
async function listener() {
  const dir = mkdtempSync(join(tmpdir(), "agend-modules-1408-"));
  tempDirs.push(dir);
  const fm = new FleetManager(dir);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const server = (fm as unknown as { healthServer: Server }).healthServer;
  return { port: (server.address() as { port: number }).port, stop: () => new Promise<void>(r => server.close(() => r())) };
}

/** The static import specifiers of an ES module (import … from "x", import "x", export … from "x"); not import(). */
function staticImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/(?:import|export)\{[^}]*\}from"([^"]+)"/g)) out.push(m[1]!);   // minified vendor files
  for (const m of src.matchAll(/import\s*\w+\s*from"([^"]+)"/g)) out.push(m[1]!);
  return [...new Set(out)];
}

describe("module admission (#1408 §4)", () => {
  it("with no session: the entry's whole static closure loads from /assets as JavaScript, and none of it is under /ui/", async () => {
    const h = await listener();
    try {
      const seen = new Map<string, { status: number; type: string }>();
      const queue = ["/assets/app.js"];
      while (queue.length) {
        const path = queue.shift()!;
        if (seen.has(path)) continue;
        const r = await get(h.port, path);
        seen.set(path, { status: r.status, type: r.type });
        if (r.status !== 200) continue;
        for (const spec of staticImports(r.body)) queue.push(new URL(spec, `http://x${path}`).pathname);
      }
      expect(seen.size, [...seen.keys()].join(", ")).toBeGreaterThanOrEqual(15);
      for (const [path, r] of seen) {
        expect(path, path).toMatch(/^\/assets\/[a-z0-9._-]+\.js$/);
        expect(r.status, path).toBe(200);
        expect(r.type, path).toContain("javascript");
      }
      // The vendored files are part of it.
      for (const v of ["/assets/preact.module.js", "/assets/preact-hooks.module.js", "/assets/htm.module.js"]) expect(seen.has(v), v).toBe(true);
      // What needs a session stays behind the gate.
      for (const p of ["/ui/js/panel-chat.js", "/ui/js/panel-fleet.js", "/ui/js/chat-store.js", "/ui/js/chat-thread.js", "/ui/events", "/ui/poll", "/ui/instances"]) {
        expect((await get(h.port, p)).status, p).toBe(401);
      }
    } finally { await h.stop(); }
  }, 30_000);

  it("the public modules reach private ones only by dynamic import(), and never statically", () => {
    const shared = join(process.cwd(), "src", "ui", "shared");
    for (const name of ["app.js", "app-shell.js", "app-nav.js", "app-stream.js", "app-store.js", "app-ctx.js", "app-route.js", "app-i18n.js", "app-session.js", "ui-dialog.js", "ui-menu.js", "ui-states.js", "ui-icons.js", "ui-toast.js", "app-html.js"]) {
      const src = readFileSync(join(shared, name), "utf8");
      for (const spec of staticImports(src)) expect(spec, `${name} → ${spec}`).toMatch(/^\.\/[a-z0-9._-]+\.js$/);
    }
    const app = readFileSync(join(shared, "app.js"), "utf8");
    // Every dynamic import() in the entry names a private panel (through retryUrl, which only adds ?retry=<n>).
    const dynamic = [...app.matchAll(/import\(([^)]*)\)/g)].map(m => m[1]!.trim());
    expect(dynamic.sort()).toEqual(['retryUrl("/ui/js/panel-chat.js", a', 'retryUrl("/ui/js/panel-fleet.js", a']);
  });
});

// ── the sign-in page's two return paths ──

function signinPage(url: string, opts: { probeOk: boolean; loginOk?: boolean }) {
  const href = new URL(url);
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ??= { id, hidden: false, textContent: "", value: "", disabled: false, listeners: {} as Record<string, Function>,
    addEventListener(t: string, f: Function) { this.listeners[t] = f; }, focus() {}, select() {} });
  let replaced: string | null = null;
  const session = new Map<string, string>();
  const ctx = vm.createContext({
    document: { getElementById: el, documentElement: {}, querySelectorAll: () => [] },
    navigator: { language: "en" },
    location: { href: href.href, origin: href.origin, pathname: href.pathname, search: href.search, hash: href.hash, replace: (u: string) => { replaced = u; } },
    history: { replaceState() {} },
    sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => session.set(k, v), removeItem: (k: string) => session.delete(k) },
    fetch: async (u: string) => ({ ok: u === "/auth/session" ? opts.probeOk : !!opts.loginOk, status: 200 }),
    URL, URLSearchParams, Date, Promise, JSON, console,
  });
  vm.runInContext(readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8"), ctx);
  return {
    settle: () => new Promise(r => setTimeout(r, 10)),
    replaced: () => replaced,
    submit: async () => { await els.form.listeners.submit({ preventDefault() {} }); },
  };
}

describe("an old /ui#instance=<name> link survives signing in (#1408 §3)", () => {
  const CASES: Array<[string, string]> = [
    ["http://127.0.0.1:19280/ui#instance=web-dev", "/ui/chat/web-dev"],
    ["http://127.0.0.1:19280/ui#instance=%E4%B8%AD", "/ui/chat/%E4%B8%AD"],
    ["http://127.0.0.1:19280/ui#instance=..%2Fx", "/ui"],
    ["http://127.0.0.1:19280/ui#instance=a&token=x", "/ui"],
    ["http://127.0.0.1:19280/ui#next=//evil.example", "/ui"],
    ["http://127.0.0.1:19280/ui", "/ui"],
    ["http://127.0.0.1:19280/ui/chat/web-dev", "/ui/chat/web-dev"],
    ["http://127.0.0.1:19280/ui?token=" + "c".repeat(48) + "#instance=web-dev", "/ui/chat/web-dev"],
  ];
  it.each(CASES)("the cookie-probe bounce: %s → %s", async (url, want) => {
    const p = signinPage(url, { probeOk: true });
    await p.settle();
    expect(p.replaced()).toBe(want);
  });
  it.each(CASES)("the code login: %s → %s", async (url, want) => {
    const p = signinPage(url, { probeOk: false, loginOk: true });
    await p.settle();
    expect(p.replaced()).toBeNull();
    await p.submit();
    expect(p.replaced()).toBe(want);
  });
  it("a ?next= still wins, and still only to a page of the app", async () => {
    let p = signinPage("http://127.0.0.1:19280/signin?next=%2Fui%2Ffleet%2Fteams", { probeOk: true });
    await p.settle(); expect(p.replaced()).toBe("/ui/fleet/teams");
    p = signinPage("http://127.0.0.1:19280/signin?next=https%3A%2F%2Fevil.example%2Fui", { probeOk: true });
    await p.settle(); expect(p.replaced()).toBe("/ui");
  });
});

// ── leases ──

describe("leases (#1408 §4)", () => {
  it("A → B → A: an answer for the first A that arrives last lands nowhere", async () => {
    const { createLease } = await import("/assets/app-ctx.js") as { createLease(t?: unknown): any };
    const shown: string[] = [];
    let resolveA1!: (v: string) => void;
    const a1 = createLease();
    const pending = new Promise<string>(r => { resolveA1 = r; });
    (async () => { const v = await pending; if (a1.current()) shown.push(v); })();
    a1.dispose();                                       // → B
    const b = createLease(); shown.push("B"); b.dispose();   // → A again
    const a2 = createLease(); shown.push("A2");
    resolveA1("A1");
    await new Promise(r => setTimeout(r, 0));
    expect(shown).toEqual(["B", "A2"]);
    expect(a2.current()).toBe(true);
    a2.dispose();
  });

  it("a disposed lease releases its timers, intervals, listeners, subscriptions and fetches; nothing runs after", async () => {
    vi.useFakeTimers();
    const { createLease, leaseCount } = await import("/assets/app-ctx.js") as { createLease(t?: unknown): any; leaseCount(): number };
    const base = leaseCount();
    const calls: string[] = [];
    const target = { added: 0, removed: 0, addEventListener() { this.added++; }, removeEventListener() { this.removed++; } };
    let aborted = false;
    const env = { setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: (_u: string, o: { signal: AbortSignal }) => new Promise((_r, rej) => { o.signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }); }) };
    const l = createLease(env);
    l.timeout(() => calls.push("timeout"), 100);
    l.interval(() => calls.push("interval"), 50);
    l.on(target, "keydown", () => {});
    let off = 0; l.hold(() => { off++; });
    l.fetch("/ui/tasks").catch(() => {});
    expect(l.holding()).toBe(5);
    expect(leaseCount()).toBe(base + 1);
    expect(vi.getTimerCount()).toBe(2);
    l.dispose();
    expect(vi.getTimerCount(), "no timer or interval is left armed").toBe(0);
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);
    expect(target.removed).toBe(1);
    expect(off).toBe(1);
    expect(aborted).toBe(true);
    expect(l.holding()).toBe(0);
    expect(leaseCount()).toBe(base);
    // A lease that has ended takes nothing new.
    expect(l.timeout(() => calls.push("late"), 1)).toBeNull();
    vi.advanceTimersByTime(10);
    expect(calls).toEqual([]);
  });
});

// ── the stream's modes ──

function fakeEnv() {
  const sources: any[] = [];
  const polls: string[] = [];
  class ES { url: string; listeners: Record<string, Function> = {}; onerror: Function | null = null; closed = false;
    constructor(url: string) { this.url = url; sources.push(this); }
    addEventListener(n: string, f: Function) { this.listeners[n] = f; } close() { this.closed = true; } }
  const env = {
    EventSource: ES, setTimeout, clearTimeout, setInterval, clearInterval, console,
    fetch: async (u: string) => { polls.push(u); return { ok: true, json: async () => ({ status: { instances: [] }, messages: [], cursor: "1-1", deliveries: [], prompts: [], needs: [] }) }; },
  };
  return { env, sources, polls };
}

describe("the stream's modes (#1408 §3)", () => {
  it("local: exactly one EventSource on /ui/events, opened only by start(); no polling while it speaks", async () => {
    vi.useFakeTimers();
    const { createStream } = await import("/assets/app-stream.js") as { createStream(o: unknown): any };
    const f = fakeEnv();
    const s = createStream({ mode: "full", env: f.env });
    expect(f.sources).toHaveLength(0);                 // listeners first: nothing sent on connect is missed
    s.start(); s.start();
    expect(f.sources.map(x => x.url)).toEqual(["/ui/events"]);
    f.sources[0].listeners.status({ data: JSON.stringify({ instances: [] }) });
    vi.advanceTimersByTime(20_000);
    f.sources[0].listeners.status({ data: JSON.stringify({ instances: [] }) });
    vi.advanceTimersByTime(20_000);
    expect(f.polls).toEqual([]);
    expect(s.connection()).toBe("live");
    s.close();
  });

  it("local: a silent or broken stream falls back to /ui/poll every 5 s, and stops when it speaks again", async () => {
    vi.useFakeTimers();
    const { createStream } = await import("/assets/app-stream.js") as { createStream(o: unknown): any };
    const f = fakeEnv();
    const s = createStream({ mode: "full", env: f.env });
    s.start();
    f.sources[0].onerror(); f.sources[0].onerror();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.polls).toHaveLength(1);
    expect(s.connection()).toBe("polling");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.polls).toHaveLength(3);
    f.sources[0].listeners.status({ data: JSON.stringify({ instances: [] }) });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.polls).toHaveLength(3);
    expect(f.sources).toHaveLength(1);
    s.close();
  });

  it("the public link: no EventSource at all, /ui/poll at once and every 5 s, with the stream's cursor", async () => {
    vi.useFakeTimers();
    const { createStream } = await import("/assets/app-stream.js") as { createStream(o: unknown): any };
    const f = fakeEnv();
    const s = createStream({ mode: "full", transport: "poll", env: f.env });
    const statuses: unknown[] = [];
    s.on("status", (d: unknown) => statuses.push(d));
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sources).toHaveLength(0);
    expect(f.polls).toEqual(["/ui/poll?after="]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.polls).toEqual(["/ui/poll?after=", "/ui/poll?after=1-1"]);
    expect(statuses).toHaveLength(2);
    expect(s.usesEventSource()).toBe(false);
    s.close();
  });

  it("View-only (step 2) and any other mode: neither", async () => {
    vi.useFakeTimers();
    const { createStream } = await import("/assets/app-stream.js") as { createStream(o: unknown): any };
    const f = fakeEnv();
    const s = createStream({ mode: "view-only", env: f.env });
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sources).toHaveLength(0);
    expect(f.polls).toEqual([]);
    expect(s.connection()).toBe("none");
  });

  it("the app opens the stream only after the chat's store is attached", () => {
    const app = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.js"), "utf8");
    expect(app).toMatch(/const loadChat = retryable\(\(a\) => import\([^)]*\)\)\.then\(\(m\) => \{\n  m\.boot\(\{ stream, boot \}\);\n[\s\S]*?if \(stream\.started\(\)\) stream\.catchUp\(\);\n  return m;\n\}\)\);/);
    expect(app).toMatch(/loadChat\(\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => stream\.start\(\)\)/);
    expect(app.indexOf("stream.start()")).toBeGreaterThan(app.indexOf("m.boot("));
  });
});
