// M-3328 on the real app, with 150 ms of latency on every request (CDP), as M-3314's smoke (the fixed link: M-3316):
//   org first:  /ui, then the Fleet org chart (canvas, Live on, three open delegations) from an empty cache — the route
//               worker is asked for under the page's version, its ./fleet-route-scene.js and ./fleet-canvas-layout.js
//               are never asked for by their plain paths; libavoid's .wasm, its glue and the worker are asked for in one
//               wave; how long from opening the chart to every line routed.
//   office:     the Office view — its background picture under the version, public immutable.
//   panel CSS:  every stylesheet the page links later (Settings, the chat, the Hub, …) under the version (stale-tab.css
//               excepted: the prompt of a tab older than the server).
//   org again:  a reload on the org chart — the worker, libavoid, the picture and every stylesheet from the cache; how
//               long to every line routed.
//   update:     the server's version changes under the open tab; opening a panel then asks for nothing of the newer one.
//   no console error, no CSP violation (before the update).
// BEFORE=1 (a checkout without M-3328): the same steps, numbers only, no checks.
// Pictures per case in $OUT/smoke-asset-cache-m3328/.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [HP=19719] [BEFORE=1] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-asset-cache-m3328.mts
// ui-gate: {"name": "Org chart and panel CSS under the version", "hp": 19719}
import { writeFileSync } from "node:fs";
import { bootFixture, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-asset-cache-m3328";
const LATENCY = 150;
const BEFORE = process.env.BEFORE === "1";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49040), classic: false });
const fm = fx.fm as any;
const dir = fm.dataDir ?? fx.dir;
const wav = await import(`${process.env.REPO}/src/web-asset-version.ts`);
const r: any = { before: BEFORE, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: BEFORE || v, detail }; if (!v && !BEFORE) c.failed = [...(c.failed ?? []), k]; };

