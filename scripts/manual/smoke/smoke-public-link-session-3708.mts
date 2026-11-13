// #3708: Settings → Access & security → Sign-in, the public link's own session limits, in a real browser on a fixture fleet.
// Matrix: en / zh-TW × desk / phone × tunnel named (web.public_link.hostname set) / quick × mode fresh / stale-deps.
//   stale-deps — a tab that used Fleet or search before the upgrade already holds the OLD settings-strings.js, settings-layout.js,
//                settings-access-strings.js, settings-registry.js and search-dialog.js (BASE's bytes, served by route); the new
//                Settings page must still read every new word, because they are in settings-public-session-strings.js (a new URL).
// Per case: the section renders with its words (no raw key, no {0}); the ⓘ opens; a quick tunnel shows why longer values do not
// apply and the in-effect line says 30 min; a named one applies 240 min. On desk-en-named-fresh and desk-zh-TW-named-fresh: a shorter
// value saves at once (200, its own body), a longer one goes through the confirmation (202 pending_confirmation, its own body).
//   PW_DIR=<playwright-core dir> REPO=<checkout> OUT=<dir> [BASE=<ref>] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//     npx --prefix <checkout> tsx scripts/manual/smoke/smoke-public-link-session-3708.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-public-link-session-3708";
const REPO = process.env.REPO ?? process.cwd();
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
const BASE = process.env.BASE ?? "v2.4.0-alpha.1";
const head = git("rev-parse", "HEAD").trim(), dirty = git("status", "--porcelain").trim();
const STALE = ["settings-strings.js", "settings-layout.js", "settings-access-strings.js", "settings-registry.js", "search-dialog.js"];
const oldBody = (f: string) => git("show", `${BASE}:src/ui/${f}`);
const wordsOf = (code: string) => {
  const out: Record<string, Record<string, string>> = { en: {}, "zh-TW": {} };
  new Function("register", code.replace(/^import .*$/gm, ""))((ns: string, t: Record<string, Record<string, string>>) => { if (ns === "settings") for (const l of Object.keys(out)) Object.assign(out[l]!, t[l] ?? {}); });
  return out;
};
const W = wordsOf(readFileSync(join(REPO, "src/ui/settings-public-session-strings.js"), "utf8"));
const RAW_KEY = /\bsettings(?:Layout)?\.[A-Za-z][A-Za-z0-9_]*|\{\d+\}|\bundefined\b|\[object Object\]/;

