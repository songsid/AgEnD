// #2122 Fleet → Usage from defaults (fleet decision a78ebdc5; design §7). Each case a fresh profile, nothing seeded in
// the browser, signed in through the visible /signin, driven through visible UI only. What the product reads is real:
// Claude Code transcripts and a Codex rollout in their real shapes (4 requests a Claude copy: its sidechain turn is not counted) (tests/fixtures/cache-1468, copied onto recent days),
// in a scratch CLAUDE_CONFIG_DIR / CODEX_HOME — never the host's. One instance's rollup carries an older day, so the
// heatmap has days that were never collected beside days read with nothing used.
// - empty (desk light en): before any transcript, Fleet → Usage → All: "Nothing recorded yet" and where usage comes from.
// - desk (desk light en): the ranked rows and their numbers against the fixture's known totals (5 requests a copy); the
//   basis line; Codex's "cache writes not reported"; "not priced" for an unknown model; every backend AgEnD can't
//   measure listed with its reason; group by backend; All: the heatmap's not-collected and idle days; the CSV download
//   (header, the basis column, the same rows).
// - phone (phone dark zh-TW, LAN origin, reduced motion): the tab bar's Fleet, then the ◔ dialog's "依 agent →"; rows as cards; no
//   horizontal overflow.
// - public (phone light en): the public link without the key: "Not offered over the public link", why, and a link to
//   this computer's Settings → Web dashboard (shot); following it — sign in there, tick "Usage report over the public
//   link", Save (at once) — and back on the public link: the rows. Only the usage read's own 403 is an accepted error.
// Every page logs no error. Guests are covered by the unit tests (no Fleet route, no dialog link).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2122-usage.mts        (PW_ENGINE=webkit: the same in WebKit)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2122-usage";
const REPO = process.env.REPO!;
// What the product reads, in a scratch place (set before the fleet exists: its cache service reads them).
const SRC = mkdtempSync(join(tmpdir(), "smoke-2122-src-"));
process.env.CLAUDE_CONFIG_DIR = join(SRC, "claude");
process.env.CODEX_HOME = join(SRC, "codex");
const fx = await bootFixture({ port: Number(process.env.HP ?? 48610), instances: 14, classic: false });
const fm = fx.fm;
const { claudeProjectKey } = await import(REPO + "/src/backend/claude-code.ts");

// Demo instances: three Claude Code, one Codex, and one of each backend AgEnD can't measure. Each its own directory.
const byBackend = (b: string) => fx.instances.filter(i => i.backend === b).map(i => i.name);
const [A, B, C] = byBackend("claude-code"), [X] = byBackend("codex");
const UNMEASURED = ["kiro-cli", "grok", "opencode", "antigravity", "muse"].map(b => byBackend(b)[0]!).filter(Boolean);
const KEEP = new Set([A!, B!, C!, X!, ...UNMEASURED]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!KEEP.has(name)) delete fm.fleetConfig.instances[name];
for (const name of KEEP) { const wd = join(SRC, "wd", String([...KEEP].indexOf(name))); mkdirSync(wd, { recursive: true }); fm.fleetConfig.instances[name].working_directory = wd; }
const wdOf = (name: string) => fm.fleetConfig.instances[name].working_directory as string;

const failed: string[] = [];
// WebKit-only lines that are the engine's, never the dashboard's (as smoke-ambient, #2127) — accepted, but printed:
// its internal sheet for each <select> ("Refused to apply a stylesheet…", renders identically) and the viewport meta's
// interactive-widget key it doesn't know. A poll or stream a navigation cancels is accepted only around the smoke's own
// navigations, for those URLs (NAV_CANCELLED below); anywhere else it fails like any error.
const WEBKIT = process.env.PW_ENGINE === "webkit";
const KNOWN_WEBKIT = /Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'|Viewport argument key "interactive-widget" not recognized/;
// (WebKit prints the URL as "https: /host/…".)
const NAV_CANCELLED = /^(?:Unhandled Promise Rejection: TypeError: Load failed|Fetch API cannot load https?: ?\/\/?[^ /]+\/ui\/(?:poll|events)[^ ]* due to access control checks\.)$/;
const known: string[] = [];
/**
 * The errors, by index, that are a cancel inside one of the smoke's own navigation windows [from, to). By position, not
 * by text: the same line outside every window still fails.
 */
