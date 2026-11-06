// #2911 item 8: Share page end to end in a real browser, on the realistic fixture — with NO real tunnel (the leader's
// condition 3): the fleet's share service runs on a fake tunnel manager that hands its local gateway a quick-tunnel
// host, and Chromium's requests to that host are routed to the gateway (as cloudflared would pass them).
// Steps: an agent sends a page; the admin opens it in the panel → Share page → the confirm dialog (what, "runs the
// page's own scripts", never "safe") → 1 hour → Share → the link once. The link opens the page in another tab (an
// opaque origin: its scripts run, cookies are denied). The bar says "Shared until …"; the channel heard a start notice
// without the URL. Stop sharing → the link shows the ended page, and the channel hears the end.
// Desktop light (en) and phone dark (zh-TW).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2911-share-page-ui.mts
import { request } from "node:http";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2911-share-page-ui";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48460), instances: 2 });
const fm = fx.fm;
const name = fx.instances.find((i: any) => !i.general)!.name;
const { OfficeShareService } = await import(process.env.REPO + "/src/office-share-service.ts");

// The share service on a fake tunnel: its gateway listens locally; we remember where, and route the host to it.
let gatewayOrigin = "", n = 0;
const channel: Array<[string, string]> = [];
const notify = fm.notifyInstanceTopic.bind(fm);
fm.notifyInstanceTopic = (inst: string, text: string, o?: unknown) => { channel.push([inst, text]); return notify(inst, text, o); };
fm.officeSharesInstance = new OfficeShareService({
  source: { status: () => ({ instances: [] }), org: () => ({}), offices: () => ({ rev: 1, offices: [] }), acts: () => [], traffic: () => ({ now: "", items: [] }), needs: () => [], hidden: () => false },
  manager: {
    start: async (_p: unknown, ctx: { origin: URL; onCandidateHost?(h: string): void }) => {
      gatewayOrigin = String(ctx.origin); const host = `smoke-share-${++n}.trycloudflare.com`; ctx.onCandidateHost?.(host);
      return { ok: true, handle: { pageUrl: `https://${host}/ready`, onUnexpectedExit: () => () => {} } } as never;
    },
    stop: async () => ({ confirmed: true }) as never,
  },
  ensure: async () => ({ path: "/bin/false" }), provider: () => ({}) as never,
  config: () => ({ enabled: true }), officeExists: () => true, ownerCurrent: () => true,
  pageConfig: () => ({ enabled: true }), pagesChanged: (l: unknown, e: unknown) => fm.pageSharesChanged(l, e),
} as never);

const PAGE = `<!doctype html><title>Sales dashboard</title><style>body{font:16px sans-serif;padding:16px}</style><h1>Q3 sales</h1><p id="o"></p>
<script>let c; try { c = "cookie:" + document.cookie; } catch (e) { c = "denied"; } document.getElementById("o").textContent = "ran · origin " + self.origin + " · " + c;</script>`;
fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "The dashboard.\n```html\n" + PAGE + "\n```", ts: new Date().toISOString() });

