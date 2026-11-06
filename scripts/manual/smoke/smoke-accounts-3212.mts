// #3212 PR 1 acceptance: Settings → Agents → Accounts and the Agent dialog's Account field, on the realistic fixture
// (never `fleet start`), with real credential-profile folders: a signed-in one an agent uses, a signed-out one only on
// disk.
// - desk light (en) and phone dark (zh-TW): the AI accounts section shows a card per CLI; the default and both profiles
//   are listed with their state and who uses them; the Agent dialog of a Claude agent has an Account field.
// - Nothing about a credential reaches the browser: the /ui/accounts answer and the page text are checked for the
//   fixture's token. No raw string key, no page error, no CSP report, no page-level horizontal scroll.
// - the stale-tab skew (rule 3): the old shell (/assets from OLD_REF) with this branch's Settings modules; this shell
//   with the old Settings modules (OLD_REF: the old sign-in list, nothing broken); this branch's Settings with an old
//   cached backend-signin.js (the Accounts view uses only exports it already had).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> [OLD_REF=songsid/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-accounts-3212.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-accounts-3212";
const REPO = process.env.REPO!, OLD_REF = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48690), instances: 2 });
const fm = fx.fm as any;
const name = fx.instances.find((i: any) => !i.general)!.name;
const TOKEN = "c".repeat(40);
const profiles = join(fm.dataDir, "credential-profiles", "claude-code");
mkdirSync(join(profiles, "work"), { recursive: true }); mkdirSync(join(profiles, "personal"));
writeFileSync(join(profiles, "work", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001", emailAddress: "probe@example.com" } }));
writeFileSync(join(profiles, "work", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: TOKEN, expiresAt: Date.now() + 86400000 } }));
// In fleet.yaml, as a save would leave it: Settings reads the file, the Accounts view the loaded config.
const cfgPath = join(fm.dataDir, "fleet.yaml");
const cfg = yaml.load(readFileSync(cfgPath, "utf8")) as any;
cfg.instances[name].backend = "claude-code";
cfg.instances[name].backend_options = { "claude-code": { credential_profile: "work" } };
writeFileSync(cfgPath, yaml.dump(cfg)); fm.loadConfig(cfgPath);
fm.refreshSignInIdentities = () => {};   // no `claude auth status` run by the smoke

