/** UI-only S-118 acceptance on the real scratch FleetManager listener. Never starts a fleet, CLI, public link or model.
 * The current core supports account-omitted sign-in only on web-only fleets. Chat/double-match acceptance MUST follow the core merge.
 * Baseline/SKEW use exact base HTML/JS/token bytes routed into the owned listener; never claim a separately running base daemon.
 * REPO=$PWD PW_DIR=$PWD/node_modules/playwright-core CHROME=<chrome> OUT=<dir> npx tsx scripts/manual/smoke/smoke-signin-unified-s118.mts
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bootFixture, caseName, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";
const REPO = process.env.REPO!;
const BASE = process.env.S118_BASE ?? "d8dd79910a643f9546cd07045015208aafb42ed6";
const OUT = process.env.OUT!;
const { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } = await import(REPO + "/src/web-remote-access.ts");
const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
const OLD = Object.fromEntries(["src/ui/signin.html", "src/ui/shared/signin.js", "src/ui/shared/tokens.css"].map(p => [p, execFileSync("git", ["show", `${BASE}:${p}`], { cwd: REPO, encoding: "utf8" })]));
const checks: Record<string, unknown> = {}, images: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks[name] = ok ? "PASS" : { FAIL: detail }; if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`); };
const fx = await bootFixture({ port: 47920, instances: 2, classic: false, host: true });
const fm = fx.fm as any;
const secret = base32Encode(Buffer.from("s118-owned-synthetic"));
const valid = () => hotp(base32Decode(secret)!, totpStep(Date.now()));
const bad = () => { for (let n = 0; n < 100; n++) { const x = String(n).padStart(6, "0"); if (![-1, 0, 1, -2, 2].some(i => hotp(base32Decode(secret)!, totpStep(Date.now()) + i) === x)) return x; } throw Error("no bad code"); };
function reset() {
  fm.webRemoteAccessState?.close();
  writeFileSync(join(fx.dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  fm.webRemoteAccessState = undefined;
}
async function record(page: any, name: string, geometry = true) {
  await page.evaluate(() => document.fonts.ready);
  const g = await page.evaluate(() => {
    const visible = (n: Element) => n.getClientRects().length;
    const style = (s: string) => { const n = document.querySelector(s)!; const c = getComputedStyle(n); return { color: c.color, background: c.backgroundColor, opacity: c.opacity }; };
    return { width: innerWidth, scroll: document.documentElement.scrollWidth, top: document.querySelector("main")!.getBoundingClientRect().top,
      input: document.querySelectorAll('#form input:not([hidden])').length, account: !!document.querySelector('#account'),
      controls: [...document.querySelectorAll("#form button,input,#reachHelp summary")].filter(visible).map(n => ({ name: n.id, h: n.getBoundingClientRect().height })),
      hint: style("#codeHint"), help: style("#reachTitle"), button: style("#go"), card: style("main"),
      hintLines: document.querySelector("#codeHint")!.getBoundingClientRect().height / parseFloat(getComputedStyle(document.querySelector("#codeHint")!).lineHeight) };
  });
  check(`${name}:no-overflow`, g.scroll <= g.width, g);
  if (geometry) check(`${name}:tap-input-and-top`, !g.account && g.input === 1 && g.controls.every((x: any) => x.h >= 44) && g.top >= 0, g);
  const path = shotPath("signin-s118", name, "view"); await page.screenshot({ path, fullPage: true }); images.push(path);
  return g;
}
function contrast(fg: string, bg: string) {
  const l = (s: string) => { const n = s.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return n[0]! * .2126 + n[1]! * .7152 + n[2]! * .0722; };
  const a = l(fg), b = l(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
try {
  for (const c of matrix()) {
    const cn = caseName(c);
    for (const mode of ["before", "after", "skew-old-js", "skew-old-html"] as const) {
      reset();
      const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", isMobile: c.device === "phone", hasTouch: c.device === "phone" });
      const page = await ctx.newPage(), errors: string[] = [], posts: Array<{ path: string; data: any }> = [];
      await page.addInitScript(() => { (window as any).__name = (v: unknown) => v; (window as any).__csp = []; document.addEventListener("securitypolicyviolation", e => (window as any).__csp.push(e.violatedDirective)); });
      page.on("pageerror", (e: any) => errors.push(String(e)));
      page.on("request", (r: any) => { if (r.method() === "POST") posts.push({ path: new URL(r.url()).pathname, data: r.postDataJSON() }); });
      if (mode === "before" || mode === "skew-old-html") await page.route("**/signin", async (route: any) => {
        const r = await route.fetch(), nonce = /nonce-([^']+)/.exec(r.headers()["content-security-policy"] ?? "")?.[1];
        const body = OLD["src/ui/signin.html"]!.replace(/<body>/, '<body data-web-only="1">').replace(/<style>/g, `<style nonce="${nonce}">`);
        await route.fulfill({ response: r, body });
      });
      if (mode === "before" || mode === "skew-old-js") await page.route("**/assets/signin.js", (route: any) => route.fulfill({ body: OLD["src/ui/shared/signin.js"], contentType: "text/javascript" }));
      if (mode !== "after") await page.route("**/assets/tokens.css", (route: any) => route.fulfill({ body: OLD["src/ui/shared/tokens.css"], contentType: "text/css" }));
      await page.goto(fx.base + "/signin"); await page.waitForSelector("#form:not([hidden])");
      if (mode === "before") {
        // Before has no new optional help ids. Screenshot its exact base form, not current geometry selectors.
        await page.evaluate(() => document.fonts.ready);
        const path = shotPath("signin-s118", `${cn}-${mode}`, "primary"); await page.screenshot({ path, fullPage: true }); images.push(path);
      } else if (mode === "after") {
        const g = await record(page, `${cn}-after-primary`);
        check(`${cn}:hint-and-help-contrast`, contrast(g.hint.color, g.card.background) >= 4.5 && contrast(g.help.color, g.card.background) >= 4.5, g);
        if (c.lang === "zh-TW") check(`${cn}:one-line-fallback`, g.hintLines <= 1.1, g);
        // Real server wrong-code response, followed by its real browser-local five-attempt pause. Manual retry is deliberate.
        await page.fill("#code", bad()); await page.waitForFunction(() => !!document.querySelector("#authHint")?.textContent);
        check(`${cn}:code-only-body`, posts.length === 1 && posts[0]!.path === "/auth/totp" && Object.keys(posts[0]!.data).join() === "code", posts);
        await record(page, `${cn}-after-wrong`);
        for (let i = 0; i < 4; i++) { const response = page.waitForResponse((r: any) => r.url().endsWith("/auth/totp") && r.request().method() === "POST"); await page.click("#go"); await response; await page.waitForTimeout(60); }
        await page.waitForFunction(() => (document.querySelector("#go") as HTMLButtonElement).disabled && !document.querySelector("#authHint")?.textContent);
        const paused = await record(page, `${cn}-after-paused`);
        check(`${cn}:disabled-text-contrast`, contrast(paused.button.color, paused.button.background) >= 4.5 && paused.button.opacity === "1", paused.button);
        await page.locator("#reachTitle").click(); await record(page, `${cn}-after-reach`);
      } else {
        // New JS+old HTML and old JS+new HTML both retain a functional code form. Only the new JS has new auto semantics.
        const display = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken), host: true }).display;
        const path = shotPath("signin-s118", `${cn}-${mode}`, "primary"); await page.screenshot({ path, fullPage: true }); images.push(path);
        await page.fill("#code", display); if (mode === "skew-old-js") await page.click("#go");
        await page.waitForURL(/\/ui$/, { timeout: 10000 });
        check(`${cn}:${mode}:sign-in`, (await page.request.get(fx.base + "/auth/session")).status() === 200);
      }
      check(`${cn}:${mode}:no-script-or-csp-errors`, errors.length === 0 && (await page.evaluate(() => (window as any).__csp)).length === 0, errors);
      await ctx.close();
    }
  }
  reset();
  const ctx = await fx.browser.newContext(); const page = await ctx.newPage();
  await page.goto(fx.base + "/signin/authenticator"); await page.waitForSelector("#form:not([hidden])");
  await page.fill("#code", valid()); await page.waitForURL(/\/ui$/, { timeout: 10000 });
  check("actual-web-only-totp-route-success", (await page.request.get(fx.base + "/auth/session")).status() === 200);
  await ctx.close();
} finally {
  mkdirSync(OUT, { recursive: true });
  const files = ["src/auth-api.ts", "src/ui/signin.html", "src/ui/shared/signin.js", "src/ui/settings-devices.js", "src/ui/settings-access-strings.js"];
  writeFileSync(join(OUT, "s118-result.json"), JSON.stringify({ base: BASE, chrome: fx.browser.version(), scope: "Owned scratch real web-only core; before/SKEW routed exact base UI assets; no chat/double-match proof", checks, images,
    sources: Object.fromEntries(files.map(p => [p, createHash("sha256").update(readFileSync(join(REPO, p))).digest("hex")])) }, null, 2));
  await fx.close();
}
console.log(JSON.stringify({ passed: Object.keys(checks).length, images: images.length }));
