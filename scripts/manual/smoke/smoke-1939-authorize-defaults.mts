// #1939 S2b/S2c from defaults (fleet decision a78ebdc5): "Authorize this browser" and Settings → Web → Web authority, each
// case a fresh profile with nothing seeded, signed in through the visible /signin as its own synthetic Discord account,
// driven only through visible UI. The account's DM is a stub adapter (what is outside the product): the card it receives
// is recorded, drawn on a neutral page and shot, and its buttons are tapped through the product's own callback dispatch.
// The card's buttons are the only step outside the page.
// - confirm (desk light, loopback): Not verified → Authorize → the card (this computer) → someone else's tap is refused →
//   Confirm → Verified, in the composer line and the session menu; Settings → Web from defaults (on, not only-this-
//   computer, default hours) lists the session; Revoke empties it and the line reads Not verified again; then Not me
//   after Confirm signs the browser out (the next page is the sign-in).
// - not-me (phone dark zh-TW, LAN origin, reduced motion): the card says "on your network"; Not me before Confirm signs
//   it out (the session-ended banner); no horizontal overflow.
// - expiry (desk dark): the card's 5 minutes run out — the card is marked expired in place (shot and asserted), the line
//   offers Authorize again, a late Confirm does nothing; then a Confirm tapped after the deadline but before the timer
//   ran is judged expired at the tap. The card's clock is moved, not waited for (REAL_EXPIRY=1 waits the real 5 minutes).
// - refusals (desk light): a second tab's stale button → "already waiting"; a 4th ask in the hour → "Three requests this
//   hour"; an account whose DMs are closed → "Couldn't send you a DM"; an account that isn't a fleet admin → says so.
// - switch off (desk light): turned off through Settings → Web (Review → Apply, applies at once, nothing to confirm); the
//   line says it is off and links to Settings → Web; turned back on there.
// - the public link (phone light): the line says why, never asks; Settings → Web has no Web authority card.
// Every page logs no error. Guests are covered by the unit tests (a guest's page shows no line).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-1939-authorize-defaults.mts
import { bootFixture, demoAccount, freshPage, mounted, openPublicLink, shotPath, type DemoAccount, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-1939-authorize-defaults";
const CHAT = "observability-dashboards";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48430) });
const fm = fx.fm;
// Demo names only in what is shot (the fixture's first instances are a real fleet's).
const DEMO = new Set([CHAT, "billing-reconciliation", "search-indexer", "資料清洗與報表自動化助理"]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];

// The demo Discord connection: its fleet admins are config the operator writes (not page state), and its DMs are a stub.
const admins: string[] = [];
fm.fleetConfig.channels = [{ id: "demo", type: "discord", bot_token_env: "DEMO_BOT_TOKEN", access: { mode: "locked", allowed_users: admins } }];
interface Card { userId: string; chatId: string; messageId: string; text: string; choices: Array<{ id: string; label: string }>; history: string[] }
const cards: Card[] = [];
const closedDms = new Set<string>();
const dm = {
  id: "demo", type: "discord",
  async sendDirect(userId: string, text: string, opts: { choices?: Array<{ id: string; label: string }> } = {}) {
    if (closedDms.has(userId)) return null;
    const card = { userId, chatId: `dm-${userId}`, messageId: `card-${cards.length + 1}`, text, choices: opts.choices ?? [], history: [text] };
    cards.push(card);
    return { chatId: card.chatId, messageId: card.messageId };
  },
  async editMessage(chatId: string, messageId: string, text: string) { const c = cards.find(x => x.chatId === chatId && x.messageId === messageId); if (c) { c.text = text; c.history.push(text); } },
  async editMessageRemoveButtons(chatId: string, messageId: string, text: string) { await dm.editMessage(chatId, messageId, text); const c = cards.find(x => x.messageId === messageId); if (c) c.choices = []; },
  async replaceMessageButtons(_chatId: string, messageId: string, choices: Array<{ id: string; label: string }>) { const c = cards.find(x => x.messageId === messageId); if (c) c.choices = choices; },
  async sendText() { return { messageId: "general-1", chatId: "general" }; },
};
fm.adapters.set("demo", dm);
const cardsOf = (a: DemoAccount) => cards.filter(c => c.userId === a.userId);
async function tap(card: Card, which: "confirm" | "notme", userId = card.userId): Promise<{ present: boolean; acks: string[] }> {
  const choice = card.choices.find(c => c.id.endsWith(`:${which}`));
  if (!choice) return { present: false, acks: [] };
  const acks: string[] = [];
  await fm.dispatchAdapterCallback({ callbackData: choice.id, userId, chatId: card.chatId, messageId: card.messageId, ack: (n?: string) => { acks.push(n ?? ""); } }, "demo", dm);
  return { present: true, acks };
}
// The card's clock (monotonic): moved forward instead of waiting five minutes.
const requests = fm.sessionAuthorizationRequests();
let skew = 0;
requests.deps.now = () => performance.now() + skew;

