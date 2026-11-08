/** #3423 real Fleet Settings + Hub + verified fake-LDAPS browser handoff. No daemon/CLI/tmux/native/model work.
 * REPO=$PWD PW_DIR=<playwright-core root> MATRIX=quick|full OUT=<owned output> npx tsx scripts/manual/smoke/smoke-hub-company-join.mts
 * Only the test DC:636 and the test Hub hostname are mapped to owned loopback listeners. Browser CA is injected per client.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
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
const { signCompanyDescriptor } = await import(repo + "/src/hub/join/descriptor.ts");
const { generateKeyPairSync } = await import("node:crypto");
const { currentBinding } = await import(repo + "/src/hub/member/pairing-api.ts");
const { setLocale } = await import(repo + "/src/locale.ts");
const { CompanyJoinClient } = await import(repo + "/src/hub/join/client.ts");
const { companyFlowCookieName } = await import(repo + "/src/hub/join/http.ts");
const { bootFixture, matrix, VIEWPORTS, caseName } = await import(repo + "/scripts/manual/smoke-fixture/index.mts");
const r = await companyJoinRig((port: number) => { dcPort = port; }, { host });
const admin = await r.signIn("alice"); await r.enable(admin, 8);
const enabled = await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 });
if (enabled.status !== 200) throw Error("Owned Hub feature admission failed");
const companyLink = enabled.body.companyLink;
const assetRoot = process.env.SKEW ?? process.env.BEFORE_ASSETS;
const result: any = { source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), cases: [], checks: [], errors: [],
  boundaries: "Owned listeners; real cookie/CSRF/Settings replay/Hub/SQLite/TLS/WSS/production AD driver with fake LDAPS wire. Inert Fleet lifecycle; per-client private CA and loopback hostname/DC mapping only." };
const check = (name: string, ok: unknown, detail?: unknown) => { result.checks.push({ name, ok: !!ok, ...(!ok ? { detail } : {}) }); if (!ok) throw Error(name + (detail ? ": " + JSON.stringify(detail) : "")); };
const smallJoinTargets = `(() => {
  const small = [];
  for (const el of document.querySelectorAll('.hub-company-join :is(button,input,summary), .s-company-join :is(button,input)')) {
    if (el.disabled || !el.getClientRects().length) continue;
    let box = el.getBoundingClientRect();
    if (el.matches('input[type=checkbox]') && el.labels?.length) box = el.labels[0].getBoundingClientRect();
    if (Math.min(box.width, box.height) < 43.5) small.push({tag:el.tagName,id:el.id,height:box.height,width:box.width});
  }
  return small;
})()`;
let fx: any = null, publicProbe: ReturnType<typeof createHttpsServer> | null = null;
try {
  if (process.env.PUBLIC_ONLY) {
    // Exercise the production public entry before navigation, not just Start's later backend refusal.
    const requests: Array<{ hostname: string; cookie: string }> = [];
    publicProbe = createHttpsServer({ key: readFileSync(r.certs.key), cert: readFileSync(r.certs.cert) }, (req, res) => {
      requests.push({ hostname: req.headers.host ?? "", cookie: req.headers.cookie ?? "" });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end("Owned Fleet navigation cookie probe. Dummy cookies only.");
    });
    await new Promise<void>((done, reject) => { publicProbe!.once("error", reject); publicProbe!.listen(0, "127.0.0.1", done); });
    const port = (publicProbe.address() as { port: number }).port;
    const unsafe = `https://${host}:${port}`, safe = `https://fleet.lan.example:${port}`;
    const hubCookie = "__Host-agend_hub_" + randomUUID(), flowCookie = companyFlowCookieName(randomUUID(), randomUUID());
    const pw = createRequire(resolve(process.env.PW_DIR!) + "/")("playwright-core"), browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", `--host-resolver-rules=MAP ${host} 127.0.0.1, MAP fleet.lan.example 127.0.0.1`] });
    try {
      for (const c of matrix()) {
        const tag = caseName(c), ctx = await browser.newContext({ viewport: VIEWPORTS[c.device], colorScheme: c.theme, ignoreHTTPSErrors: true });
        try {
          await ctx.addInitScript({ content: `try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)})}catch{}` });
          const cookie = (name: string, url: string) => ({ name, value: "dummy-cookie-control", url, httpOnly: true, secure: true, sameSite: "Strict" as const });
          await ctx.addCookies([cookie(hubCookie, r.webOrigin), cookie(flowCookie, r.webOrigin), cookie("agend_session", safe)]);
          await ctx.route("**/*", (route: any) => {
            const u = new URL(route.request().url()); if (![r.webOrigin, safe, unsafe].includes(u.origin)) return route.abort();
            if (assetRoot && (u.pathname.startsWith("/assets/") || u.pathname.startsWith("/ui/js/"))) {
              const candidate = join(resolve(assetRoot), u.pathname.split("/").pop()!);
              if (existsSync(candidate)) return route.fulfill({ path: candidate, contentType: candidate.endsWith(".css") ? "text/css" : "application/javascript" });
            }
            return route.continue();
          });
          const page = await ctx.newPage(), errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
          await page.goto(companyLink); await page.locator(".p-hub-info textarea").waitFor();
          check(tag + " public entry offers no password", await page.locator('input[type="password"]').count() === 0);
          const input = page.locator(".p-hub-info input"), link = page.locator(".p-hub-info a.btn-primary");
          const before = requests.length; await input.fill(unsafe);
          if (process.env.BEFORE_ASSETS) {
            await link.waitFor(); check(tag + " before reproduces unsafe navigation offer", (await link.getAttribute("href"))!.startsWith(unsafe + "/settings/hub"));
          } else {
            const text = c.lang === "zh-TW" ? "只更換連接埠仍不安全" : "changing only the port is not enough";
            await page.getByText(text, { exact: false }).waitFor();
            check(tag + " same hostname has guidance and no navigation target", await link.count() === 0);
            await input.press("Enter"); check(tag + " unsafe entry sends no request to Fleet listener", requests.length === before && new URL(page.url()).origin === r.webOrigin);
          }
          await page.screenshot({ path: join(out, tag + (process.env.BEFORE_ASSETS ? "-public-before.png" : "-public-blocked.png")), fullPage: true });
          if (!process.env.BEFORE_ASSETS) {
            await input.fill(safe); await link.waitFor(); check(tag + " distinct hostname offers exact Fleet path", (await link.getAttribute("href"))!.startsWith(safe + "/settings/hub#join="));
            await page.screenshot({ path: join(out, tag + "-public-distinct.png"), fullPage: true });
            const popup = ctx.waitForEvent("page"); await link.click(); const fleet = await popup; await fleet.waitForLoadState("domcontentloaded");
            const observed = requests.slice(before).find(row => row.hostname === new URL(safe).host);
            check(tag + " actual distinct-host navigation sends only Fleet cookie", !!observed && observed.cookie.includes("agend_session=") && !observed.cookie.includes(hubCookie) && !observed.cookie.includes(flowCookie));
            check(tag + " navigation has no opener", await fleet.evaluate(() => window.opener === null));
          }
          check(tag + " public entry has no overflow or script errors", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) && errors.length === 0, errors);
          result.cases.push({ tag, kind: process.env.BEFORE_ASSETS ? "public-before" : "public-entry", ok: true });
        } finally { await ctx.close(); }
      }
    } finally { await browser.close(); }
  }
  const scenarios = process.env.ADMIN_ONLY || process.env.PUBLIC_ONLY ? [] : matrix().map(c => ({ c, kind: "happy", login: "" }));
  if (!process.env.ADMIN_ONLY && !process.env.PUBLIC_ONLY && process.env.EXTRAS !== "0" && !process.env.BEFORE_ASSETS) for (const kind of process.env.HUB_SHOTS ? ["outsider", "copied"] : ["outsider", "limit", "changed", "cancel", "copied", "samehost"]) scenarios.push({ c: { device: "desk", theme: "light", lang: "zh-TW" }, kind, login: kind === "limit" ? "join-person-0" : "" });
  const selected = process.env.ONLY_CASES ? scenarios.filter(s => process.env.ONLY_CASES!.split(",").includes(s.kind)) : scenarios;
  for (const [index, scenario] of selected.entries()) {
    const { c, kind } = scenario; setLocale(c.lang); const tag = caseName(c) + (kind === "happy" ? "" : "-" + kind), login = scenario.login || "join-person-" + index;
    if (kind === "limit") await r.enable(admin, 1);
    if (!scenario.login) r.people.push({ id: randomUUID(), login, dn: `CN=${login},DC=example,DC=test`, password: "Dummy-" + login, groups: [kind === "outsider" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] });
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
    await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url());
      if (![fx.base, r.webOrigin].includes(u.origin)) return route.abort();
      if (assetRoot && (u.pathname.startsWith("/assets/") || u.pathname.startsWith("/ui/js/"))) {
        const candidate = join(resolve(assetRoot), u.pathname.split("/").pop()!);
        if (existsSync(candidate)) return route.fulfill({ path: candidate, contentType: candidate.endsWith(".css") ? "text/css" : "application/javascript" });
      }
      return route.continue(); });
    const code = await (await ctx.request.post(fx.base + "/auth/issue-code", { headers: { "X-Agend-Token": fm.webToken, Origin: fx.base } })).json();
    check(tag + " host code issued", typeof code.code === "string");
    const page = await ctx.newPage(); page.on("pageerror", (error: Error) => result.errors.push({ tag, message: error.message }));
    try {
      await page.goto(fx.base + "/signin"); await page.fill("#code", code.code); await page.click("#go"); await page.waitForURL(fx.base + "/ui");
      await page.goto(fx.base + "/settings/hub");
      if (process.env.BEFORE_ASSETS) {
        await page.locator("#hubMemberEnabled").waitFor(); await page.screenshot({ path: join(out, tag + "-before-fleet.png") });
        const beforeHub = await ctx.newPage(); await beforeHub.goto(r.webOrigin + "/ui/hub"); await beforeHub.locator("#hubLogin").waitFor();
        await beforeHub.screenshot({ path: join(out, tag + "-before-hub.png") });
        await beforeHub.fill("#hubLogin", "alice"); await beforeHub.fill("#hubPassword", "Dummy-alice-only");
        await beforeHub.getByRole("button", { name: c.lang === "zh-TW" ? "登入" : "Sign in", exact: true }).click();
        await beforeHub.locator(".p-hub-signin").waitFor({state:"detached"}); await beforeHub.goto(r.webOrigin + "/ui/hub/admin"); await beforeHub.locator(".hub-admin").waitFor();
        await beforeHub.screenshot({ path: join(out, tag + "-before-admin.png") });
        result.cases.push({ tag, kind: "before", ok: true }); continue;
      }
      await page.locator("#hubCompanyAddress").waitFor();
      check(tag + " actual Settings sub-nav", await page.locator('.settings-nav a[href="/settings/hub"], .s-nav a[href="/settings/hub"]' ).count() > 0 || await page.locator('.s-section-nav, .settings-side').count() > 0);
      let address = companyLink;
      const attemptsBefore = (r.db.prepare("SELECT COUNT(*) n FROM hub_company_join_requests").get() as { n: number }).n;
      if (kind === "samehost") { const shared = new URL(r.webOrigin); shared.hostname = new URL(fx.base).hostname; address = shared.origin; }
      if (kind === "changed") {
        const meta = (await r.call(null, "GET", "/hub/v1/join/metadata")).body, key = generateKeyPairSync("ed25519");
        const descriptor = signCompanyDescriptor({ ...meta.hub, issuerPublicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString() }, key.privateKey);
        address = r.webOrigin + "/join-info#hub=" + Buffer.from(JSON.stringify(descriptor)).toString("base64url");
      }
      await page.fill("#hubCompanyAddress", address); await page.fill("#hubCompanyFleetName", "Company Fleet " + index);
      if (c.device === "phone" && !process.env.SKEW) {
        const small = await page.evaluate(smallJoinTargets); check(tag + " Fleet company controls are phone tap targets", small.length === 0, small);
      }
      await page.screenshot({ path: join(out, tag + "-01-fleet-start.png"), fullPage: c.device === "phone" });
      const opened = ctx.waitForEvent("page"); await page.getByRole("button", { name: c.lang === "zh-TW" ? "以公司帳號登入" : "Sign in with company account", exact: true }).click();
      const hub = await opened;
      if (kind === "changed" || kind === "samehost") {
        await page.getByText(kind === "changed" ? "Hub 的身分與先前不同" : "必須使用不同的網頁主機名稱", { exact: false }).waitFor();
        check(tag + " refused before AD", !hub.url().startsWith(r.webOrigin));
        check(tag + " no new Hub request", (r.db.prepare("SELECT COUNT(*) n FROM hub_company_join_requests").get() as { n: number }).n === attemptsBefore);
        await page.screenshot({ path: join(out, tag + (kind === "changed" ? "-05-identity-changed.png" : "-08-same-hostname-refused.png")) });
        if (kind === "samehost") {
          await page.getByRole("button", { name: "以公司帳號登入", exact: true }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(out, tag + "-09-same-hostname-next-step.png") });
        }
        result.cases.push({ tag, ok: true }); continue;
      }
      hub.on("pageerror", (error: Error) => result.errors.push({ tag, message: error.message }));
      await hub.waitForURL(r.webOrigin + "/ui/hub?join=*"); await hub.locator("#hubLogin").waitFor();
      check(tag + " join tab title", (await hub.title()).endsWith((c.lang === "zh-TW" ? "連接 Hub" : "Connect to a Hub") + " · AgEnD"));
      check(tag + " no opener", await hub.evaluate("window.opener === null"));
      check(tag + " exact Fleet origin shown", (await hub.locator(".hub-signin").innerText()).includes(fx.base));
      await hub.screenshot({ path: join(out, tag + "-02-hub-signin.png") });
      if (process.env.HUB_SHOTS && kind === "happy") { result.cases.push({ tag, kind: "signin-shot", ok: true }); continue; }
      if (kind === "copied") {
        const copied = await fx.browser.newContext({ viewport: VIEWPORTS.desk, colorScheme: c.theme, ignoreHTTPSErrors: true });
        await copied.addInitScript({ content: `localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});` });
        try { const other = await copied.newPage(); await other.goto(hub.url()); await other.locator(".error-state").waitFor();
          check(tag + " copied handle shows no AD fields", await other.locator("#hubLogin").count() === 0);
          await other.screenshot({ path: join(out, tag + "-06-copied-refused.png") });
        } finally { await copied.close(); }
        if (process.env.HUB_SHOTS) { result.cases.push({ tag, kind: "copied-shot", ok: true }); continue; }
      }
      if (kind === "cancel") {
        await page.getByRole("button", { name: "取消連接", exact: true }).click();
        await page.getByText("已取消連接", { exact: true }).first().waitFor();
        await hub.locator("#hubLogin").waitFor({ state: "detached" });
        check(tag + " cancelled before issuance", !currentBinding(fm.dataDir));
        await page.screenshot({ path: join(out, tag + "-07-cancelled.png") });
        result.cases.push({ tag, ok: true }); continue;
      }
      const fleetCount = r.deps.store.read().fleets.length;
      await hub.fill("#hubLogin", login); await hub.fill("#hubPassword", "Dummy-" + login);
      await hub.getByRole("button", { name: c.lang === "zh-TW" ? "登入並連接 Fleet" : "Sign in and connect Fleet", exact: true }).click();
      await hub.locator(".p-hub-join").waitFor();
      if (kind === "outsider" || kind === "limit") {
        await hub.getByText(kind === "outsider" ? "你的公司帳號沒有連接這個 Fleet 的權限" : "你的 Fleet 數量已達上限", { exact: false }).waitFor();
        check(tag + " refused without a credential", r.deps.store.read().fleets.length === fleetCount && !currentBinding(fm.dataDir));
        await hub.screenshot({ path: join(out, tag + "-08-refused.png") });
        result.cases.push({ tag, ok: true }); continue;
      }
      await page.locator(".hub-paired").waitFor({ timeout: 30000 });
      check(tag + " actual ready link", fm.hubMemberLink === "online", fm.hubMemberLink);
      check(tag + " zero per-Fleet admin approvals", approvals === 0, approvals);
      await page.screenshot({ path: join(out, tag + "-03-fleet-connected.png") });
      await hub.screenshot({ path: join(out, tag + "-04-hub-return.png") });
      check(tag + " Fleet no overflow", await page.evaluate("document.documentElement.scrollWidth <= innerWidth"));
      check(tag + " Hub no overflow", await hub.evaluate("document.documentElement.scrollWidth <= innerWidth"));
      const binding = currentBinding(fm.dataDir), profile = binding ? JSON.parse(readFileSync(join(fm.dataDir, "hub-member", binding.hubId, "pairing.json"), "utf8")) : null;
      const fleetBrowser = await page.evaluate(() => JSON.stringify({ html: document.documentElement.outerHTML, local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
      const hubBrowser = await hub.evaluate(() => JSON.stringify({ html: document.documentElement.outerHTML, local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
      check(tag + " no browser credential or Fleet AD password", profile && !fleetBrowser.includes(profile.credential) && !hubBrowser.includes(profile.credential) && !fleetBrowser.includes("Dummy-" + login));
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
  if (!process.env.BEFORE_ASSETS && !process.env.PUBLIC_ONLY) {
    // Actual signed-in Administration, not a mock DOM or an injected shell.
    for (const c of matrix().filter(c => c.lang === "zh-TW")) {
      const pw = createRequire(resolve(process.env.PW_DIR!) + "/")("playwright-core"), browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", "--host-resolver-rules=MAP dashboard.lan.example 127.0.0.1"] });
      try {
        const ctx = await browser.newContext({ viewport: VIEWPORTS[c.device], colorScheme: c.theme, ignoreHTTPSErrors: true });
        await ctx.addInitScript(() => localStorage.setItem("agend_lang", "zh-TW"));
        const page = await ctx.newPage(); await page.goto(r.webOrigin + "/ui/hub"); await page.locator("#hubLogin").waitFor();
        await page.fill("#hubLogin", "alice"); await page.fill("#hubPassword", "Dummy-alice-only"); await page.getByRole("button", { name: "登入", exact: true }).click();
        await page.locator(".p-hub-signin").waitFor({state:"detached"}); await page.goto(r.webOrigin + "/ui/hub/admin"); await page.getByRole("button", {name:"複製公司連結",exact:true}).waitFor(); await page.getByRole("button", {name:"複製公司連結",exact:true}).scrollIntoViewIfNeeded();
        if (c.device === "phone") {
          await page.locator(".hub-company-join details").evaluate((el:any) => { el.open = true; });
          const small = await page.evaluate(smallJoinTargets); check(caseName(c) + " admin company controls are phone tap targets", small.length === 0, small);
          await page.locator(".hub-company-join details").evaluate((el:any) => { el.open = false; });
        }
        await page.screenshot({ path: join(out, caseName(c) + "-09-admin.png"), fullPage: true });
        if (c.device === "desk" && c.theme === "light") {
          await page.goto(companyLink); await page.locator(".p-hub-info textarea").waitFor();
          check("public company link offers no AD/password", await page.locator('input[type="password"]').count() === 0);
          await page.screenshot({path:join(out,"desk-light-zh-TW-10-public-link.png")});
        }
        check(caseName(c) + " admin no overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await ctx.close();
      } finally { await browser.close(); }
    }
  }
  result.status = "PASS";
} catch (error: any) { result.status = "FAIL"; result.error = error.stack; throw error; }
finally {
  if (publicProbe?.listening) { publicProbe.closeAllConnections(); await new Promise<void>(done => publicProbe!.close(() => done())); }
  if (fx) { fx.fm.companyJoinController?.close(); fx.fm.hubRuntime?.fence(); await fx.fm.hubRuntime?.close(); fx.fm.hubEffectsReady = false; await fx.close(); }
  await r.close(); tls.connect = realConnect; syncBuiltinESMExports(); writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ status: result.status, cases: result.cases.length, checks: result.checks.length, out }));
