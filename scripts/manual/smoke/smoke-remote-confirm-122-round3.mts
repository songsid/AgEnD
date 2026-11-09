// AGEND-122 (upstream #3486; Prism's second review of PR #3503), two parts, one script (PART=chat | skew), real Chromium on the shared fixture:
//
//  PART=chat — a CHAT fleet's admin (a signed-in Discord account in the connection's admin list, not the host's own session), on a LAN name:
//    1 chat-no-app:    held Settings change, no authenticator: confirmed at once (the lenient default), no code field;
//    2 chat-app-off:   own authenticator set up, own switch off: applied at once;
//    3 chat-code:      own switch on: the code field for THAT change; the account's OWN current code applies it (another admin's app would not);
//    4 chat-card:      the Owner verification card as that admin sees it: not set up, the set-up dialog, set up (with the switch), the current-code
//                      dialog for replacing the app / turning the switch off (asked whether or not the switch is on: Prism #2);
//    5 chat-notices:   what a set-up leaves behind: the Notice in every connection's General (both connections) AND the dashboard's Notices (Prism #3).
//
//  PART=skew — a tab left open from before this change (or a browser that cached some of the shared assets) against the new server: the lazy
//    Settings panels (settings-outside.js, settings-strings.js, settings-confirm.js) are new; the shared shell assets are from the review base
//    (SKEW=<dir with the base's app.js, app-shell.js, app-i18n.js, app.css>). Variants: fresh; dict (app-i18n.js old); css (app.css old);
//    dict+css; shell (app.js, app-shell.js, app-i18n.js, app.css all old). Judged on each: the pending card and the Owner verification card render
//    their words (no "undefined", no raw key), the actions work (lenient Apply; the code field and the code; the switch dialog), no page error.
//
// Stubbed, as the harness says: both connections' adapters (what would be posted in General is recorded, nothing is sent anywhere). Demo names only.
//   . smoke-env/env.sh; PART=chat|skew REPO=<checkout> OUT=<dir> MATRIX=quick [SKEW=<dir>] SMOKE_NAME=<folder> \
//   npx tsx scripts/manual/smoke/smoke-remote-confirm-122-round3.mts
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, demoAccount, matrix, shotPath, LAN_HOST, freshPage, mounted } from "../smoke-fixture/index.mts";

