// The composer's row (#2215, the user's request, 2026-10-19): what sits under the chat composer is one row at the bottom
// left — this browser's web authority (#1939), then the key hint — instead of a centred hint with the authority line
// stacked under it. Verified shows "✓ Verified" only; when it ends ("speaks as you until …") is in its tooltip, its
// accessible name, and a tap. From defaults (fleet decision a78ebdc5): fresh profiles signed in through the visible
// /signin (a guest: a guest session, as smoke-1920-guest does), driven through visible UI.
// Cases: verified, not verified, a guest, the temporary public link — each at desk and phone widths, light and dark,
// English and zh-TW; the phone verified case on a LAN origin (Chromium) with reduced motion.
// MODE=before (run against a checkout without the change) records the height under the composer and shoots it; the
// default (after) also judges: one row, left-aligned with the composer, no expiry in the visible text (it is in the
// tooltip and the accessible name; a tap shows it), no horizontal overflow, and — #2184 — switching chats keeps the
// composer and the row where they are, the thread pinned to its bottom. HEIGHTS=<file> writes the measurements.
//   PW_DIR=… REPO=… OUT=… FONTCONFIG_FILE=/etc/fonts/fonts.conf [MODE=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-composer-row-2215.mts
import { writeFileSync } from "node:fs";
import { bootFixture, demoAccount, freshPage, mounted, openPublicLink, shotPath, VIEWPORTS, type DemoAccount, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-composer-row-2215";
const MODE = process.env.MODE === "before" ? "before" : "after";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll)|auth\/session)(\?\S*)? due to access control checks\.$/;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48690), classic: false, webYaml: "  guests:\n    enabled: true" });
const fm = fx.fm;
const CHAT = "observability-dashboards", OTHER = "billing-reconciliation";
const DEMO = new Set([CHAT, OTHER, "search-indexer", "資料清洗與報表自動化助理"]);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!DEMO.has(name)) delete fm.fleetConfig.instances[name];

// The demo Discord connection (its admins are config the smoke writes) and its DMs, a stub (smoke-1939's).
const admins: string[] = [];
fm.fleetConfig.channels = [{ id: "demo", type: "discord", bot_token_env: "DEMO_BOT_TOKEN", access: { mode: "locked", allowed_users: admins } }];
const cards: Array<{ userId: string; chatId: string; messageId: string; choices: Array<{ id: string }> }> = [];
const dm = {
  id: "demo", type: "discord",
  async sendDirect(userId: string, _text: string, opts: { choices?: Array<{ id: string }> } = {}) { const c = { userId, chatId: `dm-${userId}`, messageId: `card-${cards.length + 1}`, choices: opts.choices ?? [] }; cards.push(c); return { chatId: c.chatId, messageId: c.messageId }; },
  async editMessage() {}, async editMessageRemoveButtons() {}, async replaceMessageButtons() {}, async sendText() { return { messageId: "g", chatId: "g" }; },
};
fm.adapters.set("demo", dm);
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
fm.guestScope = () => new Set([CHAT, OTHER]);

async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  throw new Error(`nothing visible matches ${selector} on ${page.url()}`);
}
const phone = (page: any) => page.viewportSize().width < 760;
async function openChat(page: any, name: string): Promise<void> {
  if (phone(page) && !(await page.locator(".shell.sb-open").count())) await clickVisible(page, 'button[aria-controls="sidebar"]');
  await clickVisible(page, `a[href="/ui/chat/${encodeURIComponent(name)}"]`);
  await page.waitForURL(`**/ui/chat/${encodeURIComponent(name)}`, { timeout: 10000 });
  await page.waitForSelector("#msgIn", { timeout: 10000 });
}
async function authorize(page: any, a: DemoAccount): Promise<void> {
  await page.waitForSelector('.dock [data-state="none"] button', { timeout: 10000 });
  await clickVisible(page, ".dock [data-state=\"none\"] button");
  await page.waitForSelector('.dock [data-state="pending"]', { timeout: 10000 });
  const card = cards.filter(c => c.userId === a.userId).at(-1)!;
  const choice = card.choices.find(c => c.id.endsWith(":confirm"))!;
  await fm.dispatchAdapterCallback({ callbackData: choice.id, userId: card.userId, chatId: card.chatId, messageId: card.messageId, ack: () => {} }, "demo", dm);
  await page.waitForSelector('.dock [data-state="verified"]', { timeout: 10000 });
}

