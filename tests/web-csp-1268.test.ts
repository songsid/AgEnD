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
import { WEB_CONTENT_SECURITY_POLICY, panelContentSecurityPolicy } from "../src/web-host-guard.js";

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
          const scripts = [...res.body.matchAll(/<script\b([^>]*)>/g)].map(x => x[1]!);
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
      localStorage: { getItem: () => null }, navigator: { language: "en" },
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
