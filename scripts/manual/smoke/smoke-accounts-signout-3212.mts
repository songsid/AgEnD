// #3212 PR 3 acceptance: Settings → Accounts → Sign out…, on the realistic fixture (never `fleet start`), with the REAL
// Claude Code, Codex and Kiro logouts run by the fleet on scratch credential profiles holding fake tokens (`c` × 40).
// SAFETY: refuses to run unless HOME is a scratch directory (so no default sign-in of this host can be reached) and the
// process has no outside network (run it inside `unshare -rn` with loopback up) — no vendor is contacted, no real
// account is involved. The default sign-ins are never signed out here (their dialogs are covered by the unit tests).
// - desk light (en): Claude Code "work" (an agent uses it): the dialog names the account and who stops; Sign out runs
//   `claude auth logout` with its folder — `.credentials.json` and its backups gone, its conversations kept, the row now
//   "not signed in". Codex "team" (`codex logout`: auth.json gone) and Kiro "kiro1" (`kiro-cli logout`: token rows gone).
// - phone dark (zh-TW): the same for Claude Code "work2".
// - the stale-tab skew: an old cached accounts-view.js (OLD_REF) with today's server (no Sign out, nothing broken).
// No raw string key, no page error, no CSP report, no page-level horizontal scroll.
//   unshare -rn sh -c 'ip link set lo up && exec env HOME=<scratch> PATH="$PATH" PW_DIR=… REPO=<checkout> OUT=<dir> \
//     [OLD_REF=…] FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-accounts-signout-3212.mts'
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

// ── safety first ──
const home = process.env.HOME ?? "";
if (!home.startsWith(tmpdir()) && !home.includes("/scratchpad/")) { console.error(`refusing: HOME (${home}) is not a scratch directory`); process.exit(2); }
for (const v of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME"]) if (process.env[v]) { console.error(`refusing: ${v} is set`); process.exit(2); }
const reachable = await new Promise<boolean>((resolve) => {
  const s = createConnection({ host: "1.1.1.1", port: 443, timeout: 3000 }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false)); s.on("timeout", () => { s.destroy(); resolve(false); });
});
if (reachable) { console.error("refusing: the outside network is reachable — run inside `unshare -rn` with loopback up"); process.exit(2); }

