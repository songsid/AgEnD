// alpha.6 feedback (#1): the Hub's signed-out page, in a real browser on a REAL Hub web listener (createHubHttp's
// handle() behind node:https on 127.0.0.1, the agreed S5 fakes from tests/helpers/hub-s3b-rig.ts, a fake directory). No
// fleet runs.
// - signed out, /ui/hub: one centred card in AgEnD's sign-in style (the brand and this Hub's name, the account and
//   password, a primary button) and nothing of the chat app around it — no sidebar ("Not signed in"), no "Ask" title,
//   no empty pane; desk and phone, en and zh-TW, light and dark;
// - a refused sign-in says so in the card; a good one opens the chats (the sidebar back);
// - the stale-tab skew: the old shell (/assets from OLD_REF) with this branch's lazy Hub modules, and this shell with the
//   old panel-hub.js: the page still signs in.
// LABEL=base: the before pictures only.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [LABEL=base|branch] [OLD_REF=songsid/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-signin-a7.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = process.env.OUT!, PW = process.env.PW_DIR!, LABEL = process.env.LABEL ?? "branch";
const OLD_REF = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
const BASE = LABEL === "base";
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const r: Record<string, unknown> = { label: LABEL, oldRef: OLD_REF };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const shot = (name: string) => { const d = join(OUT, "hub-signin-a7"); mkdirSync(d, { recursive: true }); return join(d, `${LABEL}-${name}.png`); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };

const port = 48800 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
mkdirSync(OUT, { recursive: true });
const keys = mkdtempSync(join(OUT, "hub-signin-keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); } });
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
rig.addPerson("alex", "Alex Lin");

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const CASES = [
  { device: "desk", lang: "en", theme: "light", viewport: { width: 1366, height: 860 } },
  { device: "desk", lang: "zh-TW", theme: "dark", viewport: { width: 1366, height: 860 } },
  { device: "phone", lang: "en", theme: "dark", viewport: { width: 390, height: 844 } },
  { device: "phone", lang: "zh-TW", theme: "light", viewport: { width: 390, height: 844 } },
] as const;

async function open(c: (typeof CASES)[number], route?: (page: any) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: c.viewport, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true,
    isMobile: c.device === "phone", hasTouch: c.device === "phone", deviceScaleFactor: 2 });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); localStorage.setItem("agend_tour_done", "1"); } catch {}
    window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  if (route) await route(page);
  await page.goto(origin + "/ui/hub");
  await page.waitForSelector("#hubLogin", { timeout: 15000 });
  await page.waitForTimeout(600);
  return { ctx, page, errs, csp: () => page.evaluate("window.__csp || []") as Promise<string[]> };
}
/** What a person sees: the card, whether anything of the chat app is on screen, the button's contrast. */
const LOOK = `(() => {
  const vis = (el) => { if (!el) return false; const s = getComputedStyle(el), b = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && b.width > 0 && b.height > 0; };
  const form = document.querySelector("#hubLogin").closest("form, section, main, div");
  const card = document.querySelector(".hub-signin-card") || document.querySelector(".hub-signin");
  const b = card.getBoundingClientRect();
  const btn = card.querySelector("button[type=submit]"), cs = getComputedStyle(btn);
  const lum = (c) => { const m = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  return { sidebar: vis(document.querySelector("#sidebar")), tabs: vis(document.querySelector("nav.tabs")),
    header: [...document.querySelectorAll(".panel-head, .panel-header, header h1")].filter(vis).map((x) => x.textContent.trim()).filter(Boolean),
    cardCentre: Math.round((b.left + b.width / 2) - innerWidth / 2), cardTop: Math.round(b.top), cardWidth: Math.round(b.width),
    buttonContrast: Math.round(ratio(cs.color, cs.backgroundColor) * 10) / 10, buttonBg: cs.backgroundColor,
    text: (card.innerText || "").replace(/\\s+/g, " ").slice(0, 200), overflowX: document.documentElement.scrollWidth - innerWidth, ok: !!form };
})()`;

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    const o = await open(c);
    const look = await o.page.evaluate(LOOK);
    await o.page.screenshot({ path: shot(`${tag}-1-signed-out`) });
    if (BASE) { r[tag] = look; await o.ctx.close(); continue; }
    // A refused sign-in, said in the card; then a good one opens the chats.
    await o.page.fill("#hubLogin", "alex"); await o.page.fill("#hubPassword", "wrong");
    await o.page.click("button[type=submit]");
    const refused = await o.page.waitForSelector("[role=alert]", { timeout: 8000 }).then(() => true, () => false);
    await o.page.waitForTimeout(300);
    if (c.device === "desk" && c.theme === "light") await o.page.screenshot({ path: shot(`${tag}-2-refused`) });
    await o.page.fill("#hubPassword", "pw-alex"); await o.page.click("button[type=submit]");
    const inside = await o.page.waitForSelector(".hub-home, .hub-chat-main", { timeout: 10000 }).then(() => true, () => false);
    const after = await o.page.evaluate(`({ sidebar: !!document.querySelector("#sidebar") && getComputedStyle(document.querySelector("#sidebar")).visibility !== "hidden", signinGone: !document.querySelector(".hub-signin-page") })`);
    await o.page.waitForTimeout(400);
    if (c.device === "desk" && c.theme === "light") await o.page.screenshot({ path: shot(`${tag}-3-signed-in`) });
    const got = { look, refused, inside, after, errs: o.errs, csp: await o.csp() };
    check(tag, !look.sidebar && !look.tabs && look.header.length === 0 && Math.abs(look.cardCentre) <= 2 && look.buttonContrast >= 4.5 && look.overflowX <= 0
      && refused && inside && (c.device === "phone" || after.sidebar) && after.signinGone && o.errs.length === 0 && (got.csp as string[]).length === 0, got);
    await o.ctx.close();
  }
  if (!BASE) {
    // The stale-tab skew, both ways.
    const oldShell = async (page: any) => page.route("**/assets/**", (route: any) => {
      const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
      const body = old(`shared/${file}`);
      return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
    });
    const oldHub = async (page: any) => page.route(/\/ui\/js\/panel-hub\.js(\?.*)?$/, (route: any) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old("panel-hub.js") ?? "" }));
    for (const [name, route] of [["old-shell-new-hub", oldShell], ["new-shell-old-hub", oldHub]] as const) {
      const o = await open(CASES[0], route);
      await o.page.fill("#hubLogin", "alex"); await o.page.fill("#hubPassword", "pw-alex"); await o.page.click("button[type=submit]");
      const inside = await o.page.waitForSelector(".hub-home, .hub-chat-main", { timeout: 10000 }).then(() => true, () => false);
      await o.page.screenshot({ path: shot(`skew-${name}`) });
      check(`skew-${name}`, inside && o.errs.length === 0, { inside, errs: o.errs });
      await o.ctx.close();
    }
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  mkdirSync(join(OUT, "hub-signin-a7"), { recursive: true });
  writeFileSync(join(OUT, "hub-signin-a7", `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rig.close();
  rmSync(keys, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}
