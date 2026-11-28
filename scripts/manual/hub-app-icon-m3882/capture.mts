/**
 * M-3882 capture: what the browser gets as each installed app's identity, from the REAL handlers. One small server per
 * flavor runs web-icons.ts handleWebIconRequest (the dashboard's, and the Hub listener's "hub"), and a sheet loads each
 * origin's manifest name, favicon at 16 and 32 px and its 192 px app icon, side by side, on light and dark. (A headless
 * browser has no taskbar or install dialog to photograph; these are the exact bytes those surfaces draw.)
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/hub-app-icon-m3882/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const OUT = process.env.OUT!, REPO = process.env.REPO!; mkdirSync(OUT, { recursive: true });
const { handleWebIconRequest } = await import(join(REPO, "src", "web-icons.ts"));
const { chromium } = createRequire(join(process.env.PW_DIR!, "node_modules", "x.js"))("playwright-core");
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const serve = (flavor: "fleet" | "hub") => new Promise<{ server: Server; base: string }>((resolve) => {
  const server = createServer((req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); if (!handleWebIconRequest(req, res, new URL(req.url!, "http://x").pathname, flavor)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${(server.address() as any).port}` }));
});
const fleet = await serve("fleet"), hub = await serve("hub");
const names = { fleet: JSON.parse(await (await fetch(fleet.base + "/manifest.webmanifest")).text()).name, hub: JSON.parse(await (await fetch(hub.base + "/manifest.webmanifest")).text()).name };
check("the dashboard's manifest is AgEnD; the Hub's is AgEnD Hub", names.fleet === "AgEnD" && names.hub === "AgEnD Hub", names);
const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 900, height: 380 }, deviceScaleFactor: 2, colorScheme: theme });
    const bg = theme === "dark" ? "#212121" : "#ffffff", fg = theme === "dark" ? "#ececec" : "#0d0d0d", line = theme === "dark" ? "#3d3d3d" : "#e5e5e5";
    const col = (o: { base: string }, name: string) => `<div class="app"><h2>${name}</h2><div class="row"><span>16</span><img src="${o.base}/favicon.ico" width="16" height="16"><span>32</span><img src="${o.base}/favicon.ico" width="32" height="32"><span>192</span><img src="${o.base}/icon-192.png" width="192" height="192"></div><code>${o.base.replace(/:\d+$/, "")} · ${name === "AgEnD" ? "dashboard" : "Hub"}</code></div>`;
    await page.setContent(`<html><body style="margin:0;padding:20px;background:${bg};color:${fg};font:14px system-ui,sans-serif">
      <style>.wrap{display:flex;gap:24px}.app{border:1px solid ${line};border-radius:12px;padding:14px 16px;flex:1}.app h2{margin:0 0 10px;font-size:16px}.row{display:flex;align-items:center;gap:10px}.row span{opacity:.7;font-size:12px}code{display:block;margin-top:10px;font-size:11px;opacity:.7}</style>
      <div class="wrap">${col(fleet, names.fleet)}${col(hub, names.hub)}</div></body></html>`);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
    const loaded = await page.evaluate(() => [...document.images].map((i) => i.naturalWidth));
    check(`${theme}: every icon loaded from its own listener`, loaded.length === 6 && loaded.every((w) => w > 0), loaded);
    const shot = `m3882-${theme}-dashboard-vs-hub.png`;
    await page.screenshot({ path: join(OUT, shot) });
    receipt.pictures.push({ path: shot, sha256: createHash("sha256").update(readFileSync(join(OUT, shot))).digest("hex") });
    await page.close();
  }
} finally {
  await browser.close(); fleet.server.close(); hub.server.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length; receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(`checks ${receipt.summary}`); process.exitCode = failed ? 1 : 0;
}
