// #3212 PR 2 acceptance: Settings → Accounts → + Add account and Remove, on the realistic fixture (never `fleet start`),
// with real credential-profile folders and the real routes: "work" (an agent uses it; a link inside it to a shared
// folder, as a relocated home has) and "personal" (unused).
// - desk light (en) and phone dark (zh-TW): + Add account checks the name before sending (CON refused in words); a good
//   name makes a private folder and opens Sign in at once (the sign-in's pre-check is answered by the page route here:
//   no CLI runs); Remove on "work" lists who uses it with Move… (which opens that agent's dialog, its Account field) and
//   offers no Remove; Remove on the new account needs its name typed exactly, then the folder is gone. "work", its
//   link and the shared folder's file are untouched throughout.
// - No raw string key, no page error, no CSP report, no page-level horizontal scroll.
// - the stale-tab skew (rule 3): an old cached accounts-view.js (OLD_REF) with today's server (no Add/Remove, nothing
//   broken); the old shell (/assets from OLD_REF) with this branch's Settings (Add/Remove work; only the layout rules of
//   an older accounts.css are missing).
// LABEL=base: only the Accounts section's shot (the before picture).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> [LABEL=base|branch] [OLD_REF=songsid/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-accounts-manage-3212.mts
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-accounts-manage-3212";
const REPO = process.env.REPO!, OLD_REF = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha", LABEL = process.env.LABEL ?? "branch";
const BASE = LABEL === "base";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48720), instances: 2 });
const fm = fx.fm as any;
const name = fx.instances.find((i: any) => !i.general)!.name;
const profiles = join(fm.dataDir, "credential-profiles", "claude-code");
mkdirSync(join(profiles, "work"), { recursive: true, mode: 0o700 }); mkdirSync(join(profiles, "personal"), { mode: 0o700 });
writeFileSync(join(profiles, "work", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(40), refreshToken: "c".repeat(40), expiresAt: Date.now() + 86400000 } }));
const shared = mkdtempSync(join(tmpdir(), "acct-shared-")); writeFileSync(join(shared, "keep.jsonl"), "shared");
symlinkSync(shared, join(profiles, "work", "projects"));
const cfgPath = join(fm.dataDir, "fleet.yaml");
const cfg = yaml.load(readFileSync(cfgPath, "utf8")) as any;
cfg.instances[name].backend = "claude-code";
cfg.instances[name].backend_options = { "claude-code": { credential_profile: "work" } };
writeFileSync(cfgPath, yaml.dump(cfg)); fm.loadConfig(cfgPath);
fm.refreshSignInIdentities = () => {};   // no `claude auth status` run by the smoke

