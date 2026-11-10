// Actual Settings shell + HTTP gate + per-admin TOTP core; only Accounts inventory and installer dispatch are synthetic.
// BEFORE=1 REPO=<1be11da9 checkout> captures the original immediate install. No CLI, real account or fleet start.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootFixture, caseName, matrix, freshPage } from "../smoke-fixture/index.mts";

const repo = process.env.REPO!, out = process.env.OUT!;
mkdirSync(out, { recursive: true });
const before = process.env.BEFORE === "1";
const fx = await bootFixture({ port: Number(process.env.HP ?? 47684), instances: 4, classic: false, host: true });
const fm = fx.fm as any;
const { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } = await import(repo + "/src/web-remote-access.ts");
const secret = base32Encode(Buffer.from("m2793-owned-fixture!!"));
const ownCode = () => hotp(base32Decode(secret)!, totpStep(Date.now()));
let starts = 0;
fm.accountsView = async () => ({ clis: [{ backend: "grok", profiles: false, installed: false, fleetDefault: null, agents: [], rows: [{
  scope: { kind: "host" }, backend: "grok", profile: null, state: "not_installed", signIn: false,
  usedBy: { agents: [], classic: [], fleetDefault: false }, install: "inert fixture; never run",
}] }] });
fm.promptSettingsChange = async () => undefined;
fm.startWebInstall = async (_backend: string, _reporter: unknown, execution?: any) => {
  if (!before && !execution) throw Error("missing Settings execution");
  execution?.complete(); starts++; return { started: true };
};
const results: unknown[] = [];
try {
  fm.saveFleetConfig([{ path: ["web", "verified_authority", "enabled"], value: true }, { path: ["web", "verified_authority", "loopback_only"], value: false }]);
  for (const c of matrix("desk-light-en,desk-light-zh-TW,phone-dark-en,phone-dark-zh-TW")) for (const skew of before ? [false] : [false, true]) {
    starts = 0; fm.webHostInstallsInstance = undefined;
    writeFileSync(join(fx.dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret, enrolledAt: 1, lastStep: 0, strict: true }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
    fm.webRemoteAccessState = undefined;
    const name = `${before ? "before" : skew ? "skew" : "after"}-${caseName(c)}`;
    let oldReads = 0;
    const p = await freshPage(fx, c, { origin: "lan", account: "operator", path: "/settings/agents", beforeNavigate: async (ctx: any, page: any) => {
      await ctx.setExtraHTTPHeaders({ "X-Forwarded-For": "192.0.2.20" });
      await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
      await ctx.route("**/*", (r: any) => ["dashboard.lan.example", "127.0.0.1"].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort());
      if (skew) for (const f of ["app.js", "app-shell.js", "app-i18n.js", "app.css"]) {
        const body = execFileSync("git", ["-C", repo, "show", `v2.3.5-alpha.10:src/ui/shared/${f}`], { encoding: "utf8" });
        await page.route(`**/assets/${f}*`, (r: any) => { oldReads++; return r.fulfill({ status: 200, contentType: f.endsWith("css") ? "text/css" : "text/javascript", body }); });
      }
    } });
    try {
      const page = p.page;
      const expectedWrong: string[] = [];
      const summary = page.locator(".s-ai-accounts > summary");
      await summary.waitFor();
      if (!await page.locator(".s-ai-accounts").evaluate((n: any) => n.open)) await summary.click();
      const button = page.locator('.s-account-card[data-backend="grok"] .s-account-install');
      await button.waitFor(); await button.scrollIntoViewIfNeeded();
      await button.click();
      if (before) {
        await page.waitForSelector(".s-account-install-run");
        if (starts !== 1) throw Error("before did not reproduce immediate install");
        await page.screenshot({ path: join(out, `${name}-immediate.png`) });
      } else {
        await page.waitForSelector(".pending-code-input");
        await page.waitForFunction(() => { const r = document.querySelector(".pending-code-input")?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight; });
        if (starts !== 0) throw Error("installer started before own code");
        const controls = await page.locator(".pending-card").evaluate((n: any) => Array.from(n.querySelectorAll("input,button")).map((b: any) => ({ text: b.textContent, height: b.getBoundingClientRect().height })));
        if (c.device === "phone" && controls.some((b: any) => b.height < 44)) throw Error(JSON.stringify(controls));
        await page.screenshot({ path: join(out, `${name}-code.png`) });
        const wrong = ownCode() === "000000" ? "000001" : "000000";
        await page.fill(".pending-code-input", wrong);
        const rejected = page.waitForResponse((r: any) => r.request().method() === "POST" && r.url().endsWith("/confirm-totp"));
        await page.click("form.pending-code button[type=submit]");
        const refusal = await rejected;
        if (refusal.status() !== 401) throw Error(`wrong-code status ${refusal.status()}`);
        expectedWrong.push(refusal.url());
        await page.waitForFunction(() => !!document.querySelector(".pending-card [role=alert]")?.textContent);
        if (starts !== 0) throw Error("wrong code started installer");
        if (await page.evaluate(() => (window as any).AgendAuth.sessionEnded())) throw Error("wrong code ended the browser session");
        await page.locator(".pending-card").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(out, `${name}-wrong.png`) });
        await page.fill(".pending-code-input", ownCode()); await page.click("form.pending-code button[type=submit]");
        await page.waitForSelector(".pending-card.applied");
        if (starts !== 1) throw Error(`own code dispatch count ${starts}`);
        await page.locator(".pending-card").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(out, `${name}-applied.png`) });
        if (skew && oldReads < 4) throw Error(`incomplete SKEW ${oldReads}`);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      const unexpected = p.errors.filter(e => !(e.includes("401 (Unauthorized)") && expectedWrong.some(url => e.endsWith("@ " + url))));
      if (overflow || unexpected.length) throw Error(JSON.stringify({ overflow, errors: unexpected }));
      results.push({ name, starts, oldReads, expectedWrong, observedErrors: p.errors, pass: true });
    } finally { await p.ctx.close(); }
  }
  writeFileSync(join(out, "results.json"), JSON.stringify({ source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), before, browser: fx.browser.version(), scope: "Actual shell/HTTP/settings/TOTP core; synthetic inventory+installer, no real CLI/fleet/account. Cached shared assets only, current lazy host-install/settings-confirm modules.", results }, null, 2) + "\n");
  console.log(JSON.stringify({ cases: results.length, out, pass: true }));
} finally { await fx.close(); }