// The card as the account sees it: drawn on a neutral page (not a copy of any app), shot, and its text read back from
// what was shot.
const cardCtx = await fx.browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const cardPage = await cardCtx.newPage();
async function shootCard(name: string, card: Card): Promise<{ text: string; buttons: string[] }> {
  await cardPage.setContent(`<!doctype html><meta charset="utf-8"><style>
    body { margin: 16px; background: #eef0f3; font: 15px/1.45 system-ui, sans-serif; color: #1f2328 }
    .dm { max-width: 560px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 14px }
    .cap { font-size: 12px; color: #57606a; margin-bottom: 8px } .t { white-space: pre-wrap }
    .b { display: flex; gap: 8px; margin-top: 10px } .b span { border: 1px solid #8c959f; border-radius: 6px; padding: 3px 12px; font-size: 14px }
  </style><div class="dm"><div class="cap">The account's DM (stub adapter) — ${card.messageId}</div><div class="t"></div><div class="b"></div></div>`);
  await cardPage.evaluate(([text, labels]: [string, string[]]) => {
    document.querySelector(".t")!.textContent = text;
    const b = document.querySelector(".b")!;
    for (const l of labels) { const s = document.createElement("span"); s.textContent = l; b.append(s); }
  }, [card.text, card.choices.map(c => c.label)] as [string, string[]]);
  const box = cardPage.locator(".dm");
  await box.screenshot({ path: shotPath(SMOKE, name, "card") });
  return { text: (await cardPage.locator(".dm .t").textContent()) ?? "", buttons: await cardPage.locator(".dm .b span").allTextContents() };
}

async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  await page.screenshot({ path: shotPath(SMOKE, "failure", "nothing-visible") }).catch(() => {});
  throw new Error(`nothing visible matches ${selector} on ${page.url()}`);
}
/** Open the demo agent's chat the way a person would: its entry in the sidebar (on a phone, in the menu's drawer). */
async function openChat(p: FreshPage): Promise<void> {
  const link = `a[href="/ui/chat/${CHAT}"]`;
  await mounted(p.page);
  // A phone opens the drawer first (on a desk the same button would collapse the sidebar).
  if (p.page.viewportSize().width < 760 && !(await p.page.locator(".shell.sb-open").count())) await clickVisible(p.page, 'button[aria-controls="sidebar"]');
  await clickVisible(p.page, link);
  await p.page.waitForURL(`**/ui/chat/${CHAT}`, { timeout: 10000 }).catch(async (e: unknown) => {
    await p.page.screenshot({ path: shotPath(SMOKE, "failure", "chat-not-opened") }).catch(() => {});
    throw new Error(`the chat did not open (${p.page.url()}): ${String(e).slice(0, 80)}`);
  });
}
async function openSettingsWeb(p: FreshPage): Promise<void> {
  await clickVisible(p.page, 'a[href="/settings"]');
  await p.page.waitForURL("**/settings", { timeout: 10000 });
  await clickVisible(p.page, 'a[href="/settings/web"]');
  await p.page.waitForURL("**/settings/web", { timeout: 10000 });
}
const chip = (p: FreshPage, scope = "") => p.page.locator(`${scope} .webauth-chip`.trim()).first();
async function chipState(p: FreshPage, state: string, timeout = 10000, scope = ""): Promise<string> {
  await p.page.waitForSelector(`${scope} .webauth-chip[data-state="${state}"]`.trim(), { timeout });
  return ((await chip(p, scope).textContent()) ?? "").replace(/\s+/g, " ").trim();
}
async function shootChip(p: FreshPage, name: string, scope = ""): Promise<void> {
  await chip(p, scope).scrollIntoViewIfNeeded();
  await p.page.screenshot({ path: shotPath(SMOKE, name, "page") });
}
const sessionOf = (a: DemoAccount) => fm.webSessions.list(undefined, (r: any) => r.owner?.adapterId === a.adapterId && r.owner?.userId === a.userId)[0] ?? null;
const authorizationOf = (a: DemoAccount) => { const s = sessionOf(a); return s ? fm.sessionAuthorizationStore().get(s.handle) : null; };
const overflow = (p: FreshPage) => p.page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth");
function admin(): DemoAccount { const a = demoAccount(); admins.push(a.userId); return a; }

