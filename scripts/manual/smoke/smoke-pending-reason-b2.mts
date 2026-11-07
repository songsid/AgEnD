// alpha.6 feedback #2c (the user's decision hmsg-77256f66), in a real browser on the shared fixture (the product's own web
// server, a scratch home, no fleet start). The fixture is a web-only fleet (no chat app) and its session is an admin signed in
// with a code — not this computer's owner — so a confirmed change cannot be applied here or in a General: the user's case.
// Switching Hub membership on, the pending card must, once the server has settled how it can be confirmed:
//   - say WHY in plain words (no chat app is connected) and what would let it through, with the way to Chat & connections;
//   - never instruct a host command: `agend settings confirm …` only inside the folded "Advanced" part;
//   desk light en and phone dark zh-TW; no page error, no CSP report.
// LABEL=base: the before pictures (the card's sentence was "Confirm it on the host: agend settings confirm …").
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-pending-reason-b2.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-pending-reason-b2";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const fx = await bootFixture({ port: 47530, instances: 4 });
const fm = fx.fm as any;
try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/hub" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.waitForSelector("#hubMemberEnabled", { timeout: 15000 });
    await page.click("#hubMemberEnabled");
    await page.waitForSelector(".pending-card", { timeout: 10000 });
    // The server settles how it can be confirmed (no card could be posted); the page reads it at its next poll.
    // (a function, not a string: the page's CSP forbids string evaluation)
    const settled = await page.waitForFunction(() => !/Sending the confirm card|正在把確認卡送到/.test(document.querySelector(".pending-card")?.textContent || ""), null, { timeout: 20000 }).then(() => true, () => false);
    await page.waitForTimeout(300);
    const card = await page.evaluate(`(() => { const card = document.querySelector(".pending-card"); const fold = card.querySelector("details.pending-host");
      const outside = card.innerText.replace(fold ? fold.innerText : "", "");
      return { text: card.innerText.replace(/\\s+/g, " "), why: card.querySelector(".pending-why")?.innerText.replace(/\\s+/g, " ") ?? "", link: card.querySelector(".pending-why a")?.getAttribute("href") ?? null,
        commandOutsideFold: /agend settings confirm/.test(outside), folded: !!fold && !fold.open && /agend settings confirm/.test(fold.textContent) }; })()`) as any;
    await page.locator(".pending-card").screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-pending`) });
    const cspNow = await csp();
    const got = { settled, card, errs, csp: cspNow };
    if (BASE) { r[cn] = got; await ctx.close(); continue; }
    check(cn, settled && card.text.includes(zh ? "這個 Fleet 沒有連接聊天平台" : "This fleet has no chat app connected")
      && card.why.length > 0 && card.link === "/settings/chat" && !card.commandOutsideFold && card.folded && errs.length === 0 && cspNow.length === 0, got);
    await ctx.close();
  }
  // SKEW: a tab whose shell (app-shell.js) predates this, against the new server: it ignores the new `reason` and shows its
  // old card — still a working pending card, no error.
  if (!BASE) {
    const { execFileSync } = await import("node:child_process");
    const REPO = process.env.REPO!, OLD = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
    const oldShell = execFileSync("git", ["-C", REPO, "show", `${OLD}:src/ui/shared/app-shell.js`], { encoding: "utf8", maxBuffer: 16 << 20 });
    const c = matrix("desk-light-en")[0]!;
    fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]);
    const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    let served = 0;
    await page.route(/\/assets\/app-shell\.js(\?.*)?$/, (route: any) => { served++; return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: oldShell }); });
    await page.goto(`${fx.base}/settings/hub`); await page.waitForSelector("#hubMemberEnabled", { timeout: 15000 });
    await page.click("#hubMemberEnabled");
    const shown = await page.waitForSelector(".pending-card", { timeout: 10000 }).then(() => true, () => false);
    await page.waitForTimeout(6000);
    await page.locator(".pending-card").screenshot({ path: shotPath(SMOKE, "skew-old-shell", `${LABEL}-pending`) });
    check("skew-old-shell", served > 0 && shown && errs.length === 0, { served, shown, errs });
    await ctx.close();
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