const r: Record<string, unknown> = { browser: fx.browser.version(), oldRef: OLD_REF, instance: name };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
const CASES = [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const;

async function open(c: (typeof CASES)[number], route?: (page: any) => Promise<void>) {
  const { ctx, page, csp } = await fx.page(c as any, { path: "/settings/agents" });
  const errs: string[] = [], answers: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  page.on("response", async (res: any) => { if (res.url().includes("/ui/accounts")) { try { answers.push((await res.body()).toString("utf8")); } catch { /* aborted */ } } });
  if (route) { await route(page); await page.reload(); }
  await page.waitForSelector(".s-ai-accounts", { timeout: 20000 });
  await page.evaluate(`(() => { const d = document.querySelector("details.s-ai-accounts"); if (d && !d.open) d.querySelector("summary").click(); })()`);
  await page.waitForTimeout(800);
  return { ctx, page, csp, errs, answers };
}
// Settings scrolls inside its own pane, so a full-page shot shows only the top: shoot the accounts section itself.
const shot = (page: any, path: string) => page.locator("details.s-ai-accounts").screenshot({ path }).catch(() => page.screenshot({ path }));
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  return { cards: [...document.querySelectorAll(".s-account-card")].map((c) => c.getAttribute("data-backend")),
    rows: [...document.querySelectorAll('.s-account-card[data-backend="claude-code"] .s-account-row')].map((x) => [x.getAttribute("data-account"), x.querySelector(".s-auth-state")?.textContent ?? "", x.querySelector(".s-account-used")?.textContent ?? ""]),
    oldList: !!q(".signin-list"), text: document.body.innerText, overflowX: document.documentElement.scrollWidth - innerWidth };
})()`;

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    const o = await open(c);
    const ready = await o.page.waitForSelector(".s-account-card", { timeout: 15000 }).then(() => true, () => false);
    const a = await o.page.evaluate(PROBE);
    await shot(o.page, shotPath(SMOKE, tag, "1-accounts"));
    // The Agent dialog of the Claude agent: its Account field.
    await o.page.evaluate(`(() => { const row = [...document.querySelectorAll(".s-agent-row")].find((x) => x.querySelector(".s-name")?.getAttribute("title") === ${JSON.stringify(name)}); const b = row && row.querySelector(".s-actions button"); if (b) b.click(); })()`);
    const dialog = await o.page.waitForSelector("#ag-account", { timeout: 8000 }).then(() => true, () => false);
    const opts = dialog ? await o.page.evaluate(`[...document.querySelectorAll("#ag-account option")].map((x) => [x.value, x.disabled])`) : null;
    const chosen = dialog ? await o.page.evaluate(`document.querySelector("#ag-account").value`) : null;
    await o.page.waitForTimeout(700);   // the sheet's slide-in
    if (dialog) await o.page.screenshot({ path: shotPath(SMOKE, tag, "2-agent-account") });
    const rawKey = /\baccounts\.[a-zA-Z_]+\b/.test(a.text);
    const leaks = [TOKEN, "probe@example.com"].filter((s) => o.answers.some((x) => x.includes(s)) || a.text.includes(s));
    const got = { ready, cards: a.cards, rows: a.rows, dialog, opts, chosen, rawKey, leaks, errs: o.errs, csp: await o.csp(), overflowX: a.overflowX };
    const rowOf = (n: string) => a.rows.find((x: string[]) => x[0] === n);
    check(tag, ready && a.cards.includes("claude-code") && !!rowOf("default") && !!rowOf("work") && !!rowOf("personal")
      && /1/.test(rowOf("work")![2]) && !rawKey && leaks.length === 0 && o.errs.length === 0 && (got.csp as string[]).length === 0 && a.overflowX <= 0
      && dialog && chosen === "work" && (opts as [string, boolean][]).some(([v, d]) => v === "work" && !d) && (opts as [string, boolean][]).some(([v, d]) => v === "personal" && d), got);
    await o.ctx.close();
  }

  // ── the stale-tab skew ──
  const oldShell = async (page: any) => page.route("**/assets/**", (route: any) => {
    const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
    const body = old(`shared/${file}`);
    return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
  });
  {
    const o = await open(CASES[0], oldShell);
    const ok = await o.page.waitForSelector(".s-account-card", { timeout: 10000 }).then(() => true, () => false);
    const a = await o.page.evaluate(PROBE);
    await shot(o.page, shotPath(SMOKE, "skew", "old-shell-new-settings"));
    check("skew-old-shell-new-settings", ok && !/\baccounts\.[a-zA-Z_]+\b/.test(a.text) && o.errs.length === 0, { ok, errs: o.errs });
    await o.ctx.close();
  }
  {
    const OLD = ["panel-settings.js", "settings-dialogs.js", "backend-signin.js"];
    const o = await open(CASES[0], async (page: any) => page.route(/\/ui\/js\/(panel-settings|settings-dialogs|backend-signin)\.js(\?.*)?$/, (route: any) => {
      const file = OLD.find((x) => route.request().url().includes(`/ui/js/${x}`))!;
      return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old(file) ?? "" });
    }));
    const a = await o.page.evaluate(PROBE);
    await shot(o.page, shotPath(SMOKE, "skew", "new-shell-old-settings"));
    check("skew-new-shell-old-settings", a.oldList && !a.cards.length && o.errs.length === 0, { oldList: a.oldList, cards: a.cards, errs: o.errs });
    await o.ctx.close();
  }
  {
    const o = await open(CASES[0], async (page: any) => page.route(/\/ui\/js\/backend-signin\.js(\?.*)?$/, (route: any) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old("backend-signin.js") ?? "" })));
    const ok = await o.page.waitForSelector(".s-account-card", { timeout: 10000 }).then(() => true, () => false);
    await shot(o.page, shotPath(SMOKE, "skew", "new-settings-old-signin"));
    check("skew-new-settings-old-signin", ok && o.errs.length === 0, { ok, errs: o.errs });
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
