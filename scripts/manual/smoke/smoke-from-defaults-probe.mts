// The from-defaults harness itself (fleet decision a78ebdc5). Each case is a fresh profile signed in through the
// visible /signin as its own synthetic account, its page errors collected from before the first navigation:
// - loopback (desk light): on http://127.0.0.1, a secure context;
// - LAN (phone dark, reduced motion): on http://dashboard.lan.example — the browser's own origin, not a secure context;
// - the public link (phone light): on https://demo-smoke-link.trycloudflare.com, the page knows it is one;
// - the operator (desk light): an owner-less code, the explicit `agend web` case.
// Each must mount the app (a visible navigation with a control — not the empty #app the page ships with), with no
// error, nothing seeded, its session bound to its account. Negative controls, which must be caught: a boot that throws,
// a boot that never mounts (the empty #app kept), and a person whose prefs were already written (refused).
// Saves a screenshot of each.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-from-defaults-probe.mts
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-from-defaults-probe";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48410) });
const fm = fx.fm;
// Demo names only in what is shot (the fixture's first instances are a real fleet's).
const DEMO = new Set(["observability-dashboards", "billing-reconciliation", "search-indexer", "資料清洗與報表自動化助理"]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];

const look = (p: FreshPage) => p.page.evaluate(`(() => ({ origin: location.origin, hostname: location.hostname, secure: window.isSecureContext,
  publicLink: document.body.dataset.publicLink === "1", seeded: Object.keys(localStorage).filter((k) => /^agend_(tour_done|firstrun_dismissed)$/.test(k)) }))()`);
const bound = (p: FreshPage) => p.account
  ? fm.webSessions.list(undefined, (r: any) => r.owner?.adapterId === p.account!.adapterId && r.owner?.userId === p.account!.userId).length === 1
  : fm.webSessions.list(undefined, (r: any) => !r.owner && r.tier === "admin").length >= 1;

const results: any[] = [];
async function check(name: string, open: () => Promise<FreshPage>, want: { hostname: string; secure: boolean; publicLink: boolean }) {
  const p = await open();
  const isMounted = await mounted(p.page);
  await p.page.screenshot({ path: shotPath(SMOKE, name, "landing") });
  const seen = await look(p);
  const r = { name, ...seen, mounted: isMounted, bound: bound(p), personKey: p.personKey, errors: [...p.errors], expectedBeforeSignIn: p.expected.length };
  r.ok = r.mounted && r.bound && !r.errors.length && !r.seeded.length && r.hostname === want.hostname && r.secure === want.secure && r.publicLink === want.publicLink;
  results.push(r);
  await p.ctx.close();
  return p;
}

const loop = await check("loopback-desk-light", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }), { hostname: "127.0.0.1", secure: true, publicLink: false });
await check("lan-phone-dark-reduced", () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, { origin: "lan", reducedMotion: true }), { hostname: "dashboard.lan.example", secure: false, publicLink: false });
await check("operator-desk-light", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }, { account: "operator" }), { hostname: "127.0.0.1", secure: true, publicLink: false });
const link = await openPublicLink(fx);
await check("public-phone-light", () => link.publicPage({ device: "phone", theme: "light", lang: "en" }, { reducedMotion: true }), { hostname: link.host, secure: true, publicLink: true });
const noticed = link.notices.length === 1;
await link.close();

// Negative controls — each must be caught.
const controls: any[] = [];
async function fault(name: string, body: string) {
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" }, {
    beforeNavigate: (ctx: any) => ctx.route("**/assets/app.js", (route: any) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body })),
  });
  const isMounted = await mounted(p.page, 4000);
  const caught = !isMounted || p.errors.length > 0;
  controls.push({ name, mounted: isMounted, errors: p.errors.length, caught });
  await p.ctx.close();
}
await fault("boot-throws", 'throw new Error("injected boot failure");');
await fault("no-mount", "export {};");
// A person whose prefs were already written is not a default state: refused, never cleaned.
fm.webPrefs.write(loop.personKey, new Map<string, unknown>([["theme", "dark"]]));
let refused = false;
try { await freshPage(fx, { device: "desk", theme: "light", lang: "en" }, { account: loop.account! }); } catch (e) { refused = /already has prefs/.test(String(e)); }
controls.push({ name: "polluted-person-refused", caught: refused });
// …and the next default case is its own person, untouched by the one before.
const next = await freshPage(fx, { device: "desk", theme: "light", lang: "en" });
const own = next.personKey !== loop.personKey && Object.keys(fm.webPrefs.read(next.personKey).values ?? {}).length === 0;
controls.push({ name: "next-case-own-person", caught: own });
await next.ctx.close();

console.log(JSON.stringify({ results, noticed, controls }, null, 1));
const bad = [...results.filter((r) => !r.ok).map((r) => r.name), ...(noticed ? [] : ["public-notice"]), ...controls.filter((c) => !c.caught).map((c) => c.name)];
console.log(bad.length ? `FAIL ${bad.join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);