const results: Array<{ name: string; ok: boolean; [k: string]: unknown }> = [];
function record(name: string, checks: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: failed.length === 0, failed, ...extra });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify(extra).slice(0, 600)}` : ""}`);
}
const DESK_LIGHT = { device: "desk", theme: "light", lang: "en" } as const;
/** ONLY=confirm,expiry … runs just those cases (default: all). */
const only = (name: string) => !process.env.ONLY || process.env.ONLY.split(",").includes(name);

// ── confirm ────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (only("confirm")) {
  const a = admin();
  const p = await freshPage(fx, DESK_LIGHT, { account: a });
  const c: Record<string, boolean> = { mounted: await mounted(p.page) };
  await openChat(p);
  const before = await chipState(p, "none");
  c.notVerified = before === "Not verified · Authorize this browser";
  await shootChip(p, "confirm-1-not-verified");
  await clickVisible(p.page, ".webauth-chip button");
  const waiting = await chipState(p, "pending");
  c.sent = /Waiting for your Confirm in Discord or Telegram \(\d:\d\d\)/.test(waiting) && waiting.includes("Sent — confirm it in your DM within 5 minutes.");
  await shootChip(p, "confirm-2-waiting");
  const card = cardsOf(a)[0]!;
  const ask = await shootCard("confirm-3-ask", card);
  c.cardAsks = /^🔐 Authorize this browser to speak as you\?\nDevice: .+ · on this computer\nAsked: .+ · it would last until .+\nOnly press Confirm if you just asked/.test(ask.text);
  c.cardButtons = JSON.stringify(ask.buttons) === JSON.stringify(["Confirm", "Not me"]);
  const stranger = await tap(card, "confirm", "999999999999999999");
  c.strangerRefused = stranger.acks.join() === "This request isn't yours." && authorizationOf(a) === null;
  await tap(card, "confirm");
  const done = await shootCard("confirm-4-confirmed", card);
  c.cardConfirmed = /^✅ Authorized: .+ · on this computer, until .+\. Its messages now carry your authority\./.test(done.text) && JSON.stringify(done.buttons) === JSON.stringify(["Not me"]);
  // The card's end is the session's own when that comes first, the same moment Settings lists.
  const s0 = sessionOf(a);
  c.cardUntilIsEffective = !!s0 && done.text.includes(`until ${new Date(Math.min(authorizationOf(a)?.until ?? 0, s0.absoluteExpiry)).toLocaleString()}.`);
  const auth = authorizationOf(a);
  c.stored = !!auth && typeof auth.until === "number" && auth.until > Date.now();
  const verified = await chipState(p, "verified");
  // 48 h ahead: the day is said too; "Sent —" went with the card.
  c.verified = /^✓ Verified · speaks as you until \w{3}, \w{3} \d{1,2}, \d\d:\d\d( [AP]M)?$/.test(verified);
  await shootChip(p, "confirm-5-verified");
  await clickVisible(p.page, ".session > button");
  c.menuVerified = /Verified · speaks as you until/.test(await chipState(p, "verified", 5000, ".session .pop"));
  await p.page.locator(".session .pop").screenshot({ path: shotPath(SMOKE, "confirm-6-session-menu", "pop") });
  await p.page.keyboard.press("Escape");
  // Settings → Web, from defaults.
  await openSettingsWeb(p);
  await p.page.waitForSelector(".s-web-authority #vaEnabled", { timeout: 10000 });
  const s = await p.page.evaluate(`(() => ({ enabled: document.querySelector("#vaEnabled").checked, loopbackOnly: document.querySelector("#vaLoopbackOnly").checked,
    hours: document.querySelector("#vaHours").value, placeholder: document.querySelector("#vaHours").placeholder,
    rows: [...document.querySelectorAll("#vaSessions li")].map((li) => li.textContent) }))()`) as any;
  c.settingsDefaults = s.enabled && !s.loopbackOnly && s.hours === "" && /48/.test(s.placeholder);
  c.settingsLists = s.rows.length === 1 && s.rows[0].includes(`demo:${a.userId}`);
  await p.page.setViewportSize({ width: 1366, height: 3000 });
  await p.page.locator(".s-web-authority").screenshot({ path: shotPath(SMOKE, "confirm-7-settings", "card") });
  await p.page.setViewportSize({ width: 1366, height: 900 });
  const epoch = fm.webAuthorityState().epoch;
  await p.page.click("#vaRevoke");
  await p.page.waitForSelector("dialog[open]", { timeout: 5000 });
  await p.page.click("dialog[open] .btn-danger, dialog[open] .btn-primary");
  await p.page.waitForSelector("#vaSessionsNone", { timeout: 5000 });
  c.revoked = fm.webAuthorityState().epoch === epoch + 1;
  await openChat(p);
  c.lineAfterRevoke = (await chipState(p, "none")) === "Not verified · Authorize this browser";
  await shootChip(p, "confirm-8-after-revoke");
  // Not me after Confirm: the card still offers it; the browser is signed out.
  await tap(card, "notme");
  const gone = await shootCard("confirm-9-revoked", card);
  c.cardRevoked = /^🚫 .+ was signed out; its authorization has ended\.$/.test(gone.text) && gone.buttons.length === 0;
  c.signedOut = sessionOf(a) === null;
  const errorsBefore = p.errors.length;
  await p.page.reload();
  // Signed out, the page is answered with the sign-in form in its place (401): its own and /auth/session's 401s are
  // the expected ones, and nothing else.
  c.nextPageSignIn = await p.page.waitForSelector("#code", { state: "visible", timeout: 10000 }).then(() => true, () => false);
  const after = p.errors.splice(errorsBefore);
  c.onlyExpected401s = after.every((e) => /status of 401/.test(e) && /(\/ui\/chat\/|\/auth\/session)/.test(e));
  await p.page.screenshot({ path: shotPath(SMOKE, "confirm-10-signed-out", "page") });
  c.noErrors = p.errors.length === 0;
  record("confirm-desk-light-en", c, { errors: p.errors });
  await p.ctx.close();
}

