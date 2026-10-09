/**
 * #1268: no `'unsafe-inline'` script on any web panel. Each panel's own inline <script> runs by a per-response
 * nonce; no panel has an inline `on*=` handler. #1408 step 1: the dashboard is the app shell (app.html) and its modules:
 * they bind handlers as htm props (`onClick=${fn}`), never as attribute strings, and the shell has no inline script at
 * all. Real listener for the served pages; no fleet started.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { FleetManager } from "../src/fleet-manager.js";
import { WEB_CONTENT_SECURITY_POLICY, panelContentSecurityPolicy, sendPanelHtml } from "../src/web-host-guard.js";

const UI = join(process.cwd(), "src", "ui");
// #1408 step 2: /view is app.html too (its View panel is a module, shared/panel-view.js), so view.html is gone.
const PANELS = ["app.html", "settings.html", "signin.html", join("web-terminal", "terminal.html")];
// Every script a panel can load from this origin: the app's modules and the shared ones (*.module.js is vendored Preact/htm).
const isModule = (f: string) => f.endsWith(".js") && !f.endsWith(".module.js");
const MODULES = [...readdirSync(UI).filter(isModule), ...readdirSync(join(UI, "shared")).filter(isModule).map(f => join("shared", f))];
const APP = readFileSync(join(UI, "app.html"), "utf8");
const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scriptSrc(csp: string): string { return csp.split(";").map(s => s.trim()).find(s => s.startsWith("script-src")) ?? ""; }

describe("no inline event handler, anywhere a panel could write one", () => {
  it.each(PANELS)("%s: no on*= attribute — not in the markup, not in a template the script builds", (file) => {
    const src = readFileSync(join(UI, file), "utf8");
    expect(src.match(/\son[a-z]+\s*=\s*["'`{$\\]/gi) ?? [], file).toEqual([]);
    expect(src, file).not.toMatch(/javascript:/i);
  });

  it("the View panel's modules are in the scan above, so a rename cannot drop them silently", () => {
    expect(MODULES).toEqual(expect.arrayContaining([join("shared", "panel-view.js"), join("shared", "view-strings.js")]));
  });

  it("the shared scripts a panel loads write none either", () => {
    for (const f of ["shared/agend-auth.js", "shared/shell.js", "chat-render.js"]) {
      expect(readFileSync(join(UI, f), "utf8").match(/\son[a-z]+\s*=\s*["'`]/gi) ?? [], f).toEqual([]);
    }
  });

  // The app's modules bind with htm props (onClick=${fn}): a quoted or template-string value is an attribute written as text.
  it.each(MODULES)("%s: no on*= attribute written as a string, and no javascript: URL", (file) => {
    const src = readFileSync(join(UI, file), "utf8");
    expect(src.match(/\son[a-z]+\s*=\s*["'`]/gi) ?? [], file).toEqual([]);
    // A javascript: URL is one written as a value (chat-render's LANG_ALIAS names the key, unquoted, and is fine).
    expect(src, file).not.toMatch(/["'`(=]\s*javascript:/i);
  });

  it("the app shell has no inline script or inline handler at all: its one script is external", () => {
    expect(APP.match(/<script(?![^>]*\ssrc=)[^>]*>/gi) ?? []).toEqual([]);
    expect(APP.match(/\son[a-z]+\s*=/gi) ?? []).toEqual([]);
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
          if (path === "/ui") expect(inline, "the app shell loads only external scripts").toEqual([]);
          if (inline.length) {
            expect(m, `${path} has inline script, so its CSP needs a nonce`).not.toBeNull();
            for (const a of inline) expect(a.trim(), path).toBe(`nonce="${m![1]}"`);
            expect(seen.has(m![1]!), "a nonce is never reused").toBe(false);
            seen.add(m![1]!);
          }
          expect(res.body.match(/\son[a-z]+\s*=\s*"/gi) ?? [], path).toEqual([]);
        }
      }
      // /settings has its inline script (twice, one nonce per response); /view and /ui are the app shell, which has none.
      expect(seen.size, "/settings has inline script, twice; /view and /ui none").toBe(2);
    } finally { await h.stop(); }
  }, 30_000);
});

// #1408 step 1 — dropped: "the dashboard's one click listener (the real page script)" (runs listed data-act names, not
// prototype names, escapes its arguments). The app has no data-act delegation: htm binds each handler as a prop, so
// there is no attribute that can name an action. The equivalent is in tests/sidebar-instance-identity.test.ts ("a hostile
// name stays one name") and in the static checks above.

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

// #1408 step 1 — dropped: "hostile names and config values stay inside their attribute (#1303 review)". Its roster case
// is ported to the app's sidebar (tests/sidebar-instance-identity.test.ts, "a hostile name stays one name"). Its config-tab
// case read the dashboard's innerHTML string builder, which the app does not have: the fleet's config tab binds values
// as htm props, so no value can end an attribute.

describe("the app builds its markup from templates and props; the thread's string template is escaped and allow-listed (#1303)", () => {
  const THREAD = readFileSync(join(UI, "chat-thread.js"), "utf8");
  // The one innerHTML write a module may make besides the thread: the View pane's frame, which ansiToHtml builds from
  // escaped pane text and its own spans only (#1408 step 2). Pinned by content, so a second write fails here.
  const ANSI_FRAME = "pre.current.innerHTML = ansiToHtml(text);";
  it.each(MODULES.filter(f => f !== join("chat-thread.js")))("%s: no innerHTML write, insertAdjacentHTML, document.write, eval or new Function", (file) => {
    const src = readFileSync(join(UI, file), "utf8");
    if (file === join("shared", "panel-view.js")) {
      expect(src.match(/\.innerHTML\s*=/g) ?? [], file).toHaveLength(1);
      expect(src, file).toContain(ANSI_FRAME);
    } else expect(src, file).not.toMatch(/\.innerHTML\s*=/);
    expect(src, file).not.toContain("insertAdjacentHTML");
    expect(src, file).not.toContain("document.write");
    expect(src, file).not.toMatch(/\beval\(|new Function\(/);
  });

  // The conversation's messages are one string template (the keyed renderer, #1307): every data-* value in it is escaped
  // by escAttr, and the one delegated listener runs only the actions its template names.
  it("chat-thread: every data-* value is escaped, and the one listener runs only the actions the template names", () => {
    expect(THREAD.match(/data-[\w-]+="\$\{(?!escAttr\()/g) ?? [], "an unescaped data-* value").toEqual([]);
    // Named in the template (data-act="…") or set on a node (dataset.act = "…").
    const named = [...new Set([...THREAD.matchAll(/data-act="([^"]+)"/g), ...THREAD.matchAll(/dataset\.act = "([^"]+)"/g)].map(m => m[1]!))].sort();
    const handled = [...THREAD.slice(THREAD.indexOf("function onClick(e)"), THREAD.indexOf("function onClick(e)") + 900).matchAll(/act === "(\w+)"/g)].map(m => m[1]!).sort();
    expect(named).toEqual(["copyCode", "copyMsg", "toggleFold", "toggleWrap"]);
    expect(handled).toEqual(named);
    expect(THREAD).toContain('e.target.closest("[data-act]")');
  });

  it("esc() escapes quotes on the panels that still write markup by string (the same function writes text and attributes)", () => {
    for (const file of ["settings.html", join("shared", "panel-view.js")]) {
      const src = readFileSync(join(UI, file), "utf8");
      const m = src.match(/(?:export )?(?:function esc\(s\) \{[^\n]*\}|const esc = \(s\) => [^\n]*;)/);
      expect(m, file).not.toBeNull();
      const ctx = vm.createContext({ escAttr: (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;") });
      const esc = vm.runInContext(`(() => { ${m![0].replace(/^export /, "")}; return esc; })()`, ctx) as (s: string) => string;
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
