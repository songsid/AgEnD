// #2170 from defaults (fleet decision a78ebdc5): a held Settings change confirmed by the requester's own Apply when the
// browser is web-verified and its account is a fleet admin of the change's connection. Each case a fresh profile with
// nothing seeded, signed in through the visible /signin as its own synthetic Discord account, driven through visible UI:
// Settings → Agents → ⋯ → Delete agent → Apply changes (a change held for a fleet admin's confirmation, #1423).
// - verified (desk light en; and phone dark zh-TW, LAN origin, reduced motion): Authorize this browser (the DM card's
//   Confirm tapped through the product's own callback dispatch, as in smoke-1939), then Delete + Apply: the DELETE is
//   held (202) and confirmed by the request itself — the card says "Confirmed by your account", no chat card is posted,
//   the agent is removed once (config, disk, page), and General on the other connection gets the plain notice (drawn
//   on a neutral page and shot).
// - not verified (desk dark en): the same admin account without Authorize — held, the chat card is posted in General,
//   nothing removed until it is confirmed; then Withdraw.
// - the host's own session (an `agend web` code, no account) (desk light en): held, the chat card; Withdraw.
// - the temporary public link (phone light en, reduced motion): held, the chat card, even for an admin's account.
// Stubbed, as the harness says: the lifecycle's stop (never the live tmux server); both connections' adapters (the DM
// and General are recorded, nothing is sent anywhere). Demo names and ids only.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2170-web-verified-apply.mts
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { bootFixture, demoAccount, freshPage, mounted, openPublicLink, shotPath, type DemoAccount, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2170-web-verified-apply";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
// A navigation the smoke makes (page.goto) cancels the stream and polls in flight; WebKit logs those (smoke-delete-agent).
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll)|auth\/session)(\?\S*)? due to access control checks\.$/;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48640), classic: false });
const fm = fx.fm;
const CHAT = "observability-dashboards";
const VICTIMS = ["search-indexer", "nightly-benchmarks", "docs-site-builder", "billing-reconciliation", "release-notes-drafter"];
for (const name of Object.keys(fm.fleetConfig.instances)) if (![CHAT, ...VICTIMS].includes(name)) delete fm.fleetConfig.instances[name];
for (const v of VICTIMS) {                                                        // each row shows its own name
  fm.fleetConfig.instances[v] ??= { working_directory: fx.dir, backend: "claude-code" };
  delete fm.fleetConfig.instances[v].display_name;
}

// Two demo Discord connections with the same admins (config the operator writes): "demo" owns the agents (the change's
// connection), "ops" holds General (where a chat card would go, and the notice goes).
// Two lists, never one array shared (fleet.yaml would be written with a YAML alias between them).
const demoAdmins: string[] = [], opsAdmins: string[] = [];
const admins = { push(id: string) { demoAdmins.push(id); opsAdmins.push(id); } };
fm.fleetConfig.channels = [
  { id: "demo", type: "discord", mode: "topic", bot_token_env: "DEMO_BOT_TOKEN", group_id: "demo-guild", access: { mode: "locked", allowed_users: demoAdmins } },
  { id: "ops", type: "discord", mode: "topic", bot_token_env: "OPS_BOT_TOKEN", group_id: "ops-guild", access: { mode: "locked", allowed_users: opsAdmins } },
];
fm.fleetConfig.instances.general = { working_directory: fx.dir, backend: "claude-code", general_topic: true, channel_id: "ops", topic_id: 77 };
fm.saveFleetConfig();
fm.lifecycle.daemons.set("general", { on() {}, off() {} });
fm.lifecycle.runTransition = (_name: string, fn: (t: unknown) => Promise<unknown>) => fn({});
const removed: string[] = [];
fm.lifecycle.remove = async (name: string, _auth: unknown, execution?: any) => {
  const persist = () => { delete fm.fleetConfig.instances[name]; fm.saveFleetConfig(); };
  if (execution) execution.mutate(persist); else persist();
  removed.push(name);
};
const onDisk = () => Object.keys((yaml.load(readFileSync(fm.configPath, "utf8")) as any).instances ?? {});

