// #3292 acceptance: Settings → Accounts → Keep sign-in alive, on the realistic fixture (never `fleet start`), with real
// credential-profile folders, the real routes and the real SignInKeepAlive — only its CLI runs are replaced (no `claude`
// or `codex` process starts, nothing reaches the network): a run "renews" by rewriting the scratch file, as the CLI does.
// The CLIs' default homes are scratch folders too (CLAUDE_CONFIG_DIR / CODEX_HOME set before the fleet loads).
// - desk light (en) and phone dark (zh-TW): a keep-alive line on every Claude Code / Codex host row (none elsewhere);
//   "work" ends in 3 days (warned); switching "work" on runs it at once (the fake run sees that profile's folder) and the
//   row then says renewed; the fallback appears only once on (Claude Code only); switching off returns it to off.
// - No raw string key, no page error, no CSP report, no page-level horizontal scroll.
// - the stale-tab skew: an old cached accounts-view.js (OLD_REF) with today's server (no line, nothing broken); the old
//   shell (/assets from OLD_REF) with this branch's Settings (the line works: its own words and stylesheet).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> [OLD_REF=songsid/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-accounts-keepalive-3292.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SMOKE = "smoke-accounts-keepalive-3292";
const REPO = process.env.REPO!, OLD_REF = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
const DAY = 86_400_000;
// The CLIs' default sign-ins: scratch, before anything reads them.
const homes = mkdtempSync(join(tmpdir(), "ka-smoke-homes-"));
process.env.CLAUDE_CONFIG_DIR = join(homes, "claude"); process.env.CODEX_HOME = join(homes, "codex");
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true }); mkdirSync(process.env.CODEX_HOME, { recursive: true });

// The CLI runs, replaced before the fleet loads (the same module instance the fleet imports).
const ka = await import(REPO + "/src/signin-keepalive.ts");
const runs: string[] = [];
const claudeCreds = (dir: string, expiresAt: number, endsAt: number) => writeFileSync(join(dir, ".credentials.json"),
  JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(40), refreshToken: "c".repeat(40), expiresAt, refreshTokenExpiresAt: endsAt, scopes: ["user:inference"], subscriptionType: "team" } }));
Object.assign(ka.realRunners, {
  async claudeStatus(configDir: string | null) {
    const dir = configDir ?? process.env.CLAUDE_CONFIG_DIR!;
    runs.push(`claude:${configDir ? configDir.split("/").pop() : "(default)"}`);
    const c = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")).claudeAiOauth;
    claudeCreds(dir, Date.now() + 8 * 3600e3, c.refreshTokenExpiresAt);
    return { code: 0, loggedIn: true };
  },
  async claudeFallback() { runs.push("claude-fallback"); return { code: 0 }; },
  async codexRefresh() { runs.push("codex"); return { answered: true, accountNull: false }; },
});

const { bootFixture, shotPath } = await import("../smoke-fixture/index.mts");
const fx = await bootFixture({ port: Number(process.env.HP ?? 48740), instances: 2 });
const fm = fx.fm as any;
const profiles = join(fm.dataDir, "credential-profiles");
const now = Date.now();
for (const [p, exp, ends] of [["work", now - 3600e3, now + 3 * DAY], ["personal", now + 3600e3, now + 25 * DAY]] as const) {
  mkdirSync(join(profiles, "claude-code", p), { recursive: true, mode: 0o700 }); claudeCreds(join(profiles, "claude-code", p), exp, ends);
}
claudeCreds(process.env.CLAUDE_CONFIG_DIR!, now + 3600e3, now + 20 * DAY);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c: unknown) => `${b64({ alg: "none" })}.${b64(c)}.${"s".repeat(16)}`;
writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt({ exp: Math.floor(now / 1000) + 5 * 86400 }),
  id_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }), refresh_token: "c".repeat(40) }, last_refresh: new Date(now - DAY).toISOString() }));
fm.refreshSignInIdentities = () => {};   // no `claude auth status` for the identities either

