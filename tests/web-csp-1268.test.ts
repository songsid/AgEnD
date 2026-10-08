/**
 * #1268: no `'unsafe-inline'` script on any web panel. Each panel's own inline <script> runs by a per-response
 * nonce; no panel has an inline `on*=` handler (the dashboard's buttons name an action in data-act, and one
 * delegated listener runs only listed actions). Real listener for the served pages; no fleet started.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { FleetManager } from "../src/fleet-manager.js";
import { WEB_CONTENT_SECURITY_POLICY, panelContentSecurityPolicy, sendPanelHtml } from "../src/web-host-guard.js";

const UI = join(process.cwd(), "src", "ui");
const PANELS = ["dashboard.html", "view.html", "settings.html", "signin.html", join("web-terminal", "terminal.html")];
const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scriptSrc(csp: string): string { return csp.split(";").map(s => s.trim()).find(s => s.startsWith("script-src")) ?? ""; }

describe("no inline event handler, anywhere a panel could write one", () => {
  it.each(PANELS)("%s: no on*= attribute — not in the markup, not in a template the script builds", (file) => {
    const src = readFileSync(join(UI, file), "utf8");
    expect(src.match(/\son[a-z]+\s*=\s*["'`{$\\]/gi) ?? [], file).toEqual([]);
    expect(src, file).not.toMatch(/javascript:/i);
  });

  it("the shared scripts a panel loads write none either", () => {
    for (const f of ["shared/agend-auth.js", "shared/shell.js", "chat-render.js"]) {
      expect(readFileSync(join(UI, f), "utf8").match(/\son[a-z]+\s*=\s*["'`]/gi) ?? [], f).toEqual([]);
    }
  });
});

describe("the policy", () => {
  it("script-src is this origin only; a panel response adds exactly its own nonce", () => {
    expect(scriptSrc(WEB_CONTENT_SECURITY_POLICY)).toBe("script-src 'self'");
    expect(scriptSrc(panelContentSecurityPolicy("abc"))).toBe("script-src 'self' 'nonce-abc'");
    expect(WEB_CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(WEB_CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-eval/);
  });
});

// ── the served pages ──

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); r.end();
  });
}
async function startFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-csp-")); tempDirs.push(dir);
  const fm = new FleetManager(dir);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const server = (fm as unknown as { healthServer: Server }).healthServer;
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const login = await new Promise<Res>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "POST", path: "/auth/login", headers: { "content-type": "application/json", origin } }, res => {
      let t = ""; res.on("data", (c: Buffer) => { t += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: t }));
    });
    r.on("error", reject); r.end(JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
  });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  return { port, cookie, stop: () => new Promise<void>(res => server.close(() => res())) };
}

describe("every panel as served", () => {
  it("each inline <script> carries this response's nonce, the CSP names that nonce and nothing inline, and the nonce is fresh each time", async () => {
    const h = await startFleet();
    try {
      const seen = new Set<string>();
      for (const path of ["/ui", "/view", "/settings", "/signin"]) {
        for (let i = 0; i < 2; i++) {
          const res = await raw(h.port, path, { cookie: h.cookie, accept: "text/html" });
          expect(res.status, path).toBe(200);
          const csp = String(res.headers["content-security-policy"]);
          const m = /'nonce-([A-Za-z0-9+/=]+)'/.exec(scriptSrc(csp));
          expect(scriptSrc(csp), path).not.toMatch(/unsafe-inline/);
          // Every opening script tag the page carries, in any case.
          const scripts = [...res.body.matchAll(/<script\b([^>]*)>/gi)].map(x => x[1]!);
          const inline = scripts.filter(a => !/\ssrc=/.test(a));
          if (inline.length) {
            expect(m, `${path} has inline script, so its CSP needs a nonce`).not.toBeNull();
            for (const a of inline) expect(a.trim(), path).toBe(`nonce="${m![1]}"`);
            expect(seen.has(m![1]!), "a nonce is never reused").toBe(false);
            seen.add(m![1]!);
          }
          expect(res.body.match(/\son[a-z]+\s*=\s*"/gi) ?? [], path).toEqual([]);
        }
      }
      expect(seen.size, "/ui, /view and /settings each have inline script, twice").toBe(6);
    } finally { await h.stop(); }
  }, 30_000);
});

describe("the dashboard's one click listener (the real page script)", () => {
  const RENDER = readFileSync(join(UI, "chat-render.js"), "utf8");
  const PAGE = readFileSync(join(UI, "dashboard.html"), "utf8").match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  function page() {
    let listener!: (e: unknown) => void;
    const node = () => ({ style: {}, remove() {}, append() {}, setAttribute() {}, children: [], textContent: "", innerHTML: "", className: "" });
    const c = vm.createContext({
      /* a returning browser: it has seen the first sign-in tour (#1366) */ localStorage: { getItem: (k: string) => k === "agend_tour_done" ? "1" : null }, navigator: { language: "en" },
      document: { addEventListener: (t: string, f: (e: unknown) => void) => { if (t === "click") listener = f; }, getElementById: () => node(), createElement: () => node(), body: { appendChild() {} } },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({}) }), EventSource: class { addEventListener() {} },
    });
    vm.runInContext(RENDER, c);
    vm.runInContext(PAGE, c);
    const calls: unknown[][] = [];
    (c as any).record = (...a: unknown[]) => calls.push(a);
    vm.runInContext('doAction=(a)=>record("doAction",a);taskAct=(i,a)=>record("taskAct",i,a);sel=(n)=>record("sel",n);selFleet=()=>record("selFleet");', c);
    const click = (dataset: Record<string, string>, extra: Record<string, unknown> = {}) => {
      const el = { dataset, closest: (q: string) => (q === "[data-act]" ? el : null), ...extra };
      listener({ target: el });
    };
    return { click, calls, read: (s: string) => vm.runInContext(s, c) };
  }

  it("runs the named action with its arguments", () => {
    const p = page();
    p.click({ act: "doAction", arg: "restart" });
    p.click({ act: "taskAct", arg: "t-1", arg2: "claim" });
    p.click({ act: "sel", arg: `x"><img src=y onerror=z>` });
    p.click({ act: "selFleet" });
    expect(p.calls).toEqual([["doAction", "restart"], ["taskAct", "t-1", "claim"], ["sel", `x"><img src=y onerror=z>`], ["selFleet"]]);
  });

  it("runs nothing that is not listed — not a page function, not a prototype name", () => {
    const p = page();
    for (const act of ["constructor", "__proto__", "toString", "hasOwnProperty", "eval", "alert", "doAction2", ""]) p.click({ act, arg: "x" });
    p.click({}, { closest: () => null });
    expect(p.calls).toEqual([]);
  });

  it("an argument goes into its attribute escaped — quotes cannot end it", () => {
    const p = page();
    expect(p.read(`escAttr('a"b\\'c<d>&')`)).toBe("a&quot;b&#39;c&lt;d&gt;&amp;");
    expect(p.read("escAttr(null)")).toBe("");
  });
});