interface Card { userId: string; chatId: string; messageId: string; text: string; choices: Array<{ id: string; label: string }> }
const cards: Card[] = [];
const dm = {
  id: "demo", type: "discord", on() {}, off() {},
  async sendDirect(userId: string, text: string, opts: { choices?: Array<{ id: string; label: string }> } = {}) {
    const card = { userId, chatId: `dm-${userId}`, messageId: `card-${cards.length + 1}`, text, choices: opts.choices ?? [] };
    cards.push(card); return { chatId: card.chatId, messageId: card.messageId };
  },
  async editMessage(chatId: string, messageId: string, text: string) { const c = cards.find(x => x.chatId === chatId && x.messageId === messageId); if (c) c.text = text; },
  async editMessageRemoveButtons(chatId: string, messageId: string, text: string) { await dm.editMessage(chatId, messageId, text); const c = cards.find(x => x.messageId === messageId); if (c) c.choices = []; },
  async replaceMessageButtons(_chatId: string, messageId: string, choices: Array<{ id: string; label: string }>) { const c = cards.find(x => x.messageId === messageId); if (c) c.choices = choices; },
  async sendText() { return { messageId: "demo-1", chatId: "demo-guild" }; },
};
// General's connection: what is posted there is recorded — a chat card (notifyAlert, with buttons) or a notice (sendText).
const general: { cards: Array<{ text: string }>; notices: Array<{ chatId: string; text: string; opts: any }> } = { cards: [], notices: [] };
const ops = {
  id: "ops", type: "discord", on() {}, off() {},
  async notifyAlert(chatId: string, alert: any, o: any) { general.cards.push({ text: String(alert?.message ?? "") }); return { chatId, messageId: `ops-card-${general.cards.length}`, threadId: o?.threadId }; },
  async editMessageRemoveButtons() {}, async editMessage() {},
  async sendText(chatId: string, text: string, opts: any) { general.notices.push({ chatId, text, opts }); return { chatId, messageId: `ops-notice-${general.notices.length}` }; },
};
for (const [id, adapter, groupId] of [["demo", dm, "demo-guild"], ["ops", ops, "ops-guild"]] as const) {
  fm.adapters.set(id, adapter);
  fm.worlds.set(id, { id, adapter, groupId, channelConfig: fm.fleetConfig.channels.find((c: any) => c.id === id) });
  fm.adapterState.set(id, { status: "connected", retryCount: 0 });
}
fm.adapter = dm;

async function tap(card: Card, which: "confirm" | "notme"): Promise<void> {
  const choice = card.choices.find(c => c.id.endsWith(`:${which}`));
  if (!choice) throw new Error(`the card has no ${which}`);
  await fm.dispatchAdapterCallback({ callbackData: choice.id, userId: card.userId, chatId: card.chatId, messageId: card.messageId, ack: () => {} }, "demo", dm);
}
async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  throw new Error(`nothing visible matches ${selector} on ${page.url()}`);
}
const phone = (p: FreshPage) => p.page.viewportSize().width < 760;
async function openDrawer(p: FreshPage) {
  if (phone(p) && !(await p.page.locator(".shell.sb-open").count())) await clickVisible(p.page, 'button[aria-controls="sidebar"]');
}
/** Authorize this browser from the chat's line, and Confirm the DM card as the account. */
async function authorize(p: FreshPage, a: DemoAccount): Promise<boolean> {
  await openDrawer(p);
  await clickVisible(p.page, `a[href="/ui/chat/${CHAT}"]`);
  await p.page.waitForSelector('.webauth-chip[data-state="none"] button', { timeout: 10000 });
  await clickVisible(p.page, ".webauth-chip button");
  await p.page.waitForSelector('.webauth-chip[data-state="pending"]', { timeout: 10000 });
  const card = cards.filter(c => c.userId === a.userId).at(-1);
  if (!card) return false;
  await tap(card, "confirm");
  return p.page.waitForSelector('.webauth-chip[data-state="verified"]', { timeout: 10000 }).then(() => true, () => false);
}
async function toAgents(p: FreshPage) {
  await openDrawer(p);
  await clickVisible(p.page, 'a[href="/settings"]');
  await p.page.waitForURL("**/settings", { timeout: 10000 });                     // Agents is the first section
  await p.page.waitForSelector(".s-row", { timeout: 15000 });
}
async function deleteAndApply(p: FreshPage, victim: string, lang: string) {
  const row = p.page.locator(".s-row").filter({ hasText: victim }).first();
  await row.locator(".s-actions button").last().click({ timeout: 10000 }).catch(async (e: unknown) => {
    await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-failure`, victim) }).catch(() => {});
    throw new Error(`no ⋯ on ${victim}'s row: ${JSON.stringify(await p.page.locator(".s-row").allInnerTexts()).slice(0, 600)} ${String(e).slice(0, 80)}`);
  });                                                                             // ⋯
  await p.page.getByText(lang === "en" ? "Delete agent" : "刪除 agent", { exact: true }).last().click();
  await p.page.waitForSelector("dialog[open]", { timeout: 5000 });
  await p.page.click("dialog[open] .btn-danger");
  await p.page.getByRole("button", { name: lang === "en" ? "Apply changes" : "套用變更" }).click();
}
/** The card's text once it is in that state — scrolled into view for the shot that follows (a phone's list is long). */
const cardText = (p: FreshPage, state: string) => p.page.waitForSelector(`.pending-card.${state}`, { timeout: 10000 })
  .then(async (el: any) => { await el.scrollIntoViewIfNeeded().catch(() => {}); return (await el.innerText()) as string; }, () => null);