const want = {
  en: { share: "Share page", runs: "runs the page's own scripts", shared: /^Shared until /, stop: "Stop sharing" },
  "zh-TW": { share: "分享頁面", runs: "頁面本身的腳本", shared: /^分享到 /, stop: "停止分享" },
} as const;
const results: any = { browser: fx.browser.version(), cases: {} };
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, prefs: { "preview.optIn": true } as any });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await ctx.route(/^https:\/\/smoke-share-\d+\.trycloudflare\.com\//, async (route: any) => {
    const u = new URL(route.request().url());
    // The last share gone, the gateway and its tunnel are gone too: as Cloudflare would, a 502.
    const res: any = await new Promise((ok) => {
      // Sec-Fetch-Dest as the browser sent it (cloudflared passes it on): the page's frame is served only as a frame.
      const dest = route.request().headers()["sec-fetch-dest"] ?? (route.request().frame()?.parentFrame() ? "iframe" : "document");
      const r = request(new URL(u.pathname + u.search, gatewayOrigin), { method: route.request().method(), headers: { host: u.host, "sec-fetch-dest": dest } }, (m) => {
        const chunks: Buffer[] = []; m.on("data", (ch) => chunks.push(ch)); m.on("end", () => ok({ status: m.statusCode, headers: m.headers, body: Buffer.concat(chunks) }));
      }); r.on("error", () => ok({ status: 502, headers: { "content-type": "text/plain" }, body: Buffer.from("tunnel gone") })); r.end();
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    await route.fulfill({ status: res.status, headers, body: res.body });
  });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  const r: any = {};
  const before = channel.length;
  await page.waitForSelector(".msg.agent .html-card .pv-open");
  await page.click(".msg.agent .html-card .pv-open");
  await page.waitForSelector(".pv-panel .pv-fb-share", { timeout: 8000 });
  r.button = await page.getAttribute(".pv-panel .pv-fb-share", "title");
  r.buttonLabel = await page.textContent(".pv-panel .pv-fb-share .lbl");
  await page.click(".pv-panel .pv-fb-share");
  await page.waitForSelector(".ps .ps-runs");
  r.dialog = await page.evaluate(() => ({ what: document.querySelector(".ps-what")?.textContent, runs: document.querySelector(".ps-runs")?.textContent,
    all: (document.querySelector("dialog[open]") as HTMLElement | null)?.innerText ?? "" }));
  await page.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, "1-confirm") });
  await page.click(".ps-create");
  await page.waitForSelector(".ps-url", { timeout: 15000 });
  r.url = await page.inputValue(".ps-url");
  await page.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, "2-link") });
  // The link, as someone else would open it: another tab.
  const viewer = await ctx.newPage();
  await viewer.goto(r.url);
  await viewer.waitForTimeout(500);
  // The page runs as the wrapper's frame (#2917 review P1).
  const inner = viewer.frames().find((f: any) => f !== viewer.mainFrame());
  r.viewer = { title: await viewer.title(), framed: !!inner, probe: inner ? await inner.textContent("#o") : null };
  await viewer.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, "3-viewer") });
  await page.click("dialog[open] .dlg-actions button:last-child");
  await page.waitForSelector(".pv-panel .pv-fb-shared", { timeout: 8000 });
  r.sharedLabel = (await page.getAttribute(".pv-panel .pv-fb-shared", "title")) + " | " + (await page.textContent(".pv-panel .pv-fb-shared .lbl"));
  await page.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, "4-shared") });
  await page.click(".pv-panel .pv-fb-shared");
  await page.waitForSelector(".ps-stop");
  r.reopenedShowsUrl = !!(await page.$(".ps-url"));
  await page.click(".ps-stop");
  await page.waitForSelector(".pv-panel .pv-fb-share", { timeout: 8000 });
  const gone = await viewer.goto(r.url);
  r.ended = { status: gone.status(), body: (await viewer.textContent("body"))?.slice(0, 60) };
  await viewer.close();
  r.channel = channel.slice(before).map(([i, t]) => [i, t]);
  r.overflowX = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  r.csp = await csp(); r.errors = errors;
  const w = want[c.lang];
  const token = String(r.url).split("/p/")[1] ?? "";
  r.pass = r.buttonLabel === w.share && r.dialog.runs.includes(w.runs) && !/\bsafe\b/i.test(r.dialog.all)
    && /^https:\/\/smoke-share-\d+\.trycloudflare\.com\/p\/[A-Za-z0-9_-]{43}$/.test(r.url)
    && r.viewer.title === "Sales dashboard" && r.viewer.framed && /^ran · origin null · denied$/.test(r.viewer.probe)
    && w.shared.test(r.sharedLabel.split(" | ")[1]) && !r.reopenedShowsUrl && r.ended.status !== 200 && !/Q3 sales/.test(r.ended.body ?? "")
    && r.channel.length === 2 && r.channel.every(([i, t]: string[]) => i === name && !t.includes(token) && !t.includes("trycloudflare"))
    && r.overflowX <= 0 && !r.errors.length && !r.csp.length;
  results.cases[`${c.device}-${c.theme}-${c.lang}`] = r;
  await ctx.close();
}
console.log(JSON.stringify(results, null, 1));
const ok = Object.values(results.cases).every((r: any) => r.pass);
console.log(ok ? "PASS" : "FAIL");
await fm.officeSharesInstance.close();
await fx.close();
process.exit(ok ? 0 : 1);
