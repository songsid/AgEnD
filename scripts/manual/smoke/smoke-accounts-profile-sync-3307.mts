/** #3307 sync: real shell + production HTTP/session gates/WebBackendLogins/LoginController.
 * Synthetic account rows, auth probes and terminal boundary; no real CLI/account/vendor/tmux.
 * REPO=$PWD PW_DIR=<owned dir with node_modules/playwright-core> npx tsx <this file>
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repo = resolve(process.env.REPO || "."), out = join(repo, "docs/screenshots/accounts-profile-sync-3307");
const artifacts = join(repo, ".artifacts/accounts-profile-signin-3307");
mkdirSync(out, { recursive: true }); mkdirSync(artifacts, { recursive: true });
const owned = mkdtempSync(join(artifacts, "browser-")), bin = join(owned, "bin"), home = join(owned, "home");
mkdirSync(bin); mkdirSync(home);
for (const key of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI|AWS|KIRO|CLAUDE|CODEX)_/.test(key)) delete process.env[key];
Object.assign(process.env, { REPO: repo, HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), NOTIFY_SOCKET: "" });
// Defense in depth: anything accidentally reaching a backend/tmux executable refuses.
writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
for (const name of ["claude", "codex", "kiro-cli", "tmux"]) {
  writeFileSync(join(bin, name), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(owned, "refused.jsonl"))},JSON.stringify(process.argv.slice(1))+'\\n');process.exit(97);\n`);
  chmodSync(join(bin, name), 0o755);
}
process.env.PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
process.env.AGEND_TMUX_BIN = join(bin, "tmux");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"] });
const oldRef = process.env.OLD_REF || "v2.3.5-alpha.10";
const { bootFixture } = await import("../smoke-fixture/index.mts");
const { LoginController } = await import(repo + "/src/login-controller.ts");
const { LoginWindowLock } = await import(repo + "/src/login-window-lock.ts");
const fx = await bootFixture({ port: Number(process.env.HP || 49370), instances: 2, classic: false });
const fm = fx.fm, terminals: any[] = [], probes: unknown[] = [], recovery: unknown[] = [];
const lock = new LoginWindowLock();
class Terminal extends EventEmitter {
  state = "created";
  constructor(readonly spec: any, readonly events: any) { super(); }
  async start() { this.state = "running"; }
  peekAccessToken() { return this.state === "finished" ? null : "ABCDEFGHJKMNPQRSTVWX"; }
  async cancel(detail = "cancelled") { await this.finish({ ok: false, reason: "cancel", detail }); }
  async finish(result: any) { if (this.state === "finished") return; this.state = "finished"; this.emit("finished", result); await this.events.onDone(result); }
}
fm.isCliInstalledOffLoop = async () => true;
fm.refreshSignInIdentities = () => {};
fm.backendSignInTargets = () => [];
fm.loginController = new LoginController({
  logger: fm.logger, fleetConfig: () => fm.fleetConfig, isFleetAdmin: () => false, eventLog: () => null,
  recoverBackendInstances: async (backend: string, profile: string) => { recovery.push({ backend, profile }); return { woken: [], restarted: [], pending: [] }; },
  claimWindow: (backend: string) => lock.tryClaim("web", backend), releaseWindow: (claim: any) => lock.release(claim),
  isClaimCurrent: (claim: any) => lock.isCurrent(claim), windowBusyMessage: () => lock.busyMessage(),
  checkAuth: async (check: any, env: any) => { probes.push({ argv: check.argv, env }); return "invalid"; },
  postButtons: async () => { throw Error("dashboard must use its session sink"); },
  createSession: (spec: any, events: any) => { const t = new Terminal(spec, events); terminals.push(t); return t; },
  createHttp: () => ({ listen: async () => ({ port: 49371, url: fx.base + "/t/" + "ab".repeat(16) + "/" }), close: async () => {}, setExternalHost() {}, readinessMarker: "ready" }),
} as any);
const usedBy = { agents: [], classic: [], fleetDefault: false };
fm.accountsView = async () => ({ clis: ["codex", "kiro-cli"].map(backend => ({ backend, profiles: true, installed: true, fleetDefault: null, agents: [],
  rows: [{ scope: { kind: "host" }, backend, profile: "work", state: "not_signed_in", signIn: true, usedBy }] })) });
const results: any = { browser: fx.browser.version(), oldRef, limits: "Synthetic rows/auth/terminal boundary; production HTTP/session gates and shared login controller. No real CLI/vendor/account or install evidence.", cases: [], probes, recovery };
try {
  for (const skew of [false, true]) for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
    const tag = `${c.device}-${c.lang}-${skew ? "skew" : "current"}`, r: any = { tag, requests: [], servedOld: [], errors: [] };
    results.cases.push(r);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    await ctx.route("**/*", (route: any) => new URL(route.request().url()).origin === fx.base ? route.continue() : route.abort());
    page.on("pageerror", (e: any) => r.errors.push(String(e)));
    page.on("request", (req: any) => { if (req.method() === "POST" && req.url().includes("/ui/")) r.requests.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() }); });
    if (skew) {
      await page.route("**/assets/**", (route: any) => {
        const path = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
        let body: string; try { body = git("show", `${oldRef}:src/ui/shared/${path}`); } catch { return route.continue(); }
        r.servedOld.push(path); return route.fulfill({ status: 200, contentType: path.endsWith(".css") ? "text/css" : "text/javascript", body });
      });
      await page.route(/\/ui\/js\/(backend-signin|cli-caps)\.js(?:\?.*)?$/, (route: any) => {
        const file = new URL(route.request().url()).pathname.split("/").pop()!;
        r.servedOld.push(file); return route.fulfill({ status: 200, contentType: "text/javascript", body: git("show", `${oldRef}:src/ui/${file}`) });
      });
    }
    await page.reload();
    await page.waitForSelector(".s-account-row", { state: "attached", timeout: 20000 });
    await page.evaluate(() => document.querySelectorAll(".p-settings details").forEach(d => { (d as HTMLDetailsElement).open = true; }));
    for (const backend of ["codex", "kiro-cli"]) {
      const row = page.locator(`.s-account-card[data-backend="${backend}"] .s-account-row[data-account="work"]`);
      await row.locator(".s-actions button").first().click();
      const dialog = page.locator("dialog[open]");
      await dialog.locator(".btn-primary").waitFor();
      assert((await dialog.innerText()).includes("work"));
      assert(r.requests.some((q: any) => q.path === "/ui/backend-login/check" && q.body.backend === backend && q.body.profile === "work"));
      assert(!r.requests.some((q: any) => q.path === "/ui/browser-backend-signins"), "must keep the original /login flow");
      await page.screenshot({ path: join(out, `${tag}-${backend}-confirm.png`) });
      await dialog.locator(".btn-primary").click();
      const deadline = Date.now() + 5000;
      while (terminals.at(-1)?.spec.backend !== backend || terminals.at(-1)?.state !== "running") { assert(Date.now() < deadline); await new Promise(r => setTimeout(r, 20)); }
      const terminal = terminals.at(-1)!;
      assert(terminal.spec.command.includes(backend === "codex" ? "CODEX_HOME=" : "XDG_DATA_HOME="));
      if (backend === "codex") await terminal.events.onHint("https://auth.openai.com/codex/device", "ABCD-1234");
      await page.waitForFunction((b: string) => document.querySelector("dialog[open]")?.textContent?.includes(b === "codex" ? "ABCD-1234" : "ABCDEFGHJKMNPQRSTVWX"), backend);
      if (!skew) await page.screenshot({ path: join(out, `${tag}-${backend}-running.png`) });
      await terminal.finish({ ok: true, reason: "exit", detail: "synthetic success" });
      await page.waitForFunction(() => !!document.querySelector("dialog[open] .signin-ok"));
      await dialog.locator(".dlg-actions button").first().click();
    }
    assert.equal(r.errors.length, 0); assert.equal((await csp()).length, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (skew) assert(r.servedOld.includes("backend-signin.js") && r.servedOld.includes("cli-caps.js") && r.servedOld.includes("app.css"));
    r.pass = true; await ctx.close();
  }
} finally {
  writeFileSync(join(artifacts, "browser-results.json"), JSON.stringify(results, null, 2) + "\n");
  await fx.close();
}
console.log(JSON.stringify({ cases: results.cases.map((r: any) => ({ tag: r.tag, pass: r.pass })), probes: probes.length, recoveries: recovery.length }));