/** Under the composer: its height (composer bottom → dock column bottom), its lines, its left edge, its visible text. */
const MEASURE = `(() => {
  const comp = document.querySelector(".dock .composer"), col = document.querySelector(".dock-col");
  if (!comp || !col) return null;
  const c = comp.getBoundingClientRect(), d = col.getBoundingClientRect();
  const kids = [...col.children].filter((n) => n.getBoundingClientRect().top >= c.bottom - 1 && n.offsetParent !== null && n.getBoundingClientRect().height > 0);
  const boxes = []; for (const k of kids) for (const n of [k, ...k.querySelectorAll("*")]) { if (n.children.length || !n.textContent.trim()) continue;
    const r = n.getBoundingClientRect(); if (r.height > 0 && getComputedStyle(n).visibility !== "hidden" && !n.closest("[hidden]")) boxes.push(r); }
  const tops = [...new Set(boxes.map((r) => Math.round(r.top / 4)))];
  const left = boxes.length ? Math.min(...boxes.map((r) => r.left)) : null;
  return { below: Math.round(d.bottom - c.bottom), lines: tops.length, rows: kids.length, left: left === null ? null : Math.round(left - c.left),
    text: kids.map((k) => k.innerText).join(" | "), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    clipped: [...document.querySelectorAll(".composer-row, .composer-row > *")].some((n) => n.offsetParent !== null && n.scrollWidth > n.clientWidth + 1) };
})()`;
const QUIET = (p: FreshPage, navEnd: number) => p.errors.filter((e, i) => { const t = e.replace(/ @ \S+$/, ""); return !(ENGINE === "webkit" && (WEBKIT_OWN.has(t) || (i < navEnd && CANCEL.test(t)))); });

