/** #3423 real Fleet Settings + Hub + verified fake-LDAPS browser handoff. No daemon/CLI/tmux/native/model work.
 * REPO=$PWD PW_DIR=<playwright-core root> MATRIX=quick|full OUT=<owned output> npx tsx scripts/manual/smoke/smoke-hub-company-join.mts
 * Only the test DC:636 and the test Hub hostname are mapped to owned loopback listeners. Browser CA is injected per client.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
const repo = resolve(process.env.REPO ?? process.cwd()), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-company-join/browser"));
mkdirSync(out, { recursive: true });
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
const { CompanyJoinClient } = await import(repo + "/src/hub/join/client.ts");
const { bootFixture, matrix, VIEWPORTS, caseName } = await import(repo + "/scripts/manual/smoke-fixture/index.mts");
const r = await companyJoinRig((port: number) => { dcPort = port; }, { host });
const admin = await r.signIn("alice"); await r.enable(admin, 8);
const enabled = await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 });
if (enabled.status !== 200) throw Error("Owned Hub feature admission failed");
const companyLink = enabled.body.companyLink;
const result: any = { source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), cases: [], checks: [], errors: [],
  boundaries: "Owned listeners; real cookie/CSRF/Settings replay/Hub/SQLite/TLS/WSS/production AD driver with fake LDAPS wire. Inert Fleet lifecycle; per-client private CA and loopback hostname/DC mapping only." };
const check = (name: string, ok: unknown, detail?: unknown) => { result.checks.push({ name, ok: !!ok, ...(!ok ? { detail } : {}) }); if (!ok) throw Error(name + (detail ? ": " + JSON.stringify(detail) : "")); };
let fx: any = null;
try {
  for (const [index, c] of matrix().entries()) {
    const tag = caseName(c), login = "join-person-" + index;
    r.people.push({ id: randomUUID(), login, dn: `CN=${login},DC=example,DC=test`, password: "Dummy-" + login, groups: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] });
    fx = await bootFixture({ port: Number(process.env.HP ?? 54700), instances: 1, classic: false });
    const fm = fx.fm, configPath = join(fx.dir, "fleet.yaml"), config: any = yaml.load(readFileSync(configPath, "utf8"));
    // Alternate web-only and chat-configured Fleets. Native/model delivery remains an explicit refusal boundary.
    if (index % 2) config.channels = [{ id: "tg", type: "telegram", mode: "topic", bot_token_env: "DUMMY_TELEGRAM_TOKEN", group_id: "-1001234567890", access: { mode: "locked", allowed_users: ["1234"] } }];
    writeFileSync(configPath, yaml.dump(config)); fm.hubEffectsReady = true;
    for (const name of ["startInstance", "startInstanceUnattended", "restartInstance", "restartFleet", "stopInstance"]) fm[name] = async () => { throw Error("Refused native lifecycle: " + name); };
    let approvals = 0; fm.promptSettingsChange = async () => { approvals++; throw Error("Unexpected per-Fleet admin approval"); };
    fm.loadConfig(configPath);
    const controller: any = await fm.hubCompanyJoin();
    controller.client = new CompanyJoinClient({ ca: readFileSync(r.certs.caCert), lookup: (_h: any, options: any, cb: any) => options.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4) });
    fm.webPrefs.write("operator", new Map([["theme", c.theme], ["lang", c.lang]]));
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], isMobile: c.device === "phone", hasTouch: c.device === "phone", colorScheme: c.theme,
      locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true });
    await ctx.addInitScript({ content: `window.__name=fn=>fn;try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1')}catch{};window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));` });
    await ctx.route("**/*", (route: any) => { const origin = new URL(route.request().url()).origin; return [fx.base, r.webOrigin].includes(origin) ? route.continue() : route.abort(); });
    const code = await (await ctx.request.post(fx.base + "/auth/issue-code", { headers: { "X-Agend-Token": fm.webToken, Origin: fx.base } })).json();
    check(tag + " host code issued", typeof code.code === "string");
    const page = await ctx.newPage(); page.on("pageerror", (error: Error) => result.errors.push({ tag, message: error.message }));
    try {
      await page.goto(fx.base + "/signin"); await page.fill("#code", code.code); await page.click("#go"); await page.waitForURL(fx.base + "/ui");
      await page.goto(fx.base + "/settings/hub"); await page.locator("#hubCompanyAddress").waitFor();
      check(tag + " actual Settings sub-nav", await page.locator('.settings-nav a[href="/settings/hub"], .s-nav a[href="/settings/hub"]' ).count() > 0 || await page.locator('.s-section-nav, .settings-side').count() > 0);
      await page.fill("#hubCompanyAddress", companyLink); await page.fill("#hubCompanyFleetName", "Company Fleet " + index);
      await page.screenshot({ path: join(out, tag + "-01-fleet-start.png") });
      const opened = ctx.waitForEvent("page"); await page.getByRole("button", { name: c.lang === "zh-TW" ? "以公司帳號登入" : "Sign in with company account", exact: true }).click();
      const hub = await opened; hub.on("pageerror", (error: Error) => result.errors.push({ tag, message: error.message }));
      await hub.waitForURL(r.webOrigin + "/ui/hub?join=*"); await hub.locator("#hubLogin").waitFor();
      check(tag + " no opener", await hub.evaluate("window.opener === null"));
      check(tag + " exact Fleet origin shown", (await hub.locator(".hub-signin").innerText()).includes(fx.base));
      await hub.screenshot({ path: join(out, tag + "-02-hub-signin.png") });
      await hub.fill("#hubLogin", login); await hub.fill("#hubPassword", "Dummy-" + login);
      await hub.getByRole("button", { name: c.lang === "zh-TW" ? "登入並連接 Fleet" : "Sign in and connect Fleet", exact: true }).click();
      await hub.locator(".p-hub-join").waitFor();
      await page.waitForFunction(() => document.body.innerText.includes("Fleet connected") || document.body.innerText.includes("Fleet 已連接"), undefined, { timeout: 30000 });
      check(tag + " actual ready link", fm.hubMemberLink === "online", fm.hubMemberLink);
      check(tag + " zero per-Fleet admin approvals", approvals === 0, approvals);
      await page.screenshot({ path: join(out, tag + "-03-fleet-connected.png") });
      await hub.screenshot({ path: join(out, tag + "-04-hub-return.png") });
      check(tag + " Fleet no overflow", await page.evaluate("document.documentElement.scrollWidth <= innerWidth"));
      check(tag + " Hub no overflow", await hub.evaluate("document.documentElement.scrollWidth <= innerWidth"));
      check(tag + " no script/CSP errors", result.errors.length === 0 && (await hub.evaluate("window.__csp")).length === 0, result.errors);
      await hub.getByRole("link", { name: c.lang === "zh-TW" ? "返回 Fleet 設定" : "Return to Fleet Settings", exact: true }).click();
      await hub.waitForURL(fx.base + "/settings/hub");
      result.cases.push({ tag, fleetKind: index % 2 ? "chat-configured" : "web-only", submissions: 2, optionalReturn: 1, perFleetAdmin: approvals, ok: true });
    } catch (error) { await page.screenshot({ path: join(out, tag + "-FAIL.png") }); throw error; }
    finally {
      await ctx.close(); controller.close(); fm.hubRuntime?.fence(); await fm.hubRuntime?.close(); fm.hubEffectsReady = false;
      await fx.close(); fx = null;
    }
  }
  result.status = "PASS";
} catch (error: any) { result.status = "FAIL"; result.error = error.stack; throw error; }
finally {
  if (fx) { fx.fm.companyJoinController?.close(); fx.fm.hubRuntime?.fence(); await fx.fm.hubRuntime?.close(); fx.fm.hubEffectsReady = false; await fx.close(); }
  await r.close(); tls.connect = realConnect; syncBuiltinESMExports(); writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ status: result.status, cases: result.cases.length, checks: result.checks.length, out }));