const r: Record<string, unknown> = { browser: fx.browser.version(), label: LABEL, oldRef: OLD_REF, instance: name };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
const CASES = [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const;

async function open(c: (typeof CASES)[number], route?: (page: any) => Promise<void>) {
  const { ctx, page, csp } = await fx.page(c as any, { path: "/settings/agents" });
  const errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  // A sign-in's pre-check never reaches the login controller here (no CLI runs): the dialog gets a plain answer.
  await page.route(/\/ui\/backend-login\/check$/, (route: any) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "smoke: sign-in not run" }) }));
  if (route) { await route(page); await page.reload(); }
  await page.waitForSelector(".s-ai-accounts", { timeout: 20000 });
  await page.evaluate(`(() => { const d = document.querySelector("details.s-ai-accounts"); if (d && !d.open) d.querySelector("summary").click(); })()`);
  await page.waitForSelector(".s-account-card", { timeout: 15000 });
  await page.waitForTimeout(600);
  return { ctx, page, csp, errs };
}
const shotSection = (page: any, path: string) => page.locator("details.s-ai-accounts").screenshot({ path }).catch(() => page.screenshot({ path }));
const ROWS = `[...document.querySelectorAll('.s-account-card[data-backend="claude-code"] .s-account-row')].map((x) => x.getAttribute("data-account"))`;
const dlgText = `(document.querySelector("dialog[open]")?.innerText || "")`;
const clickIn = (sel: string, label: string) => `(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) { b.click(); return true; } return false; })()`;
const W = { en: { add: "Add", remove: "Remove", move: "Move…", cancel: "Cancel" }, "zh-TW": { add: "新增", remove: "移除", move: "移動…", cancel: "取消" } } as const;

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, w = W[c.lang];
    const o = await open(c);
    await shotSection(o.page, shotPath(SMOKE, `${LABEL}-${tag}`, "1-accounts"));
    if (BASE) { check(tag, o.errs.length === 0, { errs: o.errs }); await o.ctx.close(); continue; }
    const buttons = await o.page.evaluate(`({ add: !!document.querySelector('.s-account-card[data-backend="claude-code"] .s-account-add'),
      remove: [...document.querySelectorAll('.s-account-card[data-backend="claude-code"] .s-account-row')].filter((x) => x.querySelector(".s-account-remove")).map((x) => x.getAttribute("data-account")) })`);

    // + Add account: a refused name in words, then a good one → a private folder, and Sign in at once.
    await o.page.click('.s-account-card[data-backend="claude-code"] .s-account-add');
    await o.page.waitForSelector("#acctAddName", { timeout: 5000 });
    await o.page.fill("#acctAddName", "CON");
    const refused = await o.page.evaluate(`({ err: document.querySelector("dialog[open] .err")?.textContent || "", disabled: [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.trim() === ${JSON.stringify(w.add)})?.disabled })`);
    await o.page.waitForTimeout(300);
    await o.page.screenshot({ path: shotPath(SMOKE, `${LABEL}-${tag}`, "2-add-refused-name") });
    const fresh = `new-${c.device}`;
    await o.page.fill("#acctAddName", fresh);
    await o.page.evaluate(clickIn("dialog[open] button", w.add));
    const signInOpened = await o.page.waitForFunction((n: string) => !document.querySelector("#acctAddName") && document.querySelector("dialog[open]")?.textContent?.includes(n), fresh, { timeout: 8000 }).then(() => true, () => false);
    const made = (() => { try { const st = lstatSync(join(profiles, fresh)); return { dir: st.isDirectory(), mode: (st.mode & 0o777).toString(8) }; } catch { return null; } })();
    await o.page.waitForTimeout(500);
    await o.page.screenshot({ path: shotPath(SMOKE, `${LABEL}-${tag}`, "3-added-sign-in-opens") });
    await o.page.keyboard.press("Escape"); await o.page.waitForTimeout(400);
    await o.page.evaluate(`(() => { const d = document.querySelector("dialog[open]"); if (d) { const b = [...d.querySelectorAll("button")].find((x) => /Cancel|Close|取消|關閉/.test(x.textContent)); if (b) b.click(); } })()`);
    await o.page.waitForTimeout(400);
    const rowsAfterAdd = await o.page.evaluate(ROWS);

    // Remove on "work": in use — who uses it, with Move…; no Remove, no name to type.
    await o.page.click('.s-account-card[data-backend="claude-code"] .s-account-row[data-account="work"] .s-account-remove');
    await o.page.waitForSelector("dialog[open] .s-account-inuse", { timeout: 5000 });
    const inUse = await o.page.evaluate(`({ users: [...document.querySelectorAll("dialog[open] .s-account-inuse li span")].map((x) => x.textContent), typing: !!document.querySelector("#acctRemoveName"),
      removeDisabled: [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.trim() === ${JSON.stringify(w.remove)})?.disabled })`);
    await o.page.waitForTimeout(300);
    await o.page.screenshot({ path: shotPath(SMOKE, `${LABEL}-${tag}`, "4-remove-in-use") });
    await o.page.evaluate(clickIn("dialog[open] .s-account-inuse button", w.move));
    const moved = await o.page.waitForSelector("#ag-account", { timeout: 8000 }).then(() => true, () => false);
    await o.page.waitForTimeout(700);
    await o.page.screenshot({ path: shotPath(SMOKE, `${LABEL}-${tag}`, "5-move-opens-agent-account") });
    await o.page.keyboard.press("Escape"); await o.page.waitForTimeout(500);

    // Remove the new, unused account: its name typed exactly, then the folder is gone.
    await o.page.click(`.s-account-card[data-backend="claude-code"] .s-account-row[data-account="${fresh}"] .s-account-remove`);
    await o.page.waitForSelector("#acctRemoveName", { timeout: 5000 });
    await o.page.fill("#acctRemoveName", fresh.toUpperCase());
    const wrongDisabled = await o.page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.trim() === ${JSON.stringify(w.remove)})?.disabled`);
    await o.page.fill("#acctRemoveName", fresh);
    await o.page.waitForTimeout(300);
    await o.page.screenshot({ path: shotPath(SMOKE, `${LABEL}-${tag}`, "6-remove-typed") });
    await o.page.evaluate(clickIn("dialog[open] button", w.remove));
    const gone = await o.page.waitForFunction((n: string) => !document.querySelector(`.s-account-row[data-account="${n}"]`), fresh, { timeout: 8000 }).then(() => true, () => false);
    await o.page.waitForTimeout(500);
    await shotSection(o.page, shotPath(SMOKE, `${LABEL}-${tag}`, "7-removed"));
    const text = await o.page.evaluate("document.body.innerText");
    const overflowX = await o.page.evaluate("document.documentElement.scrollWidth - innerWidth");
    const kept = existsSync(join(profiles, "work", ".credentials.json")) && lstatSync(join(profiles, "work", "projects")).isSymbolicLink() && existsSync(join(shared, "keep.jsonl"));
    const got = { buttons, refused, signInOpened, made, rowsAfterAdd, inUse, moved, wrongDisabled, gone, folderGone: !existsSync(join(profiles, fresh)), kept, errs: o.errs, csp: await o.csp(), overflowX };
    check(tag, buttons.add && JSON.stringify(buttons.remove) === JSON.stringify(["personal", "work"]) && refused.disabled === true && refused.err.length > 0
      && signInOpened && made?.dir === true && made.mode === "700" && rowsAfterAdd.includes(fresh)
      && inUse.users.length === 1 && inUse.users[0].endsWith(name) && !inUse.typing && inUse.removeDisabled === true && moved
      && wrongDisabled === true && gone && got.folderGone && kept
      && !/\baccounts(Manage)?\.[a-zA-Z_]+\b/.test(text) && o.errs.length === 0 && (got.csp as string[]).length === 0 && overflowX <= 0, got);
    await o.ctx.close();
  }

  if (!BASE) {
    // ── the stale-tab skew ──
    {
      const o = await open(CASES[0], async (page: any) => page.route(/\/ui\/js\/accounts-view\.js(\?.*)?$/, (route: any) =>
        route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old("accounts-view.js") ?? "" })));
      const a = await o.page.evaluate(`({ cards: document.querySelectorAll(".s-account-card").length, add: !!document.querySelector(".s-account-add"), remove: !!document.querySelector(".s-account-remove") })`);
      await shotSection(o.page, shotPath(SMOKE, "skew", "old-accounts-view-new-server"));
      check("skew-old-accounts-view", a.cards > 0 && !a.add && !a.remove && o.errs.length === 0, { ...a, errs: o.errs });
      await o.ctx.close();
    }
    {
      const o = await open(CASES[0], async (page: any) => page.route("**/assets/**", (route: any) => {
        const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
        const body = old(`shared/${file}`);
        return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
      }));
      await o.page.click('.s-account-card[data-backend="claude-code"] .s-account-add');
      const ok = await o.page.waitForSelector("#acctAddName", { timeout: 5000 }).then(() => true, () => false);
      await o.page.screenshot({ path: shotPath(SMOKE, "skew", "old-shell-new-settings") });
      const text = await o.page.evaluate("document.body.innerText");
      check("skew-old-shell-new-settings", ok && !/\baccounts(Manage)?\.[a-zA-Z_]+\b/.test(text) && o.errs.length === 0, { ok, errs: o.errs });
      await o.ctx.close();
    }
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(shotPath(SMOKE, "result", LABEL).replace(/\.png$/, ".json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
