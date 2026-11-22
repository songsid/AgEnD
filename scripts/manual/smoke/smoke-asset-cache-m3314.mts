// M-3314 on the real app, with 150 ms of latency on every request (CDP), as the fixed link measured in M-3312:
//   load:   /ui boots with no console error and no CSP violation; every module the page asks for is versioned
//           (/assets/v-<V>/, /ui/js/v-<V>/) and asked for once; its modules arrive in ≤ 3 waves (≈14 before).
//   later:  Settings and the Fleet org chart, opened from the page, arrive in ≤ 3 waves each; the org chart opened
//           directly from an empty cache too.
//   reload: no module goes to the network again (all from the browser's cache).
//   update: the server's version changes under the open tab; opening a panel it has not loaded shows the stale-tab
//           prompt (Reload), never a newer module; after Reload the page boots on the new version.
// Pictures per case in $OUT/smoke-asset-cache-m3314/.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [HP=19709] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-asset-cache-m3314.mts
// ui-gate: {"name": "Asset cache and module preload", "hp": 19709}
import { writeFileSync } from "node:fs";
import { bootFixture, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-asset-cache-m3314";
const LATENCY = 150;
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49030), instances: 6, classic: false });
const wav = await import(`${process.env.REPO}/src/web-asset-version.ts`);
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const MODULE = /^\/(assets|ui\/js)\/(?:v-[0-9a-f]{12}\/)?[a-z0-9._-]+\.js$/;

/** Script requests seen by CDP: url (path), when asked (ms), whether it went to the network. */
function track(cdp: any) {
  const reqs = new Map<string, { path: string; t: number; cached: boolean }>();
  const all: Array<{ path: string; t: number; cached: boolean; id: string }> = [];
  cdp.on("Network.requestWillBeSent", (e: any) => {
    const u = new URL(e.request.url); const row = { path: u.pathname, t: e.timestamp * 1000, cached: false, id: e.requestId };
    reqs.set(e.requestId, row); all.push(row);
  });
  cdp.on("Network.requestServedFromCache", (e: any) => { const x = reqs.get(e.requestId); if (x) x.cached = true; });
  cdp.on("Network.responseReceived", (e: any) => { const x = reqs.get(e.requestId); if (x && (e.response.fromDiskCache || e.response.fromPrefetchCache)) x.cached = true; });
  return { all, since: (t0: number) => all.filter(x => x.t >= t0 && MODULE.test(x.path)) };
}
/** Requests asked for in groups: a gap longer than most of a round trip starts a new wave. */
function waves(rows: Array<{ t: number }>): number {
  const ts = rows.map(x => x.t).sort((a, b) => a - b);
  let n = 0, last = -Infinity;
  for (const t of ts) { if (t - last > LATENCY * 0.8) n++; last = t; }
  return n;
}
async function clientNav(page: any, path: string) {
  await page.evaluate((p: string) => { const a = document.createElement("a"); a.href = p; document.body.appendChild(a); a.click(); a.remove(); }, path);
}