const { bootFixture, shotPath } = await import("../smoke-fixture/index.mts");
const SMOKE = "smoke-accounts-signout-3212";
const REPO = process.env.REPO!, OLD_REF = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48740), instances: 2 });
const fm = fx.fm as any;
const name = fx.instances.find((i: any) => !i.general)!.name;
const C40 = "c".repeat(40);
const prof = (cli: string, p: string) => join(fm.dataDir, "credential-profiles", cli, p);
function seedClaude(p: string) {
  const d = prof("claude-code", p); mkdirSync(join(d, "projects", "-tmp-x"), { recursive: true, mode: 0o700 });
  writeFileSync(join(d, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: C40, refreshToken: C40, expiresAt: Date.now() + 86_400_000, scopes: ["user:inference"] } }));
  writeFileSync(join(d, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001", emailAddress: "probe@example.com" }, numStartups: 1 }));
  writeFileSync(join(d, "projects", "-tmp-x", "s.jsonl"), "{}\n");
}
seedClaude("work"); seedClaude("work2");
mkdirSync(prof("codex", "team"), { recursive: true, mode: 0o700 });
writeFileSync(join(prof("codex", "team"), "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: C40, access_token: C40, refresh_token: C40, account_id: "00000000-0000-4000-8000-000000000003" } }));
mkdirSync(join(prof("codex", "team"), "sessions"), { recursive: true }); writeFileSync(join(prof("codex", "team"), "sessions", "r.jsonl"), "{}\n");
// Kiro: its own store made by kiro-cli (offline), then a fake token row.
mkdirSync(prof("kiro-cli", "kiro1"), { recursive: true, mode: 0o700 });
try { execFileSync("kiro-cli", ["whoami"], { env: { ...process.env, XDG_DATA_HOME: prof("kiro-cli", "kiro1") }, stdio: "ignore", timeout: 30_000, killSignal: "SIGINT" }); } catch { /* "Not logged in" exits 1 */ }
const Database = (await import(REPO + "/node_modules/better-sqlite3/lib/index.js")).default;
const kiroDb = () => new Database(join(prof("kiro-cli", "kiro1"), "kiro-cli", "data.sqlite3"));
{ const db = kiroDb(); db.prepare("INSERT OR REPLACE INTO auth_kv(key, value) VALUES (?, ?)").run("kirocli:social:token", JSON.stringify({ access_token: C40, refresh_token: C40, expires_at: "2099-01-01T00:00:00Z", region: "us-east-1", provider: "Github" })); db.close(); }
const kiroTokens = () => { const db = kiroDb(); try { return (db.prepare("SELECT count(*) AS n FROM auth_kv WHERE key LIKE '%:token'").get() as { n: number }).n; } finally { db.close(); } };
const cfgPath = join(fm.dataDir, "fleet.yaml");
const cfg = yaml.load(readFileSync(cfgPath, "utf8")) as any;
cfg.instances[name].backend = "claude-code";
cfg.instances[name].backend_options = { "claude-code": { credential_profile: "work" } };
writeFileSync(cfgPath, yaml.dump(cfg)); fm.loadConfig(cfgPath);
fm.refreshSignInIdentities = () => {};

const r: Record<string, unknown> = { browser: fx.browser.version(), oldRef: OLD_REF, instance: name, network: "blocked", home: "scratch" };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };

async function open(c: any, route?: (page: any) => Promise<void>) {
  const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
  const errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  if (route) { await route(page); await page.reload(); }
  await page.waitForSelector(".s-ai-accounts", { timeout: 20000 });
  await page.evaluate(`(() => { const d = document.querySelector("details.s-ai-accounts"); if (d && !d.open) d.querySelector("summary").click(); })()`);
  await page.waitForSelector(".s-account-card", { timeout: 15000 }); await page.waitForTimeout(600);
  return { ctx, page, csp, errs };
}
const shotSection = (page: any, path: string) => page.locator("details.s-ai-accounts").screenshot({ path }).catch(() => page.screenshot({ path }));
const stateOf = (page: any, cli: string, acct: string) => page.evaluate(`document.querySelector('.s-account-card[data-backend="${cli}"] .s-account-row[data-account="${acct}"] .s-auth-state')?.textContent || ""`);
async function signOut(page: any, cli: string, acct: string, go: string) {
  await page.click(`.s-account-card[data-backend="${cli}"] .s-account-row[data-account="${acct}"] .s-account-signout`);
  await page.waitForSelector("dialog[open]", { timeout: 5000 });
  const said = await page.evaluate(`document.querySelector("dialog[open]").innerText`);
  await page.waitForTimeout(300);
  await page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.trim() === ${JSON.stringify(go)}).click()`);
  const closed = await page.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 60000 }).then(() => true, () => false);
  await page.waitForTimeout(1200);
  return { said, closed };
}

try {
  {
    const c = { device: "desk", theme: "light", lang: "en" }, tag = "desk-light-en";
    const o = await open(c);
    await shotSection(o.page, shotPath(SMOKE, tag, "1-accounts"));
    const before = { work: await stateOf(o.page, "claude-code", "work"), team: await stateOf(o.page, "codex", "team"), kiro1: await stateOf(o.page, "kiro-cli", "kiro1") };
    await o.page.click('.s-account-card[data-backend="claude-code"] .s-account-row[data-account="work"] .s-account-signout');
    await o.page.waitForSelector("dialog[open]", { timeout: 5000 }); await o.page.waitForTimeout(400);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "2-sign-out-dialog") });
    await o.page.keyboard.press("Escape"); await o.page.waitForTimeout(400);
    const claude = await signOut(o.page, "claude-code", "work", "Sign out");
    const codex = await signOut(o.page, "codex", "team", "Sign out");
    const kiro = await signOut(o.page, "kiro-cli", "kiro1", "Sign out");
    await o.page.evaluate(`document.querySelector('.s-account-card[data-backend="codex"]').scrollIntoView({ block: "center" })`); await o.page.waitForTimeout(300);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "3-signed-out") });
    const after = { work: await stateOf(o.page, "claude-code", "work"), team: await stateOf(o.page, "codex", "team"), kiro1: await stateOf(o.page, "kiro-cli", "kiro1") };
    const w = prof("claude-code", "work");
    const disk = { claudeCreds: existsSync(join(w, ".credentials.json")), claudeBackups: existsSync(join(w, "backups")) ? readdirSync(join(w, "backups")).filter((f) => f.startsWith(".claude.json.backup")) : [],
      claudeIdentity: readFileSync(join(w, ".claude.json"), "utf8").includes("probe@example.com"), claudeConversation: existsSync(join(w, "projects", "-tmp-x", "s.jsonl")),
      codexAuth: existsSync(join(prof("codex", "team"), "auth.json")), codexSessions: existsSync(join(prof("codex", "team"), "sessions", "r.jsonl")), kiroTokens: kiroTokens() };
    const text = await o.page.evaluate("document.body.innerText"), overflowX = await o.page.evaluate("document.documentElement.scrollWidth - innerWidth");
    const got = { before, after, claude, codex, kiro, disk, errs: o.errs, csp: await o.csp(), overflowX };
    check(tag, /Agent /.test(claude.said) && /account “work”/.test(claude.said) && claude.closed && codex.closed && kiro.closed
      && before.work === "signed in" && before.team === "signed in" && before.kiro1 === "signed in"
      && after.work === "not signed in" && after.team === "not signed in" && after.kiro1 === "not signed in"
      && !disk.claudeCreds && disk.claudeBackups.length === 0 && !disk.claudeIdentity && disk.claudeConversation && !disk.codexAuth && disk.codexSessions && disk.kiroTokens === 0
      && !/\baccounts(Manage)?\.[a-zA-Z_]+\b/.test(text) && o.errs.length === 0 && (got.csp as string[]).length === 0 && overflowX <= 0, got);
    await o.ctx.close();
  }
  {
    const c = { device: "phone", theme: "dark", lang: "zh-TW" }, tag = "phone-dark-zh-TW";
    const o = await open(c);
    await o.page.click('.s-account-card[data-backend="claude-code"] .s-account-row[data-account="work2"] .s-account-signout');
    await o.page.waitForSelector("dialog[open]", { timeout: 5000 }); await o.page.waitForTimeout(400);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "2-sign-out-dialog") });
    await o.page.keyboard.press("Escape"); await o.page.waitForTimeout(400);
    const res = await signOut(o.page, "claude-code", "work2", "登出");
    await o.page.evaluate(`document.querySelector('.s-account-row[data-account="work2"]').scrollIntoView({ block: "center" })`); await o.page.waitForTimeout(300);
    await o.page.screenshot({ path: shotPath(SMOKE, tag, "3-signed-out") });
    const after = await stateOf(o.page, "claude-code", "work2");
    const gone = !existsSync(join(prof("claude-code", "work2"), ".credentials.json"));
    check(tag, res.closed && /帳號「work2」/.test(res.said) && after === "尚未登入" && gone && o.errs.length === 0 && (await o.csp()).length === 0, { res, after, gone, errs: o.errs });
    await o.ctx.close();
  }
  {
    const o = await open({ device: "desk", theme: "light", lang: "en" }, async (page: any) => page.route(/\/ui\/js\/accounts-view\.js(\?.*)?$/, (route: any) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old("accounts-view.js") ?? "" })));
    const a = await o.page.evaluate(`({ cards: document.querySelectorAll(".s-account-card").length, signOut: !!document.querySelector(".s-account-signout") })`);
    await shotSection(o.page, shotPath(SMOKE, "skew", "old-accounts-view-new-server"));
    check("skew-old-accounts-view", a.cards > 0 && !a.signOut && o.errs.length === 0, { ...a, errs: o.errs });
    await o.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(shotPath(SMOKE, "result", "json").replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