function cancelledIn(errors: string[], windows: Array<[number, number]>, webkit = WEBKIT): Set<number> {
  const out = new Set<number>();
  if (!webkit) return out;
  for (const [from, to] of windows) for (let i = from; i < Math.min(to, errors.length); i++) if (NAV_CANCELLED.test(errors[i]!)) out.add(i);
  return out;
}
{ // Control, every run: one poll cancel inside a window and the very same line outside it — only the one inside goes.
  const line = "Fetch API cannot load https: /demo.example/ui/poll?after= due to access control checks.";
  const kept = cancelledIn([line, "something else", line], [[0, 1]], true);
  if (!(kept.has(0) && !kept.has(2) && kept.size === 1)) throw new Error("cancelledIn: a line outside its window was accepted");
}
const pageErrors = (errors: string[]) => errors.filter(e => { if (WEBKIT && KNOWN_WEBKIT.test(e)) { known.push(e); return false; } return true; });
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed.push(what); };
const DAY = 86_400_000, now = Date.now();
const dayOf = (k: number) => new Date(now - k * DAY).toISOString().slice(0, 10);

// ── The sources, in their real shapes: each copy of the Claude transcript is 5 requests (msg_01 spans two lines). ──
const claudeLines = readFileSync(join(REPO, "tests/fixtures/cache-1468/claude-transcript.jsonl"), "utf8").trimEnd().split("\n");
function claudeCopy(daysAgo: number, tag: string, model?: string): string {
  return claudeLines.map(l => {
    const d = JSON.parse(l);
    if (d.timestamp) d.timestamp = `${dayOf(daysAgo)}T${d.timestamp.slice(11)}`;
    if (d.message?.id) d.message.id = `${d.message.id}_${tag}`;
    if (model && d.message?.model) d.message.model = model;
    return JSON.stringify(d);
  }).join("\n") + "\n";
}
function writeClaude(name: string, copies: Array<[number, string?]>) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", claudeProjectKey(wdOf(name)));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), copies.map(([k, model], i) => claudeCopy(k, `${i}`, model)).join(""));
}
function writeCodex(name: string, daysAgo: number) {
  const lines = readFileSync(join(REPO, "tests/fixtures/cache-1468/codex-rollout.jsonl"), "utf8").trimEnd().split("\n").map(l => {
    const d = JSON.parse(l);
    if (d.timestamp) d.timestamp = `${dayOf(daysAgo)}T${d.timestamp.slice(11)}`;
    if (d.payload?.cwd) d.payload.cwd = wdOf(name);
    return JSON.stringify(d);
  });
  const dir = join(process.env.CODEX_HOME!, "sessions", dayOf(daysAgo).replace(/-/g, "/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-${dayOf(daysAgo)}T09-00-00-smoke.jsonl`), lines.join("\n") + "\n");
}

async function open(c: Parameters<typeof freshPage>[1], opts: Parameters<typeof freshPage>[2] = {}): Promise<FreshPage> {
  const p = await freshPage(fx, c, opts);
  check(await mounted(p.page), `${c.device}: the app mounted`);
  return p;
}
async function toUsageFromFleet(page: any) {
  await page.click(".side-overview");                                          // the sidebar's Fleet overview
  await page.click('.p-fleet nav.seg a[href="/ui/fleet/usage"]');
  await page.waitForSelector(".us, .p-fleet .empty", { timeout: 10000 });
}
const text = (page: any, sel: string) => page.$eval(sel, (e: any) => e.textContent.trim()).catch(() => "");
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ── empty: nothing read yet. A joins the fleet after this case, so the product first reads A's rollup (with its older
// day) after it is written below — never a copy loaded before. ──
const configA = fm.fleetConfig.instances[A!];
delete fm.fleetConfig.instances[A!];
{
  const desk = { device: "desk", theme: "light", lang: "en" } as const;
  const p = await open(desk);
  await toUsageFromFleet(p.page);
  await p.page.click('.us-bar-top button:has-text("All")');
  await p.page.waitForSelector(".us .empty", { timeout: 10000 });
  const t = await text(p.page, ".us .empty");
  check(t.includes("Nothing recorded yet") && t.includes("Usage is read from Claude Code and Codex transcripts"), `empty: "${t}"`);
  check(!!(await text(p.page, ".us-basis")), "empty: the basis line is still there");
  await p.page.screenshot({ path: shotPath(SMOKE, desk, "empty"), fullPage: true });
  check(pageErrors(p.errors).length === 0, `empty: no page errors (${pageErrors(p.errors).join(" | ")})`);
  await p.ctx.close();
}
fm.fleetConfig.instances[A!] = configA;

// ── The sources appear: A on 4 days, B on 1, C with a model not in the price table, X a Codex rollout. A's rollup holds
// one older day (39 days ago), read only around it: the days between were never collected. ──
writeClaude(A!, [[0], [1], [2], [4]]);
writeClaude(B!, [[1]]);
writeClaude(C!, [[2, "made-up-model-9"], [3, "made-up-model-9"]]);           // day 3: used, only by an unpriced model
writeCodex(X!, 1);
{
  const dir = join(fm.getInstanceDir(A!)); mkdirSync(dir, { recursive: true });
  const old = now - 39 * DAY, oldDay = dayOf(39);
  writeFileSync(join(dir, "usage-days.json"), JSON.stringify({ v: 1, checkpoint: Math.floor(old / 3_600_000) * 3_600_000,
    rows: [{ date: oldDay, zone: fm.usageZone(), be: "claude-code", pf: "default", m: { "claude-opus-5-5|0": [5, 13, 40800, 0, 50400, 0, 350] } }],
    coverage: [[old - 3 * 3_600_000, old + 3 * 3_600_000]] }));
}
// The scan the page would start, until it has read every source (a rollout written within the index's 1 s listing
// cache is seen on the next pass, as in the product).
const readAll = async () => { const d = await fm.cacheServiceFor().usageData(); return [A, B, C, X].every(n => Object.keys(d.instances.find((i: any) => i.inst.name === n)?.ledger.hours ?? {}).length > 0); };
for (let k = 0; k < 30 && !(await readAll()); k++) { await fm.cacheServiceFor().kick(); await new Promise(r => setTimeout(r, 1200)); }
check(await readAll(), "setup: the product read every source");
if (process.env.DEBUG) {
  const { sharedRolloutIndex } = await import(REPO + "/src/rollout-index.ts");
  const root = join(process.env.CODEX_HOME!, "sessions");
  console.log("DEBUG rollouts", JSON.stringify(sharedRolloutIndex(root).list(true)));
  const d = await fm.cacheServiceFor().usageData();
  for (const i of d.instances) console.log("DEBUG", i.inst.name, i.inst.backend, i.status, Object.keys(i.ledger.hours).length, i.inst.workingDirectory);
}

// ── desk ──
{
  const desk = { device: "desk", theme: "light", lang: "en" } as const;
  const p = await open(desk);
  await toUsageFromFleet(p.page);
  await p.page.waitForSelector(".us-row", { timeout: 10000 });
  const rows = await p.page.$$eval(".us-row", (rs: any[]) => rs.map(r => ({
    name: r.querySelector(".us-name .mono").textContent, flags: r.querySelector(".us-flags")?.textContent ?? "",
    cells: Object.fromEntries([...r.querySelectorAll("td")].map((td: any) => [td.getAttribute("data-label"), td.textContent])) })));
  const row = (n: string) => rows.find((r: any) => r.name === n);
  check(rows.map((r: any) => r.name).slice(0, 2).join(",") === `${A},${B}`, `desk: ranked by API-equivalent: ${rows.map((r: any) => r.name).join(", ")}`);
  check(row(A)?.cells.Requests === "16" && row(B)?.cells.Requests === "4", `desk: requests are the fixture's (4 a copy — its sidechain turn is not counted: A 4×4, B 4): ${row(A)?.cells.Requests}, ${row(B)?.cells.Requests}`);
  check(row(A)?.cells.Input === "44" && row(B)?.cells.Input === "11", `desk: uncached input is the fixture's (A 4×11, B 11): ${row(A)?.cells.Input}, ${row(B)?.cells.Input}`);
  check(/^\$\d/.test(row(A)?.cells["API-equivalent"] ?? ""), `desk: A has an API-equivalent: ${row(A)?.cells["API-equivalent"]}`);
  check(row(C)?.cells["API-equivalent"] === "not priced" && row(C)?.flags.includes("not priced: made-up-model-9"), `desk: C not priced: ${row(C)?.cells["API-equivalent"]} / ${row(C)?.flags}`);
  check(!!row(X) && row(X).flags.includes("cache writes not reported (Codex) — an estimate") && row(X).cells["Cache write"] === "—", `desk: Codex's writes not reported: ${row(X)?.flags} / ${row(X)?.cells["Cache write"]}`);
  const basis = await text(p.page, ".us-basis");
  check(/^API-equivalent at list price \(checked \d{4}-\d{2}-\d{2}\) — not money spent\./.test(basis), `desk: basis: "${basis}"`);
  const rest = await p.page.$$eval(".us-rest .row-item", (li: any[]) => li.map(l => l.textContent));
  for (const name of UNMEASURED) check(rest.some((r: string) => r.startsWith(name)), `desk: ${name} not measured, with its reason`);
  check(rest.some((r: string) => r.includes("Kiro is credit-billed")) && rest.some((r: string) => r.includes("AgEnD can't read this CLI's usage yet")), "desk: the reasons in words");
  check(!rows.some((r: any) => UNMEASURED.includes(r.name)), "desk: never a $0 row for one");
  await p.page.screenshot({ path: shotPath(SMOKE, desk, "rows-7d"), fullPage: true });

  // Group by backend.
  await p.page.selectOption(".us-group select", "backend");
  await p.page.waitForFunction(() => document.querySelector(".us-table thead th")?.textContent === "Backend", null, { timeout: 10000 });
  const keys = await p.page.$$eval(".us-row .us-name .mono", (e: any[]) => e.map(x => x.textContent));
  check(keys.includes("claude-code") && keys.includes("codex"), `desk: by backend: ${keys.join(", ")}`);

  // All: the older day, the never-collected days between, and the idle days read since.
  await p.page.selectOption(".us-group select", "instance");
  await p.page.click('.us-bar-top button:has-text("All")');
  await p.page.waitForFunction(() => document.querySelectorAll(".us-h").length > 30, null, { timeout: 10000 });
  const heat = await p.page.$$eval(".us-h", (r: any[]) => r.map(x => [x.getAttribute("class"), x.querySelector("title").textContent]));
  const gaps = heat.filter(([c]: string[]) => c === "us-h gap"), idle = heat.filter(([c]: string[]) => c === "us-h idle");
  check(gaps.length >= 5 && gaps.every(([, t]: string[]) => t.endsWith(": not collected")), `desk: not-collected days: ${gaps.length}`);
  check(idle.length >= 1 && idle.every(([, t]: string[]) => t.endsWith(": read, nothing used")), `desk: idle days read: ${idle.length} (e.g. ${idle[0]?.[1]})`);
  check(heat.some(([c, t]: string[]) => c.startsWith("us-h l") && t.startsWith(dayOf(39))), "desk: the older day from the rollup is there");
  const day3 = heat.find(([, t]: string[]) => t.startsWith(dayOf(3)));
  check(!!day3 && day3[0].startsWith("us-h l") && day3[1].endsWith("tokens · not priced"), `desk: a day used only by an unpriced model is used, and says not priced: ${day3?.join(" / ")}`);
  const label = await p.page.$eval(".us-heatmap", (e: any) => e.getAttribute("aria-label"));
  check(/^\d+ days; \d+ with usage, \d+ not collected\.$/.test(label), `desk: heatmap described in text: "${label}"`);
  await p.page.screenshot({ path: shotPath(SMOKE, desk, "all-heatmap"), fullPage: true });
  // The panel scrolls inside its own box: the charts are shot as elements, scrolled into view.
  for (const [sel, nm] of [[".us-trend", "trend"], [".us-heat", "heatmap"]] as const) { const el = await p.page.$(sel); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: shotPath(SMOKE, desk, nm) }); }

  // The CSV: the same answer.
  const [download] = await Promise.all([p.page.waitForEvent("download"), p.page.click(".us-csv")]);
  const csv = readFileSync(await download.path(), "utf8");
  const lines = csv.trimEnd().split("\r\n");
  check(lines[0] === "date,zone,instance,backend,model,tier,profile,input,output,cache_read,cache_write_5m,cache_write_1h,cache_write,requests,messages,amount,basis,flags", "desk: CSV header");
  check(lines.slice(1).filter(l => l.includes(`,${A},claude-code,`)).every(l => l.includes(",API-equivalent at list price (checked ")), "desk: CSV token rows carry the basis");
  check(download.suggestedFilename() === `agend-usage-all-${dayOf(0)}.csv`, `desk: CSV name ${download.suggestedFilename()}`);
  const aRequests = lines.filter(l => l.split(",")[2] === A).reduce((n, l) => n + Number(l.split(",")[13] || 0), 0);
  check(aRequests === 21, `desk: CSV rows sum to A's requests over all (4×4 + the older day's 5): ${aRequests}`);
  check(await noOverflow(p.page), "desk: no horizontal overflow");
  check(pageErrors(p.errors).length === 0, `desk: no page errors (${pageErrors(p.errors).join(" | ")})`);
  await p.ctx.close();
}