// ── not me (phone, LAN, reduced motion, zh-TW) ──────────────────────────────────────────────────────────────────────────
if (only("notme")) {
  const a = admin();
  const p = await freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, { account: a, origin: "lan", reducedMotion: true });
  const c: Record<string, boolean> = { mounted: await mounted(p.page) };
  await openChat(p);
  c.notVerified = (await chipState(p, "none")) === "未驗證 · 授權這個瀏覽器";
  await shootChip(p, "notme-1-not-verified");
  await clickVisible(p.page, ".webauth-chip button");
  const waiting = await chipState(p, "pending");
  c.sent = waiting.includes("已送出——請在 5 分鐘內到私訊確認。");
  c.noOverflow = !(await overflow(p));
  await shootChip(p, "notme-2-waiting");
  const card = cardsOf(a)[0]!;
  const ask = await shootCard("notme-3-ask", card);
  c.cardLan = /· on your network\n/.test(ask.text);
  await tap(card, "notme");
  const denied = await shootCard("notme-4-denied", card);
  c.cardDenied = /^🚫 Not authorized: .+ was signed out\.$/.test(denied.text) && denied.buttons.length === 0;
  c.signedOut = sessionOf(a) === null && authorizationOf(a) === null;
  // The page's next read (its poll while the card waited) finds it signed out.
  c.banner = await p.page.waitForSelector(".agend-session-ended", { timeout: 10000 }).then(() => true, () => false);
  c.lineGone = await p.page.waitForSelector(".webauth-chip", { state: "detached", timeout: 5000 }).then(() => true, () => false);
  await p.page.screenshot({ path: shotPath(SMOKE, "notme-5-signed-out", "page") });
  c.noErrors = p.errors.filter(e => !/status of 401/.test(e)).length === 0;
  record("notme-phone-dark-zh-TW-lan-reduced", c, { errors: p.errors });
  await p.ctx.close();
}