const fx = await bootFixture({ port: Number(process.env.HP ?? 48963), classic: true, instances: 2 });
const fm = fx.fm as any;
const token = fm.getDashboardAccess().token as string;
const hostCode = async () => (await (await fetch(`${fx.base}/auth/issue-code`, { method: "POST", headers: { "x-agend-token": token, origin: fx.base } })).json()).code as string;
const file = join(fx.dir, "fleet.yaml"), original = readFileSync(file, "utf8");
const setTunnel = (named: boolean) => {
  const doc = yaml.load(original) as any;
  doc.web = { ...doc.web, public_link: { ...doc.web?.public_link, ...(named ? { hostname: "agend.example.com" } : {}) } };
  if (!named) delete doc.web.public_link.hostname;
  writeFileSync(file, yaml.dump(doc));
  fm.loadConfig(file);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Check = { ok: boolean; detail?: string };
const results: Array<{ name: string; ok: boolean; checks: Record<string, Check> }> = [];

for (const lang of ["en", "zh-TW"] as const) for (const dev of [{ device: "desk", width: 1366, height: 900 }, { device: "phone", width: 390, height: 844 }] as const)
for (const tunnel of ["named", "quick"] as const) for (const mode of ["fresh", "stale-deps"] as const) {
  const name = `${dev.device}-${lang}-${tunnel}-${mode}`, w = W[lang]!;
  if (process.env.CASES && !process.env.CASES.split(",").includes(name)) continue;
  const checks: Record<string, Check> = {};
  const check = (k: string, ok: boolean, detail?: string) => { checks[k] = { ok, ...(detail === undefined ? {} : { detail }) }; };
  setTunnel(tunnel === "named");
  fm.webPrefs.write("operator", new Map<string, unknown>([...Object.keys(fm.webPrefs.read("operator").values ?? {}).map(k => [k, null] as [string, null]), ["theme", "light"], ["lang", lang]]));
  const ctx = await fx.browser.newContext({ viewport: { width: dev.width, height: dev.height }, isMobile: dev.device === "phone", hasTouch: dev.device === "phone", locale: lang === "zh-TW" ? "zh-TW" : "en-US" });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); localStorage.setItem("agend_lang","${lang}"); } catch {}` });
  const page = await ctx.newPage(), errors: string[] = [], hits: Record<string, number> = {};
  const writes: Array<{ status: number; body: unknown; response: string }> = [];
  page.on("pageerror", (e: any) => errors.push(String(e)));
  page.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on("response", async (r: any) => {
    const q = r.request(), u = new URL(r.url());
    if (q.method() === "PUT" && u.pathname === "/api/settings/fleet/web") writes.push({ status: r.status(), body: JSON.parse(q.postData() ?? "null"), response: (await r.text().catch(() => "")).slice(0, 200) });
  });
  if (mode === "stale-deps") for (const f of STALE) {
    const url = `/ui/js/${f}`, body = oldBody(f); hits[url] = 0;
    await page.route(`**${url}*`, (r: any) => { hits[url]++; r.fulfill({ status: 200, contentType: "text/javascript", body }); });
  }
  const t = (sel: string) => page.locator(sel);
  try {
    // Sign in with a host code through the sign-in API (the sign-in page's one-box form changed on this line).
    await page.goto(`${fx.base}/signin`); await sleep(500);
    const code = await hostCode();
    await page.evaluate(async (c: string) => { await fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c }) }); }, code);
    await page.goto(`${fx.base}/ui`); await page.waitForSelector("body", { timeout: 15000 }); await sleep(800);
    // Search first (a tab that used it before Settings): loads settings-registry.js and the string files.
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".search-dlg .search-input", { timeout: 15000 });
    await page.fill(".search-dlg .search-input", lang === "en" ? "unused for, minutes" : "閒置後登出");
    await page.waitForSelector(".search-settings .search-row", { timeout: 10000 }).catch(() => null);
    const searchText = ((await t(".search-settings").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    check("search", !RAW_KEY.test(searchText) && (mode === "stale-deps" || searchText.includes(w.publicSessionIdle!)), searchText.slice(0, 160) || "no settings results");
    await page.keyboard.press("Escape");
    await t(".search-dlg").waitFor({ state: "detached", timeout: 3000 }).catch(() => page.keyboard.press("Escape"));
    await page.evaluate((path: string) => { history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")); }, "/settings/access");
    await page.waitForSelector(".p-settings [role=tab]", { timeout: 20000 });
    await t(".p-settings [role=tab]").nth(1).click();
    await page.waitForSelector("#webPublicSession", { timeout: 10000 });
    await sleep(400);
    if (mode === "stale-deps") check("stale-served", STALE.every(f => hits[`/ui/js/${f}`]! > 0), JSON.stringify(hits));
    const sec = t("#webPublicSession");
    const secText = ((await sec.innerText()) ?? "").replace(/\s+/g, " ");
    const labels = [await t("label[for=webPublicSessionAbsolute]").innerText(), await t("label[for=webPublicSessionIdle]").innerText()].map(s => s.trim());
    check("words", labels[0]!.startsWith(w.publicSessionAbsolute!) && labels[1]!.startsWith(w.publicSessionIdle!) && secText.includes(w.publicSessionTitle!) && secText.includes(w.publicSessionCeiling!)
      && !RAW_KEY.test(((await t(".p-settings").innerText()) ?? "")), `${labels.join(" | ")}; raw: ${RAW_KEY.exec((await t(".p-settings").innerText()) ?? "")?.[0] ?? "none"}`);
    check("quick-note", tunnel === "quick" ? (await t("#webPublicSessionQuick").count()) === 1 : (await t("#webPublicSessionQuick").count()) === 0, tunnel);
    await sec.scrollIntoViewIfNeeded();
    await page.screenshot({ path: shotPath(SMOKE, name, "section"), fullPage: false });
    // A longer idle value: on a named tunnel it applies as typed; on a quick one 30 min applies (quick tunnel).
    await t("#webPublicSessionIdle").fill("240"); await sleep(300);
    const effect = ((await t("#webPublicSessionIdle").locator("xpath=..").locator(".s-effect").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    const want = tunnel === "named" ? (lang === "en" ? "240 min" : "240 分鐘") : (lang === "en" ? "30 min" : "30 分鐘");
    // Named: the typed value applies as typed (no in-effect line, as the local fields); quick: 30 min, saying why.
    check("in-effect", tunnel === "named" ? effect === "" : effect.includes(want) && effect.includes(w.publicSessionQuick!), effect || "(no in-effect line: applies as typed)");
    await page.screenshot({ path: shotPath(SMOKE, name, "edited"), fullPage: false });
    // The ⓘ opens with the trade-off text.
    await sec.locator(".s-i .s-tipbtn").first().click();
    await sleep(300);
    const tip = ((await sec.locator(".s-i .s-tipbody").first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    check("tip", tip.includes(w.publicSessionTip!.slice(0, 40)), tip.slice(0, 80));
    await page.screenshot({ path: shotPath(SMOKE, name, "tip"), fullPage: false });
    await page.keyboard.press("Escape");
    if (dev.device === "desk" && tunnel === "named" && mode === "fresh") {
      // Longer → the confirmation path, its own body.
      await t(".s-pending .btn-primary").waitFor({ timeout: 5000 });
      let before = writes.length;
      await t(".s-pending .btn-primary").click();
      await page.waitForResponse((r: any) => r.request().method() === "PUT" && r.url().endsWith("/api/settings/fleet/web"), { timeout: 10000 }).catch(() => null);
      await sleep(1200);
      const w1 = writes.slice(before);
      check("longer-confirmed", w1.length === 1 && JSON.stringify(w1[0]!.body) === JSON.stringify({ session: { public_link: { idle_minutes: 240 } } }) && w1[0]!.status === 202 && /pending_confirmation/.test(w1[0]!.response), JSON.stringify(w1));
      await page.screenshot({ path: shotPath(SMOKE, name, "confirm"), fullPage: false });
      // Reload the page against the file as it now stands, then a shorter value: applied at once.
      await page.reload(); await page.waitForSelector(".p-settings [role=tab]", { timeout: 20000 }); await t(".p-settings [role=tab]").nth(1).click();
      await page.waitForSelector("#webPublicSessionIdle", { timeout: 10000 });
      const saved = await t("#webPublicSessionIdle").inputValue();
      await t("#webPublicSessionIdle").fill("15"); await sleep(300);
      await t(".s-pending .btn-primary").waitFor({ timeout: 5000 });
      before = writes.length;
      await t(".s-pending .btn-primary").click();
      await page.waitForResponse((r: any) => r.request().method() === "PUT" && r.url().endsWith("/api/settings/fleet/web"), { timeout: 10000 }).catch(() => null);
      await sleep(800);
      const w2 = writes.slice(before);
      const disk = readFileSync(file, "utf8");
      check("shorter-direct", w2.length === 1 && JSON.stringify(w2[0]!.body) === JSON.stringify({ session: { public_link: { idle_minutes: 15 } } }) && w2[0]!.status === 200 && /idle_minutes: 15/.test(disk),
        `${JSON.stringify(w2)}; field before ${saved}; fleet.yaml has idle_minutes: 15: ${/idle_minutes: 15/.test(disk)}`);
    }
    check("no-page-errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) { check("case-ran", false, String(e).slice(0, 400)); check("no-page-errors", errors.length === 0, errors.slice(0, 3).join(" | ")); }
  await ctx.close();
  results.push({ name, ok: Object.values(checks).every(c => c.ok), checks });
  console.log(`${results.at(-1)!.ok ? "✅" : "❌"} ${name} ${Object.entries(checks).map(([k, c]) => `${c.ok ? "✓" : "✗"}${k}`).join(" ")}`);
}
const keys = [...new Set(results.flatMap(r => Object.keys(r.checks)))];
const receipt = [`# ${SMOKE}`, ``, `- commit: ${head}${dirty ? " (DIRTY tree)" : " (clean)"}`, `- base for stale-deps: ${BASE} (${STALE.join(", ")})`, ``,
  `| case | ${keys.join(" | ")} |`, `|---|${keys.map(() => "---").join("|")}|`,
  ...results.map(r => `| ${r.ok ? "✅" : "❌"} ${r.name} | ${keys.map(k => (r.checks[k] ? (r.checks[k]!.ok ? "✓" : "✗") : "–")).join(" | ")} |`), ``,
  `## Failures`, ...(results.some(r => !r.ok) ? results.filter(r => !r.ok).flatMap(r => Object.entries(r.checks).filter(([, c]) => !c.ok).map(([k, c]) => `- ${r.name} / ${k}: ${c.detail ?? ""}`)) : ["none"]), ``].join("\n");
writeFileSync(join(OUT, "receipt.md"), receipt);
writeFileSync(join(OUT, "result.json"), JSON.stringify({ commit: head, clean: !dirty, base: BASE, results }, null, 2));
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
