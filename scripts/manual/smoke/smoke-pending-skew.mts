// AGEND-118 (review of #3487, P2 3): the "waiting for confirmation" card in a tab that holds some assets from before an upgrade
// and others from after, both ways, and each of the three assets on its own:
//   fresh        — this checkout as served (the baseline).
//   old-dict     — the NEW shell with the OLD app-i18n.js (the dictionary a tab keeps by URL): no raw key may be printed.
//   old-css      — the NEW shell with the OLD app.css (without the rules this branch added).
//   old-dict-css — both of those.
//   old-confirm  — the NEW shell with the OLD settings-confirm.js (it publishes no `retry`): the card still reads, no Send again.
//   old-shell    — the other way: the OLD app-shell.js with the NEW dictionary, stylesheet and settings-confirm.js (which publishes
//                  `retry` that the old shell does not read).
// Per case, in the real shell on the shared fixture (the product's own web server, a scratch home, no fleet start):
//   pending (no authenticator set up)  → the card reads in its language, no raw key (app.…, pendingHost.…, pendingEnded.…) or {0};
//   pending (authenticator set up)     → the 6-digit field is there and no raw key;
//   withdrawn (terminal)               → the card reads, no raw key; with the new shell + new confirm, Send again is offered;
//   Send again refused (409)           → the failure line reads in its language (new shell + new confirm), no raw key;
//   no page error, no CSP report. Every swapped URL must be requested at least once (swapped-urls-requested), and the old copy
//   is proven old: old-dict's served dictionary still has the old expired title; old-css lacks a rule it added.
// The old copies are read from git (`git show BASE:src/ui/…`); BASE defaults to the merge-base with upstream/release/2.3.5-alpha.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [BASE=<ref>] [MATRIX=quick|full|desk-light-en,…] [CASES=old-dict,…] \
//   FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-pending-skew.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-pending-skew";
const REPO = process.env.REPO!;
const { base32Encode, WEB_REMOTE_ACCESS_FILE } = await import(REPO + "/src/web-remote-access.ts");
const SECRET = base32Encode(Buffer.from("smoke-secret-0123456"));
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
const BASE = process.env.BASE ?? git("merge-base", "HEAD", "upstream/release/2.3.5-alpha").trim();
const old = (p: string) => git("show", `${BASE}:${p}`);
const cur = (p: string) => readFileSync(join(REPO, p), "utf8");          // the working tree: what is being judged

const URLS = { dict: "/assets/app-i18n.js", css: "/assets/app.css", confirm: "/ui/js/settings-confirm.js", shell: "/assets/app-shell.js" } as const;
const SRC = { dict: "src/ui/shared/app-i18n.js", css: "src/ui/shared/app.css", confirm: "src/ui/settings-confirm.js", shell: "src/ui/shared/app-shell.js" } as const;
type Asset = keyof typeof URLS;
const MODES: Record<string, Asset[]> = {
  fresh: [], "old-dict": ["dict"], "old-css": ["css"], "old-dict-css": ["dict", "css"], "old-confirm": ["confirm"], "old-shell": ["shell"],
};
// What each old copy must lack, to count as old (a word or rule this branch added).
const PROOF: Partial<Record<Asset, [string, string]>> = { css: [".pending-more", old(SRC.css)], confirm: ["resendOf", old(SRC.confirm)], shell: ["pendingEnded", old(SRC.shell)] };
const RAW_KEY = /\bapp\.(?:pending|withdraw|op)[A-Za-z_]*|\b(?:pendingHost|pendingEnded)\.[A-Za-z_]+|\bwebauth\.[a-z][A-Za-z_]+|\{\d\}/;   // a key the card reads, printed raw (the page's own words may end a sentence with "app.")
const WORDS = {
  en: { cant: "This device can't confirm this change yet.", code: "Enter the 6-digit code", withdrawn: "You withdrew this change", again: "Send again", failed: "It could not be sent again" },
  "zh-TW": { cant: "你目前在這台裝置還無法直接確認這項變更。", code: "輸入驗證器 App 的 6 位數代碼", withdrawn: "你已撤回這項變更", again: "重新送出", failed: "無法重新送出" },
} as const;

