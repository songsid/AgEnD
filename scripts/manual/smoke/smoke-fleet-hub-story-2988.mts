// M-2988 (Lumen's Hub user-story board): the Fleet-side words, on the shared fixture (in-process FleetManager, scratch
// home, loopback only; no chat app connected, so it is a web-only Fleet; no fleet, CLI or Hub runs). Run with REPO at the
// change (AFTER=1, judged) and at its base (pictures only):
//   #9  Settings → Hub: Start a company-account connection. The probe and the Start are answered as a Fleet with Discord
//       connected and no authenticator would answer them (held for General's card; no Hub is contacted, nothing is written).
//   #8 / #1  Settings → Hub: the Share card mounted in the connection card's place on a page-local paired client (no
//       Hub member in this fixture), with the request's live view put in the shell's list as settings-confirm.js would — first as this
//       fixture's own kind (no General: the confirm card), then as a card in General on Discord.
//   #13 the Hub setup card for a session that is not the host's (the server refuses it: `denied`).
//   #7  the sign-in page (signed out).
//   PW_DIR=… REPO=<checkout> OUT=<dir> [AFTER=1] [MATRIX=…] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-fleet-hub-story-2988.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = join(process.env.OUT!, "fleet-hub-story-2988"), AFTER = process.env.AFTER === "1";
mkdirSync(OUT, { recursive: true });
const { bootFixture, matrix, caseName } = await import(REPO + "/scripts/manual/smoke-fixture/index.mts");
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const shot = (name: string) => join(OUT, `${name}.png`);
const probeAnswer = { ok: true, hubName: "Acme Hub", webOrigin: "https://synthetic-hub.example.test", companyJoin: true, identity: "new", separateHosts: true, suggestedLabel: "QA Fleet", features: [] };
const until = async (page: any, js: string, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await page.evaluate(js)) return true; await page.waitForTimeout(100); } return false; };