const c = { device: "desk", theme: "light", lang: "en" } as const;
const res: any = (r.cases.desk = {});
const { page } = await fx.page(c as any);
const errors: string[] = [];
page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
const net = track(cdp);
const V = wav.assetVersion();
try {
  // Load (a fresh cache: the sign-in page loaded none of the app's modules).
  await cdp.send("Network.clearBrowserCache");
  const t0 = net.all.length ? net.all[net.all.length - 1].t + 1 : 0;
  await page.goto(`${fx.base}/ui`);
  ok(res, "mounted", await mounted(page, 60000));
  await page.waitForTimeout(3000);
  const load = net.since(t0);
  const plain = load.filter(x => !/\/v-[0-9a-f]{12}\//.test(x.path)).map(x => x.path);
  const dup = [...new Set(load.map(x => x.path).filter((p, i, a) => a.indexOf(p) !== i))];
  ok(res, "load_all_versioned", plain.length === 0, plain.slice(0, 10));
  ok(res, "load_each_once", dup.length === 0, dup.slice(0, 10));
  ok(res, "load_versioned_V", load.every(x => x.path.includes(`/v-${V}/`)), V);
  const w = waves(load);
  ok(res, "load_waves_le_3", w <= 3, { waves: w, modules: load.length });
  await page.screenshot({ path: shotPath(SMOKE, c as any, "load") });

  for (const [name, path] of [["settings", "/settings"], ["org", "/ui/fleet/org"]] as const) {
    const t1 = net.all.length ? net.all[net.all.length - 1].t + 1 : 0;
    await clientNav(page, path);
    await page.waitForTimeout(4000);
    const rows = net.since(t1);
    ok(res, `${name}_waves_le_3`, rows.length === 0 || waves(rows) <= 3, { waves: waves(rows), modules: rows.length });
    ok(res, `${name}_all_versioned`, rows.every(x => x.path.includes(`/v-${V}/`)), rows.filter(x => !x.path.includes(`/v-${V}/`)).map(x => x.path).slice(0, 5));
    await page.screenshot({ path: shotPath(SMOKE, c as any, name) });
  }

  // Reload: the modules come from the cache.
  const t2 = net.all.length ? net.all[net.all.length - 1].t + 1 : 0;
  await page.goto(`${fx.base}/ui`);
  ok(res, "reload_mounted", await mounted(page, 60000));
  await page.waitForTimeout(2500);
  const again = net.since(t2);
  const network = again.filter(x => !x.cached).map(x => x.path);
  ok(res, "reload_modules_from_cache", again.length > 0 && network.length === 0, { modules: again.length, network: network.slice(0, 10) });

  // The org chart opened directly, from an empty cache (from Settings it needs nothing new: Settings imports the Fleet panel).
  await cdp.send("Network.clearBrowserCache");
  const t3 = net.all.length ? net.all[net.all.length - 1].t + 1 : 0;
  await page.goto(`${fx.base}/ui/fleet/org`);
  ok(res, "org_direct_mounted", await mounted(page, 60000));
  await page.waitForTimeout(3000);
  const org = net.since(t3);
  ok(res, "org_direct_waves_le_3", org.length > 0 && waves(org) <= 3, { waves: waves(org), modules: org.length });
  await page.screenshot({ path: shotPath(SMOKE, c as any, "org-direct") });

  ok(res, "no_console_errors", errors.length === 0, errors.slice(0, 5));
  const csp = await page.evaluate("window.__csp || []") as string[];
  ok(res, "no_csp_violations", csp.length === 0, csp.slice(0, 5));

  // An update under the open tab: a new <V>; a panel not loaded yet asks for the old one and gets the stale-tab prompt.
  errors.length = 0;
  wav.resetAssetVersion("feedfacefeed");
  // Needs you: a panel /ui neither imports nor preloads (the workspace's Log and Details are loaded at boot already).
  await clientNav(page, "/ui/needs");
  const prompt = await page.waitForSelector("[data-stale-tab]", { timeout: 15000 }).then(() => true, () => false);
  ok(res, "update_stale_prompt", prompt);
  await page.screenshot({ path: shotPath(SMOKE, c as any, "update-stale") });
  const newer = net.all.filter(x => x.path.includes("/v-feedfacefeed/")).length;
  ok(res, "update_no_newer_module_in_old_tab", newer === 0, newer);
  await page.locator("[data-stale-tab] button").click();
  await page.waitForLoadState("load");
  ok(res, "update_reload_mounted", await mounted(page, 60000));
  await page.waitForTimeout(2000);
  const shell = await page.content();
  ok(res, "update_reload_new_version", shell.includes("/assets/v-feedfacefeed/app.js"));
} catch (e) {
  res.failed = [...(res.failed ?? []), `threw: ${String(e).slice(0, 300)}`];
} finally {
  wav.resetAssetVersion();
}

const failed = Object.entries(r.cases).filter(([, v]: any) => v.failed?.length);
writeFileSync(`${process.env.OUT ?? "."}/${SMOKE}.json`, JSON.stringify(r, null, 2));
console.log(JSON.stringify(r, null, 2));
await fx.close();
process.exit(failed.length ? 1 : 0);