// ── phone, dark, zh-TW, a LAN origin, reduced motion: from the ◔ dialog ──
{
  const phone = { device: "phone", theme: "dark", lang: "zh-TW" } as const;
  // WebKit has no host resolver rules (smoke-fixture): its phone case is on loopback; Chromium's is on a LAN origin.
  const p = await open(phone, { origin: process.env.PW_ENGINE === "webkit" ? "loopback" : "lan", reducedMotion: true });
  await p.page.click(".tabs a.tab:nth-of-type(3)");                              // the tab bar's Fleet
  await p.page.waitForSelector(".p-fleet .hd-usage", { timeout: 10000 });
  await p.page.click(".p-fleet .hd-usage");                                      // ◔ in Fleet's header
  await p.page.click(".u-by-agent");
  await p.page.waitForSelector(".us-row", { timeout: 10000 });
  check(p.page.url().endsWith("/ui/fleet/usage"), `phone: the dialog's link opened ${p.page.url()}`);
  check((await text(p.page, ".u-by-agent")) === "" , "phone: the dialog closed with the navigation");
  const basis = await text(p.page, ".us-basis");
  check(basis.startsWith("依牌價換算的 API 等值"), `phone: basis in zh-TW: "${basis}"`);
  const card = await p.page.$eval(".us-row", (r: any) => getComputedStyle(r).display);
  check(card === "block", `phone: rows are cards (${card})`);
  check(await noOverflow(p.page), "phone: no horizontal overflow");
  await p.page.screenshot({ path: shotPath(SMOKE, phone, "rows"), fullPage: true });
  await p.page.click('.us-bar-top button:has-text("全部")');                    // All: 40 days, wider than the phone
  await p.page.waitForFunction(() => document.querySelectorAll(".us-h").length > 30, null, { timeout: 10000 });
  check(await noOverflow(p.page), "phone: All — still no horizontal overflow");
  for (const [sel, nm] of [[".us-trend", "trend"], [".us-heat", "heatmap"]] as const) { const el = await p.page.$(sel); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: shotPath(SMOKE, phone, nm) }); }
  const scrolls = await p.page.$$eval(".us-scroll", (s: any[]) => s.map(x => x.scrollWidth > x.clientWidth));
  check(scrolls.some(Boolean), `phone: a chart wider than the screen scrolls inside its own box (${scrolls.join(",")})`);
  const atEnd = await p.page.$$eval(".us-scroll", (s: any[]) => s.filter(x => x.scrollWidth > x.clientWidth).every(x => x.scrollLeft + x.clientWidth >= x.scrollWidth - 2));
  check(atEnd, "phone: a scrolling chart opens at its latest days");
  check(pageErrors(p.errors).length === 0, `phone: no page errors (${pageErrors(p.errors).join(" | ")})`);
  await p.ctx.close();
}

