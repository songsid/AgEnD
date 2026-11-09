/** #3335: real browser → Settings HTTP gate → persisted account → real Apply plan/reconcile.
 * Fake provider-scoped profiles and an owned logout-only CLI; native stop/start are recording stubs.
 * No fleet start, provider login, real CLI/native agent process, public network, or default tmux socket.
 * REPO=$PWD PW_DIR=<playwright-core dir> CHROME=<chromium> FONTCONFIG_FILE=<CJK fonts.conf>
 *   /absolute/node --import tsx scripts/manual/smoke/smoke-accounts-move-3335.mts
 * Optional: HP=49150 OLD_CSS_REF=b47cad34a BEFORE_PNG=<earlier B5 rejection PNG>.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";

const repo = resolve(process.env.REPO ?? process.cwd());
const out = join(repo, "docs/screenshots/accounts-move-3335");
const artifacts = join(repo, ".artifacts/accounts-move-3335");
mkdirSync(out, { recursive: true }); mkdirSync(artifacts, { recursive: true });
const owned = mkdtempSync(join(artifacts, "browser-")), home = join(owned, "home"), bin = join(owned, "bin");
for (const p of [home, bin, join(home, ".claude"), join(home, ".codex"), join(owned, "tmux")]) mkdirSync(p, { recursive: true });
const cliLog = join(owned, "mock-cli.jsonl"), guardLog = join(owned, "refused-native.jsonl");
Object.assign(process.env, { REPO: repo, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
  AGEND_HOME: join(home, "agend"), TMUX_TMPDIR: join(owned, "tmux"), SMOKE_CLI_LOG: cliLog, SMOKE_GUARD_LOG: guardLog, SMOKE_OWNED_ROOT: owned });
// The only discoverable Claude is this private mock. It never opens a connection or starts a login.
writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}\n');
writeFileSync(join(bin, "claude"), `#!${process.execPath}
const fs=require('fs'),path=require('path');const args=process.argv.slice(2),root=process.env.CLAUDE_CONFIG_DIR;
fs.appendFileSync(process.env.SMOKE_CLI_LOG,JSON.stringify({args,root,at:new Date().toISOString()})+'\\n');
const allowed=root&&(root.startsWith(process.env.SMOKE_OWNED_ROOT+path.sep)||root.startsWith(process.env.AGEND_HOME+path.sep));
if(!allowed){console.error('refused unowned credential home');process.exit(97)}
if(args.includes('--version')){console.log('2.1.319 (Claude Code)');process.exit(0)}
if(args[0]==='auth'&&args[1]==='logout'){for(const f of ['.credentials.json','.claude.json'])fs.rmSync(path.join(root,f),{force:true});console.log('Successfully logged out');process.exit(0)}
if(args[0]==='auth'&&args[1]==='status'){let c;try{c=JSON.parse(fs.readFileSync(path.join(root,'.credentials.json'),'utf8'))}catch{}const on=!!c?.claudeAiOauth?.accessToken;console.log(JSON.stringify({loggedIn:on,authMethod:on?'oauth_token':'none',apiProvider:'firstParty',email:on?'fixture@example.invalid':undefined,subscriptionType:on?'max':undefined}));process.exit(on?0:1)}
console.error('mock refuses unsupported Claude invocation');process.exit(97);
`);
const guard = `#!${process.execPath}\nrequire('fs').appendFileSync(process.env.SMOKE_GUARD_LOG,JSON.stringify({binary:process.argv[1],args:process.argv.slice(2)})+'\\n');process.exit(97);\n`;
for (const name of ["tmux", "codex", "kiro-cli", "agend-private-tmux"]) writeFileSync(join(bin, name), guard);
for (const name of ["claude", "tmux", "codex", "kiro-cli", "agend-private-tmux"]) chmodSync(join(bin, name), 0o755);
process.env.PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
process.env.AGEND_TMUX_BIN = join(bin, "agend-private-tmux");

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 16 << 20 }).trim();
const oldCssRef = process.env.OLD_CSS_REF ?? "b47cad34a";
const result: any = { startedAt: new Date().toISOString(), source: git("rev-parse", "HEAD"), sourceDirty: git("status", "--short", "--", "src", "tests"),
  browser: null, owned, cases: [], failures: [], limits: ["Fake signed-in Claude firstParty OAuth profiles are seeded directly; provider login and model reasoning are not exercised.",
    "The production HTTP routes, Settings confirmation gate, Apply plan/job/reconcile and profile removal run normally; only native stop/start are recorded stubs.",
    "Sign out runs an owned logout-only mock Claude subprocess. No real CLI/native agent process is relaunched and no real provider account is contacted.",
    "Browser HTTP requests are restricted to the fixture loopback origin. A private tmux guard refuses all tmux invocations."] };
const beforeDest = join(out, "before-b5-earlier-alpha-2b4b33d22.png");
const before = resolve(process.env.BEFORE_PNG ?? beforeDest);
if (existsSync(before)) {
  if (before !== beforeDest) copyFileSync(before, beforeDest);
  result.before = { screenshot: "before-b5-earlier-alpha-2b4b33d22.png", source: "2b4b33d22", evidenceCheckout: "74865e076", copiedFrom: before,
    sha256: createHash("sha256").update(readFileSync(before)).digest("hex"), note: "Earlier fresh-process B5 rejection evidence; not a same-base 06f60b079 capture." };
}

const { bootFixture } = await import("../smoke-fixture/index.mts");
const words = {
  en: { stage: "Stage", save: "Save", signout: "Sign out", move: "Move…", done: "Done", remove: "Remove" },
  "zh-TW": { stage: "加入待儲存", save: "儲存", signout: "登出", move: "移動…", done: "完成", remove: "移除" },
};
const cases = [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" },
  { device: "desk", theme: "light", lang: "en", skew: true }] as const;
const until = async (fn: () => unknown, label: string, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); } throw Error("timed out: " + label); };
const seed = (root: string) => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access-" + "c".repeat(40), refreshToken: "fixture-refresh-" + "r".repeat(40),
    expiresAt: Date.now() + 3600000, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }));
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001", emailAddress: "fixture@example.invalid" }, numStartups: 1 }));
};

for (const [index, c] of cases.entries()) {
  let fx: any, page: any;
  const tag = `${c.device}-${c.theme}-${c.lang}${"skew" in c ? "-skew-old-app-css" : ""}`, w = words[c.lang];
  const r: any = { tag, requests: [], lifecycle: [], pageErrors: [], browserDialogs: [], assertions: {}, screenshots: [], cssRequests: 0 };
  result.cases.push(r);
  const check = (name: string, ok: unknown, detail?: unknown) => { r.assertions[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) throw Error(name + ": " + JSON.stringify(detail)); };
  const shot = async (name: string, target?: any) => {
    // Let transient staging/success notices expire normally: a stale “not saved yet” toast must not obscure proof.
    await until(() => page.locator(".toasts .toast").count().then((n: number) => n === 0), "toasts expired", 7000);
    if (target) await target.scrollIntoViewIfNeeded(); await page.waitForTimeout(220);
    const file = `${tag}-${name}.png`; await page.screenshot({ path: join(out, file) }); r.screenshots.push(file);
  };
  try {
    fx = await bootFixture({ port: Number(process.env.HP ?? 49150) + index * 2, instances: 2, classic: false });
    const { InstanceLifecycle } = await import(repo + "/src/instance-lifecycle.ts");
    result.browser ??= fx.browser.version(); r.ports = [Number(new URL(fx.base).port), Number(new URL(fx.base).port) + 1];
    const fm = fx.fm, cfgPath = join(fx.dir, "fleet.yaml"), cfg: any = yaml.load(readFileSync(cfgPath, "utf8"));
    const worker = fx.instances.find((i: any) => !i.general)!.name; r.instance = worker;
    for (const inst of Object.values(cfg.instances) as any) { inst.backend = "claude-code"; delete inst.backend_options; }
    writeFileSync(cfgPath, yaml.dump(cfg)); fm.loadConfig(cfgPath);
    const profiles = join(fx.dir, "credential-profiles/claude-code");
    seed(process.env.CLAUDE_CONFIG_DIR!); seed(join(profiles, "old-work")); seed(join(profiles, "personal"));
    fm.refreshSignInIdentities = () => {}; // Profiles already seeded; logout itself still invokes the real mock CLI.
    fm.lifecycle = new InstanceLifecycle(fm); fm.startupComplete = true;
    const runtime = new Map<string, any>();
    const daemon = (name: string) => ({ getConfigSnapshot: () => runtime.get(name), getProcessStatus: () => "running", applyConfigUpdate: (update: any) => Object.assign(runtime.get(name), update) });
    for (const [name, config] of Object.entries(fm.fleetConfig.instances)) { runtime.set(name, structuredClone(config)); fm.lifecycle.daemons.set(name, daemon(name)); }
    fm.stopInstance = async (name: string) => { r.lifecycle.push({ action: "stop", name }); fm.lifecycle.daemons.delete(name); return { backgroundWorkEnded: false }; };
    fm.startInstanceUnattended = async (name: string, config: any, topicMode: string, reason: string) => {
      r.lifecycle.push({ action: "start", name, profile: config.backend_options?.["claude-code"]?.credential_profile ?? null, reason });
      runtime.set(name, structuredClone(config)); fm.lifecycle.daemons.set(name, daemon(name));
    };
    fm.startInstance = async () => { throw Error("unexpected native startInstance"); };
    fm.webPrefs.write("operator", new Map([["theme", c.theme], ["lang", c.lang]]));
    const ctx = await fx.browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, colorScheme: c.theme,
      locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", isMobile: c.device === "phone", hasTouch: c.device === "phone" });
    await ctx.addInitScript({ content: `window.__name=(fn)=>fn;localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");localStorage.setItem("agend_lang",${JSON.stringify(c.lang)});window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));` });
    const oldCss = "skew" in c ? git("show", `${oldCssRef}:src/ui/shared/app.css`) : null;
    if (oldCss) { r.cssRef = oldCssRef; r.cssSha256 = createHash("sha256").update(oldCss).digest("hex"); }
    await ctx.route("**/*", (route: any) => {
      const u = new URL(route.request().url());
      if (u.origin !== fx.base) return route.abort();
      if (oldCss && u.pathname === "/assets/app.css") { r.cssRequests++; return route.fulfill({ status: 200, contentType: "text/css", body: oldCss }); }
      return route.continue();
    });
    page = await ctx.newPage();
    page.on("pageerror", (e: any) => r.pageErrors.push(String(e)));
    page.on("dialog", async (d: any) => { r.browserDialogs.push({ type: d.type(), message: d.message() }); await d.dismiss(); });
    const responses: Promise<void>[] = [];
    page.on("response", (response: any) => {
      const u = new URL(response.url()), req = response.request();
      if (u.origin !== fx.base || !u.pathname.match(/^\/(api\/settings|ui\/accounts)/) || req.method() === "GET") return;
      responses.push((async () => { r.requests.push({ method: req.method(), path: u.pathname, status: response.status(), request: req.postData(), response: await response.json().catch(() => null) }); })());
    });
    const issued = await fetch(fx.base + "/auth/issue-code", { method: "POST", headers: { "x-agend-token": fm.getDashboardAccess().token, origin: fx.base } });
    if (!issued.ok) throw Error("issue host-owner code HTTP " + issued.status);
    const { code } = await issued.json() as any;
    await page.goto(fx.base + "/signin"); await page.fill("#code", code); await page.click("#go"); await page.waitForURL(fx.base + "/ui");
    r.authority = await page.evaluate(async () => await (await fetch("/ui/authorization")).json());
    check("verified-host-owner", r.authority.state === "verified", r.authority);
    await page.goto(fx.base + "/settings/agents"); await page.waitForSelector(".s-ai-accounts");
    if (!(await page.locator(".s-ai-accounts").getAttribute("open"))) { if (!(await page.locator(".s-ai-accounts").evaluate((e: any) => e.open))) await page.locator(".s-ai-accounts > summary").click(); }
    const row = (profile: string) => page.locator(`.s-account-card[data-backend="claude-code"] .s-account-row[data-account="${profile}"]`);
    await row("personal").waitFor();
    const readProfile = () => (yaml.load(readFileSync(cfgPath, "utf8")) as any).instances[worker].backend_options?.["claude-code"]?.credential_profile;
    r.initialProfile = readProfile() ?? null;
    check("starts-on-default-account", readProfile() === undefined);
    const save = async (profile: string, expectedRestarts: number) => {
      await page.getByRole("button", { name: w.save, exact: true }).click();
      await until(() => readProfile() === profile && r.lifecycle.filter((x: any) => x.action === "start").length === expectedRestarts, "saved profile and restart");
      await until(async () => { await Promise.all(responses); const jobs = r.requests.filter((x: any) => x.path === "/api/settings/apply" && x.method === "POST"); return jobs.length === expectedRestarts && fm.applyJobs.get(jobs.at(-1)?.response?.id)?.status === "done"; }, "real Apply job done");
      await until(() => page.locator("dialog[open]").count().then((n: number) => n === 0), "no new confirmation dialog");
      const apply = r.requests.filter((x: any) => x.path === "/api/settings/apply").at(-1);
      const job = structuredClone(fm.applyJobs.get(apply.response.id)); (r.jobs ??= []).push(job);
      check(`save-${profile}-persisted`, readProfile() === profile);
      check(`save-${profile}-one-worker-restart`, r.lifecycle.length === expectedRestarts * 2 && r.lifecycle.every((x: any) => x.name === worker), r.lifecycle);
      check(`save-${profile}-real-plan`, job.targets.length === 1 && job.targets[0].target === worker && job.targets[0].kind === "restart" && job.targets[0].status === "done", job);
      const pending = fm.settingsConfirmation?.store.listBySource("web_session") ?? [];
      (r.pendingAfterSave ??= []).push({ profile, count: pending.length });
      check(`save-${profile}-no-pending`, pending.length === 0 && !r.requests.some((x: any) => x.response?.pending_change || (x.status === 202 && x.path !== "/api/settings/apply")) && r.browserDialogs.length === 0);
      await page.waitForTimeout(1100);
    };

    // B5: actual Accounts Move → Stage → Save, including the production gate and Apply execution.
    await row("personal").getByRole("button", { name: c.lang === "en" ? "Move agents here…" : "把 Agent 移到這裡…", exact: true }).click();
    await page.waitForSelector("dialog[open] .s-account-move");
    await page.locator("dialog[open] .s-account-move li").filter({ hasText: worker }).locator('input[type="checkbox"]').check();
    await shot("b5-01-move-stage");
    await page.locator("dialog[open]").getByRole("button", { name: w.stage, exact: true }).click();
    await save("personal", 1); await shot("b5-02-saved-restarted", row("personal"));

    if (!("skew" in c)) {
      // B7: the real logout route invokes only our logout mock. Remove names the agent and links to its real editor.
      await row("personal").locator(".s-account-signout").click(); await page.waitForSelector("dialog[open]");
      await shot("b7-01-signout");
      await page.locator("dialog[open]").getByRole("button", { name: w.signout, exact: true }).click();
      await until(() => !existsSync(join(profiles, "personal/.credentials.json")), "mock logout removed fake token");
      await until(() => page.locator("dialog[open]").count().then((n: number) => n === 0), "logout dialog closed");
      await row("personal").locator(".s-account-remove").click(); await page.waitForSelector("dialog[open] .s-account-inuse");
      check("remove-guard-names-agent", (await page.locator("dialog[open] .s-account-inuse").innerText()).includes(worker));
      check("remove-guard-no-name-input", await page.locator("#acctRemoveName").count() === 0);
      check("remove-guard-disabled", await page.locator("dialog[open]").getByRole("button", { name: w.remove, exact: true }).isDisabled());
      await shot("b7-02-remove-in-use");
      await page.locator("dialog[open] .s-account-inuse li").filter({ hasText: worker }).getByRole("button", { name: w.move, exact: true }).click();
      await page.waitForSelector("#ag-account"); await page.selectOption("#ag-account", "old-work"); await shot("b7-03-agent-account-move");
      await page.locator("dialog[open]").getByRole("button", { name: w.done, exact: true }).click();
      await save("old-work", 2); await shot("b7-04-saved-restarted", row("old-work"));
      await row("personal").locator(".s-account-remove").click(); await page.waitForSelector("#acctRemoveName");
      await page.fill("#acctRemoveName", "personal"); await shot("b7-05-remove-unused");
      await page.locator("dialog[open]").getByRole("button", { name: w.remove, exact: true }).click();
      await until(() => !existsSync(join(profiles, "personal")), "profile removed by real DELETE route");
      await until(() => row("personal").count().then((n: number) => n === 0), "removed account row gone");
      await shot("b7-06-unused-removed", row("old-work"));
      check("unused-profile-removed", !existsSync(join(profiles, "personal")));
      check("used-profile-kept", existsSync(join(profiles, "old-work/.credentials.json")) && readProfile() === "old-work");
    }
    await Promise.all(responses);
    check("http-writes-successful", r.requests.every((x: any) => x.status >= 200 && x.status < 300 && (x.status !== 202 || x.path === "/api/settings/apply")), r.requests);
    check("no-page-errors", r.pageErrors.length === 0, r.pageErrors);
    check("no-browser-confirmations", r.browserDialogs.length === 0, r.browserDialogs);
    r.csp = await page.evaluate(() => (window as any).__csp); check("no-csp-violations", r.csp.length === 0, r.csp);
    r.pageWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    check("no-horizontal-overflow", r.pageWidth.scroll <= r.pageWidth.client + 1, r.pageWidth);
    if ("skew" in c) check("old-css-served", r.cssRequests > 0);
    r.status = "PASS"; console.log("PASS", tag);
  } catch (e: any) {
    r.status = "FAIL"; r.error = String(e.stack ?? e); result.failures.push(tag); console.error("FAIL", tag, r.error);
    if (page) await shot("ERROR").catch(() => {});
  } finally {
    if (fx) { fx.fm.settingsConfirmation?.store.close(); fx.fm.stormWindow.shutdown(); fx.fm.spawnGate.shutdown(); await fx.close(); }
    r.stopped = true;
    writeFileSync(join(owned, `${tag}.json`), JSON.stringify(r, null, 2) + "\n");
  }
}
result.cli = existsSync(cliLog) ? readFileSync(cliLog, "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
result.nativeGuards = existsSync(guardLog) ? readFileSync(guardLog, "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
if (result.nativeGuards.length) result.failures.push("unexpected native command (safely refused)");
result.finishedAt = new Date().toISOString(); result.status = result.failures.length ? "FAIL" : "PASS";
const report = join(artifacts, "browser-results.json"); writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
console.log(result.status, report); process.exit(result.failures.length ? 1 : 0);