// ── A small fleet with three open delegations (as smoke-2182-org-routing) ──
const TEAMS: Record<string, string[]> = { "platform": ["infra-terraform", "ci-runner", "log-shipper"], "ota-svc": ["ota-builder", "ota-signer", "ota-canary"] };
const names = ["general", ...Object.values(TEAMS).flat(), "docs-site-builder", "release-notes-drafter"];
fm.fleetConfig.instances = Object.fromEntries(names.map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = Object.fromEntries(Object.entries(TEAMS).map(([t, members]) => [t, { members }]));
fm.getInstanceStatus = () => "running";
let seq = 0;
const row = (from: string, to: string, kind: string, corr: string, state: string) => ({
  deliveryId: `m3328-${from}-${to}-${corr}`, operationId: `op-${corr}`, sourceKey: "k", sourceInstance: from, sourceDaemonBootId: "b", targetInstance: to, targetSession: null, targetDaemonBootId: null,
  kind: "fleet_inbound", correlationId: corr, payload: { type: "fleet_inbound", content: "", meta: { request_kind: kind } }, state, attemptNo: 0, createdSeq: ++seq,
  managerBootId: null, responseDeliveredAt: null, nextAttemptAt: null, lastError: null, reconciliationPending: false });
const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
for (const [i, z] of ["ota-builder", "ota-canary", "release-notes-drafter"].entries()) {
  for (const s of ["queued", "delivering", "delivered"]) fm.publishTraffic(row("general", z, "task", `m3328-${i}`, s));
  fm.publishTraffic(row("general", z, "task", `m3328-${i}`, "delivered"), "consumed");
}

// ── Requests as CDP sees them ──
type Req = { path: string; t: number; cached: boolean; status: number; cc: string | null; type: string; worker: boolean };
const all: Req[] = [];
const byId = new Map<string, Req>();
function watch(cdp: any, worker = false) {
  cdp.on("Network.requestWillBeSent", (e: any) => { const row = { path: new URL(e.request.url).pathname, t: e.timestamp * 1000, cached: false, status: 0, cc: null, type: e.type ?? "", worker }; byId.set(e.requestId, row); all.push(row); });
  cdp.on("Network.requestServedFromCache", (e: any) => { const x = byId.get(e.requestId); if (x) x.cached = true; });
  cdp.on("Network.responseReceived", (e: any) => { const x = byId.get(e.requestId); if (!x) return; x.status = e.response.status; x.cc = e.response.headers["cache-control"] ?? e.response.headers["Cache-Control"] ?? null; if (e.response.fromDiskCache || e.response.fromPrefetchCache) x.cached = true; });
}
const mark = () => (all.length ? all[all.length - 1].t + 1 : 0);
const since = (t0: number) => all.filter(x => x.t >= t0);
const isRouter = (p: string) => /fleet-route-worker\.js$|fleet-route-scene\.js$|fleet-canvas-layout\.js$|libavoid\.(js|wasm)$/.test(p);
const waves = (rows: Array<{ t: number }>) => { const ts = rows.map(x => x.t).sort((a, b) => a - b); let n = 0, last = -Infinity; for (const t of ts) { if (t - last > LATENCY * 0.8) n++; last = t; } return n; };
const brief = (rows: Req[]) => rows.map(x => `${x.path.replace(/\/v-[0-9a-f]{12}\//, "/v-…/")}${x.worker ? " (worker)" : ""} ${x.cached ? "cache" : x.status}`);

async function clientNav(page: any, path: string) {
  await page.evaluate((p: string) => { const a = document.createElement("a"); a.href = p; document.body.appendChild(a); a.click(); a.remove(); }, path);
}
/** ms from now until every traffic line on the canvas is routed by the worker (null: not within the wait). */
async function untilRouted(page: any, ms = 20000): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => { const g = [...document.querySelectorAll(".oc-fl")]; return { n: g.length, routed: g.filter((x: any) => x.dataset.routed === "1").length }; });
    if (s.n > 0 && s.routed === s.n) return Date.now() - t0;
    await wait(50);
  }
  return null;
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
// What reached the server (the worker's own imports included, which the page's CDP session does not see).
const hits: Array<{ path: string; t: number }> = [];
(fm.healthServer as any).prependListener("request", (req: any) => { hits.push({ path: String(req.url ?? "").split("?")[0], t: Date.now() }); });
const hitsSince = (t: number) => hits.filter(h => h.t >= t);
watch(cdp);
const V = wav.assetVersion();
try {
  await page.evaluate(() => { localStorage.setItem("agend_org_mode", "canvas"); localStorage.setItem("agend_org_live", "1"); });
  await cdp.send("Network.clearBrowserCache");
  await page.goto(`${fx.base}/ui`);
  ok(res, "mounted", await mounted(page, 60000));
  await page.waitForTimeout(2500);

  // ── The org chart, first open (empty cache for everything it adds) ──
  const t1 = mark();
  const tNav = Date.now();
  await clientNav(page, "/ui/fleet/org");
  await page.waitForSelector(".oc-svg .oc-node", { timeout: 20000 });
  const routed1 = await untilRouted(page);
  r.org_first_ms_from_open = routed1 === null ? null : Date.now() - tNav;
  await page.waitForTimeout(1000);
  const first = since(t1).filter(x => isRouter(x.path));
  r.org_first_router_requests = brief(first);
  const worker = first.find(x => /fleet-route-worker\.js$/.test(x.path));
  ok(res, "org_first_routed", routed1 !== null, r.org_first_ms_from_open);
  ok(res, "worker_versioned", !!worker && worker.path === `/ui/js/v-${V}/fleet-route-worker.js`, worker?.path);
  ok(res, "worker_private_immutable", !!worker && worker.cc === "private, max-age=31536000, immutable", worker?.cc);
  r.org_first_server_router_hits = hitsSince(tNav).filter(h => isRouter(h.path)).map(h => h.path.replace(/\/v-[0-9a-f]{12}\//, "/v-…/"));
  const plainImports = hitsSince(tNav).filter(h => /^\/ui\/js\/(fleet-route-scene|fleet-canvas-layout)\.js$/.test(h.path)).map(h => h.path);
  ok(res, "worker_imports_not_plain", plainImports.length === 0, plainImports);
  // Each file's first request (the worker's own start comes later and is answered from the cache the warm-up filled).
  const trio = first.filter((x, i, a) => /fleet-route-worker\.js$|libavoid\.(js|wasm)$/.test(x.path) && a.findIndex(y => y.path === x.path) === i);
  ok(res, "worker_start_from_cache", hitsSince(tNav).filter(h => /fleet-route-worker\.js$/.test(h.path)).length === 1, hitsSince(tNav).filter(h => /fleet-route-worker\.js$/.test(h.path)).length);
  ok(res, "router_files_one_wave", trio.length >= 3 && waves(trio) === 1, { waves: waves(trio), files: brief(trio) });
  await page.screenshot({ path: shotPath(SMOKE, c as any, "org-first") });

  // ── The Office view: its picture under the version ──
  const t2 = mark();
  await page.evaluate(() => localStorage.setItem("agend_org_mode", "office"));
  await clientNav(page, "/ui/fleet");
  await page.waitForTimeout(800);
  await clientNav(page, "/ui/fleet/org");
  await page.waitForTimeout(4000);
  const pics = since(t2).filter(x => /\/assets\/(v-[0-9a-f]{12}\/)?office-[a-z]+\.png$/.test(x.path));
  r.office_pictures = brief(pics);
  ok(res, "office_picture_versioned", pics.length > 0 && pics.every(x => x.path.includes(`/assets/v-${V}/`) && x.cc === "public, max-age=31536000, immutable"), brief(pics));
  await page.screenshot({ path: shotPath(SMOKE, c as any, "office") });

  // ── Panels that link their own stylesheets ──
  // (Not the task board: the fixture has none, its read is a 503.)
  for (const p of ["/settings", "/ui/needs", "/ui/hub"]) { await clientNav(page, p); await page.waitForTimeout(2500); }
  const css = all.filter(x => /^\/assets\/(v-[0-9a-f]{12}\/)?[a-z0-9-]+\.css$/.test(x.path));
  const plainCss = [...new Set(css.filter(x => !x.path.includes(`/v-${V}/`) && !/\/stale-tab\.css$/.test(x.path)).map(x => x.path))];
  r.css_seen = [...new Set(css.map(x => x.path.replace(/\/v-[0-9a-f]{12}\//, "/v-…/")))];
  ok(res, "panel_css_versioned", css.length > 0 && plainCss.length === 0, plainCss);

  // ── The org chart again: a reload on it ──
  await page.evaluate(() => localStorage.setItem("agend_org_mode", "canvas"));
  const t3 = mark();
  const tNav2 = Date.now();
  await page.goto(`${fx.base}/ui/fleet/org`);
  ok(res, "reload_mounted", await mounted(page, 60000));
  await page.waitForSelector(".oc-svg .oc-node", { timeout: 20000 });
  const routed2 = await untilRouted(page);
  r.org_again_ms_from_open = routed2 === null ? null : Date.now() - tNav2;
  await page.waitForTimeout(1000);
  const again = since(t3).filter(x => isRouter(x.path) || /\.css$|office-[a-z]+\.png$/.test(x.path));
  r.org_again_cached = again.filter(x => x.cached).length;
  const network = hitsSince(tNav2).filter(h => isRouter(h.path) || /\.(css|png|js)$/.test(h.path));
  r.org_again_server_hits = network.map(h => h.path.replace(/\/v-[0-9a-f]{12}\//, "/v-…/"));
  ok(res, "org_again_routed", routed2 !== null, r.org_again_ms_from_open);
  ok(res, "org_again_router_css_pictures_cached", network.filter(h => isRouter(h.path) || /\.css$|office-[a-z]+\.png$/.test(h.path)).length === 0, r.org_again_server_hits);
  await page.screenshot({ path: shotPath(SMOKE, c as any, "org-again") });

  // The fixture has no task board: the Office's read of it is a 503 (on the base too) — those, and only those, aside.
  const bad = all.filter(x => x.status >= 400);
  r.bad_responses = brief(bad);
  const fixture503 = bad.filter(x => x.status === 503 && x.path === "/ui/tasks/board").length;
  const own = errors.filter(e => !/status of 503/.test(e)).concat(errors.filter(e => /status of 503/.test(e)).slice(fixture503));
  ok(res, "no_console_errors", own.length === 0, own.slice(0, 5));
  const csp = await page.evaluate("window.__csp || []") as string[];
  ok(res, "no_csp_violations", csp.length === 0, csp.slice(0, 5));

  // ── An update under the open tab: nothing of the newer version reaches it ──
  wav.resetAssetVersion("feedfacefeed");
  const t4 = mark();
  for (const p of ["/settings", "/ui/hub"]) { await clientNav(page, p); await page.waitForTimeout(2500); }
  const newer = since(t4).filter(x => x.path.includes("/v-feedfacefeed/")).map(x => x.path);
  ok(res, "update_no_newer_file_in_old_tab", newer.length === 0, newer);
} catch (e) {
  res.failed = [...(res.failed ?? []), `threw: ${String(e).slice(0, 300)}`];
} finally {
  wav.resetAssetVersion();
}

const failed = Object.entries(r.cases).filter(([, v]: any) => v.failed?.length);
writeFileSync(`${process.env.OUT ?? "."}/${SMOKE}${BEFORE ? "-before" : ""}.json`, JSON.stringify(r, null, 2));
console.log(JSON.stringify(r, null, 2));
await fx.close();
process.exit(failed.length ? 1 : 0);