const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const fx = await bootFixture({ port: 47570, instances: 4 });
const fm = fx.fm as any;
const enroll = (on: boolean) => {
  const file = join(fx.dir, WEB_REMOTE_ACCESS_FILE);
  if (on) writeFileSync(file, JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  else rmSync(file, { force: true });
  fm.webRemoteAccessState = undefined;
};
try {
  const cases = matrix(process.env.MATRIX ?? "quick");
  for (const [mode, swapped] of Object.entries(MODES)) {
    if (process.env.CASES && !process.env.CASES.split(",").includes(mode)) continue;
    for (const c of cases) {
      const cn = `${mode}:${caseName(c)}`, w = WORDS[c.lang];
      const hits: Record<string, number> = {}, served: Record<string, string> = {};
      enroll(false);
      fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]);
      const { ctx, page, csp } = await fx.page(c, { path: "/settings/hub" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      for (const a of swapped) {
        const url = URLS[a], body = old(SRC[a]); hits[url] = 0; served[url] = body;
        await ctx.route(`**${url}*`, (rt: any) => { hits[url]++; rt.fulfill({ status: 200, contentType: url.endsWith(".css") ? "text/css" : "text/javascript", body }); });
      }
      await page.reload();                                             // every asset again, the swapped ones from the old copy
      await page.waitForSelector("#hubMemberEnabled", { timeout: 15000 });
      const text = async () => (await page.evaluate(() => (document.querySelector(".pending-card")?.textContent ?? "").replace(/\s+/g, " "))) as string;
      const waitCard = async () => {
        await page.waitForSelector(".pending-card", { timeout: 15000 });
        await page.waitForFunction(() => !/Sending the confirm card|正在把確認卡送到/.test(document.querySelector(".pending-card")?.textContent || "x"), null, { timeout: 20000 });
        await page.waitForTimeout(400);
      };
      const newShell = !swapped.includes("shell"), newConfirm = !swapped.includes("confirm");
      // The old copies are really old (and really served).
      for (const a of swapped) { const p = PROOF[a]; if (p) check(`${cn}:${a}-is-old`, !served[URLS[a]]!.includes(p[0]) && cur(SRC[a]).includes(p[0]), `${a}: old copy ${served[URLS[a]]!.includes(p[0]) ? "HAS" : "lacks"} ${p[0]}`); }
      if (swapped.includes("dict")) check(`${cn}:dict-is-old`, served[URLS.dict]!.includes("Expired — nothing was changed") && !cur(SRC.dict).includes("Expired — nothing was changed"), "the dictionary served is the base's (its expired title is the old one)");

      // pending, no authenticator set up
      await page.click("#hubMemberEnabled"); await waitCard();
      const t1 = await text();
      await page.locator(".pending-card").first().screenshot({ path: shotPath(SMOKE, cn, "1-pending") });
      check(`${cn}:pending-words`, !RAW_KEY.test(t1) && (newShell ? t1.includes(w.cant) : t1.length > 20), t1.slice(0, 220));
      // withdrawn (terminal)
      await page.getByRole("button", { name: /Withdraw|撤回/ }).first().click(); await page.waitForSelector(".pending-card.rejected", { timeout: 8000 });
      await page.waitForTimeout(300);
      const t3 = await text();
      await page.locator(".pending-card").first().screenshot({ path: shotPath(SMOKE, cn, "3-withdrawn") });
      const offered = (await page.getByRole("button", { name: w.again }).count()) > 0;
      check(`${cn}:withdrawn-words`, !RAW_KEY.test(t3) && (newShell ? t3.includes(w.withdrawn) : t3.length > 20), t3.slice(0, 220));
      check(`${cn}:send-again`, offered === (newShell && newConfirm), { offered, newShell, newConfirm });
      // Send again refused: the failure line
      if (newShell && newConfirm) {
        await ctx.route("**/api/settings/hub/membership", (rt: any) => rt.request().method() === "PUT" ? rt.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "revision_conflict" }) }) : rt.continue());
        await page.getByRole("button", { name: w.again }).click();
        await page.waitForSelector(".pending-card [role=alert]", { timeout: 8000 });
        const t4 = await text();
        await page.locator(".pending-card").first().screenshot({ path: shotPath(SMOKE, cn, "4-resend-failed") });
        check(`${cn}:resend-failed-words`, !RAW_KEY.test(t4) && t4.includes(w.failed), t4.slice(0, 260));
      }
      // authenticator set up (a fresh load: the first change is withdrawn and settled)
      enroll(true);
      await ctx.unroute("**/api/settings/hub/membership");
      await page.reload();
      await page.waitForSelector("#hubMemberEnabled:not([disabled])", { timeout: 15000 });
      await page.click("#hubMemberEnabled"); await waitCard();
      await page.waitForSelector(".pending-code-input", { timeout: 10000 });
      const t2 = await text();
      await page.locator(".pending-card").first().screenshot({ path: shotPath(SMOKE, cn, "2-code") });
      check(`${cn}:code-words`, !RAW_KEY.test(t2) && (newShell ? t2.includes(w.code) : true), t2.slice(0, 220));
      for (const a of swapped) check(`${cn}:swapped-urls-requested:${a}`, hits[URLS[a]]! > 0, hits);
      check(`${cn}:no-errors`, errs.length === 0 && (await csp()).length === 0, { errs, csp: await csp() });
      await ctx.close();
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1800); }
finally {
  await fx.close();
  const out = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
  mkdirSync(out, { recursive: true });
  r.receipt = { head: git("rev-parse", "HEAD").trim(), base: git("rev-parse", BASE).trim(), dirty: git("status", "--porcelain").trim() !== "" };
  writeFileSync(join(out, "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1)); console.log(fail.length ? "FAIL: " + fail.join(", ") : "ALL PASS");
  process.exit(fail.length ? 1 : 0);
}