const r: Record<string, unknown> = { browser: fx.browser.version(), oldRef: OLD_REF };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
const CASES = [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const;

async function open(c: (typeof CASES)[number], route?: (page: any) => Promise<void>) {
  const { ctx, page, csp } = await fx.page(c as any, { path: "/settings/agents" });
  const errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  if (route) { await route(page); await page.reload(); }
  await page.waitForSelector(".s-ai-accounts", { timeout: 20000 });
  await page.evaluate(`(() => { const d = document.querySelector("details.s-ai-accounts"); if (d && !d.open) d.querySelector("summary").click(); })()`);
  await page.waitForSelector(".s-account-card", { timeout: 15000 });
  await page.waitForTimeout(600);
  return { ctx, page, csp, errs };
}
const shotSection = (page: any, path: string) => page.locator("details.s-ai-accounts").screenshot({ path }).catch(() => page.screenshot({ path }));
const LINES = `[...document.querySelectorAll(".s-account-row")].filter((x) => x.querySelector(".s-account-keepalive")).map((x) => x.closest(".s-account-card").getAttribute("data-backend") + ":" + x.getAttribute("data-account"))`;
const row = (b: string, a: string) => `document.querySelector('.s-account-card[data-backend="${b}"] .s-account-row[data-account="${a}"] .s-account-keepalive')`;
const info = (b: string, a: string) => `(() => { const k = ${row(b, a)}; if (!k) return null; return { on: k.getAttribute("data-keepalive"), fallback: !!k.querySelector(".s-keepalive-fallback"),
  ends: k.querySelector(".s-keepalive-ends")?.textContent || "", warn: !!k.querySelector(".s-keepalive-ends.is-warn"),
  warnColor: (() => { const w = k.querySelector(".s-keepalive-ends"), h = k.querySelector(".s-keepalive-hint"); return w && h ? getComputedStyle(w).color !== getComputedStyle(h).color : false; })(), last: k.querySelector(".s-keepalive-last")?.textContent || "", plan: k.querySelector(".s-keepalive-plan")?.textContent || "" }; })()`;
const W = { en: { renewed: "renewed" }, "zh-TW": { renewed: "已續期" } } as const;

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    runs.length = 0;
    const o = await open(c);
    const lines = await o.page.evaluate(LINES);
    const workOff = await o.page.evaluate(info("claude-code", "work"));
    const codexDefault = await o.page.evaluate(info("codex", "default"));
    await shotSection(o.page, shotPath(SMOKE, tag, "1-accounts"));
    // Switch "work" on: it runs at once (a couple of seconds), on its own folder.
    await o.page.click(`.s-account-card[data-backend="claude-code"] .s-account-row[data-account="work"] .s-account-keepalive input[type="checkbox"]`);
    const ran = await (async () => { for (let i = 0; i < 40 && !runs.includes("claude:work"); i++) await o.page.waitForTimeout(250); return runs.includes("claude:work"); })();
    // #3313 review P2-7: no refresh of the smoke's own — the server's backend_login event makes the page read the view again.
    const renewedShown = await (async () => { for (let i = 0; i < 40; i++) { const k = await o.page.evaluate(info("claude-code", "work")); if (k && k.last.includes(W[c.lang].renewed)) return true; await o.page.waitForTimeout(200); } return false; })();
    const workOn = await o.page.evaluate(info("claude-code", "work"));
    await o.page.locator(`.s-account-card[data-backend="claude-code"] .s-account-row[data-account="work"]`).scrollIntoViewIfNeeded();
    await shotSection(o.page, shotPath(SMOKE, tag, "2-work-on-renewed"));
    // The fallback, then off again.
    await o.page.click(`.s-account-card[data-backend="claude-code"] .s-account-row[data-account="work"] .s-keepalive-fallback input`);
    await o.page.waitForTimeout(800);
    const settings1 = JSON.parse(readFileSync(join(fm.dataDir, "signin-keepalive.json"), "utf8")).entries;
    await o.page.click(`.s-account-card[data-backend="claude-code"] .s-account-row[data-account="work"] .s-account-keepalive > label input`);
    await o.page.waitForTimeout(800);
    const workOffAgain = await o.page.evaluate(info("claude-code", "work"));
    const text = await o.page.evaluate("document.body.innerText");
    const overflowX = await o.page.evaluate("document.documentElement.scrollWidth - innerWidth");
    const got = { lines, workOff, codexDefault, ran, renewedShown, runs: [...runs], workOn, settings1, workOffAgain, errs: o.errs, csp: await o.csp(), overflowX };
    check(tag, JSON.stringify(lines) === JSON.stringify(["claude-code:default", "claude-code:personal", "claude-code:work", "codex:default"])
      && workOff?.on === "off" && workOff.warn && workOff.warnColor && !workOff.fallback && codexDefault?.plan.includes("plus") && !codexDefault.fallback
      && ran && renewedShown && JSON.stringify(runs) === JSON.stringify(["claude:work"]) && workOn?.on === "on" && workOn.fallback && workOn.last.includes(W[c.lang].renewed)
      && settings1.some((e: any) => e.backend === "claude-code" && e.profile === "work" && e.enabled && e.fallback)
      && workOffAgain?.on === "off" && !workOffAgain.fallback
      && !/\baccountsKeepAlive\.[a-zA-Z_]+\b/.test(text) && o.errs.length === 0 && (got.csp as string[]).length === 0 && overflowX <= 0, got);
    await o.ctx.close();
    writeFileSync(join(fm.dataDir, "signin-keepalive.json"), JSON.stringify({ version: 1, entries: [] }));
    (fm as any).signInKeepAlive = null;    // the next case starts from no setting
    claudeCreds(join(profiles, "claude-code", "work"), now - 3600e3, now + 3 * DAY);
  }

  // ── the stale-tab skew ──
  {
    const o = await open(CASES[0], async (page: any) => page.route(/\/ui\/js\/accounts-view\.js(\?.*)?$/, (route: any) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old("accounts-view.js") ?? "" })));
    const a = await o.page.evaluate(`({ cards: document.querySelectorAll(".s-account-card").length, lines: document.querySelectorAll(".s-account-keepalive").length })`);
    await shotSection(o.page, shotPath(SMOKE, "skew", "old-accounts-view-new-server"));
    check("skew-old-accounts-view", a.cards > 0 && a.lines === 0 && o.errs.length === 0, { ...a, errs: o.errs });
    await o.ctx.close();
  }
  {
    const o = await open(CASES[1], async (page: any) => page.route("**/assets/**", (route: any) => {
      const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
      const body = old(`shared/${file}`);
      return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
    }));
    const k = await o.page.evaluate(info("claude-code", "work"));
    const css = await o.page.evaluate(`getComputedStyle(${row("claude-code", "work")}).flexBasis`);
    await shotSection(o.page, shotPath(SMOKE, "skew", "old-shell-new-settings"));
    const text = await o.page.evaluate("document.body.innerText");
    check("skew-old-shell-new-settings", !!k && k.warn && css === "100%" && !/\baccountsKeepAlive\.[a-zA-Z_]+\b/.test(text) && o.errs.length === 0, { k, css, errs: o.errs });
    await o.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(shotPath(SMOKE, "result", "branch").replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
