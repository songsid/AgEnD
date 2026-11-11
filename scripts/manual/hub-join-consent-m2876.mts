/** #3423 real Fleet Settings + Hub + verified fake-LDAPS browser handoff. No daemon/CLI/tmux/native/model work.
 * REPO=$PWD PW_DIR=<playwright-core root> MATRIX=quick|full OUT=<owned output> npx tsx scripts/manual/smoke/smoke-hub-company-join.mts
 * Only the test DC:636 and the test Hub hostname are mapped to owned loopback listeners. Browser CA is injected per client.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import yaml from "js-yaml";
const repo = resolve(process.env.REPO ?? process.cwd()), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-company-join-consent-m2876/browser"));
mkdirSync(out, { recursive: true });
if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" }).trim()) throw Error("capture requires clean tracked sources before starting any rig");
const scratch = mkdtempSync(join(out, "run-")), home = join(scratch, "home"), bin = join(scratch, "bin");
for (const p of [home, bin, join(home, "tmux"), join(home, ".claude"), join(home, ".codex")]) mkdirSync(p, { recursive: true, mode: 0o700 });
Object.assign(process.env, { REPO: repo, HOME: home, AGEND_HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), TMUX_TMPDIR: join(home, "tmux") });
for (const command of ["tmux", "agend", "claude", "codex", "kiro-cli"]) { const path = join(bin, command); writeFileSync(path, `#!${process.execPath}\nprocess.exit(97)\n`); chmodSync(path, 0o755); }
process.env.AGEND_TMUX_BIN = join(bin, "tmux"); process.env.PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
const require = createRequire(import.meta.url), tls = require("node:tls"), realConnect = tls.connect;
const host = "dashboard.lan.example"; let dcPort = 0;
tls.connect = (options: any, ...args: any[]) => realConnect({ ...options,
  ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dcPort } : {}), ...(options.host === host ? { host: "127.0.0.1" } : {}) }, ...args);
syncBuiltinESMExports();
const { companyJoinRig } = await import(repo + "/tests/support/hub-company-join-rig.ts");
const { signCompanyDescriptor } = await import(repo + "/src/hub/join/descriptor.ts");
const { generateKeyPairSync } = await import("node:crypto");
const { currentBinding } = await import(repo + "/src/hub/member/pairing-api.ts");
const { base32Decode, hotp, totpStep, HOST_ADMIN_KEY } = await import(repo + "/src/web-remote-access.ts");
const { tokenEpoch } = await import(repo + "/src/web-session.ts");
const { setLocale } = await import(repo + "/src/locale.ts");
const { CompanyJoinClient } = await import(repo + "/src/hub/join/client.ts");
const { companyFlowCookieName } = await import(repo + "/src/hub/join/http.ts");
const { bootFixture, matrix, VIEWPORTS, caseName } = await import(repo + "/scripts/manual/smoke-fixture/index.mts");
const r = await companyJoinRig((port: number) => { dcPort = port; }, { host });
const admin = await r.signIn("alice"); await r.enable(admin, 8);
const enabled = await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 });
if (enabled.status !== 200) throw Error("Owned Hub feature admission failed");
const companyLink = enabled.body.companyLink;
// Candidate is committed before capture. Asset records use digest-first lists, never token-like keys.
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--untracked-files=no")) throw Error("capture requires clean tracked sources");
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const inputPaths = ["src/settings-http-confirmation.ts", "src/settings-confirmation.ts", "src/fleet-manager.ts", "src/ui/settings-hub-company-join.js", "src/ui/settings-confirm.js", "src/ui/hub-company-join.js", "src/ui/hub-company-join-strings.js", "scripts/manual/hub-join-consent-m2876.mts", "tests/support/hub-company-join-rig.ts", "scripts/manual/smoke-fixture/index.mts"];
const inputs = inputPaths.map(path => ({ path, digest: hash(readFileSync(join(repo, path))) }));
const result: any = { source: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), inputs, checks: [], cases: [], errors: [], scope: "Real Fleet cookie/CSRF/claim/replay + Hub HTTPS/SQLite/TLS/WSS/production AD over owned fake LDAPS. Inert lifecycle; dummy account, owned CA/host mapping. Forwarded peer models remote admin; no live operation." };
const check = (name: string, ok: unknown, detail?: unknown) => { result.checks.push({ name, ok: !!ok, ...(!ok ? { detail } : {}) }); if (!ok) throw Error(name + ": " + JSON.stringify(detail)); };
const baseline = process.env.BASELINE_REF ?? "3dd72e50a888d3e639219f66c7301e1e812d87aa";
let fx: any = null;
try {
 const scenarios = matrix().map(c => ({ c, strict: false }));
 if (!process.env.BEFORE && !process.env.SKEW) for (const c of matrix("desk-light-en,phone-dark-zh-TW")) scenarios.push({ c, strict: true });
 for (const [index, { c, strict }] of scenarios.entries()) {
  setLocale(c.lang); const tag = caseName(c) + (strict ? "-code" : ""), login = "consent-person-" + index;
  r.people.push({ id: randomUUID(), login, dn: `CN=${login},DC=example,DC=test`, password: "Dummy-" + login, groups: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] });
  console.log(JSON.stringify({ tag, phase: "boot" }));
  fx = await bootFixture({ port: Number(process.env.HP ?? 54960), instances: 1, classic: false }); const fm = fx.fm;
  for (const name of ["startInstance", "startInstanceUnattended", "restartInstance", "restartFleet", "stopInstance"]) fm[name] = async () => { throw Error("Inert fixture refuses " + name); };
  let notifications = 0; fm.promptSettingsChange = async () => { notifications++; throw Error("Unexpected held General card"); };
  fm.hubEffectsReady = true; const controller: any = await fm.hubCompanyJoin();
  controller.client = new CompanyJoinClient({ ca: readFileSync(r.certs.caCert), lookup: (_h: any, options: any, cb: any) => options.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4) });
  let secret = "";
  if (strict) { const access = fm.webRemoteAccess(), handle = "owned-enrollment"; secret = access.beginEnrollment(handle, "Owned mock admin").secret;
   check(tag + " test-only own code enrollment", access.confirmEnrollment(handle, hotp(base32Decode(secret), totpStep(Date.now()) - 1), { physicalHost: true }) === "ok");
   check(tag + " own enforcement on", access.setStrict(HOST_ADMIN_KEY, true) === "ok"); }
  fm.webPrefs.write("operator", new Map([["theme", c.theme], ["lang", c.lang]]));
  const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], isMobile: c.device === "phone", hasTouch: c.device === "phone", colorScheme: c.theme, locale: c.lang === "en" ? "en-US" : "zh-TW", ignoreHTTPSErrors: true });
  await ctx.addInitScript((prefs: any) => { if (!/^https?:$/.test(location.protocol)) return; for (const [k,v] of Object.entries(prefs)) localStorage.setItem(k, String(v)); (window as any).__csp = []; document.addEventListener("securitypolicyviolation", (e: any) => (window as any).__csp.push(e.violatedDirective)); }, { agend_lang: c.lang, agend_theme: c.theme, agend_tour_done: "1", agend_firstrun_dismissed: "1" });
  const assets: Record<string, Set<string>> = {}, substitutions: any[] = [], responses: Promise<void>[] = [];
  const replace = process.env.BEFORE ? ["settings-hub-company-join.js", "hub-company-join.js", "hub-company-join-strings.js", "settings-confirm.js"] : process.env.SKEW ? process.env.SKEW.split(",") : [];
  await ctx.route("**/*", async (route: any) => { const u = new URL(route.request().url());
   if (![fx.base, r.webOrigin].includes(u.origin)) return route.abort();
   const name = u.pathname.split("/").pop();
   if (replace.includes(name)) { const path = "src/ui/" + name, body = execFileSync("git", ["show", baseline + ":" + path], { cwd: repo }); substitutions.push({ path, digest: hash(body) }); return route.fulfill({ status: 200, contentType: "text/javascript", body }); }
   return route.continue(u.origin === fx.base ? { headers: { ...route.request().headers(), "x-forwarded-for": "192.0.2.29" } } : {});
  });
  ctx.on("page", (p: any) => { p.on("pageerror", (e: Error) => result.errors.push(e.message)); p.on("response", (v: any) => { const path = new URL(v.url()).pathname; if (path.startsWith("/assets/") || path.startsWith("/ui/js/")) responses.push((async () => { try { const d = hash(await v.body()); (assets[d] ??= new Set()).add(path); } catch {} })()); }); });
  fm.initializeWebSessions(); const issued = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken), host: true });
  const page = await ctx.newPage();
  const shot = async (name: string, p = page) => { await p.evaluate(async () => { await document.fonts.ready; await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))); }); await p.screenshot({ path: join(out, tag + "-" + name + ".png"), fullPage: c.device === "phone" }); };
  try {
   await page.goto(fx.base + "/signin"); await page.fill("#code", issued.display); await page.waitForURL(fx.base + "/ui"); await page.goto(fx.base + "/settings/hub"); await page.locator("#hubCompanyAddress").waitFor();
   if (!process.env.BEFORE && !process.env.SKEW?.includes("settings-hub-company-join.js")) { check(tag + " empty link source", (await page.locator(".s-company-join").innerText()).includes(c.lang === "en" ? "Copy colleague connection link" : "複製同仁連線連結")); check(tag + " disabled reason", (await page.locator("#hubCompanyStartHint").innerText()).includes(c.lang === "en" ? "Paste the Hub link first" : "請先貼上 Hub 連結")); }
   await shot("empty"); await page.fill("#hubCompanyAddress", companyLink); await page.fill("#hubCompanyFleetName", "Owned Fleet " + index);
   const opened = ctx.waitForEvent("page"); await page.getByRole("button", { name: c.lang === "en" ? "Sign in with company account" : "以公司帳號登入", exact: true }).click(); const hub = await opened;
   if (strict) { await page.locator(".hub-join-code input").waitFor(); check(tag + " no generic held card", await page.locator(".pending-card").count() === 0); check(tag + " no premature Hub request", !hub.url().startsWith(r.webOrigin)); if (c.device === "phone") { const boxes = await page.locator(".hub-join-code input, .hub-join-code button").evaluateAll((els: any[]) => els.map(el => { const b = el.getBoundingClientRect(); return { width: b.width, height: b.height }; })); check(tag + " inline code tap", boxes.length === 2 && boxes.every((b: any) => Math.min(b.width,b.height) >= 43.5), boxes); }
    await shot("code");
    await page.locator(".hub-join-code input").fill(hotp(base32Decode(secret), totpStep(Date.now()))); await page.locator(".hub-join-code button").click(); }
   await hub.waitForURL(r.webOrigin + "/ui/hub?join=*"); await hub.locator("#hubLogin").waitFor(); check(tag + " actual nonhost requester", controller.active?.authority.session.hostHere === false); check(tag + " no local consent step", notifications === 0); check(tag + " no opener", await hub.evaluate(() => window.opener === null)); await shot("hub-signin", hub);
   await hub.fill("#hubLogin", login); await hub.fill("#hubPassword", "Dummy-" + login); await hub.getByRole("button", { name: c.lang === "en" ? "Sign in and connect Fleet" : "登入並連接 Fleet", exact: true }).click();
   await page.locator('.s-hub-connection[data-state="connected"]').waitFor({ timeout: 30000 }); check(tag + " link online", fm.hubMemberLink === "online"); check(tag + " one connection", !!currentBinding(fm.dataDir)); check(tag + " no General approval", notifications === 0); await shot("connected");
   for (const p of [page, hub]) check(tag + " no overflow", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
   if (c.device === "phone") { const small = await page.locator(".s-hub-connection").evaluate((el: any) => [...el.querySelectorAll("button,input,a.btn")].filter((n: any) => !n.disabled && n.getClientRects().length && n.offsetParent !== null).map((n: any) => { const target = n.type === "checkbox" ? n.closest("label") || n : n, b = target.getBoundingClientRect(); return { tag: n.tagName, id: n.id, width: b.width, height: b.height }; }).filter((b: any) => Math.min(b.width,b.height) < 43.5)); check(tag + " phone controls", small.length === 0, small); }
   // A navigation can leave Chromium's body() pending until context closure. Finish the
   // journey first, then drain response capture after physically closing its context.
   await ctx.close();
   console.log(JSON.stringify({ tag, phase: "asset-receipts" }));
   await Promise.all(responses); result.cases.push({ tag, strict, hostHere: false, completed: true, substitutions, assets: Object.entries(assets).map(([digest,paths]) => ({ digest, paths: [...paths] })) });
  } finally { console.log(JSON.stringify({ tag, phase: "context-close" })); await ctx.close(); controller.close(); fm.hubRuntime?.fence(); console.log(JSON.stringify({ tag, phase: "runtime-close" })); await fm.hubRuntime?.close(); fm.hubEffectsReady = false; console.log(JSON.stringify({ tag, phase: "fixture-close" })); await fx.close(); fx = null; console.log(JSON.stringify({ tag, phase: "closed" })); }
 }
 // A separate authenticated Hub admin; no invitation, policy or manual-pairing mutation for these screenshots.
 for (const c of matrix()) {
  const pw = createRequire(resolve(process.env.PW_DIR!) + "/")("playwright-core"), browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", "--host-resolver-rules=MAP dashboard.lan.example 127.0.0.1"] });
  try { const ctx = await browser.newContext({ viewport: VIEWPORTS[c.device], colorScheme: c.theme, ignoreHTTPSErrors: true }); await ctx.addInitScript((prefs: any) => { if (!/^https?:$/.test(location.protocol)) return; localStorage.setItem("agend_lang", prefs.lang); localStorage.setItem("agend_theme", prefs.theme); }, { lang: c.lang, theme: c.theme });
   if (process.env.BEFORE) for (const name of ["hub-company-join.js", "hub-company-join-strings.js"]) await ctx.route("**/ui/js/" + name, (route: any) => route.fulfill({ contentType: "text/javascript", body: execFileSync("git", ["show", baseline + ":src/ui/" + name], { cwd: repo }) }));
   const page = await ctx.newPage(); await page.goto(r.webOrigin + "/ui/hub"); await page.fill("#hubLogin", "alice"); await page.fill("#hubPassword", "Dummy-alice-only"); await page.getByRole("button", { name: c.lang === "en" ? "Sign in" : "登入", exact: true }).click(); await page.locator(".p-hub-signin").waitFor({ state: "detached" }); await page.goto(r.webOrigin + "/ui/hub/admin"); await page.locator(".hub-admin-access").waitFor();
   if (!process.env.BEFORE) check(caseName(c) + " three guide steps", await page.locator(".hub-company-guide li").count() === 3);
   await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))); }); await page.screenshot({ path: join(out, caseName(c) + "-admin.png"), fullPage: c.device === "phone" }); await ctx.close();
  } finally { await browser.close(); }
 }
 check("nonempty matrix", result.cases.length > 0); check("no page errors", result.errors.length === 0, result.errors); result.status = "PASS";
} catch (e: any) { result.status = "FAIL"; result.error = e.stack; throw e; }
finally { if (fx) { fx.fm.companyJoinController?.close(); fx.fm.hubRuntime?.fence(); await fx.fm.hubRuntime?.close(); fx.fm.hubEffectsReady = false; await fx.close(); } await r.close(); tls.connect = realConnect; syncBuiltinESMExports(); result.cleaned = true;
 for (const row of inputs) if (hash(readFileSync(join(repo,row.path))) !== row.digest) throw Error("capture source changed");
 if (git("rev-parse", "HEAD") !== result.source || git("status", "--porcelain", "--untracked-files=no")) throw Error("capture tree changed");
 writeFileSync(join(out, "receipt.json"), JSON.stringify(result, null, 2)); }
console.log(JSON.stringify({ status: result.status, cases: result.cases.length, checks: result.checks.length, cleaned: result.cleaned }));
process.exit(0);