const PART = process.env.PART === "skew" ? "skew" : "chat";
const SMOKE = process.env.SMOKE_NAME ?? `smoke-remote-confirm-122-${PART}`;
const REPO = process.env.REPO!;
const { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE, adminKey, HOST_ADMIN_KEY } = await import(REPO + "/src/web-remote-access.ts");
const SECRET = base32Encode(Buffer.from("smoke-secret-0123456"));
const OTHER = base32Encode(Buffer.from("smoke-other-app-9876"));
const code = (s = SECRET, shift = 0) => hotp(base32Decode(s)!, totpStep(Date.now()) + shift);
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const fx = await bootFixture({ port: Number(process.env.HP ?? (PART === "chat" ? 47570 : 47580)), instances: 4, host: PART === "skew" });
const fm = fx.fm as any;
const BAD = /\bundefined\b|\[object|\bNaN\b|\bsettingsOutside\.|\bpendingSelf\b|\bpendingHost\b|\bstrictLabel\b|\bleadConfirm\b|\bpendingApplyRefused\b/;
const membership = () => !!fm.getRawFleetConfig()?.hub_member?.enabled;
const file = () => join(fx.dir, WEB_REMOTE_ACCESS_FILE);
const seed = (rec: Record<string, unknown> | null) => { if (rec) writeFileSync(file(), JSON.stringify({ v: 1, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [], ...rec }), { mode: 0o600 }); else rmSync(file(), { force: true }); fm.webRemoteAccessState = undefined; };
const rec = (secret: string, strict = false) => ({ secret, enrolledAt: 1, lastStep: 0, ...(strict ? { strict: true } : {}) });
const readCard = (page: any) => page.evaluate(() => {
  const c = document.querySelector(".pending-card");
  return { present: !!c, text: (c?.textContent ?? "").replace(/\s+/g, " ").trim(), hostCommand: !!c?.querySelector(".pending-host"), codeField: !!c?.querySelector(".pending-code-input"), applied: !!document.querySelector(".pending-card.applied") };
});
/** Page errors that are the fixture's, not the product's: it has no Hub, so the Hub page's own reads answer 403/404 (also on a fresh tab). */
const realErrors = (errs: string[]) => errs.filter(e => !/Failed to load resource.*\/api\/hub\/member\//.test(e));
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// ---- a chat fleet (PART=chat): two demo Discord connections with the same admin list; General on "ops" ----------------------------------------
const general: { notices: Array<{ chatId: string; text: string }> } = { notices: [] };
const noticesOn: Record<string, string[]> = { demo: [], ops: [] };
const admins: string[] = [];
const removed: string[] = [];
/** Into the lists the fleet holds NOW (a save can reload them; a list kept from before would be a stale copy). */
const addAdmin = (id: string) => { for (const ch of fm.fleetConfig.channels ?? []) { const l: string[] = ch.access?.allowed_users ?? []; if (!l.includes(id)) l.push(id); } };
let victimN = 0;
const nextVictim = () => { const v = `demo-victim-${++victimN}`; fm.fleetConfig.instances[v] = { working_directory: fx.dir, backend: "claude-code" }; fm.saveFleetConfig(); return v; };
if (PART === "chat") {
  const mk = (id: string) => ({ id, type: "discord", on() {}, off() {},
    async sendDirect() { return { chatId: "dm", messageId: "dm-1" }; },
    async notifyAlert(chatId: string, alert: any) { noticesOn[id]!.push(String(alert?.message ?? "")); return { chatId, messageId: `${id}-a` }; },
    async sendText(chatId: string, text: string) { noticesOn[id]!.push(text); general.notices.push({ chatId, text }); return { chatId, messageId: `${id}-n` }; },
    async editMessage() {}, async editMessageRemoveButtons() {}, async replaceMessageButtons() {} });
  fm.fleetConfig.channels = [
    { id: "demo", type: "discord", mode: "topic", bot_token_env: "DEMO_BOT_TOKEN", group_id: "demo-guild", access: { mode: "locked", allowed_users: admins } },
    { id: "ops", type: "discord", mode: "topic", bot_token_env: "OPS_BOT_TOKEN", group_id: "ops-guild", access: { mode: "locked", allowed_users: admins } },
  ];
  fm.fleetConfig.instances.general = { working_directory: fx.dir, backend: "claude-code", general_topic: true, channel_id: "ops", topic_id: 77 };
  // Each connection has its own General (their admin lists can differ in a real fleet): the security Notice goes to every one of them.
  fm.fleetConfig.instances["general-demo"] = { working_directory: fx.dir, backend: "claude-code", general_topic: true, channel_id: "demo", topic_id: 78 };
  fm.saveFleetConfig();
  fm.lifecycle.daemons.set("general", { on() {}, off() {} });
  fm.lifecycle.daemons.set("general-demo", { on() {}, off() {} });
  delete fm.notifyFleetError;                       // the fixture stubs it (index.mts); the product's own posts to General, so the Notice reaches the stub adapters
  // The held change on a chat fleet is "Delete agent" (the 2170 smoke's): the lifecycle's stop is stubbed, never a real tmux server.
  fm.lifecycle.runTransition = (_name: string, fn: (t: unknown) => Promise<unknown>) => fn({});
  fm.lifecycle.epochOf ??= () => 0;
  fm.lifecycle.remove = async (name: string, _auth: unknown, execution?: any) => {
    const persist = () => { delete fm.fleetConfig.instances[name]; fm.saveFleetConfig(); removed.push(name); };
    if (execution) execution.mutate(persist); else persist();
  };
  for (const [id, groupId] of [["demo", "demo-guild"], ["ops", "ops-guild"]] as const) {
    const adapter = mk(id);
    fm.adapters.set(id, adapter);
    fm.worlds.set(id, { id, adapter, groupId, channelConfig: fm.fleetConfig.channels.find((c: any) => c.id === id), accessManager: { getMode: () => "allowlist", isAllowed: () => true }, stop: async () => {} });
    fm.adapterState.set(id, { status: "connected", retryCount: 0 });
  }
  fm.adapter = fm.adapters.get("demo");
}

const REMOTE = { origin: "lan" as const, headers: { "X-Forwarded-For": "100.64.0.7" }, host: PART === "skew" };
/** A chat fleet: Settings → Agents → ⋯ → Delete agent → Apply changes, then the held card. */
async function holdDelete(page: any, lang: string, victim: string) {
  await page.waitForSelector(".s-row", { state: "visible", timeout: 12000 }).catch(async (e: unknown) => { await page.screenshot({ path: join(process.env.OUT ?? "/tmp/smoke-out", "norow.png") }).catch(() => {}); throw e; });
  const row = page.locator(".s-row:visible").filter({ hasText: victim }).first();
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.locator(".s-actions button:visible").last().click({ timeout: 10000 });
  await page.getByText(lang === "en" ? "Delete agent" : "刪除 agent", { exact: true }).last().click();
  await page.waitForSelector("dialog[open]", { timeout: 5000 });
  await page.click("dialog[open] .btn-danger");
  await page.getByRole("button", { name: lang === "en" ? "Save" : "儲存", exact: true }).click({ timeout: 8000 }).catch(async (e: unknown) => {
    await page.screenshot({ path: join(process.env.OUT ?? "/tmp/smoke-out", "holdDelete-failure.png") }).catch(() => {}); throw e; });
  await page.waitForSelector(".pending-card", { timeout: 15000 }).catch(async (e: unknown) => {
    await page.screenshot({ path: join(process.env.OUT ?? "/tmp/smoke-out", "holdDelete-nocard.png") }).catch(() => {});
    throw new Error(`no pending card (removed: ${removed.join(",")}): ${(await page.evaluate("document.body.textContent.replace(/\\s+/g,' ').slice(-400)"))}`); });
  await page.waitForFunction(() => !/Sending the confirm card|正在把確認卡送到/.test(document.querySelector(".pending-card")?.textContent || "x"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return readCard(page);
}
/** Open /settings/hub, flip Hub membership on, wait for the card to leave "Sending", read it. */
async function holdChange(page: any) {
  await page.waitForSelector("#hubMemberEnabled", { timeout: 20000 });
  await page.click("#hubMemberEnabled");
  await page.waitForSelector(".pending-card", { timeout: 15000 }).catch(async (e: unknown) => {
    await page.screenshot({ path: join(process.env.OUT ?? "/tmp/smoke-out", "holdChange-failure.png") }).catch(() => {});
    throw new Error(`no pending card: ${(await page.evaluate(() => (document.body.textContent ?? "").replace(/\\s+/g, " ").slice(0, 500)))} ${String(e).slice(0, 60)}`);
  });
  await page.waitForFunction(() => !/Sending the confirm card|正在把確認卡送到/.test(document.querySelector(".pending-card")?.textContent || "x"), null, { timeout: 20000 });
  await page.waitForTimeout(900);
  return readCard(page);
}
async function ownerCard(page: any) {
  await page.waitForSelector("#outsideCard", { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(600);
  return page.evaluate(() => ({ present: !!document.querySelector("#outsideCard"), text: (document.querySelector("#outsideCard")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
    setUp: !!document.querySelector("#outSetUp"), strictSwitch: !!document.querySelector("#outStrict") }));
}

try {
  if (PART === "chat") {
    for (const c of matrix(process.env.MATRIX ?? "quick")) {
      const cn = caseName(c);
      // 1–3: a held change, the admin's own record decides.
      for (const [name, state] of [["1-chat-no-app", "none"], ["2-chat-app-off", "off"], ["3-chat-code", "strict"]] as const) {
        const victim = nextVictim(), gone = () => removed.includes(victim);
        const a = demoAccount(); addAdmin(a.userId);
        const mine = adminKey(a.adapterId, a.userId);
        seed(state === "none" ? null : { admins: { [mine]: rec(SECRET, state === "strict") } });
        const p = await freshPage(fx, c, { origin: "lan", account: a, path: "/settings/agents", beforeNavigate: async (_ctx: any, pg: any) => { await pg.setExtraHTTPHeaders(REMOTE.headers); } });
        await mounted(p.page, 30000);
        const card = await holdDelete(p.page, c.lang, victim), tag = `${cn}:${name}`;
        r[`${tag}:observed`] = { ...card, applied: gone() };
        await p.page.locator(".pending-card").first().screenshot({ path: shotPath(SMOKE, cn, name) });
        check(`${tag}:no-host-command`, !card.hostCommand && !/agend settings confirm/.test(card.text) && !BAD.test(card.text) && realErrors(p.errors).length === 0, { card, errs: p.errors });
        if (state === "strict") {
          check(`${tag}:asks-for-code`, card.codeField && !gone(), { card, gone: gone() });
          // Another admin's app (a different secret) is not this admin's: refused; the account's own current code applies it.
          await p.page.fill(".pending-code-input", code(OTHER));
          await p.page.click("form.pending-code button[type=submit]"); await p.page.waitForTimeout(900);
          check(`${tag}:other-apps-code-refused`, !gone(), { gone: gone() });
          await p.page.fill(".pending-code-input", code(SECRET, 1));
          await p.page.click("form.pending-code button[type=submit]");
          const ok = await p.page.waitForSelector(".pending-card.applied", { timeout: 15000 }).then(() => true, () => false);
          check(`${tag}:own-code-applies`, ok && gone(), { ok, gone: gone() });
        } else check(`${tag}:applies-at-once`, gone() && !card.codeField, { card });
        await p.ctx.close();
      }
      // 4: the Owner verification card of a chat admin; set up in the dialog (the code read off the dialog's own key), then the lifecycle dialogs.
      {
        const a = demoAccount(); addAdmin(a.userId); seed(null);
        const mine = adminKey(a.adapterId, a.userId);
        const p = await freshPage(fx, c, { origin: "lan", account: a, path: "/settings/access", beforeNavigate: async (_ctx: any, pg: any) => { await pg.setExtraHTTPHeaders(REMOTE.headers); } });
        await mounted(p.page, 30000);
        const wb = fm.webNoticeStore()?.newest?.() ?? 0;
        r[`${cn}:4a-observed`] = await ownerCard(p.page);
        if (!(r[`${cn}:4a-observed`] as any).present) r[`${cn}:4a-api`] = await p.page.evaluate(async () => { const x = await fetch("/ui/outside", { credentials: "same-origin" }); return [x.status, await x.text()]; });
        if (!(r[`${cn}:4a-observed`] as any).present) await p.page.screenshot({ path: join(process.env.OUT ?? "/tmp/smoke-out", "nocard.png") });
        await p.page.locator("#outsideCard").first().screenshot({ path: shotPath(SMOKE, cn, "4a-card-not-set-up") });
        await p.page.click("#outSetUp"); await p.page.waitForSelector(".dlg #outKey", { timeout: 8000 }); await p.page.waitForTimeout(400);
        await p.page.locator(".dlg").first().screenshot({ path: shotPath(SMOKE, cn, "4b-set-up-dialog") });
        const key = ((await p.page.textContent("#outKey")) ?? "").replace(/[\s-]/g, "");
        await p.page.fill("#outCode", hotp(base32Decode(key)!, totpStep(Date.now())));
        await p.page.click("#outConfirm");
        await p.page.waitForSelector("#outAgain", { timeout: 15000 });
        await p.page.waitForTimeout(500);
        check(`${cn}:4-chat-admin-set-up`, JSON.parse(readFileSync(file(), "utf8")).admins?.[mine]?.secret === key && (JSON.parse(readFileSync(file(), "utf8")).totp ?? null) === null, { file: JSON.parse(readFileSync(file(), "utf8")) });
        await p.page.locator("#outsideCard").first().screenshot({ path: shotPath(SMOKE, cn, "4c-card-set-up") });
        await p.page.click("#outStrict"); await p.page.waitForTimeout(900);
        check(`${cn}:4-switch-on-asks-nothing`, JSON.parse(readFileSync(file(), "utf8")).admins?.[mine]?.strict === true, {});
        // Replace and remove ask the admin's own current code off the computer; so does turning the switch off.
        await p.page.click("#outAgain"); await p.page.waitForSelector(".dlg #outAskCode", { timeout: 8000 });
        await p.page.locator(".dlg").first().screenshot({ path: shotPath(SMOKE, cn, "4d-replace-asks-code") });
        await p.page.keyboard.press("Escape"); await p.page.waitForTimeout(300);
        await p.page.click("#outStrict"); await p.page.waitForSelector(".dlg #outAskCode", { timeout: 8000 });
        await p.page.locator(".dlg").first().screenshot({ path: shotPath(SMOKE, cn, "4e-switch-off-asks-code") });
        await p.page.fill("#outAskCode", code(key, 1)); await p.page.click("#outAskGo"); await p.page.waitForTimeout(1200);
        check(`${cn}:4-switch-off-with-code`, JSON.parse(readFileSync(file(), "utf8")).admins?.[mine]?.strict !== true, {});
        // With the switch OFF the app that exists is still its owner's: removing asks the current code (Prism #2).
        await p.page.click("#outRemove"); await p.page.waitForSelector(".dlg #outAskCode", { timeout: 8000 });
        check(`${cn}:4-remove-asks-code-though-switch-off`, true);
        await p.page.locator(".dlg").first().screenshot({ path: shotPath(SMOKE, cn, "4f-remove-asks-code-switch-off") });
        await p.page.keyboard.press("Escape");
        // 5: what the set-up and the switch changes left behind.
        const sec = (id: string) => noticesOn[id]!.filter(t => /authenticator/i.test(t) && t.includes(a.username)).length;
        check(`${cn}:5-notice-in-both-connections`, sec("demo") === 3 && sec("ops") === 3, { demo: sec("demo"), ops: sec("ops") });   // set up, switch on, switch off: each, in every General
        const store = fm.webNoticeStore();
        check(`${cn}:5-notice-in-dashboard`, !!store && (store.newest?.() ?? 0) > wb, { newest: store?.newest?.(), before: wb });
        r[`${cn}:5-observed`] = { general: general.notices.slice(-3).map(n => n.text.slice(0, 160)) };
        await p.page.goto(`${p.base}/ui/notices`); await p.page.waitForTimeout(1500);
        await p.page.screenshot({ path: shotPath(SMOKE, cn, "5-dashboard-notices") });
        const nt = await p.page.evaluate(() => (document.body.textContent ?? "").replace(/\s+/g, " ").slice(0, 3000));
        check(`${cn}:5-notices-page-names-the-admin`, /authenticator|驗證器/i.test(nt) && !BAD.test(nt.slice(0, 3000)), { nt: nt.slice(0, 300) });
        check(`${cn}:no-page-errors`, realErrors(p.errors).length === 0, realErrors(p.errors));
        await p.ctx.close();
      }
    }
  } else {
    // ---- SKEW: the shared assets of the review base in a tab that otherwise loads the new server's assets --------------------------------------
    const SKEW = process.env.SKEW!;
    const VARIANTS: Array<[string, string[]]> = [["fresh", []], ["dict", ["app-i18n.js"]], ["css", ["app.css"]], ["dict-css", ["app-i18n.js", "app.css"]], ["shell", ["app.js", "app-shell.js", "app-i18n.js", "app.css"]]];
    for (const c of matrix(process.env.MATRIX ?? "quick")) {
      const cn = caseName(c);
      for (const [vname, files] of VARIANTS) {
        const route = async (_ctx: any, pg: any) => {
          await pg.setExtraHTTPHeaders(REMOTE.headers);
          for (const f of files) {
            const body = readFileSync(join(SKEW, f), "utf8");
            await pg.route(`**/assets/${f}*`, (rt: any) => rt.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css" : "text/javascript", body }));
          }
        };
        const tag = `${cn}:${vname}`;
        // The pending card: lenient (no app) and code-asked (own switch).
        for (const [name, state] of [["a-pending-lenient", "none"], ["b-pending-code", "strict"]] as const) {
          fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: false }]);
          seed(state === "none" ? null : { totp: rec(SECRET, true) });
          const p = await freshPage(fx, c, { origin: "lan", account: "operator", path: "/settings/hub", beforeNavigate: route });
          await mounted(p.page, 30000);
          const card = await holdChange(p.page).catch((e: unknown) => ({ present: false, text: String(e).slice(0, 160), hostCommand: false, codeField: false, applied: false }));
          r[`${tag}:${name}:observed`] = { ...card, applied: membership() };
          await p.page.screenshot({ path: shotPath(SMOKE, `${cn}-${vname}`, name) });
          check(`${tag}:${name}:words`, card.present && !BAD.test(card.text) && (files.includes("app-shell.js") || !/agend settings confirm/.test(card.text)), { text: card.text });   // the old shell never knew the card is remote: it keeps its folded host command (the old behaviour), nothing else
          if (state === "strict") {
            await p.page.fill(".pending-code-input", code()); await p.page.click("form.pending-code button[type=submit]");
            const ok = await p.page.waitForSelector(".pending-card.applied", { timeout: 15000 }).then(() => true, () => false);
            check(`${tag}:${name}:code-applies`, ok && membership(), { ok });
          } else check(`${tag}:${name}:applies-at-once`, membership(), { card });
          check(`${tag}:${name}:no-page-errors`, realErrors(p.errors).length === 0, realErrors(p.errors));
          await p.ctx.close();
        }
        // The Owner verification card with the app set up and the switch on: its words, and the current-code dialog for turning the switch off.
        seed({ totp: rec(SECRET, true) });
        const p = await freshPage(fx, c, { origin: "lan", account: "operator", path: "/settings/access", beforeNavigate: route });
        await mounted(p.page, 30000);
        const o = await ownerCard(p.page);
        r[`${tag}:card:observed`] = o;
        await p.page.locator("#outsideCard").first().screenshot({ path: shotPath(SMOKE, `${cn}-${vname}`, "c-owner-card") }).catch(() => {});
        check(`${tag}:card:words`, o.present && o.strictSwitch && !BAD.test(o.text), o);
        await p.page.click("#outStrict").catch(() => {}); await p.page.waitForSelector(".dlg #outAskCode", { timeout: 8000 }).catch(() => {});
        await p.page.locator(".dlg").first().screenshot({ path: shotPath(SMOKE, `${cn}-${vname}`, "d-code-dialog") }).catch(() => {});
        check(`${tag}:card:code-dialog`, (await p.page.locator(".dlg #outAskCode").count()) === 1 && !BAD.test((await p.page.locator(".dlg").first().textContent().catch(() => "")) ?? ""));
        check(`${tag}:card:no-page-errors`, realErrors(p.errors).length === 0, realErrors(p.errors));
        await p.ctx.close();
      }
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== "PASS" && !k.endsWith(":observed"))), null, 1).slice(0, 6000));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
void HOST_ADMIN_KEY; void sleep; void LAN_HOST;