// ── the public link: blocked by default, with the reason and the way to fix it — followed through the visible UI ──
// The person is on the computer running AgEnD (the link's address is this machine's own): the blocked page's link opens
// Settings → Web on the dashboard reached directly; signing in there, ticking the switch and applying it is all visible
// UI; back on the public link, the same page now shows the rows.
{
  const pub = { device: "phone", theme: "light", lang: "en" } as const;
  const link = await openPublicLink(fx);
  const p = await link.publicPage(pub, { path: "/ui/fleet/usage" });
  const publicUsage = p.page.url();
  // The fixture's own navigation (signed in at /ui, then to this page): a poll it cancels is that navigation's.
  const atArrival = p.errors.length;
  if (process.env.DEBUG) { p.page.on("pageerror", (e: any) => console.log("PAGEERR", p.page.url(), String(e?.stack ?? e).slice(0, 600))); p.page.on("framenavigated", (fr: any) => { if (fr === p.page.mainFrame()) console.log("NAV", fr.url()); }); }
  await p.page.waitForSelector(".p-fleet .empty", { timeout: 10000 });
  const title = await text(p.page, ".p-fleet .empty-title"), hint = await text(p.page, ".p-fleet .empty-hint");
  check(title === "Not offered over the public link", `public: blocked: "${title}"`);
  check(hint.startsWith("Usage is offered over the public link only when \"Usage report over the public link\" is on in Settings → Web dashboard"), `public: why, and where: "${hint}"`);
  const fixHref = await p.page.$eval(".us-fix", (a: any) => a.getAttribute("href")).catch(() => "");
  const port = new URL(fx.base).port;
  check(fixHref === `http://localhost:${port}/settings/web-dashboard`, `public: the fix link is this computer's Settings → Web dashboard: ${fixHref}`);
  await p.page.screenshot({ path: shotPath(SMOKE, pub, "public-blocked"), fullPage: true });
  // Follow it. The dashboard reached directly asks this browser to sign in there (its own origin), as it would.
  const beforeNav = p.errors.length;
  await p.page.click(".us-fix");
  await p.page.waitForSelector("#code", { timeout: 15000 });
  // WebKit: a fetch the public page had in flight is cancelled by this navigation ("Load failed"), only in this window.
  const windows: Array<[number, number]> = [[0, atArrival], [beforeNav, p.errors.length]];
  const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
  const code = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken), recipient: link.owner }).display;
  await p.page.fill("#code", code);
  await p.page.click("#go");
  await p.page.waitForURL(/\/(ui|settings)/, { timeout: 15000 });
  if (!p.page.url().endsWith("/settings/web-dashboard")) await p.page.click(`a[href="/settings/web-dashboard"]`).catch(async () => { await p.page.goto(fixHref); });
  await p.page.waitForSelector("#webUsagePublic", { timeout: 15000 });
  check(!(await p.page.$eval("#webUsagePublic", (e: any) => e.checked)), "public: Settings → Web dashboard shows the switch off (the default)");
  await p.page.check("#webUsagePublic");
  // #2347: an edit is unsaved at once; the bar's Save writes it.
  await p.page.click('.s-pending button:has-text("Save")');
  await p.page.waitForFunction(() => document.body.textContent?.includes("Applied") || document.body.textContent?.includes("applied"), null, { timeout: 15000 }).catch(() => {});
  for (let k = 0; k < 40 && fm.fleetConfig.web?.usage_report_on_public_link !== true; k++) await new Promise(r => setTimeout(r, 250));
  check(fm.fleetConfig.web?.usage_report_on_public_link === true, "public: the switch was applied from Settings → Web dashboard (at once, nothing to confirm)");
  await p.page.screenshot({ path: shotPath(SMOKE, pub, "public-fix-settings"), fullPage: true });
  // Back on the public link: the rows. (WebKit: leaving Settings cancels its own fetch in flight — "Load failed".)
  const beforeBack = p.errors.length;
  await p.page.goto(publicUsage);
  await p.page.waitForSelector(".us-row", { timeout: 15000 });
  windows.push([beforeBack, p.errors.length]);
  check((await p.page.$$(".us-row")).length >= 3, "public: after the fix, the rows");
  check(await noOverflow(p.page), "public: no horizontal overflow");
  await p.page.screenshot({ path: shotPath(SMOKE, pub, "public-on"), fullPage: true });
  // Only the expected refusals: the usage report's own 403 while the switch was off, and the dashboard reached directly
  // answering this browser's first visit there before it signed in (the page itself, and the sign-in page's
  // /auth/session — the same pair every fresh sign-in has). Anything else fails.
  const local = `http://localhost:${port}`;
  const navCancelled = cancelledIn(p.errors, windows);
  const unexpected = pageErrors(p.errors.filter((_, i) => !navCancelled.has(i))).filter(e => !((/status of 403/.test(e) && /\/ui\/usage-report\?/.test(e))
    || (/status of 401/.test(e) && (e.endsWith(`@ ${local}/settings/web-dashboard`) || e.endsWith(`@ ${local}/auth/session`)))));
  for (const i of navCancelled) known.push(p.errors[i]!);
  check(unexpected.length === 0, `public: no page errors besides the refused usage read (${unexpected.join(" | ")})`);
  await p.ctx.close();
  await link.close();
}

if (known.length) console.log(`WebKit's own lines, accepted (${known.length}):\n  ${[...new Set(known)].join("\n  ")}`);
console.log(`engine: ${WEBKIT ? "webkit" : "chromium"} ${fx.browser.version()}`);
await fx.close();
console.log(failed.length ? `\n${SMOKE}: ${failed.length} FAILED` : `\n${SMOKE}: PASS`);
process.exit(failed.length ? 1 : 0);