// ── #1303 review: a value in a quoted attribute can never become attributes of its own ──

/** The attributes of every start tag, the way an HTML tokenizer reads double-quoted values (up to the next `"`). */
function startTags(html: string): Array<{ tag: string; attrs: Array<[string, string]> }> {
  const out: Array<{ tag: string; attrs: Array<[string, string]> }> = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g)) {
    const attrs: Array<[string, string]> = [];
    for (const a of m[2]!.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs.push([a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? ""]);
    out.push({ tag: m[1]!.toLowerCase(), attrs });
  }
  return out;
}
const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("hostile names and config values stay inside their attribute (#1303 review)", () => {
  const RENDER = readFileSync(join(UI, "chat-render.js"), "utf8");
  const PAGE = readFileSync(join(UI, "dashboard.html"), "utf8").match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  const HOSTILE = `victim" data-act="doAction" data-arg="stop" x="`;
  function page(api: (m: string, p: string) => unknown) {
    const nodes: Record<string, { innerHTML: string; textContent: string; style: Record<string, string>; className: string; querySelectorAll(): unknown[]; addEventListener(): void }> = {};
    const node = (id: string) => (nodes[id] ??= { innerHTML: "", textContent: "", style: {}, className: "", querySelectorAll: () => [], addEventListener() {} });
    const posts: string[] = [];
    const c = vm.createContext({
      /* a returning browser: it has seen the first sign-in tour (#1366) */ localStorage: { getItem: (k: string) => k === "agend_tour_done" ? "1" : null }, navigator: { language: "en" },
      document: { addEventListener() {}, getElementById: (id: string) => node(id), createElement: () => ({ style: {}, remove() {}, append() {} }), body: { appendChild() {} } },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      fetch: async (u: string, o: { method?: string } = {}) => { if ((o.method ?? "GET") !== "GET") posts.push(String(u)); return { ok: true, json: async () => ({}) }; },
      EventSource: class { addEventListener() {} },
    });
    vm.runInContext(RENDER, c);
    vm.runInContext(PAGE, c);
    (c as any).apiStub = api;
    vm.runInContext("api = async (m, p, b) => apiStub(m, p, b);", c);
    return { nodes, posts, read: (s: string) => vm.runInContext(s, c) };
  }

  it("the roster: a quote-bearing instance name forges no data-act; data-n and the tooltip carry the name whole", () => {
    const p = page(() => ({}));
    p.read(`instances = [{ name: ${JSON.stringify(HOSTILE)}, status: "running", backend: "claude-code" }]; mode = "instance"; cur = null; renderList();`);
    const tags = startTags(p.nodes.instanceList!.innerHTML);
    const row = tags.find(t => t.attrs.some(([k]) => k === "data-n"))!;
    expect(row.attrs.map(([k]) => k).sort()).toEqual(["class", "data-n", "role", "tabindex", "title"]);
    expect(unescape(row.attrs.find(([k]) => k === "data-n")![1])).toBe(HOSTILE);
    expect(tags.flatMap(t => t.attrs).filter(([k]) => k === "data-act"), "no element in the roster names an action").toEqual([]);
  });

  it("the config tab: hostile group id and allowed users stay one value each; the only data-act are the page's own", async () => {
    const p = page(async (_m, path) => path === "/ui/config"
      ? { channel: { type: `x" data-act="doAction`, group_id: `-1" data-act="doAction" data-arg="delete`, access: { mode: "locked", allowed_users: [`a" data-act="saveConfig`, "b"] } }, defaults: {}, project_roots: [`/r" data-act="removeParent`] }
      : {});
    await p.read("loadConfig()");
    const tags = startTags(p.nodes.configView!.innerHTML);
    const acts = tags.flatMap(t => t.attrs).filter(([k]) => k === "data-act").map(([, v]) => v);
    expect(acts.sort()).toEqual(["addRoot", "removeParent", "saveConfig", "togglePw", "togglePw"].sort());
    const gid = tags.find(t => t.attrs.some(([k, v]) => k === "id" && v === "cfg-gid"))!;
    expect(unescape(gid.attrs.find(([k]) => k === "value")![1])).toBe(`-1" data-act="doAction" data-arg="delete`);
    const users = tags.find(t => t.attrs.some(([k, v]) => k === "id" && v === "cfg-users"))!;
    expect(unescape(users.attrs.find(([k]) => k === "value")![1])).toBe(`a" data-act="saveConfig, b`);
  });

  it("esc() escapes quotes on every panel (the same function writes text and attributes)", () => {
    for (const file of ["dashboard.html", "view.html", "settings.html"]) {
      const src = readFileSync(join(UI, file), "utf8");
      const m = src.match(/(?:function esc\(s\) \{[^\n]*\}|const esc = \(s\) => [^\n]*;)/);
      expect(m, file).not.toBeNull();
      const ctx = vm.createContext({ escAttr: (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;") });
      const esc = vm.runInContext(`(() => { ${m![0]}; return esc; })()`, ctx) as (s: string) => string;
      expect(esc(`a"b'c<d>&`), file).toBe("a&quot;b&#39;c&lt;d&gt;&amp;");
    }
  });
});

describe("sendPanelHtml stamps the nonce on the page's own bare tags only (#1262 CodeQL)", () => {
  const serve = (html: string) => {
    const headers: Record<string, string> = {};
    let body = "";
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; }, writeHead: () => {}, end: (b: string) => { body = b; } };
    sendPanelHtml(res as never, html);
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(headers["Content-Security-Policy"]!)![1]!;
    return { body, nonce };
  };

  it("every bare <script> and <style> gets this response's nonce", () => {
    const { body, nonce } = serve("<head><style>a{}</style></head><body><script>1</script><script>2</script></body>");
    expect(body).toBe(`<head><style nonce="${nonce}">a{}</style></head><body><script nonce="${nonce}">1</script><script nonce="${nonce}">2</script></body>`);
  });

  it("any other spelling is left without a nonce, so CSP blocks it inline", () => {
    for (const tag of ["<SCRIPT>", "<Script>", "<script type=\"module\">", "<script src=\"/x.js\">", "<script >", "<STYLE>", "<style media=\"all\">"]) {
      const { body } = serve(`<body>${tag}x</body>`);
      expect(body, tag).toBe(`<body>${tag}x</body>`);
    }
  });
});