const fx: any = await bootFixture({ port: Number(process.env.HP ?? 54930), instances: 2, classic: false });
for (const name of ["startInstance", "startInstanceUnattended", "restartInstance", "restartFleet", "stopInstance"]) fx.fm[name] = async () => { throw Error("Refused lifecycle " + name); };
const agent = fx.instances[0]!.name as string;
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const tag = caseName(c), en = c.lang === "en";
    // ── #9 the company-account wait ──
    {
      const { ctx, page } = await fx.page(c, { path: "/settings/hub" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      // As a Fleet with Discord connected and no authenticator would answer: the Start is held for General's card.
      const id = "c".repeat(32);
      const held = { id, state: "pending", section: "hub", summary: [en ? "Connect to Acme Hub" : "連接 Acme Hub"], requested_at: Date.now(), expires_at: Date.now() + 300000,
        remaining_ms: 300000, requested_by: "admin", can_withdraw: true, confirmation: { kind: "chat", code: id, where: [{ platform: "discord", connection: "discord" }] } };
      await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url()); if (u.origin !== fx.base) return route.abort();
        if (u.pathname.endsWith("/company-join/probe")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(probeAnswer) });
        if (u.pathname.endsWith("/company-join/start")) return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true, result: "pending_confirmation", pending_change: held }) });
        if (u.pathname === `/api/settings/pending/${id}`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(held) });
        return route.continue(); });
      await ctx.addInitScript({ content: "window.open = () => null;" });
      await page.reload();
      await page.locator("#hubCompanyAddress").waitFor({ timeout: 20000 });
      await page.fill("#hubCompanyAddress", "https://synthetic-hub.example.test"); await page.locator("#hubCompanyAddress").blur();
      await page.waitForTimeout(800);
      await page.locator(".s-company-join form button[type=submit]").click();
      await page.locator(".company-local-wait").waitFor({ timeout: 10000 });
      await page.waitForTimeout(800);
      const wait = await page.evaluate(`document.querySelector(".company-local-wait").innerText.replace(/\\s+/g, " ").trim()`);
      await page.screenshot({ path: shot(`${tag}-09-company-wait`), fullPage: true });
      if (AFTER) check(`${tag}-9`, (en ? /First press Confirm on the card in General on Discord, so AgEnD knows it's really you connecting this Fleet/.test(wait) : /請先到 Discord 的 General，在確認卡上按「確認」，確定是你本人要連接這個 Fleet/.test(wait))
        && !/ocal confirmation|本機確認/.test(wait) && errs.length === 0, { wait, errs });
      r[`${tag}-9-words`] = wait;
      await ctx.close();
    }
    // ── #8 / #1 the Share hint; #13 is on the same Settings ──
    {
      const { ctx, page } = await fx.page(c, { path: "/ui" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      await page.goto(`${fx.base}/settings/hub`);
      await page.waitForSelector("#hub-connection", { timeout: 20000 });
      // This fixture is not a Hub member, so Settings → Hub embeds no Share list: mount the card itself in its place, on a
      // page-local client that is paired (nothing reaches a Hub or the server's member routes).
      await page.evaluate(`(async () => {
        const m = await import("/ui/js/hub-client.js");
        const row = { agent: ${JSON.stringify(agent)}, display: ${JSON.stringify(agent)}, exposureId: null, revision: 0, state: "withdrawn", policy: null, enforceable: true, choices: { dataViews: [{ id: "agent", label: "x" }], tools: [] }, pending: null };
        m.setHubClient({ stub: false, subscribe: () => () => {}, exposures: async () => [row],
          pairing: async () => ({ state: "paired", hub: { hubId: "h", name: "Acme Hub", memberOrigin: "https://synthetic-hub.example.test", webOrigin: "https://synthetic-hub.example.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } }, link: "online" }),
          setExposed: async () => ({ ok: true, pending: { id: "${"q".repeat(32)}", expiresAt: Date.now() + 300000 }, view: { ...row, pending: {} }, settled: new Promise(() => {}) }) });
        const { render, h } = await import("/assets/preact.module.js");
        const card = await import("/ui/js/settings-hub.js");
        const at = document.querySelector("#hub-connection"), host = document.createElement("div");
        at.parentElement.insertBefore(host, at); at.style.display = "none";
        render(h(card.HubConnectCard, {}), host);
      })()`);
      await page.waitForSelector(".hub-exposure input", { timeout: 15000 });
      await page.locator(".hub-exposure input").first().check({ force: true }).catch(() => page.locator(".hub-exposure input").first().click());
      await until(page, `!!document.querySelector(".hub-exposures [role=status]")`);
      const view = (confirmation: unknown) => ({ id: "q".repeat(32), state: "pending", section: "hub", summary: [en ? `Share ${agent}` : `分享 ${agent}`], requested_at: Date.now(), expires_at: Date.now() + 300000,
        remaining_ms: 300000, requested_by: "admin", can_withdraw: false, confirmation });
      const words: Record<string, string> = {};
      for (const [leg, confirmation] of [["card", { kind: "host_cli", code: "q", reason: "no_chat" }], ["discord", { kind: "chat", code: "q", where: [{ platform: "discord", connection: "discord" }] }]] as const) {
        await page.evaluate(`(async () => { const s = await import("/assets/app-store.js"); s.appStore.set({ pendingChanges: [${JSON.stringify(view(confirmation))}] }); })()`);
        await page.waitForTimeout(400);
        words[leg] = await page.evaluate(`document.querySelector(".hub-exposures [role=status]").textContent.trim()`);
        await page.locator(".hub-exposures").scrollIntoViewIfNeeded();
        await page.screenshot({ path: shot(`${tag}-08-share-hint-${leg}`) });
      }
      const lead = await page.evaluate(`document.querySelector(".hub-exposures .note").textContent.trim()`);
      await page.evaluate(`(async () => { const s = await import("/assets/app-store.js"); s.appStore.set({ pendingChanges: [] }); })()`);
      if (AFTER) check(`${tag}-8-1`, (en ? words.card === "Sent for confirmation: finish it on the confirm card at the top of this page to share it." && /General on Discord/.test(words.discord) && /ClassicBot rooms can't be shared yet/.test(lead)
        : words.card === "已送出確認：請在上方的確認卡完成，才會分享。" && /Discord 的 General/.test(words.discord) && /ClassicBot 房間還不能分享/.test(lead)) && errs.length === 0, { words, lead, errs });
      r[`${tag}-8-words`] = { ...words, lead };
      // #13: the Hub setup card (this session is a plain admin's, not the host's).
      // The page's setup mark, as web-api sets it where this computer can set up a Hub (data-hub-setup="1"); this session is a
      // plain admin's, so the server's setup read answers that the host's own sign-in is needed.
      await page.route("**/settings/hub", async (q: any) => { const res = await q.fetch(); const body = (await res.text()).replace(/<body([^>]*)>/, '<body$1 data-hub-setup="1">'); await q.fulfill({ response: res, body }); });
      await page.goto(`${fx.base}/settings/hub`);
      await page.waitForTimeout(1500);
      const setup = await page.waitForSelector("#hub-setup", { timeout: 15000 }).then(() => true, () => false);
      const setupText = setup ? await page.evaluate(`document.querySelector("#hub-setup").innerText.replace(/\\s+/g, " ").trim()`) : "";
      if (setup) { await page.locator("#hub-setup").scrollIntoViewIfNeeded(); await page.locator("#hub-setup").screenshot({ path: shot(`${tag}-13-setup-not-host`) }); }
      if (AFTER) check(`${tag}-13`, setup && (en ? /run agend web in a terminal/.test(setupText) : /在終端機執行 agend web/.test(setupText)), { setupText: setupText.slice(0, 300) });
      r[`${tag}-13-words`] = setupText.slice(0, 300);
      await ctx.close();
    }
    // ── #7 the sign-in page ──
    {
      const ctx = await fx.browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, colorScheme: c.theme,
        locale: en ? "en-US" : "zh-TW", isMobile: c.device === "phone", hasTouch: c.device === "phone", deviceScaleFactor: 2 });
      await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); } catch {}` });
      const page = await ctx.newPage();
      await page.goto(`${fx.base}/ui`); await page.waitForSelector('[data-i18n="lead"]', { timeout: 15000 }); await page.waitForTimeout(500);
      const lead = await page.evaluate(`document.querySelector('[data-i18n="lead"]').textContent.trim()`);
      await page.screenshot({ path: shot(`${tag}-07-signin`) });
      if (AFTER) check(`${tag}-7`, en ? /authenticator app, or an 8-character device sign-in code/.test(lead) : /或 8 字元的裝置登入碼/.test(lead), { lead });
      r[`${tag}-7-words`] = lead;
      await ctx.close();
    }
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : AFTER ? "ALL PASS" : "captured (before: not judged)");
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