// ── expiry ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (only("expiry")) {
  const a = admin();
  const p = await freshPage(fx, { device: "desk", theme: "dark", lang: "en" }, { account: a });
  const c: Record<string, boolean> = { mounted: await mounted(p.page) };
  await openChat(p);
  await chipState(p, "none");
  await clickVisible(p.page, ".webauth-chip button");
  await chipState(p, "pending");
  const card = cardsOf(a)[0]!;
  const sentButtons = [...card.choices];                                                 // what a stale client could still send
  if (process.env.REAL_EXPIRY === "1") await p.page.waitForTimeout(5 * 60_000 + 5_000);
  else skew += 5 * 60_000 + 1_000;
  // The page's next poll (every 3 s) finds the card gone: the line offers Authorize again; the card is marked in place.
  c.lineAgain = (await chipState(p, "none", 15000)).startsWith("Not verified · Authorize this browser");
  await shootChip(p, "expiry-1-line-again");
  const expired = await shootCard("expiry-2-expired", card);
  c.cardExpired = /^⌛ This request for .+ expired\. Ask again from the dashboard if you still want it\.$/.test(expired.text) && expired.buttons.length === 0;
  const late = await tap({ ...card, choices: sentButtons }, "confirm");                  // the removed button, sent anyway
  c.lateTapNothing = late.present && authorizationOf(a) === null && card.text === expired.text;
  // A Confirm after the deadline, before the timer and any poll: judged expired at the tap.
  await p.page.reload();
  await mounted(p.page);
  await chipState(p, "none");
  await clickVisible(p.page, ".webauth-chip button");
  await chipState(p, "pending");
  const second = cardsOf(a)[1]!;
  skew += 5 * 60_000 + 1_000;
  const atTap = await tap(second, "confirm");
  const judged = await shootCard("expiry-3-tapped-late", second);
  c.tapJudgedExpired = atTap.present && authorizationOf(a) === null && /^⌛ This request for .+ expired\./.test(judged.text) && judged.buttons.length === 0;
  c.lineAgain2 = (await chipState(p, "none", 15000)).startsWith("Not verified · Authorize this browser");
  c.noErrors = p.errors.length === 0;
  record(`expiry-desk-dark-en${process.env.REAL_EXPIRY === "1" ? "-real-5min" : ""}`, c, { errors: p.errors });
  await p.ctx.close();
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (only("refusals")) {
  const a = admin();
  const p = await freshPage(fx, DESK_LIGHT, { account: a });
  const c: Record<string, boolean> = { mounted: await mounted(p.page) };
  await openChat(p);
  await chipState(p, "none");
  // A second tab of the same browser, opened before the ask: its button is stale.
  const tab2 = await p.ctx.newPage();
  await tab2.goto(p.page.url());
  await tab2.waitForSelector('.webauth-chip[data-state="none"] button', { timeout: 10000 });
  await clickVisible(p.page, ".webauth-chip button");
  await chipState(p, "pending");
  await tab2.click(".webauth-chip button");
  await tab2.waitForSelector(".webauth-chip [role=status]", { timeout: 5000 });
  c.pending = (await tab2.locator(".webauth-chip [role=status]").textContent()) === "A request is already waiting in your DM.";
  await tab2.screenshot({ path: shotPath(SMOKE, "refusal-1-pending", "page") });
  await tab2.close();
  // Two more asks (each card left to expire), then the 4th in the hour is refused.
  for (let i = 0; i < 2; i++) {
    skew += 5 * 60_000 + 1_000;
    await chipState(p, "none", 15000);
    await clickVisible(p.page, ".webauth-chip button");
    await chipState(p, "pending");
  }
  skew += 5 * 60_000 + 1_000;
  await chipState(p, "none", 15000);
  await clickVisible(p.page, ".webauth-chip button");
  await p.page.waitForSelector(".webauth-chip [role=status]", { timeout: 5000 });
  c.rateLimited = /^Three requests this hour — try again in \d+ min\.$/.test((await p.page.locator(".webauth-chip [role=status]").textContent()) ?? "");
  c.threeCards = cardsOf(a).length === 3;
  await shootChip(p, "refusal-2-rate-limited");
  c.noErrors = p.errors.length === 0;
  record("refusals-desk-light-en", c, { errors: p.errors });
  await p.ctx.close();

  const closed = admin();
  closedDms.add(closed.userId);
  const q = await freshPage(fx, DESK_LIGHT, { account: closed });
  const d: Record<string, boolean> = { mounted: await mounted(q.page) };
  await openChat(q);
  await chipState(q, "none");
  await clickVisible(q.page, ".webauth-chip button");
  await q.page.waitForSelector(".webauth-chip [role=status]", { timeout: 5000 });
  d.dmUnavailable = (await q.page.locator(".webauth-chip [role=status]").textContent()) === "Couldn't send you a DM. Open your DMs with the bot, then try again.";
  d.noCard = cardsOf(closed).length === 0;
  await shootChip(q, "refusal-3-dm-closed");
  d.noErrors = q.errors.length === 0;
  record("dm-closed-desk-light-en", d, { errors: q.errors });
  await q.ctx.close();

  const notAdmin = demoAccount();                                                        // not in the admin list
  const r = await freshPage(fx, DESK_LIGHT, { account: notAdmin });
  const e: Record<string, boolean> = { mounted: await mounted(r.page) };
  await openChat(r);
  const line = await chipState(r, "none");
  e.notAdmin = line === "Not verified: Your account is not a fleet admin here." && (await r.page.locator(".webauth-chip button").count()) === 0;
  await shootChip(r, "refusal-4-not-admin");
  e.noErrors = r.errors.length === 0;
  record("not-admin-desk-light-en", e, { errors: r.errors });
  await r.ctx.close();
}