const overflow = (p: FreshPage) => p.page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth");
const gate = () => (fm as any).settingsGate();
const heldIds = () => [...gate().store.records.values()].filter((e: any) => e.view.state === "pending").map((e: any) => e.view.id);

// The notice as General shows it: drawn on a neutral page (not a copy of any app), shot, and read back from what was shot.
const noticePage = await (await fx.browser.newContext({ viewport: { width: 640, height: 320 }, deviceScaleFactor: 1 })).newPage();
async function shootNotice(name: string, text: string): Promise<string> {
  await noticePage.setContent(`<!doctype html><meta charset="utf-8"><style>
    body { margin: 16px; background: #eef0f3; font: 15px/1.45 system-ui, sans-serif; color: #1f2328 }
    .m { max-width: 560px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 14px }
    .cap { font-size: 12px; color: #57606a; margin-bottom: 8px } .t { white-space: pre-wrap }
  </style><div class="m"><div class="cap">General on the other connection (stub adapter)</div><div class="t"></div></div>`);
  await noticePage.evaluate((t: string) => { document.querySelector(".t")!.textContent = t; }, text);
  await noticePage.locator(".m").screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "notice") });
  return (await noticePage.locator(".m .t").textContent()) ?? "";
}

const results: any[] = [];
function record(name: string, chk: Record<string, boolean>, p: FreshPage, navEnd: number, extra: Record<string, unknown>) {
  const errors = p.errors.filter((e, i) => { const text = e.replace(/ @ \S+$/, "");
    return !(ENGINE === "webkit" && (WEBKIT_OWN.has(text) || (i < navEnd && CANCEL.test(text)))); });
  chk.noErrors = errors.length === 0;
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ errors, ...extra }).slice(0, 1600)}` : ""}`);
}
function admin(): DemoAccount { const a = demoAccount(); admins.push(a.userId); return a; }

async function verifiedCase(name: string, open: (a: DemoAccount) => Promise<FreshPage>, victim: string, lang: string) {
  const a = admin();
  const p = await open(a);
  await mounted(p.page, 30000);
  const navEnd = p.errors.length;
  const calls: string[] = [];
  p.page.on("response", (r: any) => { const u = new URL(r.url()); if (r.request().method() !== "GET" && u.pathname.startsWith("/api/settings")) calls.push(`${r.request().method()} ${u.pathname} ${r.status()}`); });
  const chk: Record<string, boolean> = { authorized: await authorize(p, a) };
  await toAgents(p);
  const cardsBefore = general.cards.length, noticesBefore = general.notices.length;
  await deleteAndApply(p, victim, lang);
  const text = await cardText(p, "applying") ?? await cardText(p, "applied");
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "1-confirmed-by-you") });
  const gone = await p.page.waitForFunction((v: string) => ![...document.querySelectorAll(".s-row .s-name")].some((e) => (e.textContent ?? "").includes(v)), victim, { timeout: 20000 }).then(() => true, () => false);
  await p.page.waitForTimeout(500);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "2-deleted") });
  const notice = general.notices.slice(noticesBefore);
  const shown = notice[0] ? await shootNotice(name, notice[0].text) : "";
  Object.assign(chk, {
    heldThenConfirmedByRequest: calls.includes(`DELETE /api/settings/fleet/instances/${victim} 202`) && heldIds().length === 0,
    cardSaysYourAccount: !!text && text.includes(lang === "en" ? "Confirmed by your account (this browser is web-verified)" : "由你的帳號確認（這個瀏覽器已通過網頁驗證）")
      && !text.includes(lang === "en" ? "confirms this in chat" : "在聊天（General topic）中確認"),
    noChatCard: general.cards.length === cardsBefore,
    removedOnce: removed.filter(r => r === victim).length === 1, goneFromConfig: !Object.hasOwn(fm.fleetConfig.instances, victim), goneFromDisk: !onDisk().includes(victim), goneFromPage: gone,
    oneNoticeInGeneral: notice.length === 1 && notice[0].chatId === "ops-guild" && notice[0].opts?.threadId === "77" && JSON.stringify(notice[0].opts?.allowedMentions) === '{"parse":[]}',
    noticeSays: /^✅ Settings change confirmed from the web by .+ \(web-verified\)\nSource: web_session\nRequester: .+\n[\s\S]+\nOutcome: Change applied\.$/.test(shown),
    noOverflow: !(await overflow(p)),
  });
  record(name, chk, p, navEnd, { calls, text, notice });
  await p.ctx.close();
}

