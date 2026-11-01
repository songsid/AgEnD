// #2911 item 8: a page share opened in a real browser, through the real share gateway (createOfficeShareGateway with
// the page shares), with NO real tunnel (the leader's condition 3): Chromium's requests to the quick-tunnel host are
// routed to the local gateway with that Host, as cloudflared would pass them. The shared page probes its own powers.
// Expected (the design's viewer table, condition 1):
// - the page renders and its own scripts run;
// - its origin is opaque ("null"): document.cookie and localStorage throw, so nothing of any origin is readable;
// - no network: fetch, an <img> and a form post to another host are blocked (CSP), window.open gives null;
// - the gateway sends no cookie; a dashboard path on the share host is an empty 404; an ended link shows the ended page.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2911-page-share.mts
import { createRequire } from "node:module";
import { request } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.REPO!, PW = process.env.PW_DIR!, OUT = join(process.env.OUT ?? "/tmp/smoke-out", "smoke-2911-page-share");
mkdirSync(OUT, { recursive: true });
const PS = await import(REPO + "/src/page-share.ts");
const { createOfficeShareGateway } = await import(REPO + "/src/office-share.ts");

const HOST = "smoke-page-share.trycloudflare.com";
const PAGE = `<!doctype html><title>Probe</title><style>body{font:16px sans-serif;padding:16px}</style><h1>Shared page</h1><ul id="out"></ul>
<img src="https://example.com/pixel.png" alt="">
<form id="f" method="post" action="https://example.com/steal"><input name="x" value="1"></form>
<script>
const out = {}; const put = (k, v) => { out[k] = v; const li = document.createElement("li"); li.textContent = k + ": " + v; document.getElementById("out").appendChild(li); };
put("ran", "yes");
put("origin", String(self.origin));
try { put("cookie", "read:" + document.cookie); } catch (e) { put("cookie", "denied " + e.name); }
try { localStorage.setItem("k", "v"); put("storage", "allowed"); } catch (e) { put("storage", "denied " + e.name); }
try { put("popup", String(window.open("https://example.com/") === null ? "null" : "opened")); } catch (e) { put("popup", "denied " + e.name); }
let violations = [];
document.addEventListener("securitypolicyviolation", (e) => { violations.push(e.violatedDirective); });
fetch("https://example.com/x").then(() => put("fetch", "allowed"), (e) => put("fetch", "blocked " + e.name));
try { document.getElementById("f").submit(); put("form", "submitted?"); } catch (e) { put("form", "denied " + e.name); }
setTimeout(() => { window.__probe = { ...out, violations }; }, 800);
</script>`;

const pages = new PS.PageShares({});
const made = pages.create({ html: PAGE, instance: "w", title: "Probe", owner: "o" });
if (!made.ok) throw new Error(made.error);
const gw = createOfficeShareGateway({ shares: { find: () => null }, source: { status: () => ({}), org: () => ({}), offices: () => ({ rev: 1, offices: [] }), acts: () => [], traffic: () => ({}), needs: () => [], hidden: () => false } as any, pages, statics: () => null });
const local = await gw.listen();
gw.setHost(HOST);

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const results: any = { browser: browser.version() };
const outbound: string[] = [];
try {
  const ctx = await browser.newContext();
  // The tunnel, emulated: https://HOST/... → the local gateway with Host: HOST. Every other host is recorded and refused.
  await ctx.route("**/*", async (route: any) => {
    const u = new URL(route.request().url());
    if (u.host !== HOST) { outbound.push(`${route.request().method()} ${u.href}`); return route.abort(); }
    const res: any = await new Promise((ok, no) => {
      const r = request({ host: "127.0.0.1", port: Number(local.port), method: route.request().method(), path: u.pathname + u.search, headers: { host: HOST, cookie: "agend_session=planted" } }, (m) => {
        const chunks: Buffer[] = []; m.on("data", (c) => chunks.push(c)); m.on("end", () => ok({ status: m.statusCode, headers: m.headers, body: Buffer.concat(chunks) }));
      }); r.on("error", no); r.end();
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    results.lastHeaders = headers;
    await route.fulfill({ status: res.status, headers, body: res.body });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  const resp = await page.goto(`https://${HOST}/p/${made.token}`);
  results.status = resp.status();
  results.shareHeaders = { csp: results.lastHeaders["content-security-policy"], setCookie: results.lastHeaders["set-cookie"] ?? null, xfo: results.lastHeaders["x-frame-options"] };
  await page.waitForFunction(() => (window as any).__probe, null, { timeout: 5000 });
  results.probe = await page.evaluate(() => (window as any).__probe);
  results.cookiesInBrowser = (await ctx.cookies()).length;
  await page.screenshot({ path: join(OUT, "1-shared-page.png") });
  // A dashboard path on the share host, and an ended link.
  results.dashboardPath = (await page.goto(`https://${HOST}/ui/chat/w`)).status();
  pages.revoke("all");
  const ended = await page.goto(`https://${HOST}/p/${made.token}`);
  results.ended = { status: ended.status(), text: (await page.textContent("body"))?.trim().slice(0, 60) };
  await page.screenshot({ path: join(OUT, "2-ended.png") });
  results.outbound = outbound; results.errors = errors;
  const p = results.probe;
  results.pass = results.status === 200 && /sandbox allow-scripts/.test(results.shareHeaders.csp) && results.shareHeaders.setCookie === null
    && p.ran === "yes" && p.origin === "null" && /^denied/.test(p.cookie) && /^denied/.test(p.storage) && p.popup === "null"
    && /^blocked/.test(p.fetch) && results.outbound.length === 0 && results.cookiesInBrowser === 0
    && results.dashboardPath === 404 && results.ended.status === 404 && /has ended/.test(results.ended.text);
  await ctx.close();
} finally {
  await browser.close();
  gw.close();
}
console.log(JSON.stringify(results, null, 1));
console.log(results.pass ? "PASS" : "FAIL");
process.exit(results.pass ? 0 : 1);