const results: any[] = [], heights: Record<string, unknown> = {};
async function shoot(page: any, name: string) {
  const box = await page.locator(".dock").boundingBox();
  await page.screenshot({ path: shotPath(SMOKE, `${MODE}-${ENGINE}-${name}`, "dock"), clip: { x: 0, y: Math.max(0, box.y - 8), width: page.viewportSize().width, height: Math.min(page.viewportSize().height - Math.max(0, box.y - 8), box.height + 16) } });
  await page.screenshot({ path: shotPath(SMOKE, `${MODE}-${ENGINE}-${name}`, "page") });
}
async function judge(name: string, p: FreshPage, navEnd: number, state: string, lang: string, extra: (m: any) => Promise<Record<string, boolean>>) {
  await p.page.waitForTimeout(600);
  const m = await p.page.evaluate(MEASURE);
  heights[name] = m;
  await shoot(p.page, name);
  if (MODE === "before" && /^(un)?verified/.test(name)) heights[`${name}-switch`] = (await switchKeepsPlace(p.page, name)) ? "kept" : switches[name];
  const chk: Record<string, boolean> = { mounted: !!m };
  if (MODE === "after" && m) Object.assign(chk, {
    // One row; a guest's note or the public link's sentence may take a second line on a phone rather than lose words.
    oneRow: m.rows === 1 && (m.lines === 1 || (/^(guest|public)/.test(name) && phone(p.page) && m.lines === 2)),
    nothingClipped: !m.clipped,
    leftAligned: m.left !== null && m.left >= -2 && m.left <= 16,
    noOverflow: !m.overflow,
    ...(await extra(m)),
  });
  chk.noErrors = QUIET(p, navEnd).length === 0;
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed });
  if (failed.includes("keepsPlaceOnSwitch")) console.log("  switch:", JSON.stringify(switches[name]));
  console.log(`${failed.length ? "FAIL" : "ok  "} ${MODE}-${ENGINE}-${name} below=${m?.below}px lines=${m?.lines} rows=${m?.rows} "${String(m?.text ?? "").replace(/\s+/g, " ").slice(0, 90)}"${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ m, errors: QUIET(p, navEnd) }).slice(0, 900)}` : ""}`);
}
const UNTIL = /until|到 \d|\d{1,2}:\d\d/;

/**
 * #2184: switching to another chat and back keeps the row where it is under the composer (its height there the same;
 * a composer that is taller in one chat — its placeholder names the chat and can wrap on a phone — is that chat's own),
 * the dock at the bottom, the thread pinned to its bottom.
 */
const switches: Record<string, unknown> = {};
async function switchKeepsPlace(page: any, name = ""): Promise<boolean> {
  const at = () => page.evaluate(`(() => { const c = document.querySelector(".dock .composer").getBoundingClientRect(), col = document.querySelector(".dock-col").getBoundingClientRect(),
    d = document.querySelector(".dock").getBoundingClientRect(), t = document.querySelector(".thread");
    return { below: Math.round(col.bottom - c.bottom), dockBottom: Math.round(d.bottom), pinned: !t || t.scrollHeight - t.scrollTop - t.clientHeight < 4 }; })()`);
  const a = await at();
  const kids = () => page.evaluate(`[...document.querySelector(".dock-col").children].map((n) => n.className + ":" + Math.round(n.getBoundingClientRect().height))`);
  if (process.env.DOCK_PROBE) console.log("  dock A:", JSON.stringify(await kids()));
  await openChat(page, OTHER); await page.waitForTimeout(500);
  if (process.env.DOCK_PROBE) console.log("  dock B:", JSON.stringify(await kids()));
  const b = await at();
  await openChat(page, CHAT); await page.waitForTimeout(500);
  const c = await at();
  switches[name] = [a, b, c];
  return a.below === b.below && b.below === c.below && a.dockBottom === b.dockBottom && b.dockBottom === c.dockBottom && a.pinned && b.pinned && c.pinned;
}

const CASES = [
  { state: "verified", c: { device: "desk", theme: "light", lang: "zh-TW" } },
  { state: "verified", c: { device: "phone", theme: "dark", lang: "zh-TW" }, lan: true },
  { state: "unverified", c: { device: "desk", theme: "dark", lang: "en" } },
  { state: "unverified", c: { device: "phone", theme: "light", lang: "en" } },
  { state: "guest", c: { device: "desk", theme: "light", lang: "en" } },
  { state: "guest", c: { device: "phone", theme: "dark", lang: "zh-TW" } },
  { state: "public", c: { device: "desk", theme: "dark", lang: "en" } },
  { state: "public", c: { device: "phone", theme: "light", lang: "en" } },
] as const;

let link: Awaited<ReturnType<typeof openPublicLink>> | null = null;
for (const k of CASES) {
  const name = `${k.state}-${k.c.device}-${k.c.theme}-${k.c.lang}`;
  if (k.state === "verified" || k.state === "unverified") {
    const a = demoAccount(); admins.push(a.userId);
    const p = await freshPage(fx, k.c as any, { account: a, ...("lan" in k && k.lan && ENGINE !== "webkit" ? { origin: "lan" as const, reducedMotion: true } : {}) });
    await mounted(p.page, 30000);
    const navEnd = p.errors.length;
    await openChat(p.page, CHAT);
    if (k.state === "verified") await authorize(p.page, a);
    else await p.page.waitForSelector('.dock [data-state="none"]', { timeout: 10000 });
    await judge(name, p, navEnd, k.state, k.c.lang, async (m) => {
      if (k.state !== "verified") {
        const kept = await switchKeepsPlace(p.page, name);
        // #2216 review: press Authorize — what it answered ("Sent —") is said in the row, in the hint's place; nothing is
        // laid over the composer (Attach and the text box still take a click), and the row stays one row.
        await clickVisible(p.page, ".dock .webauth-ask");
        await p.page.waitForSelector('.dock [data-state="pending"] .webauth-notice', { timeout: 10000 });
        await p.page.fill("#msgIn", "hello");
        const after = await p.page.evaluate(MEASURE);
        const hits = await p.page.evaluate(`(() => [document.getElementById("attachBtn"), document.getElementById("msgIn")].map((el) => {
          const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && (at === el || el.contains(at)); }))()`);
        const tipShown = await p.page.evaluate(`[...document.querySelectorAll(".dock .webauth-tip")].some((t) => !t.hidden && t.getBoundingClientRect().height > 0)`);
        await shoot(p.page, `${name}-pending`);
        return { saysNotVerified: /Not verified|未驗證/.test(m.text) && /Authorize|授權/.test(m.text), keepsPlaceOnSwitch: kept,
          pendingSaysSentInRow: /Sent —|已送出/.test(after.text) && after.rows === 1 && after.lines <= (phone(p.page) ? 2 : 1),
          pendingCoversNothing: hits.every(Boolean) && !tipShown };
      }
      const ok = p.page.locator(".dock .webauth-ok").first();
      const title = (await ok.getAttribute("title")) ?? "", label = (await ok.getAttribute("aria-label")) ?? "";
      const described = await ok.evaluate((el: Element) => { const id = el.getAttribute("aria-describedby"); return id ? (document.getElementById(id)?.textContent ?? "") : ""; });
      await ok.click();                                                                     // a tap (or a click) shows it
      const tip = await p.page.locator(".dock .webauth-tip").first().evaluate((el: HTMLElement) => ({ text: el.textContent ?? "", shown: !el.hidden && el.getBoundingClientRect().height > 0 })).catch(() => ({ text: "", shown: false }));
      await shoot(p.page, `${name}-tapped`);
      await ok.click();
      return { verifiedShort: /✓/.test(m.text) && !UNTIL.test(m.text), tooltipSaysUntil: UNTIL.test(title), screenReaderSaysUntil: UNTIL.test(label + " " + described),
        tapShowsUntil: tip.shown && UNTIL.test(tip.text), keepsPlaceOnSwitch: await switchKeepsPlace(p.page, name) };
    });
    await p.ctx.close();
  } else if (k.state === "guest") {
    const owner = { adapterId: "demo", userId: String(800000000000000000n + BigInt(results.length)) };
    const sid = fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke", tokenEpoch: tokenEpoch(fm.webToken), owner }).sessionId;
    fm.webPrefs.write("operator", new Map<string, unknown>([["theme", k.c.theme], ["lang", k.c.lang]]));
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[k.c.device], deviceScaleFactor: 1, colorScheme: k.c.theme, locale: k.c.lang === "zh-TW" ? "zh-TW" : "en-US", isMobile: k.c.device === "phone", hasTouch: k.c.device === "phone" });
    await ctx.addCookies([{ name: "agend_session", value: sid, url: fx.base }]);
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_lang", ${JSON.stringify(k.c.lang)}); } catch {}` });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
    page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(CHAT)}`);
    await page.waitForSelector("#msgIn", { timeout: 15000 });
    const p = { ctx, page, base: fx.base, errors, expected: [], account: null, personKey: "" } as unknown as FreshPage;
    await judge(name, p, 0, k.state, k.c.lang, async (m) => ({ saysGuest: /guest|訪客/i.test(m.text) }));
    fm.webPrefs.write("operator", new Map<string, unknown>([["theme", null], ["lang", null]]));
    await ctx.close();
  } else {
    link ??= await openPublicLink(fx);
    const p = await link.publicPage(k.c as any, { reducedMotion: true });
    await mounted(p.page, 30000);
    const navEnd = p.errors.length;
    await openChat(p.page, CHAT);
    await p.page.waitForSelector('.dock [data-state="public"]', { timeout: 10000 });
    await judge(name, p, navEnd, k.state, k.c.lang, async (m) => ({ saysPublic: /public link|公開連結/i.test(m.text) }));
    await p.ctx.close();
  }
}
await link?.close();
if (process.env.HEIGHTS) writeFileSync(process.env.HEIGHTS, JSON.stringify(heights, null, 2));
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${MODE}, ${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);
