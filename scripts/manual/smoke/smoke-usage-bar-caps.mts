// #2136 follow-up: Fleet → Usage's per-row bar keeps round caps at every width. The bar was an SVG with a 100-wide
// viewBox stretched by preserveAspectRatio="none", so rx=3 became an ellipse — a pointed lens on the longest bar. From
// defaults (fleet decision a78ebdc5): a fresh profile, nothing seeded in the browser, signed in through the visible
// /signin, Fleet → Usage through visible UI. Real Claude Code transcripts in a scratch CLAUDE_CONFIG_DIR: A 20 copies
// (100%), B 19 (95%, near full), C 1 (5%).
// - desk (light en) and phone (dark zh-TW): every bar's rect is drawn at a uniform scale (its screen matrix scales x and
//   y alike, so rx stays a circle); the fill's width is its share of the track; element shots of the top rows' bars.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-usage-bar-caps.mts      (PW_ENGINE=webkit: the same in WebKit)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-usage-bar-caps";
const REPO = process.env.REPO!;
const SRC = mkdtempSync(join(tmpdir(), "smoke-barcap-src-"));
process.env.CLAUDE_CONFIG_DIR = join(SRC, "claude");
process.env.CODEX_HOME = join(SRC, "codex");
const fx = await bootFixture({ port: Number(process.env.HP ?? 48630), instances: 14, classic: false });
const fm = fx.fm;
const { claudeProjectKey } = await import(REPO + "/src/backend/claude-code.ts");

const [A, B, C] = fx.instances.filter(i => i.backend === "claude-code").map(i => i.name);
const KEEP = [A!, B!, C!];
for (const name of Object.keys(fm.fleetConfig.instances)) if (!KEEP.includes(name)) delete fm.fleetConfig.instances[name];
for (const name of KEEP) { const wd = join(SRC, "wd", String(KEEP.indexOf(name))); mkdirSync(wd, { recursive: true }); fm.fleetConfig.instances[name].working_directory = wd; }

const failed: string[] = [];
const WEBKIT = process.env.PW_ENGINE === "webkit";
// WebKit's own lines (as smoke-2122-usage): its internal <select> sheet and the viewport meta's interactive-widget key.
const KNOWN_WEBKIT = /Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'|Viewport argument key "interactive-widget" not recognized/;
const pageErrors = (errors: string[]) => errors.filter(e => !(WEBKIT && KNOWN_WEBKIT.test(e)));
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed.push(what); };
const DAY = 86_400_000, now = Date.now();
const dayOf = (k: number) => new Date(now - k * DAY).toISOString().slice(0, 10);

const claudeLines = readFileSync(join(REPO, "tests/fixtures/cache-1468/claude-transcript.jsonl"), "utf8").trimEnd().split("\n");
function claudeCopy(daysAgo: number, tag: string): string {
  return claudeLines.map(l => {
    const d = JSON.parse(l);
    if (d.timestamp) d.timestamp = `${dayOf(daysAgo)}T${d.timestamp.slice(11)}`;
    if (d.message?.id) d.message.id = `${d.message.id}_${tag}`;
    return JSON.stringify(d);
  }).join("\n") + "\n";
}
function writeClaude(name: string, copies: number) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", claudeProjectKey(fm.fleetConfig.instances[name].working_directory));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), Array.from({ length: copies }, (_, i) => claudeCopy(i % 6, `${i}`)).join(""));
}
writeClaude(A!, 20); writeClaude(B!, 19); writeClaude(C!, 1);
const readAll = async () => { const d = await fm.cacheServiceFor().usageData(); return KEEP.every(n => Object.keys(d.instances.find((i: any) => i.inst.name === n)?.ledger.hours ?? {}).length > 0); };
for (let k = 0; k < 30 && !(await readAll()); k++) { await fm.cacheServiceFor().kick(); await new Promise(r => setTimeout(r, 1200)); }
check(await readAll(), "setup: the product read every source");

/** Each row's bar as drawn: the fill's screen matrix (x and y scale), its width against the track's. */
const bars = (page: any) => page.$$eval(".us-row", (rs: any[]) => rs.map(r => {
  const fg = r.querySelector(".us-bar-fg"), bg = r.querySelector(".us-bar-bg"), m = fg.getScreenCTM();
  const fw = fg.getBoundingClientRect().width, bw = bg.getBoundingClientRect().width;
  return { name: r.querySelector(".us-name .mono").textContent, sx: m.a, sy: m.d, skew: Math.abs(m.b) + Math.abs(m.c), fw, bw, share: fw / bw };
}));

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const p = await freshPage(fx, c, WEBKIT || c.device === "desk" ? {} : { origin: "lan" });
  check(await mounted(p.page), `${c.device}: the app mounted`);
  if (c.device === "desk") await p.page.click(".side-overview");
  else await p.page.click(".tabs a.tab:nth-of-type(3)");                      // the tab bar's Fleet
  await p.page.click('.p-fleet nav.seg a[href="/ui/fleet/usage"]');
  await p.page.waitForSelector(".us-row", { timeout: 10000 });
  const got = await bars(p.page);
  const row = (n: string) => got.find((b: any) => b.name === n);
  check(got.map((b: any) => b.name).join(",") === `${A},${B},${C}`, `${c.device}: ranked A, B, C: ${got.map((b: any) => b.name).join(", ")}`);
  for (const b of got) check(Math.abs(b.sx - b.sy) < 1e-6 && b.skew === 0, `${c.device}: ${b.name}'s bar is drawn at a uniform scale — round caps (x ${b.sx.toFixed(3)}, y ${b.sy.toFixed(3)})`);
  check(Math.abs(row(A!)!.share - 1) < 0.005 && row(A!)!.bw > 100, `${c.device}: A's bar is full (${row(A!)!.fw.toFixed(1)} of ${row(A!)!.bw.toFixed(1)}px)`);
  check(Math.abs(row(B!)!.share - 0.95) < 0.006, `${c.device}: B's bar is near full, 95% (${(row(B!)!.share * 100).toFixed(1)}%)`);
  check(Math.abs(row(C!)!.share - 0.05) < 0.006, `${c.device}: C's bar is 5% (${(row(C!)!.share * 100).toFixed(1)}%)`);
  // Each bar with 8px around it, so both caps are in the shot (the row's own box ends exactly at the track's end).
  const barEls = await p.page.$$(".us-row .us-bar");
  for (const [i, nm] of [[0, "bar-100"], [1, "bar-95"]] as const) {
    await barEls[i]!.scrollIntoViewIfNeeded();
    const r = (await barEls[i]!.boundingBox())!;
    await p.page.screenshot({ path: shotPath(SMOKE, c, nm), clip: { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 } });
  }
  await p.page.screenshot({ path: shotPath(SMOKE, c, "rows"), fullPage: true });
  check(pageErrors(p.errors).length === 0, `${c.device}: no page errors (${pageErrors(p.errors).join(" | ")})`);
  await p.ctx.close();
}

console.log(`engine: ${WEBKIT ? "webkit" : "chromium"} ${fx.browser.version()}`);
await fx.close();
console.log(failed.length ? `\n${SMOKE}: ${failed.length} FAILED` : `\n${SMOKE}: PASS`);
process.exit(failed.length ? 1 : 0);
