/**
 * #1300: no `'unsafe-inline'` style on any web panel either. A panel's own <style> block applies by the response's
 * nonce; no panel has a style attribute — not in its markup, not in what its scripts write — and what a script colours
 * or sizes at run time goes through the style object (CSSOM), which the policy does not govern. Real listener for the
 * served pages; no fleet started. (#1268 is the same for scripts: tests/web-csp-1268.test.ts.)
 * #1408 step 1: the dashboard is the app shell: app.html has no <style> block at all (tokens.css and app.css are
 * external), and every app module is scanned like the panels' scripts.
 * #1408 step 2: /view is the app shell too (its View panel is shared/panel-view.js, with the ANSI renderer that used
 * to live in view.html), so view.html is gone and the terminal-colour cases read panel-view.js.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { FleetManager } from "../src/fleet-manager.js";
import { WEB_CONTENT_SECURITY_POLICY, panelContentSecurityPolicy } from "../src/web-host-guard.js";

const UI = join(process.cwd(), "src", "ui");
const PANELS = ["app.html", "settings.html", "signin.html"];
// Every script a panel can load from this origin: the app's modules and the shared ones (*.module.js is vendored Preact/htm).
const isModule = (f: string) => f.endsWith(".js") && !f.endsWith(".module.js");
const SHARED = [...readdirSync(join(UI)).filter(isModule), ...readdirSync(join(UI, "shared")).filter(isModule).map(f => join("shared", f))];
const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const directive = (csp: string, name: string) => csp.split(";").map(s => s.trim()).find(s => s.startsWith(name + " ")) ?? "";

describe("no style attribute, anywhere a panel could write one", () => {
  it("the View panel's modules are in the scan below, so a rename cannot drop them silently", () => {
    expect(SHARED).toEqual(expect.arrayContaining([join("shared", "panel-view.js"), join("shared", "view-strings.js")]));
  });

  it.each(PANELS)("%s: none in the markup or in a template its script builds; no setAttribute('style')", (file) => {
    const src = readFileSync(join(UI, file), "utf8");
    expect(src.match(/\sstyle\s*=\s*["'`{$\\]/gi) ?? [], file).toEqual([]);
    expect(src, file).not.toMatch(/setAttribute\(\s*["'`]style["'`]/);
    expect(src, file).not.toMatch(/createElement\(\s*["'`]style["'`]/);   // a <style> made at run time has no nonce
    // An attribute object handed to a builder (settings' el(tag, { … })) is a style attribute too.
    expect(src.match(/[{,]\s*style\s*:\s*["'`]/g) ?? [], file).toEqual([]);
  });

  it("settings' el() refuses a style attribute outright", () => {
    const src = readFileSync(join(UI, "settings.html"), "utf8");
    const line = src.split("\n").find(l => l.includes("const el = (tag, attrs = {}, ...kids)"))!;
    const c = vm.createContext({ document: { createElement: () => ({ setAttribute() {}, append() {}, addEventListener() {} }) } });
    vm.runInContext(line.trim().replace(/^const el =/, "globalThis.el ="), c);
    expect(() => vm.runInContext('el("div", { style: "color:red" })', c)).toThrow(/class, not a style attribute/);
    expect(() => vm.runInContext('el("div", { class: "u-row", title: "x" })', c)).not.toThrow();
  });

  it.each(PANELS)("%s: every <style> block is a bare <style>, so the server's nonce reaches it", (file) => {
    const src = readFileSync(join(UI, file), "utf8");
    const tags = [...src.matchAll(/<style\b[^>]*>/g)].map(m => m[0]);
    // The app shell's styles are external (tokens.css, app.css): it has no style block to nonce.
    if (file === "app.html") expect(tags, "the shell has no <style> block").toEqual([]);
    else expect(tags.length, file).toBeGreaterThan(0);
    expect(tags.filter(t => t !== "<style>"), file).toEqual([]);
  });

  it("the shared scripts a panel loads write none either", () => {
    for (const f of SHARED) {
      const src = readFileSync(join(UI, f), "utf8");   // every app module too: the same rule
      expect(src.match(/\sstyle\s*=\s*["'`{$\\]/gi) ?? [], f).toEqual([]);
      // An htm prop (style=${…}) or an attribute object's key (el(tag, { style: … })) is a style attribute too.
      expect(src.match(/[{,]\s*style\s*:\s*["'`]/g) ?? [], f).toEqual([]);
      expect(src, f).not.toMatch(/setAttribute\(\s*["'`]style["'`]|createElement\(\s*["'`]style["'`]/);
    }
  });
});

describe("the policy", () => {
  it("style-src is this origin only; a panel response adds exactly its own nonce, the same as for scripts", () => {
    expect(directive(WEB_CONTENT_SECURITY_POLICY, "style-src")).toBe("style-src 'self'");
    expect(WEB_CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline/);
    const p = panelContentSecurityPolicy("abc");
    expect(directive(p, "style-src")).toBe("style-src 'self' 'nonce-abc'");
    expect(directive(p, "script-src")).toBe("script-src 'self' 'nonce-abc'");
    expect(p).not.toMatch(/unsafe-inline/);
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
  const dir = mkdtempSync(join(tmpdir(), "agend-csp1300-")); tempDirs.push(dir);
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
  it("each <style> carries this response's nonce, the CSP's style-src names it and nothing inline, and no style attribute is served", async () => {
    const h = await startFleet();
    try {
      for (const path of ["/ui", "/view", "/settings", "/signin"]) {
        const res = await raw(h.port, path, { cookie: h.cookie, accept: "text/html" });
        expect(res.status, path).toBe(200);
        const csp = String(res.headers["content-security-policy"]);
        const style = directive(csp, "style-src");
        expect(style, path).not.toMatch(/unsafe-inline/);
        const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(style)?.[1];
        expect(nonce, `${path}: style-src names a nonce`).toBeTruthy();
        expect(directive(csp, "script-src"), "one nonce for both").toContain(`'nonce-${nonce}'`);
        const tags = [...res.body.matchAll(/<style\b([^>]*)>/g)].map(m => m[1]!.trim());
        // /ui and /view are the app shell: its styles are external files, so there is no <style> to nonce.
        if (path === "/ui" || path === "/view") expect(tags, `${path}: the app shell's styles are external files`).toEqual([]);
        else expect(tags.length, path).toBeGreaterThan(0);
        for (const a of tags) expect(a, path).toBe(`nonce="${nonce}"`);
        expect(res.body.match(/\sstyle\s*=\s*"/gi) ?? [], path).toEqual([]);
      }
    } finally { await h.stop(); }
  });
});

// ── /view's live terminal: colours as data, painted through the style object ──

describe("/view's terminal colours", () => {
  const VIEW = readFileSync(join(UI, "shared", "panel-view.js"), "utf8");
  // The ANSI section of the View panel's module: BASE, esc, xterm256, ansiToHtml and paintAnsi, up to the roster. Its
  // exports are dropped so the section runs as a plain script.
  const between = (from: string, to: string) => VIEW.slice(VIEW.indexOf(from), VIEW.indexOf(to));
  function load() {
    const c = vm.createContext({});
    vm.runInContext(between("const BASE = [", "// ── The roster").replace(/^export /gm, ""), c);
    return c as unknown as { ansiToHtml(t: string): string; paintAnsi(root: unknown): void; xterm256(n: number): string };
  }

  it("a coloured run is a span with its colours as data — never a style attribute", () => {
    const { ansiToHtml } = load();
    const html = ansiToHtml("plain \x1b[31mred\x1b[0m \x1b[1;32mbold green\x1b[0m \x1b[38;5;208mxterm\x1b[48;2;1;2;3m rgb bg\x1b[0m");
    expect(html).not.toMatch(/style=/);
    expect(html).toBe(
      'plain <span class="ansi" data-fg="#cd3131">red</span> ' +
      '<span class="ansi" data-fg="#23d18b" data-b>bold green</span> ' +
      '<span class="ansi" data-fg="rgb(255,135,0)">xterm</span>' +
      '<span class="ansi" data-fg="rgb(255,135,0)" data-bg="rgb(1,2,3)"> rgb bg</span>');
  });

  it("the pane's text stays text, and nothing from it reaches an attribute", () => {
    const { ansiToHtml } = load();
    const html = ansiToHtml('\x1b[31m<img src=x onerror=alert(1)> " style="position:fixed\x1b[0m');
    expect(html).toBe('<span class="ansi" data-fg="#cd3131">&lt;img src=x onerror=alert(1)&gt; &quot; style=&quot;position:fixed</span>');
  });

  it("paintAnsi sets each run's colours through the style object", () => {
    const { paintAnsi } = load();
    const span = (fg?: string, bg?: string) => ({ dataset: { ...(fg ? { fg } : {}), ...(bg ? { bg } : {}) }, style: {} as Record<string, string> });
    const runs = [span("#cd3131"), span(undefined, "rgb(1,2,3)"), span("#ffffff", "#000000")];
    paintAnsi({ querySelectorAll: (q: string) => { expect(q).toBe(".ansi[data-fg], .ansi[data-bg]"); return runs; } });
    expect(runs.map(r => r.style)).toEqual([{ color: "#cd3131" }, { background: "rgb(1,2,3)" }, { color: "#ffffff", background: "#000000" }]);
  });
});