// ── the switch, off and on again through Settings → Web ─────────────────────────────────────────────────────────────────
if (only("switch")) {
  const a = admin();
  const p = await freshPage(fx, DESK_LIGHT, { account: a });
  const c: Record<string, boolean> = { mounted: await mounted(p.page) };
  await openSettingsWeb(p);
  await p.page.waitForSelector(".s-web-authority #vaEnabled", { timeout: 10000 });
  c.onByDefault = await p.page.isChecked("#vaEnabled");
  const setSwitch = async (on: boolean) => {
    await p.page.setChecked("#vaEnabled", on);
    await p.page.click("#vaReview");
    await p.page.waitForSelector(".s-pending", { timeout: 5000 });
    await p.page.locator(".s-pending button.btn-primary").click();
    await p.page.waitForFunction(`!document.querySelector(".s-pending")`, null, { timeout: 15000 });
    await p.page.waitForTimeout(800);
    return (await p.page.locator(".s-pending").count()) === 0;                           // a failed Apply stages it again
  };
  c.applyOffLanded = await setSwitch(false);
  c.appliedOff = fm.fleetConfig.web?.verified_authority?.enabled === false && fm.webAuthorityState().enabled === false;
  c.noConfirmAsked = (await p.page.locator("dialog[open]").count()) === 0;
  await openChat(p);
  const off = await chipState(p, "none");
  c.lineOff = off === "Not verified: Web authority is turned off. Settings";
  await shootChip(p, "switch-1-off");
  await clickVisible(p.page, '.webauth-chip a[href="/settings/web"]');
  await p.page.waitForSelector(".s-web-authority #vaEnabled", { timeout: 10000 });
  c.linkLandsOnCard = p.page.url().endsWith("/settings/web") && !(await p.page.isChecked("#vaEnabled"));
  c.applyOnLanded = await setSwitch(true);
  c.appliedOn = fm.fleetConfig.web?.verified_authority?.enabled !== false && fm.webAuthorityState().enabled === true;
  await openChat(p);
  c.lineOn = (await chipState(p, "none")) === "Not verified · Authorize this browser";
  await shootChip(p, "switch-2-on-again");
  c.noErrors = p.errors.length === 0;
  record("switch-desk-light-en", c, { errors: p.errors });
  await p.ctx.close();
}

// ── the temporary public link ──────────────────────────────────────────────────────────────────────────────────────────
if (only("public")) {
  const link = await openPublicLink(fx);
  admins.push(link.owner.userId);
  const asked: string[] = [];
  const p = await link.publicPage({ device: "phone", theme: "light", lang: "en" }, { reducedMotion: true,
    beforeNavigate: (_ctx: any, page: any) => { page.on("request", (r: any) => { if (new URL(r.url()).pathname === "/ui/authorization") asked.push(r.method()); }); } });
  const c: Record<string, boolean> = { mounted: await mounted(p.page) };
  await openChat(p);
  c.says = (await chipState(p, "public")) === "Not on the temporary public link: open the dashboard directly to authorize.";
  c.noOverflow = !(await overflow(p));
  await shootChip(p, "public-1-line");
  c.neverAsked = asked.length === 0;
  await openSettingsWeb(p);
  await p.page.waitForSelector("#webPublicRefused", { timeout: 10000 });
  c.noSettingsCards = (await p.page.locator(".s-web-authority, .s-guest-fields").count()) === 0;
  await p.page.screenshot({ path: shotPath(SMOKE, "public-2-settings-web", "page") });
  c.noErrors = p.errors.length === 0;
  record("public-link-phone-light-en", c, { errors: p.errors, asked });
  await p.ctx.close();
  await link.close();
}

console.log(JSON.stringify(results, null, 1));
const bad = results.filter(r => !r.ok);
console.log(bad.length ? `FAIL ${bad.map(b => `${b.name} [${(b.failed as string[]).join(", ")}]`).join("; ")}` : "PASS");
await cardCtx.close();
await fx.close();
process.exit(bad.length ? 1 : 0);