async function heldCase(name: string, open: () => Promise<FreshPage>, victim: string, lang: string) {
  const p = await open();
  await mounted(p.page, 30000);
  const navEnd = p.errors.length;
  const calls: string[] = [];
  p.page.on("response", (r: any) => { const u = new URL(r.url()); if (r.request().method() !== "GET" && u.pathname.startsWith("/api/settings")) calls.push(`${r.request().method()} ${u.pathname} ${r.status()}`); });
  await toAgents(p);
  const cardsBefore = general.cards.length, noticesBefore = general.notices.length;
  await deleteAndApply(p, victim, lang);
  // Answered as held for the host (no card is posted yet); the next poll (2 s) says it is in chat once the card is.
  await cardText(p, "pending");
  const chat = lang === "en" ? "A fleet admin confirms this in chat" : "由 fleet 管理員在聊天";
  await p.page.waitForFunction((t: string) => (document.querySelector(".pending-card.pending") as HTMLElement | null)?.innerText.includes(t), chat, { timeout: 6000 }).catch(() => {});
  const text = await cardText(p, "pending");
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "1-waiting-for-chat") });
  const chk: Record<string, boolean> = {
    held: calls.includes(`DELETE /api/settings/fleet/instances/${victim} 202`) && heldIds().length === 1,
    cardSaysChat: !!text && text.includes(chat) && !/Confirmed by your account|由你的帳號確認/.test(text),
    chatCardPosted: general.cards.length === cardsBefore + 1,
    notRemoved: !removed.includes(victim) && Object.hasOwn(fm.fleetConfig.instances, victim),
    noNotice: general.notices.length === noticesBefore,
    noOverflow: !(await overflow(p)),
  };
  await clickVisible(p.page, `.pending-card.pending button`);                    // Withdraw
  chk.withdrawn = await p.page.waitForSelector(".pending-card.rejected", { timeout: 10000 }).then(() => true, () => false) && heldIds().length === 0;
  record(name, chk, p, navEnd, { calls, text });
  await p.ctx.close();
}

await verifiedCase("verified-desk-light-en", (a) => freshPage(fx, { device: "desk", theme: "light", lang: "en" }, { account: a }), VICTIMS[0], "en");
await verifiedCase(ENGINE === "webkit" ? "verified-phone-dark-zh-TW-reduced" : "verified-phone-dark-zh-TW-lan-reduced",
  (a) => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, { account: a, reducedMotion: true, ...(ENGINE === "webkit" ? {} : { origin: "lan" as const }) }), VICTIMS[1], "zh-TW");
await heldCase("not-verified-desk-dark-en", () => freshPage(fx, { device: "desk", theme: "dark", lang: "en" }, { account: admin() }), VICTIMS[2], "en");
await heldCase("host-session-desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }, { account: "operator" }), VICTIMS[3], "en");
{
  const link = await openPublicLink(fx);
  admins.push(link.owner.userId);
  await heldCase("public-link-phone-light-en-reduced", () => link.publicPage({ device: "phone", theme: "light", lang: "en" }, { reducedMotion: true }), VICTIMS[4], "en");
  await link.close();
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);
