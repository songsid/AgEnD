// #3711 review (Prism P2): baseline-before (v2.4.0-alpha.1) and after (PR head) captures of Settings → Access & security → Sign-in,
// light + dark × en + zh-TW × desk + phone, named tunnel. Read-only: no saves. REPO=<checkout> LABEL=before|after OUT=<dir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const REPO = process.env.REPO!, LABEL = process.env.LABEL!, OUT = process.env.OUT!;
mkdirSync(OUT, { recursive: true });
const { bootFixture } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const yaml = (await import(join(REPO, "node_modules/js-yaml/index.js"))).default;
const head = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
const fx = await bootFixture({ port: Number(process.env.HP ?? 48971), classic: true, instances: 2 });
const fm = fx.fm as any, token = fm.getDashboardAccess().token as string;
const file = join(fx.dir, "fleet.yaml"), doc = yaml.load(readFileSync(file, "utf8")) as any;
doc.web = { ...doc.web, public_link: { ...doc.web?.public_link, hostname: "agend.example.com" } };
writeFileSync(file, yaml.dump(doc)); fm.loadConfig(file);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const shots: string[] = [];
for (const theme of ["light", "dark"] as const) for (const lang of ["en", "zh-TW"] as const) for (const dev of [{ d: "desk", w: 1366, h: 900 }, { d: "phone", w: 390, h: 844 }] as const) {
  fm.webPrefs.write("operator", new Map<string, unknown>([...Object.keys(fm.webPrefs.read("operator").values ?? {}).map(k => [k, null] as [string, null]), ["theme", theme], ["lang", lang]]));
  const ctx = await fx.browser.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: dev.d === "phone", hasTouch: dev.d === "phone", locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); localStorage.setItem("agend_lang","${lang}"); } catch {}` });
  const page = await ctx.newPage();
  await page.goto(`${fx.base}/signin`); await sleep(500);
  const code = (await (await fetch(`${fx.base}/auth/issue-code`, { method: "POST", headers: { "x-agend-token": token, origin: fx.base } })).json()).code;
  await page.evaluate(async (c: string) => { await fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c }) }); }, code);
  await page.goto(`${fx.base}/settings/access`); await page.waitForSelector(".p-settings [role=tab]", { timeout: 20000 });
  await page.locator(".p-settings [role=tab]").nth(1).click(); await page.waitForSelector("#webSessionAbsolute", { timeout: 10000 }); await sleep(600);
  const anchor = (await page.locator("#webPublicSession").count()) ? "#webPublicSession" : ".s-session-ceiling";
  await page.locator("#webSessionAbsolute").scrollIntoViewIfNeeded();
  await page.evaluate((sel: string) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), anchor);
  const name = `${LABEL}-${theme}-${lang}-${dev.d}.png`;
  await page.screenshot({ path: join(OUT, name) }); shots.push(name);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log(name, anchor, bg);
  await ctx.close();
}
writeFileSync(join(OUT, `${LABEL}-receipt.md`), `# ${LABEL}\n- source: ${head}${dirty ? " (DIRTY)" : " (clean)"}\n- fleet: named tunnel (web.public_link.hostname set), defaults otherwise\n- view: Settings → Access & security → Sign-in, scrolled to the public-link block (after) / the public-session note (before)\n${shots.map(s => `- ${s}`).join("\n")}\n`);
await fx.close(); process.exit(0);
